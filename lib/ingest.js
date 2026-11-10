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

async function embed(texts, type) {
  if (!process.env.VOYAGE_API_KEY) throw new Error('Chưa cấu hình VOYAGE_API_KEY.');
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const body = JSON.stringify({ input: texts.slice(i, i + 32), model: process.env.EMBED_MODEL || 'voyage-3.5', input_type: type, output_dimension: 1024 });
    let res;
    for (let t = 0; t < 4; t++) {   // thử lại khi bị giới hạn tốc độ hoặc lỗi tạm thời
      res = await fetch(VOYAGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.VOYAGE_API_KEY }, body });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise(r => setTimeout(r, 2000 * 2 ** t));
    }
    if (!res.ok) throw new Error('Embedding lỗi ' + res.status + ': ' + (await res.text()).slice(0, 200));
    (await res.json()).data.forEach(d => out.push(d.embedding));
  }
  return out;
}

module.exports = { analyze, embed };
