// Kiểu dữ liệu của trường biểu mẫu, chuẩn hóa/kiểm tra giá trị người dùng nhập, và bộ dựng nội dung thay thế "{{khóa|bộ_lọc}}".
// Mọi việc ở đây là CODE xác định (không dùng AI) vì văn bản pháp lý không chấp nhận số, chữ, ngày "gần đúng".
const { fold, parseNumber, parseDate, formatNumber, numberToWords, p2 } = require('./vn');

const TYPES = {
  text: 'Chữ', money: 'Số tiền (VNĐ)', number: 'Số', percent: 'Phần trăm (%)', date: 'Ngày',
  tax_code: 'Mã số thuế / mã số doanh nghiệp', id_card: 'Số CCCD / CMND'
};
const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
const clean = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/** Chuẩn hóa một giá trị thô (chuỗi / số / Date từ Excel) theo kiểu của trường → { value } hoặc { error }. value rỗng = null. */
function normalizeValue(field, raw) {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim());
  if (empty) return field.required ? { error: 'Còn thiếu' } : { value: null };
  const t = field.type || 'text';
  if (t === 'text') return { value: clean(String(raw instanceof Date ? raw.toISOString() : raw)).replace(/[ \t]+/g, ' ').trim() };
  if (t === 'date') { const d = parseDate(raw); return d ? { value: d } : { error: 'Ngày không hợp lệ (nhập dạng 28/08/2026)' }; }
  if (t === 'tax_code') {
    const d = String(raw).replace(/[\s.\-]/g, '');
    return /^\d{10}$|^\d{13}$/.test(d) ? { value: d } : { error: 'Mã số thuế phải gồm 10 hoặc 13 chữ số' };
  }
  if (t === 'id_card') {
    const d = String(raw).replace(/[\s.\-]/g, '');
    return /^\d{9}$|^\d{12}$/.test(d) ? { value: d } : { error: 'CCCD gồm 12 chữ số (CMND cũ 9 chữ số)' };
  }
  const n = parseNumber(raw);
  if (!Number.isFinite(n)) return { error: 'Không đọc được số' };
  if (t === 'money') return Math.abs(n - Math.round(n)) < 1e-9 ? { value: Math.round(n) } : { error: 'Số tiền phải là số nguyên (VNĐ)' };
  if (t === 'percent') return n >= 0 && n <= 100 ? { value: n } : { error: 'Phần trăm phải từ 0 đến 100' };
  return { value: n };
}

// Hiển thị mặc định theo kiểu (khi mẫu chỉ ghi {{khóa}} không kèm bộ lọc)
function defaultText(field, v) {
  if (v === null || v === undefined) return '';
  switch (field.type) {
    case 'money': case 'number': case 'percent': return formatNumber(v);
    case 'date': return `${p2(v.d)}/${p2(v.m)}/${v.y}`;
    default: return String(v);
  }
}

const needNum = (v, f) => { if (typeof v !== 'number') throw new Error(`Bộ lọc "${f}" chỉ dùng cho trường số`); return v; };
const needDate = (v, f) => { if (!v || typeof v !== 'object') throw new Error(`Bộ lọc "${f}" chỉ dùng cho trường ngày`); return v; };
// Mỗi bộ lọc nhận (giá trị, trường) và trả về chuỗi hoặc giá trị đã biến đổi để lọc tiếp
const FILTERS = {
  upper: v => String(v).toUpperCase(),
  lower: v => String(v).toLowerCase(),
  title: v => String(v).toLowerCase().replace(/(^|\s)(\S)/gu, (_, a, b) => a + b.toUpperCase()),
  so: v => formatNumber(needNum(v, 'so')),                    // 279000000000 → 279.000.000.000
  chu: v => numberToWords(needNum(v, 'chu')),                 // → hai trăm bảy mươi chín tỷ
  chu_hoa: v => cap(numberToWords(needNum(v, 'chu_hoa'))),    // → Hai trăm bảy mươi chín tỷ
  ngay: v => p2(needDate(v, 'ngay').d), thang: v => p2(needDate(v, 'thang').m), nam: v => String(needDate(v, 'nam').y),
  ngay1: v => String(needDate(v, 'ngay1').d), thang1: v => String(needDate(v, 'thang1').m),   // không thêm số 0 đứng đầu
  dmy: v => defaultText({ type: 'date' }, needDate(v, 'dmy')),
  ngay_thang_nam: v => { const d = needDate(v, 'ngay_thang_nam'); return `ngày ${p2(d.d)} tháng ${p2(d.m)} năm ${d.y}`; }
};

const REF_RE = /\{\{\s*([a-z][a-z0-9_]*)((?:\s*\|\s*[a-z0-9_]+)*)\s*\}\}/g;
/** Liệt kê các tham chiếu trong chuỗi mẫu: "{{a|upper}} và {{b}}" → [{key:'a',filters:['upper']},{key:'b',filters:[]}] */
function refsOf(format) {
  return [...String(format || '').matchAll(REF_RE)].map(m => ({ key: m[1], filters: (m[2] || '').split('|').map(s => s.trim()).filter(Boolean) }));
}
/** Trả về danh sách lỗi cú pháp của chuỗi mẫu (rỗng = hợp lệ). */
function checkFormat(format, fields) {
  const errs = [], f = String(format || '');
  if (!f.trim()) errs.push('Nội dung thay thế đang trống.');
  const rest = f.replace(REF_RE, '');
  if (/\{\{|\}\}/.test(rest)) errs.push('Có "{{" hoặc "}}" không đúng cú pháp {{khóa}} hoặc {{khóa|bộ_lọc}}.');
  for (const r of refsOf(f)) {
    if (fields && !fields[r.key]) errs.push(`Trường "${r.key}" chưa được khai báo.`);
    for (const n of r.filters) if (!FILTERS[n]) errs.push(`Bộ lọc "${n}" không tồn tại.`);
  }
  return errs;
}
/** Dựng nội dung thay thế từ chuỗi mẫu + giá trị đã chuẩn hóa ({khóa: value}). */
function renderFormat(format, values, fields) {
  return clean(String(format).replace(REF_RE, (_, key, fl) => {
    const field = fields[key] || { type: 'text' }, v = values[key];
    if (v === null || v === undefined) return '';
    const names = (fl || '').split('|').map(s => s.trim()).filter(Boolean);
    if (!names.length) return defaultText(field, v);
    return names.reduce((acc, n) => FILTERS[n](acc, field), v);
  }));
}

module.exports = { TYPES, KEY_RE, FILTERS, normalizeValue, defaultText, refsOf, checkFormat, renderFormat, fold };
