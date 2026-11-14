// Tiện ích tiếng Việt dùng chung: bỏ dấu, đọc số thành chữ, đọc/định dạng số - ngày, tạo mã (slug).

// Bảng bỏ dấu. PHẢI khớp từng ký tự với hàm vn_fold() trong schema.sql (có test đối chiếu).
const FROM = 'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ'
           + 'ÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ';
const TO = ('a'.repeat(17) + 'e'.repeat(11) + 'i'.repeat(5) + 'o'.repeat(17) + 'u'.repeat(11) + 'y'.repeat(5) + 'd').repeat(2);

/** Bỏ dấu + hạ chữ thường. "Điều 12" → "dieu 12". Chịu được cả chữ dạng dựng sẵn (NFC) lẫn tổ hợp (NFD). */
const fold = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

const slug = (s, max = 40) => {
  let t = fold(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (t.length > max) t = t.slice(0, max).replace(/_[^_]*$/, '') || t.slice(0, max);
  return /^[a-z]/.test(t) ? t : (t ? 'f_' + t : '');
};

// ---------- Tìm kiếm: từ dừng, tách từ, nhận diện "Điều N" ----------
// Từ dừng giữ ở mức tối thiểu vì khi bỏ dấu nhiều từ nghĩa khác nhau trùng mặt chữ ("cổ" ~ "có", "dược" ~ "được", "trọng" ~ "trong").
const STOP = new Set(('va la cua cac nhung trong cho khi khong nay voi mot hay hoac ve theo vao se dang bi nao gi ai rat xin vui giup '
  + 'dieu khoan diem muc chuong tren duoi sau truoc').split(/\s+/));
const words = s => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
const keywords = s => [...new Set(words(s).filter(w => !STOP.has(w) && (w.length >= 2)))].slice(0, 24);

/** Câu hỏi nhắc tới "Điều 12", "điều 5 và 6", "Điều 78a" → ['12'], ['5','6'], ['78a']. */
function parseArticleRefs(text) {
  const out = [], re = /\bdieu\s*(\d{1,3}[a-z]?)((?:\s*(?:,|;|va|hoac|den|-|\/)\s*\d{1,3}[a-z]?(?![a-z]))*)(?![a-z])/g;
  const f = fold(text); let m;
  while ((m = re.exec(f))) { out.push(m[1], ...(m[2].match(/\d{1,3}[a-z]?/g) || [])); }
  return [...new Set(out)].slice(0, 6);
}

// ---------- Số → chữ ----------
const D = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const UNIT = ['', 'nghìn', 'triệu'];
function readTriple(n, hasHigher, linh) {
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, u = n % 10, out = [];
  if (h > 0) out.push(D[h], 'trăm'); else if (hasHigher && (t > 0 || u > 0)) out.push('không', 'trăm');
  if (t > 1) { out.push(D[t], 'mươi'); if (u === 1) out.push('mốt'); else if (u === 5) out.push('lăm'); else if (u > 0) out.push(D[u]); }
  else if (t === 1) { out.push('mười'); if (u === 5) out.push('lăm'); else if (u > 0) out.push(D[u]); }
  else if (u > 0) { if (h > 0 || hasHigher) out.push(linh); out.push(D[u]); }
  return out.join(' ');
}
/** 279000000000 → "hai trăm bảy mươi chín tỷ" (không kèm chữ "đồng"). Chấp nhận số nguyên không âm tới 10^18. */
function numberToWords(value, linh = process.env.VN_LINH || 'lẻ') {
  let n = BigInt(Math.round(Number(value)));
  if (n < 0n) return 'âm ' + numberToWords(-n, linh);
  if (n === 0n) return 'không';
  const groups = [];
  while (n > 0n) { groups.push(Number(n % 1000n)); n /= 1000n; }
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    const hasHigher = i < groups.length - 1;
    const unit = [UNIT[i % 3], ...Array(Math.floor(i / 3)).fill('tỷ')].filter(Boolean).join(' ');
    parts.push(readTriple(groups[i], hasHigher, linh) + (unit ? ' ' + unit : ''));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------- Đọc / định dạng số ----------
const grp = n => String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
/** 279000000000 → "279.000.000.000"; 33.5 → "33,5" */
function formatNumber(n) {
  if (!Number.isFinite(n)) return '';
  const neg = n < 0 ? '-' : '', a = Math.abs(n), ip = Math.trunc(a);
  const frac = a === ip ? '' : String(+(a - ip).toFixed(6)).slice(2);
  return neg + grp(ip) + (frac ? ',' + frac : '');
}
const MULT = { ty: 1e9, trieu: 1e6, nghin: 1e3, ngan: 1e3 };
/** "279.000.000.000 đồng", "279,000,000,000", "1,5 tỷ", "33,33", 12000 → số. Không hiểu được thì trả NaN. */
function parseNumber(raw) {
  if (typeof raw === 'number') return raw;
  let s = fold(raw).replace(/\s+/g, ' ').trim();
  if (!s) return NaN;
  let mult = 1;
  const mm = s.match(/\b(ty|trieu|nghin|ngan)\s*(dong|vnd|d)?$/);
  if (mm) { mult = MULT[mm[1]]; s = s.slice(0, mm.index).trim(); }
  s = s.replace(/\s*(dong|vnd|d|%)$/, '').replace(/\s+/g, '');
  if (!/^-?[\d.,]+$/.test(s)) return NaN;
  const neg = s[0] === '-'; if (neg) s = s.slice(1);
  const dots = (s.match(/\./g) || []).length, coms = (s.match(/,/g) || []).length;
  let v;
  if (!dots && !coms) v = Number(s);
  else if (dots && coms) {                       // "1.234,56" (Việt) hoặc "1,234.56" (Anh): dấu đứng sau cùng là dấu thập phân
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',', ths = dec === '.' ? ',' : '.';
    v = Number(s.split(ths).join('').replace(dec, '.'));
  } else {
    const ch = dots ? '.' : ',', n = dots || coms, after = s.slice(s.lastIndexOf(ch) + 1);
    if (n > 1) v = Number(s.split(ch).join(''));                                   // 279.000.000
    else if (after.length === 3 && mult === 1 && (ch === '.' || s.indexOf(ch) <= 3)) v = Number(s.replace(ch, ''));   // 1.000 hoặc 1,000
    else v = Number(s.replace(ch, '.'));                                           // 33,5
  }
  return (neg ? -v : v) * mult;
}

/** "28/08/2026", "28-8-2026", "2026-08-28", Date, số serial Excel → {y,m,d} hoặc null. */
function parseDate(raw) {
  if (raw instanceof Date && !isNaN(raw)) return { y: raw.getUTCFullYear(), m: raw.getUTCMonth() + 1, d: raw.getUTCDate() };
  if (typeof raw === 'number' && raw > 20000 && raw < 80000) return parseDate(new Date(Math.round((raw - 25569) * 86400000)));
  const s = String(raw ?? '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^ng[àa]y\s+(\d{1,2})\s+th[áa]ng\s+(\d{1,2})\s+n[ăa]m\s+(\d{4})$/i))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? { y, m: mo, d } : null;
}
const p2 = n => String(n).padStart(2, '0');

module.exports = { foldVN: fold, fold, FROM, TO, slug, words, keywords, parseArticleRefs, numberToWords, formatNumber, parseNumber, parseDate, p2, STOP };
