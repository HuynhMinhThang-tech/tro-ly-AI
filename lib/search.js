// Tìm kiếm lai cho chatbot: gộp 3 nguồn kết quả rồi chọn ra TOPK đoạn gửi cho AI.
//   1. "Điều N" trong câu hỏi  → tra thẳng theo tiêu đề đoạn (SQL), không cần embedding, chính xác tuyệt đối.
//   2. Từ khóa (full-text)     → tài liệu tìm được ngay khi vừa tải lên, kể cả khi embedding chưa xong hoặc Voyage đang bận.
//   3. Ngữ nghĩa (pgvector)    → hiểu câu hỏi diễn đạt khác với văn bản.
// (2) và (3) được xếp hạng lại bằng RRF (reciprocal rank fusion): đoạn nào đứng cao ở cả hai danh sách sẽ lên đầu.
const { fold, keywords, words, parseArticleRefs, STOP } = require('./vn');

const TOPK = 6, CAND = 20, RRF_K = 60;

// ---------- 1. Điều N ----------
function articlePattern(refs) {
  // heading đã bỏ dấu có dạng "chuong i - ... › dieu 12. ten dieu"; ref "12" không được khớp nhầm "12a" hay "120"
  return '(^|[^a-z0-9])dieu\\s*(' + refs.join('|') + ')([^a-z0-9]|$)';
}
/** Nếu câu hỏi nêu tên luật/số hiệu thì chỉ giữ các điều thuộc tài liệu đó; không nêu thì giữ hết (AI tự phân biệt qua tên văn bản). */
function pickDocs(rows, text) {
  const docs = new Map();
  for (const r of rows) if (!docs.has(r.doc_id)) docs.set(r.doc_id, r);
  if (docs.size < 2) return rows;
  const q = fold(text), qw = new Set(words(text).filter(w => !STOP.has(w) && w.length >= 3));
  const score = d => {
    let s = 0;
    for (const w of new Set(words(d.title))) if (w.length >= 3 && !STOP.has(w) && qw.has(w)) s++;
    if (d.doc_number && q.includes(fold(d.doc_number))) s += 5;
    return s;
  };
  const sc = new Map([...docs].map(([id, d]) => [id, score(d)])), best = Math.max(...sc.values());
  return best >= 2 ? rows.filter(r => sc.get(r.doc_id) === best) : rows;
}
async function articleHits(pool, text, limit = 4) {
  const refs = parseArticleRefs(text);
  if (!refs.length) return [];
  const { rows } = await pool.query(
    `select c.id, c.heading, c.content, d.id as doc_id, d.title, d.doc_number
       from chunks c join documents d on d.id = c.document_id
      where d.active and vn_fold(c.heading) ~ $1
      order by d.created_at desc, c.id limit 60`, [articlePattern(refs)]);
  return pickDocs(rows, text).slice(0, limit);
}

// ---------- 2. Từ khóa ----------
/** Từ khóa nối bằng OR (câu hỏi tự nhiên hiếm khi có đủ mọi từ), cộng điểm thưởng cho cụm 2 từ đứng liền nhau. */
function buildTsQueries(text) {
  const kw = keywords(text);
  if (!kw.length) return null;
  const seq = words(text).slice(0, 40), phrases = [];
  for (let i = 0; i + 1 < seq.length && phrases.length < 12; i++) {
    if (STOP.has(seq[i]) && STOP.has(seq[i + 1])) continue;
    phrases.push(`(${seq[i]} <-> ${seq[i + 1]})`);
  }
  return { any: kw.join(' | '), phrase: phrases.length ? [...new Set(phrases)].join(' | ') : null };
}
async function keywordHits(pool, text, limit = CAND) {
  const q = buildTsQueries(text);
  if (!q) return [];
  const rank = q.phrase ? 'ts_rank_cd(c.tsv, to_tsquery(\'simple\', $1)) + 2 * ts_rank_cd(c.tsv, to_tsquery(\'simple\', $2))' : 'ts_rank_cd(c.tsv, to_tsquery(\'simple\', $1))';
  const params = q.phrase ? [q.any, q.phrase, limit] : [q.any, limit];
  const { rows } = await pool.query(
    `select c.id, c.heading, c.content, d.id as doc_id, d.title, d.doc_number, ${rank} as score
       from chunks c join documents d on d.id = c.document_id
      where d.active and c.tsv @@ to_tsquery('simple', $1)
      order by score desc, c.id limit $${params.length}`, params);
  return rows;
}

// ---------- 3. Ngữ nghĩa ----------
// pgvector ≥ 0.8 có "quét lặp" để bộ lọc d.active không làm HNSW trả thiếu kết quả; bản cũ hơn thì chỉ tăng ef_search.
let iterOK = null;
async function supportsIterative(pool) {
  if (iterOK !== null) return iterOK;
  try {
    const { rows } = await pool.query("select extversion as v from pg_extension where extname = 'vector'");
    const [a, b] = String(rows[0]?.v || '0.0').split('.').map(Number);
    iterOK = a > 0 || b >= 8;
  } catch { iterOK = false; }
  return iterOK;
}
async function vectorHits(pool, vec, limit = CAND) {
  const iter = await supportsIterative(pool), c = await pool.connect();
  try {
    // SET LOCAL (qua set_config) chỉ có hiệu lực trong giao dịch này, an toàn cả khi đi qua bộ gom kết nối (pooler) của Neon
    await c.query("begin; select set_config('hnsw.ef_search', '100', true)" + (iter ? ", set_config('hnsw.iterative_scan', 'relaxed_order', true)" : ''));
    const { rows } = await c.query(
      `select * from (
         select c.id, c.heading, c.content, d.id as doc_id, d.title, d.doc_number, c.embedding <=> $1::vector as dist
           from chunks c join documents d on d.id = c.document_id
          where d.active and c.embedding is not null
          order by c.embedding <=> $1::vector limit $2) s
       order by dist`, [JSON.stringify(vec), limit]);
    await c.query('commit');
    return rows;
  } catch (e) { await c.query('rollback').catch(() => { }); throw e; }
  finally { c.release(); }
}

// ---------- Gộp ----------
function rrf(lists, k = RRF_K) {
  const score = new Map(), row = new Map();
  lists.forEach(list => list.forEach((r, i) => {
    score.set(r.id, (score.get(r.id) || 0) + 1 / (k + i + 1));
    if (!row.has(r.id)) row.set(r.id, r);
  }));
  return [...score].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ ...row.get(id), rrf: s }));
}

/**
 * @param vec vector của câu hỏi, hoặc null nếu không tạo được (Voyage bận / lỗi / chưa cấu hình) → chỉ tìm theo từ khóa
 * @returns { hits, mode: 'hybrid'|'keyword', direct: số đoạn tra thẳng theo Điều }
 */
async function search(pool, { text, vec, topk = TOPK }) {
  const [direct, kw, vv] = await Promise.all([
    articleHits(pool, text),
    keywordHits(pool, text),
    vec ? vectorHits(pool, vec) : Promise.resolve([])
  ]);
  const seen = new Set(), hits = [];
  for (const r of [...direct, ...rrf([vv, kw])]) {
    if (seen.has(r.id) || hits.length >= topk) continue;
    seen.add(r.id); hits.push(r);
  }
  return { hits, mode: vec ? 'hybrid' : 'keyword', direct: direct.length, vector: vv.length, keyword: kw.length };
}

module.exports = { search, articleHits, keywordHits, vectorHits, buildTsQueries, articlePattern, pickDocs, rrf, TOPK };
