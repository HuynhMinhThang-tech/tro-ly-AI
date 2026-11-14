// Đọc dữ liệu người dùng tải lên (CSV / Excel) và tạo tệp mẫu để họ điền.
const path = require('path');
const Papa = require('papaparse');
const ExcelJS = require('exceljs');
const { fold } = require('./vn');

const MAX_ROWS = +process.env.MAX_FORM_ROWS || 50;

function decodeText(buf) {
  let b = buf; if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1258').decode(b); }   // CSV lưu từ Excel đời cũ ở máy tiếng Việt
}
// Giá trị ô Excel → chuỗi / số / Date thuần
function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return '';
    return String(v);
  }
  return v;
}
const toStr = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim();

/** Đọc tệp .csv / .xlsx → { headers: [..], rows: [[..]] } (giá trị đã đổi sang chuỗi; ngày Excel → yyyy-mm-dd). */
async function readTable(buf, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  let grid;
  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch { throw new Error('Không đọc được tệp Excel. Hãy dùng tệp .xlsx (không phải .xls cũ) hoặc lưu lại dưới dạng CSV.'); }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Tệp Excel không có trang tính nào.');
    grid = []; ws.eachRow({ includeEmpty: false }, row => { const a = []; for (let c = 1; c <= ws.columnCount; c++) a.push(cellValue(row.getCell(c).value)); grid.push(a); });
  } else if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    const res = Papa.parse(decodeText(buf), { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
    grid = res.data;
  } else throw new Error('Chỉ nhận tệp Excel (.xlsx) hoặc CSV (.csv).');
  grid = grid.map(r => r.map(toStr)).filter(r => r.some(Boolean));
  if (grid.length < 2) throw new Error('Tệp cần có dòng tiêu đề và ít nhất một dòng dữ liệu.');
  const headers = grid[0].map(h => h.replace(/\s+/g, ' ').trim()), rows = grid.slice(1);
  if (rows.length > MAX_ROWS) throw new Error(`Tệp có ${rows.length} dòng, vượt giới hạn ${MAX_ROWS} dòng mỗi lần. Hãy tách nhỏ tệp.`);
  return { headers, rows: rows.map(r => headers.map((_, i) => r[i] ?? '')) };
}

const norm = s => fold(s).replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
/** Ghép tiêu đề cột với trường theo tên hiển thị hoặc mã trường (không phân biệt hoa thường/dấu). Trả về { chỉ số cột: mã trường | null }. */
function autoMap(headers, fields) {
  const out = {}, taken = new Set();
  const names = f => [norm(f.label), norm(f.key.replace(/_/g, ' '))].filter(Boolean);
  headers.forEach((h, i) => {
    const n = norm(h); out[i] = null;
    if (!n) return;
    const hit = fields.find(f => !taken.has(f.key) && names(f).includes(n));
    if (hit) { out[i] = hit.key; taken.add(hit.key); }
  });
  headers.forEach((h, i) => {   // lượt 2: tiêu đề chứa tên trường (hoặc ngược lại), chỉ nhận khi khớp duy nhất
    if (out[i]) return;
    const n = norm(h); if (n.length < 4) return;
    const c = fields.filter(f => !taken.has(f.key) && names(f).some(x => x.length >= 4 && (n.includes(x) || x.includes(n))));
    if (c.length === 1) { out[i] = c[0].key; taken.add(c[0].key); }
  });
  return out;
}

const REQ = { fgColor: { argb: 'FFFDE9E7' } };
/** Tệp Excel mẫu: trang "Du lieu" (tiêu đề + 1 dòng ví dụ) và trang "Huong dan". */
async function sampleXlsx(fields) {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Du lieu', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = fields.map(f => ({ header: f.label, key: f.key, width: Math.max(18, Math.min(40, f.label.length + 6)),
    style: ['text', 'tax_code', 'id_card'].includes(f.type) ? { numFmt: '@' } : {} }));
  const head = ws.getRow(1); head.font = { bold: true }; head.alignment = { vertical: 'middle', wrapText: true }; head.height = 30;
  head.eachCell((c, i) => { c.fill = { type: 'pattern', pattern: 'solid', ...(fields[i - 1].required ? REQ : { fgColor: { argb: 'FFE8EEF7' } }) }; c.border = { bottom: { style: 'thin' } }; });
  ws.addRow(Object.fromEntries(fields.map(f => [f.key, f.example ?? ''])));
  const g = wb.addWorksheet('Huong dan');
  g.columns = [{ header: 'Tên cột', width: 38 }, { header: 'Kiểu dữ liệu', width: 30 }, { header: 'Bắt buộc', width: 12 }, { header: 'Ví dụ', width: 40 }];
  g.getRow(1).font = { bold: true };
  const { TYPES } = require('./forms');
  fields.forEach(f => g.addRow([f.label, TYPES[f.type] || f.type, f.required ? 'Có' : 'Không', String(f.example ?? '')]));
  g.addRow([]); g.addRow(['Điền dữ liệu ở trang "Du lieu" (mỗi dòng = một bộ hồ sơ). Dòng ví dụ có thể xóa hoặc ghi đè.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** CSV mẫu: dấu chấm phẩy (Excel tiếng Việt mở đúng cột), mã hóa UTF-8 có BOM (để không lỗi dấu). */
function sampleCsv(fields) {
  return Buffer.from('\uFEFF' + Papa.unparse([fields.map(f => f.label), fields.map(f => f.example ?? '')], { delimiter: ';', newline: '\r\n' }), 'utf8');
}

module.exports = { readTable, autoMap, sampleXlsx, sampleCsv, MAX_ROWS, norm };
