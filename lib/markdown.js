// BƯỚC 1 của pipeline: đọc tệp tải lên.
// Hệ thống KHÔNG chuyển đổi định dạng. Chỉ nhận Markdown (.md, .markdown) và văn bản thuần (.txt),
// nội dung được dùng nguyên văn. Tệp khác (PDF, Word, HTML...) bị từ chối kèm hướng dẫn chuyển sang .md hoặc .txt.
// Trả về { type, pages, text, markdown, notes } hoặc { error }.
const ALLOWED = ['.md', '.markdown', '.txt'];
const HINT = 'Hệ thống chỉ nhận tệp Markdown (.md) hoặc văn bản (.txt). Hãy chuyển tệp sang một trong hai định dạng này rồi tải lên lại.';

const extOf = name => (String(name || '').match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();

function readTextFile(buf, filename = '') {
  const ext = extOf(filename);
  if (!ALLOWED.includes(ext))
    return { error: (ext ? `Tệp ${ext} chưa được hỗ trợ. ` : 'Tệp không có đuôi định dạng (.md hoặc .txt). ') + HINT };
  if (buf.subarray(0, 4000).includes(0))
    return { error: `Không đọc được nội dung ${ext}: tệp không phải văn bản thuần hoặc không lưu bằng mã hóa UTF-8. Hãy lưu lại thành .txt hoặc .md với mã hóa UTF-8.` };
  const text = buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  return { type: ext === '.txt' ? 'text' : 'markdown', pages: null, text, markdown: text, notes: [] };
}

module.exports = { readTextFile, ALLOWED, HINT };
