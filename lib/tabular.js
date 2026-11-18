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
// Ô Excel định dạng phần trăm (0%) lưu giá trị 1 cho "100%". Định dạng kiểu General"%" (do tệp mẫu của hệ thống dùng) lưu đúng 100 nên không quy đổi.
const isPercentFmt = f => /%/.test(String(f || '').replace(/"[^"]*"|\\./g, ''));
const pct = v => String(Number((v * 100).toFixed(6)));

/**
 * Đọc tệp .csv / .xlsx → { headers: [..], rows: [[..]], bands } (giá trị đã đổi sang chuỗi; ngày Excel → yyyy-mm-dd).
 * opts.titles: tên các khối của biểu mẫu. Nếu hàng đầu tiên chỉ gồm những tên khối đó (tệp mẫu nhiều khối có hàng tên khối phía trên hàng tiêu đề)
 * thì hàng ấy được bỏ đi và trả về bands[i] = tên khối của cột i (ô trống tính cùng khối với ô có chữ bên trái). Không có thì bands = null.
 */
async function readTable(buf, filename, opts = {}) {
  const ext = path.extname(filename || '').toLowerCase();
  let grid;
  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf); } catch { throw new Error('Không đọc được tệp Excel. Hãy dùng tệp .xlsx (không phải .xls cũ) hoặc lưu lại dưới dạng CSV.'); }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('Tệp Excel không có trang tính nào.');
    grid = []; ws.eachRow({ includeEmpty: false }, row => {
      const a = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c), v = cellValue(cell.value);
        a.push(typeof v === 'number' && isPercentFmt(cell.numFmt) ? pct(v) : v);
      }
      grid.push(a);
    });
  } else if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    const res = Papa.parse(decodeText(buf), { skipEmptyLines: 'greedy', delimitersToGuess: [',', ';', '\t', '|'] });
    grid = res.data;
  } else throw new Error('Chỉ nhận tệp Excel (.xlsx) hoặc CSV (.csv).');
  grid = grid.map(r => r.map(toStr)).filter(r => r.some(Boolean));
  let bands = null;
  const titles = new Set((opts.titles || []).map(t => norm(t)).filter(Boolean));
  if (titles.size && grid.length) {
    const first = grid[0], filled = first.filter(Boolean);
    if (filled.length && filled.every(c => titles.has(norm(c)))) {
      let cur = ''; bands = first.map(c => { if (c) cur = c.replace(/\s+/g, ' ').trim(); return cur; });
      grid = grid.slice(1);
    }
  }
  if (grid.length < 2) throw new Error('Tệp cần có dòng tiêu đề và ít nhất một dòng dữ liệu.');
  const headers = grid[0].map(h => h.replace(/\s+/g, ' ').trim()), rows = grid.slice(1);
  if (rows.length > MAX_ROWS) throw new Error(`Tệp có ${rows.length} dòng, vượt giới hạn ${MAX_ROWS} dòng mỗi lần. Hãy tách nhỏ tệp.`);
  return { headers, rows: rows.map(r => headers.map((_, i) => r[i] ?? '')), bands: bands && headers.map((_, i) => bands[i] || '') };
}

const norm = s => fold(s).replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Ghép tiêu đề cột với trường theo tên hiển thị hoặc mã trường (không phân biệt hoa thường/dấu). Trả về { chỉ số cột: mã trường | null }.
 * bands (nếu có): tên khối của từng cột. Cột nằm dưới khối "Thành viên 2" chỉ ghép với trường thuộc khối đó, nên hai cột cùng tên "Chức vụ"
 * của hai khối không bị lẫn nhau kể cả khi người dùng đổi thứ tự cột.
 */
function autoMap(headers, fields, bands) {
  const out = {}, taken = new Set();
  const names = f => [norm(f.label), norm(f.key.replace(/_/g, ' '))].filter(Boolean);
  headers.forEach((_, i) => { out[i] = null; });
  if (bands) {
    const blockOf = new Map();
    blocksOf(fields).forEach(b => b.fields.forEach(f => blockOf.set(f.key, norm(b.title))));
    headers.forEach((h, i) => {
      const n = norm(h), bn = norm(bands[i] || ''); if (!n || !bn) return;
      const hit = fields.find(f => !taken.has(f.key) && blockOf.get(f.key) === bn && names(f).includes(n));
      if (hit) { out[i] = hit.key; taken.add(hit.key); }
    });
  }
  headers.forEach((h, i) => {
    if (out[i]) return;
    const n = norm(h);
    if (!n) return;
    const hit = fields.find(f => !taken.has(f.key) && names(f).includes(n));
    if (hit) { out[i] = hit.key; taken.add(hit.key); }
  });
  headers.forEach((h, i) => {   // lượt cuối: tiêu đề chứa tên trường (hoặc ngược lại), chỉ nhận khi khớp duy nhất
    if (out[i]) return;
    const n = norm(h); if (n.length < 4) return;
    const c = fields.filter(f => !taken.has(f.key) && names(f).some(x => x.length >= 4 && (n.includes(x) || x.includes(n))));
    if (c.length === 1) { out[i] = c[0].key; taken.add(c[0].key); }
  });
  return out;
}

const REQ = { fgColor: { argb: 'FFFDE9E7' } };
const { TYPES, normalizeValue, defaultText, blocksOf } = require('./forms');
const colName = n => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };

/** Định dạng hiển thị và ràng buộc nhập trong Excel theo kiểu trường (Excel tự hiện dấu chấm nghìn / dd/mm/yyyy theo máy người dùng). */
const NUMFMT = { text: '@', tax_code: '@', id_card: '@', money: '#,##0', number: 'General', percent: 'General"%"', date: 'dd/mm/yyyy' };
function validationOf(f, cell) {
  const base = { allowBlank: true, showInputMessage: true, showErrorMessage: true, errorStyle: 'stop', promptTitle: f.label };
  switch (f.type) {
    case 'money': return { ...base, type: 'whole', operator: 'greaterThanOrEqual', formulae: [0], prompt: 'Số tiền (VNĐ), số nguyên. Ví dụ: 25000000000 (Excel tự hiện 25.000.000.000)', errorTitle: 'Số tiền không hợp lệ', error: 'Chỉ nhập số nguyên không âm, không gõ chữ hoặc đơn vị. Ví dụ: 25000000000.' };
    case 'number': return { ...base, type: 'decimal', operator: 'greaterThanOrEqual', formulae: [0], prompt: 'Nhập một số, ví dụ: 5', errorTitle: 'Số không hợp lệ', error: 'Chỉ nhập số, không gõ chữ.' };
    case 'percent': return { ...base, type: 'decimal', operator: 'between', formulae: [0, 100], prompt: 'Phần trăm từ 0 đến 100. Gõ 100 để ra 100%', errorTitle: 'Tỷ lệ không hợp lệ', error: 'Nhập số từ 0 đến 100 (ví dụ 100 nghĩa là 100%).' };
    case 'date': return { ...base, type: 'date', operator: 'greaterThan', formulae: [new Date(Date.UTC(1900, 0, 1))], errorStyle: 'warning', prompt: 'Nhập ngày theo dạng ngày/tháng/năm, ví dụ 28/08/2026', errorTitle: 'Kiểm tra lại ngày', error: 'Ngày nên có dạng 28/08/2026. Vẫn dùng giá trị này?' };
    case 'tax_code': return { ...base, type: 'custom', formulae: [`OR(LEN(${cell})=10,LEN(${cell})=13)`], prompt: 'Mã số thuế gồm 10 hoặc 13 chữ số, không có chữ', errorTitle: 'Mã số thuế chưa đúng', error: 'Mã số thuế gồm 10 hoặc 13 chữ số.' };
    case 'id_card': return { ...base, type: 'custom', formulae: [`OR(LEN(${cell})=9,LEN(${cell})=12)`], prompt: 'CCCD gồm 12 chữ số (CMND cũ 9 chữ số)', errorTitle: 'Số giấy tờ chưa đúng', error: 'CCCD gồm 12 chữ số (CMND cũ 9 chữ số).' };
    default: return null;
  }
}
/** Ví dụ của admin → giá trị đúng kiểu ô Excel (số, ngày thật) để định dạng ô có tác dụng; không hiểu được thì giữ nguyên chữ. */
function exampleCell(f) {
  const r = normalizeValue({ ...f, required: false }, f.example);
  if (r.error || r.value === null) return f.example ?? '';
  if (['money', 'number', 'percent'].includes(f.type)) return r.value;
  if (f.type === 'date') return new Date(Date.UTC(r.value.y, r.value.m - 1, r.value.d));
  return r.value;
}

const BAND_FILL = ['FFD6E6F5', 'FFDDEFD9', 'FFFBEBC8', 'FFEBDDF3'];   // màu nền luân phiên của hàng tên khối
/**
 * Tệp Excel mẫu: trang "Du lieu" (tiêu đề + 1 dòng ví dụ, ô đã định dạng và có ràng buộc nhập) và trang "Huong dan".
 * Biểu mẫu có từ 2 khối trở lên (admin đặt đường ngắt khoảng): thêm một hàng tên khối (gộp ô, mỗi khối một màu) phía trên hàng tiêu đề,
 * và kẻ đường dọc đậm ở đầu mỗi khối, để người điền nhìn ra ngay cột nào thuộc "người 1", cột nào thuộc "người 2".
 */
async function sampleXlsx(fields) {
  const blocks = blocksOf(fields), multi = blocks.length > 1, H = multi ? 2 : 1, first = H + 1;
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Du lieu', { views: [{ state: 'frozen', ySplit: H }] });
  ws.columns = fields.map(f => ({ key: f.key, width: Math.max(18, Math.min(40, f.label.length + 6)), style: { numFmt: NUMFMT[f.type] || '@' } }));
  const head = ws.getRow(H);
  fields.forEach((f, i) => { head.getCell(i + 1).value = f.label; });
  head.font = { bold: true }; head.alignment = { vertical: 'middle', wrapText: true }; head.height = 30;
  head.numFmt = '@';
  head.eachCell((c, i) => { c.fill = { type: 'pattern', pattern: 'solid', ...(fields[i - 1].required ? REQ : { fgColor: { argb: 'FFE8EEF7' } }) }; c.border = { bottom: { style: 'thin' } }; });
  ws.addRow(Object.fromEntries(fields.map(f => [f.key, exampleCell(f)])));
  fields.forEach((f, i) => {   // ràng buộc nhập cho đủ số dòng tối đa của một lần xử lý
    for (let r = first; r <= H + MAX_ROWS; r++) {
      const addr = colName(i + 1) + r, v = validationOf(f, addr);
      if (v) ws.getCell(addr).dataValidation = v;
      if (r > first) ws.getCell(addr).numFmt = NUMFMT[f.type] || '@';
    }
  });
  if (multi) {
    const band = ws.getRow(1); band.height = 24;
    let col = 1;
    blocks.forEach((b, bi) => {
      const s = col, e = col + b.fields.length - 1, c = band.getCell(s);
      c.value = b.title; c.font = { bold: true, size: 12 }; c.alignment = { horizontal: 'center', vertical: 'middle' };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND_FILL[bi % BAND_FILL.length] } };
      if (e > s) ws.mergeCells(1, s, 1, e);
      if (bi > 0) for (let r = 1; r <= H + MAX_ROWS; r++) { const x = ws.getCell(r, s); x.border = { ...(x.border || {}), left: { style: 'medium', color: { argb: 'FF1B4965' } } }; }   // đường ngắt khoảng
      col = e + 1;
    });
  }
  const g = wb.addWorksheet('Huong dan');
  g.columns = [{ header: 'Tên cột', width: 38 }, { header: 'Kiểu dữ liệu', width: 30 }, { header: 'Bắt buộc', width: 12 }, { header: 'Cách nhập', width: 60 }, ...(multi ? [{ header: 'Thuộc khối', width: 28 }] : [])];
  g.getRow(1).font = { bold: true };
  const how = { money: 'Số nguyên, không gõ chữ "đồng". Ví dụ 25000000000, Excel tự hiện 25.000.000.000', number: 'Chỉ nhập số', percent: 'Số từ 0 đến 100 (gõ 100 nghĩa là 100%)', date: 'Ngày/tháng/năm, ví dụ 28/08/2026', tax_code: '10 hoặc 13 chữ số', id_card: '12 chữ số (CMND cũ 9 số)', text: 'Chữ' };
  blocks.forEach(b => b.fields.forEach(f => g.addRow([f.label, TYPES[f.type] || f.type, f.required ? 'Có' : 'Không', how[f.type] || '', ...(multi ? [b.title] : [])])));
  g.addRow([]); g.addRow([multi
    ? 'Điền dữ liệu ở trang "Du lieu" (mỗi dòng là một bộ hồ sơ). Hàng trên cùng ghi tên từng khối (ví dụ từng người); đừng xóa hoặc đổi chỗ hàng này. Dòng ví dụ có thể xóa hoặc ghi đè. Cột có nền hồng là bắt buộc.'
    : 'Điền dữ liệu ở trang "Du lieu" (mỗi dòng là một bộ hồ sơ). Dòng ví dụ có thể xóa hoặc ghi đè. Cột có nền hồng là bắt buộc.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** CSV mẫu: dấu chấm phẩy (Excel tiếng Việt mở đúng cột), UTF-8 có BOM (để không lỗi dấu). Ví dụ hiển thị đúng dạng chuẩn: 25.000.000.000, 28/08/2026. */
function sampleCsv(fields) {
  const ex = f => { const r = normalizeValue({ ...f, required: false }, f.example); return r.error || r.value === null ? (f.example ?? '') : defaultText(f, r.value); };
  return Buffer.from('\uFEFF' + Papa.unparse([fields.map(f => f.label), fields.map(ex)], { delimiter: ';', newline: '\r\n' }), 'utf8');
}

module.exports = { readTable, autoMap, sampleXlsx, sampleCsv, MAX_ROWS, norm };
