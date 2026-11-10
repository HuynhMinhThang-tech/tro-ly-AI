// BƯỚC 1 của pipeline: tệp tải lên → Markdown.
//   PDF  → pdf-parse (lấy chữ) → nhận diện cấu trúc pháp lý (Chương/Mục/Điều), nối dòng bị ngắt cứng
//   DOCX → mammoth (HTML, giữ Heading/bảng/danh sách) → turndown (Markdown)
//   HTML → turndown
//   MD   → giữ nguyên (chỉ chuẩn hóa tiêu đề Chương/Mục/Điều)
//   TXT  → như PDF
// Mọi nhánh đều trả về cùng một dạng: { type, pages, text, markdown, notes, error }.
// Muốn thêm OCR cho PDF scan sau này: chỉ cần thay phần lấy chữ trong pdfToMarkdown(), phần sau không đổi.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const mammoth = require('mammoth');
const TurndownService = require('turndown');

// ---------- Nhận diện cấu trúc văn bản pháp luật (chịu lỗi OCR: "Chưong", "Điêu", "Điều 2 1 .") ----------
const RE = {
  chuong: /^(?:Ch[uư]+[oơ]ng|CH[UƯ]+[OƠ]NG)\s*([IVXLC]{1,6}|\d{1,2})(?![\p{L}\d])\s*[.:\-–—]?\s*(.*)$/u,
  muc: /^(?:Mục|MỤC)\s+(\d{1,2}|[IVXLC]{1,5})(?![\p{L}\d])\s*[.:\-–—]?\s*(.*)$/u,
  dieu: /^[ĐD]i[eêềéếể]u\s*(\d[\d\s]{0,3}?)\s*[.:]\s*(.*)$/u,
  docType: /^(LUẬT|BỘ LUẬT|NGHỊ ĐỊNH|NGHỊ QUYẾT|THÔNG TƯ|THÔNG TƯ LIÊN TỊCH|QUYẾT ĐỊNH|PHÁP LỆNH|CHỈ THỊ|QUY CHẾ|NỘI QUY)$/u,
  listStart: /^(\d{1,2}[.)]\s|[a-zđ]\)\s|[-+•●–]\s)/u,
};
const LEVEL = { chuong: 2, muc: 3, dieu: 4 };

// Trả về { kind, level, text } nếu dòng là tiêu đề Chương/Mục/Điều; text đã chuẩn hóa chính tả
function structureOf(raw) {
  const line = String(raw).replace(/^\s*#{1,6}\s*/, '').replace(/^\s*(\*\*|__)(.+?)\1\s*$/u, '$2').replace(/\\([.\-])/g, '$1').trim();
  let m;
  if ((m = line.match(RE.dieu))) {
    const rest = m[2].trim();
    if (rest.length > 220) return null;                 // đoạn văn dài bắt đầu bằng "Điều N." → không phải tiêu đề
    return { kind: 'dieu', level: LEVEL.dieu, text: `Điều ${m[1].replace(/\s+/g, '')}.` + (rest ? ' ' + rest : ''), title: rest };
  }
  if ((m = line.match(RE.chuong))) {
    let rest = m[2].trim(); if (rest.length <= 3) rest = '';   // rác OCR như "in"
    return { kind: 'chuong', level: LEVEL.chuong, text: `Chương ${m[1]}` + (rest ? ' – ' + rest : ''), title: rest };
  }
  if ((m = line.match(RE.muc))) {
    const rest = m[2].trim();
    return { kind: 'muc', level: LEVEL.muc, text: `Mục ${m[1]}` + (rest ? '. ' + rest : ''), title: rest };
  }
  return null;
}

const upperRatio = s => {
  const letters = s.match(/\p{L}/gu) || [];
  return letters.length ? letters.filter(c => c !== c.toLowerCase()).length / letters.length : 0;
};
const heading = (level, text) => '#'.repeat(level) + ' ' + text.replace(/\s+/g, ' ').trim();

// ---------- Văn bản thuần (PDF/TXT) → Markdown ----------
function cleanPlain(raw) {
  return String(raw).replace(/^\uFEFF/, '').replace(/\r/g, '').replace(/\f/g, '\n').replace(/\u00A0/g, ' ')
    .split('\n')
    .filter(l => !/^\s*\d{1,3}\s*$/.test(l) && !/^\s*E-pas/i.test(l))   // số trang, dấu cuối trang của bản scan
    .map(l => l.replace(/\s+$/, ''))
    .join('\n');
}

function textToMarkdown(raw) {
  const lines = cleanPlain(raw).split('\n');
  const lens = lines.map(l => l.trim().length).filter(Boolean).sort((a, b) => a - b);
  const W = lens[Math.floor(lens.length * 0.9)] || 80;           // độ rộng dòng thường gặp của bản ngắt cứng
  const out = [], used = new Set();
  let para = [];
  const flush = () => { if (para.length) { out.push(para.join(' ').replace(/\s+/g, ' ').trim()); para = []; } };
  const t = i => (lines[i] || '').trim();
  const isStruct = i => !!structureOf(t(i));

  // Tiêu đề văn bản: dòng "LUẬT"/"NGHỊ ĐỊNH"... đứng riêng + tối đa 2 dòng chữ in hoa kế tiếp
  const first = lines.slice(0, 40).findIndex(l => RE.docType.test(l.trim()));
  if (first >= 0) {
    let title = t(first); used.add(first);
    for (let j = first + 1; j <= first + 2 && t(j) && !isStruct(j) && t(j).length <= 150 && upperRatio(t(j)) >= 0.5; j++) { title += ' ' + t(j); used.add(j); }
    out.push(heading(1, title));
  }

  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const l = t(i);
    if (!l) {
      if (para.length) {                               // dòng trống do sang trang giữa câu: câu chưa kết thúc, dòng sau viết thường → nối tiếp
        let j = i + 1; while (j < lines.length && !t(j)) j++;
        const nx = t(j);
        if (nx && !/[.;:!?]$/.test(para[para.length - 1]) && /^\p{Ll}/u.test(nx) && !isStruct(j) && !RE.listStart.test(nx)) continue;
      }
      flush(); continue;
    }
    const st = structureOf(l);
    if (st) {
      flush();
      let text = st.text, title = st.title, j = i + 1;
      if (st.kind === 'dieu') {            // tiêu đề Điều bị ngắt dòng: nối các dòng bắt đầu bằng chữ thường
        for (let n = 0; n < 3 && t(j) && !isStruct(j) && !RE.listStart.test(t(j)) && /^\p{Ll}/u.test(t(j)) && (text.length + t(j).length) < 320; n++, j++) text += ' ' + t(j);
      } else {                             // tiêu đề Chương/Mục nằm ở 1-3 dòng in hoa kế tiếp
        for (let n = 0; n < 3 && t(j) && !isStruct(j) && !RE.listStart.test(t(j)) && t(j).length <= 110 && (n === 0 || upperRatio(t(j)) >= 0.4); n++, j++) {
          text += (title || n ? ' ' : ' – ') + t(j); title = title || t(j);
        }
      }
      out.push(heading(st.level, text));
      i = j - 1;
      continue;
    }
    if (RE.listStart.test(l)) flush();                 // Khoản "1." / điểm "a)" luôn mở đoạn mới
    else if (para.length) {
      const prev = para[para.length - 1];              // bản ngắt cứng: dòng ngắn hơn hẳn bình thường (hoặc ngắn + kết thúc câu) là dòng cuối đoạn
      const ended = prev.length < W * 0.6 || (/[.;:!?]$/.test(prev) && prev.length < W * 0.75);
      if (ended && /^\p{Lu}/u.test(l)) flush();
    }
    para.push(l);
  }
  flush();
  return out.join('\n\n') + '\n';
}

// ---------- Markdown có sẵn (DOCX/HTML/MD) → chuẩn hóa tiêu đề Chương/Mục/Điều ----------
// Nhiều tệp Word không dùng style Heading mà gõ thẳng "Điều 1. ..." (hoặc in đậm). Ép về đúng cấp tiêu đề để chunker dùng được.
function promoteLegalHeadings(md) {
  const lines = md.replace(/\r/g, '').split('\n'), out = [];
  if (!/^# \S/m.test(md)) {                           // chưa có tên văn bản: "QUY CHẾ" + dòng in hoa kế tiếp → tiêu đề cấp 1
    const bare = l => (l || '').trim().replace(/^(\*\*|__)(.+?)\1$/u, '$2').trim();
    const k = lines.slice(0, 40).findIndex(l => RE.docType.test(bare(l)));
    if (k >= 0) {
      let title = bare(lines[k]); lines[k] = '';
      for (let j = k + 1, n = 0; j < lines.length && n < 2; j++) {
        if (!lines[j].trim()) continue;
        const b = bare(lines[j]);
        if (/^[#|]/.test(b) || structureOf(b) || b.length > 150 || upperRatio(b) < 0.5) break;
        title += ' ' + b; lines[j] = ''; n++;
      }
      lines[k] = heading(1, title);
    }
  }
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || /^\s*\|/.test(line) || !line.trim()) { out.push(line); continue; }
    const standalone = /^#{1,6}\s/.test(line) || ((i === 0 || !lines[i - 1].trim()) && (i === lines.length - 1 || !lines[i + 1].trim()));
    const st = standalone && structureOf(line);
    if (!st) { out.push(line); continue; }
    let text = st.text;
    if (st.kind !== 'dieu' && !st.title) {             // "Chương I" rồi tiêu đề ở đoạn sau
      let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
      const nxt = (lines[j] || '').trim();
      if (nxt && !/^[#|]/.test(nxt) && !structureOf(nxt) && nxt.length <= 110 && upperRatio(nxt) >= 0.5) { text += ' – ' + nxt.replace(/^(\*\*|__)(.+)\1$/u, '$2'); i = j; }
    }
    out.push(heading(st.level, text));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ---------- HTML → Markdown ----------
function makeTurndown() {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', hr: '---' });
  td.escape = s => s;                                   // không thêm "\" vào "1." hay "*": nội dung đi thẳng vào embedding
  td.remove(['script', 'style', 'noscript', 'head']);
  td.addRule('img', { filter: 'img', replacement: () => '' });   // chỉ lấy chữ, không nhúng ảnh base64 vào văn bản
  td.addRule('table', {
    filter: 'table',
    replacement(_, node) {                              // Bảng → bảng GFM (hàng đầu là tiêu đề), giữ nguyên số cột
      const rows = Array.from(node.querySelectorAll('tr')).map(tr => {
        const cells = [];
        for (const c of Array.from(tr.children)) {
          cells.push(c.textContent.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
          for (let k = 1; k < (parseInt(c.getAttribute('colspan'), 10) || 1); k++) cells.push('');
        }
        return cells;
      }).filter(r => r.length);
      if (!rows.length) return '';
      const n = Math.max(...rows.map(r => r.length)), line = r => '| ' + r.concat(Array(n - r.length).fill('')).join(' | ') + ' |';
      return '\n\n' + [line(rows[0]), '| ' + Array(n).fill('---').join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n') + '\n\n';
    }
  });
  return td;
}
const htmlToMarkdown = html => makeTurndown().turndown(html).replace(/\n{3,}/g, '\n\n').trim() + '\n';

// ---------- Từng loại tệp ----------
async function pdfToMarkdown(buf) {
  const d = await pdfParse(buf);                        // ném lỗi nếu hỏng / có mật khẩu → analyze() báo "block"
  const text = d.text || '';
  return { type: 'pdf', pages: d.numpages, text, markdown: textToMarkdown(text), notes: [] };
}

async function docxToMarkdown(buf) {
  let images = 0;
  const res = await mammoth.convertToHtml({ buffer: buf }, {
    styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Tiêu đề'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
    convertImage: mammoth.images.imgElement(async () => { images++; return { src: '' }; })
  });
  const text = (await mammoth.extractRawText({ buffer: buf })).value || '';
  const notes = [];
  if (images) notes.push(`Tệp Word có ${images} hình ảnh. Hệ thống chỉ lấy chữ, nội dung nằm trong ảnh sẽ không tìm kiếm được.`);
  return { type: 'docx', pages: null, text, markdown: promoteLegalHeadings(htmlToMarkdown(res.value)), notes };
}

// Nhận diện theo nội dung (byte đầu), không tin đuôi tệp. Trả về { error } nếu không đọc được.
async function toMarkdown(buf, filename = '') {
  const head = buf.subarray(0, 8);
  try {
    if (head.subarray(0, 5).toString() === '%PDF-') return await pdfToMarkdown(buf);
    if (head[0] === 0x50 && head[1] === 0x4b) return await docxToMarkdown(buf);   // ZIP → DOCX
    if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0)
      return { error: 'Định dạng Word cũ (.doc) chưa được hỗ trợ. Hãy mở bằng Word và lưu lại thành .docx.' };
    if (head.subarray(0, 5).toString() === '{\\rtf') return { error: 'Định dạng RTF chưa được hỗ trợ. Hãy lưu lại thành .docx hoặc .txt.' };
  } catch (e) {
    const kind = head[0] === 0x50 ? 'DOCX (tệp hỏng, hoặc là Excel/PowerPoint, hiện chỉ hỗ trợ Word)' : 'PDF (tệp hỏng hoặc có đặt mật khẩu)';
    return { error: 'Không đọc được ' + kind + '.' };
  }
  if (buf.subarray(0, 4000).includes(0)) return { error: 'Tệp không phải văn bản, PDF hoặc DOCX hợp lệ.' };

  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const sample = text.slice(0, 4000).trimStart().toLowerCase();
  if (/^(<!doctype html|<html|<body|<div|<p[\s>])/.test(sample) || /\.html?$/i.test(filename))
    return { type: 'html', pages: null, text, markdown: promoteLegalHeadings(htmlToMarkdown(text)), notes: [] };
  if ((text.match(/^#{1,6}\s+\S/gm) || []).length >= 2)
    return { type: 'markdown', pages: null, text, markdown: promoteLegalHeadings(text), notes: [] };
  return { type: 'text', pages: null, text, markdown: textToMarkdown(text), notes: [] };
}

module.exports = { toMarkdown, textToMarkdown, promoteLegalHeadings, htmlToMarkdown, structureOf };
