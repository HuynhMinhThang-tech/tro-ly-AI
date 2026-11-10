const crypto = require('crypto');
const { toMarkdown } = require('./markdown');
const { chunkMarkdown } = require('./chunker');
const VOYAGE_URL = process.env.VOYAGE_URL || 'https://api.voyageai.com/v1/embeddings';

// PIPELINE LẬP CHỈ MỤC:  tệp → toMarkdown() → chunkMarkdown() → embed() → database
// analyze() chạy hai bước đầu (chưa lưu gì), server.js gọi embed() và ghi database sau khi admin xác nhận.
async function analyze(buf, filename = '') {
  const out = { type: 'text', pages: null, text: '', markdown: '', chunks: [], issues: [], hash: null };
  const add = (level, text) => out.issues.push({ level, text });

  // Bước 1: chuyển sang Markdown (nhận diện theo nội dung tệp, không tin đuôi tệp)
  const conv = await toMarkdown(buf, filename);
  if (conv.error) { add('block', conv.error); return out; }
  Object.assign(out, { type: conv.type, pages: conv.pages, text: conv.text, markdown: conv.markdown });
  conv.notes.forEach(n => add('info', n));

  const clean = out.text.replace(/\s+/g, ' ').trim();
  if (clean.length < 200) {
    add('block', out.type === 'pdf'
      ? 'PDF gần như không có chữ, có thể là bản scan (ảnh). Cần chạy OCR trước khi tải lên.'
      : 'Nội dung trống hoặc quá ngắn.');
    return out;
  }
  out.hash = crypto.createHash('sha256').update(clean).digest('hex');   // hash trên chữ gốc, giữ tương thích với tài liệu đã lập chỉ mục trước đây

  // Bước 2: tách đoạn trên Markdown
  out.chunks = chunkMarkdown(out.markdown);
  if (!out.chunks.length) { add('block', 'Không tách được đoạn nào từ nội dung tệp.'); return out; }

  const bad = (out.text.match(/\uFFFD/g) || []).length;
  if (bad > 20) add('warn', `Có ${bad} ký tự lỗi mã hóa, nội dung có thể hiển thị sai.`);
  const weird = (clean.match(/[^\p{L}\p{N}\s.,;:()\-–—"“”‘’'\/%&°…\[\]§+=?!_*#@<>|]/gu) || []).length;
  if (weird / clean.length > 0.02) add('warn', `Nhiều ký tự lạ (${(weird / clean.length * 100).toFixed(1)}%), có thể là lỗi OCR.`);
  const split = (out.text.match(/(?:^|\s)\p{L}(?:\s+\p{L}){2,}(?=\s|$)/gu) || []).length;
  if (split > 5) add('warn', `Phát hiện ${split} chỗ chữ bị tách rời (ví dụ "c ứ u"), dấu hiệu lỗi OCR: tìm kiếm có thể kém chính xác.`);
  const dieu = out.chunks.filter(c => /Điều\s*\d/.test(c.heading)).length;
  const heads = (out.markdown.match(/^#{1,6}\s/gm) || []).length;
  if (dieu < 2 && heads >= 2) add('info', 'Không có cấu trúc "Điều"; trích dẫn sẽ dùng tiêu đề của tài liệu.');
  else if (dieu < 2) add('info', 'Không thấy tiêu đề hay cấu trúc "Điều" rõ ràng, văn bản sẽ được cắt theo độ dài đoạn và trích dẫn sẽ không có tên mục.');
  return out;
}

// ---------- Embedding (Voyage) có giữ nhịp theo hạn mức ----------
// Gói Voyage chưa thanh toán chỉ cho 3 yêu cầu/phút và 10.000 token/phút. Sau khi thêm thẻ, đặt EMBED_RPM và EMBED_TPM
// theo hạn mức ghi trên trang Voyage của bạn để chạy nhanh hơn. Giá trị đọc lại mỗi lần gọi (tiện cho test).
const lim = () => ({
  rpm: Number(process.env.EMBED_RPM) > 0 ? Number(process.env.EMBED_RPM) : 3,
  tpm: Number(process.env.EMBED_TPM) > 0 ? Number(process.env.EMBED_TPM) : 10000,
  windowMs: Number(process.env.EMBED_WINDOW_MS) > 0 ? Number(process.env.EMBED_WINDOW_MS) : 60000
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let charsPerToken = 2.5;                                     // học dần từ số token Voyage báo về
const estTokens = t => Math.ceil(String(t).length / (charsPerToken * 0.85)) + 4;   // ước lượng thận trọng thêm ~15%

// Phần hạn mức chừa lại cho câu hỏi của người dùng, để lập chỉ mục nền không chặn chatbot
const reserveFor = L => ({ rpm: L.rpm >= 3 ? 1 : 0, tokens: Math.min(600, Math.floor(L.tpm * 0.05)) });
function batchTokens() {                                    // trần token cho MỘT yêu cầu lập chỉ mục
  const L = lim(), R = reserveFor(L);
  return Math.max(300, Math.min(Math.floor((L.tpm - R.tokens) / Math.max(1, L.rpm - R.rpm)), 30000));
}
function fitBatch(texts) {                                  // số văn bản ở đầu danh sách vừa trong một yêu cầu
  const cap = batchTokens(); let used = 0, n = 0;
  for (const t of texts) { const e = estTokens(t); if (n && (used + e > cap || n >= 128)) break; used += e; n++; }
  return n;
}
function estMinutes(tokens) {                               // thời gian lập chỉ mục ước tính (phút)
  const L = lim(), R = reserveFor(L);
  const perMin = Math.max(1, Math.min(L.tpm - R.tokens, (L.rpm - R.rpm) * batchTokens()));
  return Math.max(1, Math.ceil(tokens / perMin));
}

const win = [];                                             // các yêu cầu trong cửa sổ 60 giây gần nhất: { t, tokens }
function takeSlot(tokens, reserve) {
  const L = lim(), now = Date.now();
  while (win.length && now - win[0].t >= L.windowMs) win.shift();
  const used = win.reduce((a, e) => a + e.tokens, 0);
  if (!win.length || (win.length + 1 + reserve.rpm <= L.rpm && used + tokens + reserve.tokens <= L.tpm)) {
    const e = { t: now, tokens }; win.push(e); return { e };
  }
  return { wait: win[0].t + L.windowMs - now + 250 };
}

// type 'document': lập chỉ mục (chờ bao lâu cũng được, thử lại khi 429). type 'query': câu hỏi người dùng (chờ tối đa ~25 giây).
async function embed(texts, type) {
  if (!process.env.VOYAGE_API_KEY) throw new Error('Chưa cấu hình VOYAGE_API_KEY.');
  const isDoc = type === 'document', L = lim();
  const reserve = isDoc ? reserveFor(L) : { rpm: 0, tokens: 0 }, maxWait = isDoc ? Infinity : 25000, tries = isDoc ? 6 : 2;
  const out = [];
  for (let i = 0; i < texts.length;) {
    const part = texts.slice(i, i + (isDoc ? fitBatch(texts.slice(i, i + 128)) : texts.length));
    const est = part.reduce((a, t) => a + estTokens(t), 0), chars = part.reduce((a, t) => a + t.length, 0);
    const body = JSON.stringify({ input: part, model: process.env.EMBED_MODEL || 'voyage-3.5', input_type: type, output_dimension: 1024 });
    let res, entry, waited = 0;
    for (let attempt = 0; attempt < tries; attempt++) {
      for (;;) {                                            // đợi tới khi còn chỗ trong hạn mức
        const s = takeSlot(est, reserve);
        if (s.e) { entry = s.e; break; }
        if (waited + s.wait > maxWait) throw Object.assign(new Error('Hệ thống đang bận tạo embedding, vui lòng thử lại sau ít phút.'), { busy: true });
        waited += s.wait; await sleep(s.wait);
      }
      try { res = await fetch(VOYAGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.VOYAGE_API_KEY }, body }); }
      catch (e) { throw new Error('Không kết nối được tới Voyage (' + ((e.cause && (e.cause.code || e.cause.message)) || e.message) + ').'); }
      if (res.status !== 429 && res.status < 500) break;
      if (attempt < tries - 1) { const ra = Number(res.headers.get('retry-after')); await sleep(ra > 0 ? ra * 1000 : isDoc ? 20000 : 3000 * (attempt + 1)); }
    }
    if (!res.ok) throw Object.assign(new Error('Embedding lỗi ' + res.status + ': ' + (await res.text()).slice(0, 200)), { status: res.status });
    const j = await res.json();
    if (j.usage && j.usage.total_tokens > 0) { entry.tokens = j.usage.total_tokens; charsPerToken = 0.7 * charsPerToken + 0.3 * (chars / j.usage.total_tokens); }
    j.data.forEach(d => out.push(d.embedding));
    i += part.length;
  }
  return out;
}

const resetLimiter = () => { win.length = 0; };   // dùng trong test
module.exports = { analyze, embed, fitBatch, estTokens, estMinutes, batchTokens, resetLimiter };
