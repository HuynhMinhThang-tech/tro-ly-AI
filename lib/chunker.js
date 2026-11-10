// BƯỚC 2 của pipeline: Markdown → các đoạn (chunk) để tạo embedding.
// Nguyên tắc:
//   1. Mỗi mục (Điều / Heading) là một đơn vị riêng, không bao giờ gộp hai Điều vào một đoạn.
//   2. Nhãn (heading) là đường dẫn tiêu đề: "Chương I – QUY ĐỊNH CHUNG › Điều 2. Giải thích từ ngữ".
//   3. Mục dài được tách ở ranh giới đoạn văn (Khoản/điểm), không cắt giữa câu. Bảng được giữ nguyên, bảng quá dài
//      thì tách theo hàng và lặp lại hàng tiêu đề.
//   4. Chỉ khi một đoạn văn đơn lẻ vượt MAX mới tách theo câu (có gối đầu), cuối cùng mới cắt cứng.
const MAX = Number(process.env.CHUNK_MAX_CHARS) > 0 ? Number(process.env.CHUNK_MAX_CHARS) : 1800;
const OVERLAP = 150;      // gối đầu khi phải tách một đoạn văn quá dài
const MIN_TAIL = 250;     // mẩu cuối ngắn hơn mức này sẽ được gộp ngược vào mẩu trước

function parseSections(md) {
  const sections = [{ level: 0, title: '', stack: [], body: [] }];
  let cur = sections[0], stack = [], fence = false;
  for (const line of md.replace(/\r/g, '').split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) { cur.body.push(line); continue; }
    const level = m[1].length, title = m[2].trim();
    stack = stack.filter(s => s.level < level).concat({ level, title });
    cur = { level, title, stack, body: [] };
    sections.push(cur);
  }
  return sections;
}

// Tiêu đề cấp 1 là tên văn bản, không lặp lại trong nhãn của từng đoạn (trừ khi chỉ có cấp 1)
function labelOf(sec) {
  if (!sec.stack.length) return 'Phần mở đầu';
  const deep = sec.stack.filter(s => s.level > 1);
  const label = (deep.length ? deep : sec.stack).map(s => s.title).join(' › ');
  return label.length > 240 ? '…' + label.slice(-239) : label;
}

const tailOf = t => t.length <= OVERLAP ? '' : t.slice(-OVERLAP).replace(/^\S*\s+/, '');

function splitTable(block, max) {
  const rows = block.split('\n'), hasSep = /^\s*\|?\s*:?-{2,}/.test(rows[1] || '');
  const head = hasSep ? rows.slice(0, 2).join('\n') : '', body = hasSep ? rows.slice(2) : rows;
  const out = []; let cur = head;
  for (const r of body) {
    if (cur && cur !== head && cur.length + 1 + r.length > max) { out.push(cur); cur = head; }
    cur = cur ? cur + '\n' + r : r;
  }
  if (cur && cur !== head) out.push(cur);
  return out;
}

function splitLong(block, max) {
  if (block.split('\n').every(l => /^\s*\|/.test(l))) return splitTable(block, max);
  const out = []; let cur = '';
  for (let s of block.split(/(?<=[.;:!?])\s+(?=\S)/u)) {
    while (s.length > max) {                              // một câu dài hơn MAX: cắt cứng, có gối đầu
      if (cur) { out.push(cur); cur = ''; }
      out.push(s.slice(0, max)); s = s.slice(max - OVERLAP);
    }
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      const tail = tailOf(cur);
      cur = tail && tail.length + 1 + s.length <= max ? tail + ' ' + s : s;
    } else cur = cur ? cur + ' ' + s : s;
  }
  if (cur) out.push(cur);
  return out;
}

function splitBody(body, max) {
  const pieces = []; let cur = '';
  const push = () => { if (cur) { pieces.push(cur); cur = ''; } };
  for (const b of body.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean)) {
    if (b.length > max) { push(); pieces.push(...splitLong(b, max)); continue; }
    if (cur && cur.length + 2 + b.length > max) push();
    cur = cur ? cur + '\n\n' + b : b;
  }
  push();
  if (pieces.length > 1) {                                // không để lại mẩu cuối quá ngắn
    const last = pieces[pieces.length - 1], prev = pieces[pieces.length - 2];
    if (last.length < MIN_TAIL && prev.length + 2 + last.length <= max * 1.25) pieces.splice(-2, 2, prev + '\n\n' + last);
  }
  return pieces;
}

// → [{ heading, content }]  (cùng dạng với chunkText cũ nên server.js, embed() và truy vấn giữ nguyên)
function chunkMarkdown(md, { max = MAX } = {}) {
  const secs = parseSections(md), out = [];
  secs.forEach((sec, i) => {
    const label = labelOf(sec), body = sec.body.join('\n').trim();
    if (!body) {                                          // mục chỉ có tiêu đề: bỏ nếu là nhóm có mục con, giữ nếu là mục lá
      const next = secs[i + 1];
      if (sec.title && (!next || next.level <= sec.level) && sec.title.length >= 12) out.push({ heading: label, content: sec.title });
      return;
    }
    const pieces = splitBody(body, max);
    pieces.forEach((p, k) => {
      if (p.trim().length >= 15) out.push({ heading: pieces.length > 1 ? `${label} (phần ${k + 1}/${pieces.length})` : label, content: p });
    });
  });
  return out;
}

module.exports = { chunkMarkdown, parseSections };
