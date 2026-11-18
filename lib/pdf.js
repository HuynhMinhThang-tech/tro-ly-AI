// Chuyển .docx → .pdf. Hai cách, tự chọn theo cấu hình:
//   1. GOTENBERG_URL=https://...  → gọi dịch vụ Gotenberg (LibreOffice đóng gói sẵn trong Docker): dùng khi app chạy trên Vercel/serverless, nơi không cài được LibreOffice.
//      Dịch vụ nên bật đăng nhập: đặt GOTENBERG_USER / GOTENBERG_PASSWORD (hoặc viết thẳng https://user:pass@host). Xem gotenberg/README.md.
//   2. LibreOffice cài trên máy chủ (lệnh `soffice`, hoặc đặt SOFFICE_PATH)
// Không có cách nào → available() = false và giao diện tự khóa lựa chọn PDF.
// LƯU Ý: PDF do LibreOffice dựng; font Times New Roman cần có trên máy chủ (hoặc font tương thích Liberation Serif) thì ngắt dòng mới giống Word.
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

let found;
function findSoffice() {
  if (found !== undefined) return found;
  const cands = [process.env.SOFFICE_PATH, 'soffice', 'libreoffice', '/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe'].filter(Boolean);
  for (const c of cands) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return (found = c); continue; }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const p = path.join(dir, c + ext); if (fs.existsSync(p)) return (found = p);
    }
  }
  return (found = null);
}
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TRANSIENT = new Set([502, 503, 504]);   // dịch vụ đang khởi động / quá tải: thử lại một lần

function pdfError(code, message, detail) { const e = new Error(message); e.code = code; if (detail) e.detail = detail; return e; }

/** Đọc cấu hình Gotenberg từ môi trường (đọc mỗi lần gọi để đổi biến môi trường không cần sửa code). Trả null nếu chưa đặt hoặc URL sai. */
function gbConfig() {
  const raw = (process.env.GOTENBERG_URL || '').trim();
  if (!raw) return null;
  let u; try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const user = process.env.GOTENBERG_USER || decodeURIComponent(u.username), pass = process.env.GOTENBERG_PASSWORD || decodeURIComponent(u.password);
  u.username = ''; u.password = '';   // fetch không nhận thông tin đăng nhập nằm trong URL: tách ra gửi bằng header
  return { base: u.toString().replace(/\/+$/, ''), auth: user || pass ? 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') : null };
}
const mode = () => process.env.GOTENBERG_URL ? 'gotenberg' : findSoffice() ? 'soffice' : null;
const available = () => process.env.GOTENBERG_URL ? !!gbConfig() : !!findSoffice();

// LibreOffice chạy nặng: xếp hàng, mỗi lần một (đặt PDF_CONCURRENCY để tăng)
let active = 0; const waiting = [], LIMIT = +process.env.PDF_CONCURRENCY || 1;
const slot = () => new Promise(res => { const go = () => { active++; res(() => { active--; waiting.length && waiting.shift()(); }); }; active < LIMIT ? go() : waiting.push(go); });

/** Gọi Gotenberg: gắn đăng nhập, giới hạn thời gian, thử lại một lần khi dịch vụ vừa thức dậy (502/503/504 hoặc mất kết nối). Quá thời gian thì không thử lại. */
async function gbFetch(route, init = {}, { timeout = +process.env.GOTENBERG_TIMEOUT_MS || 60e3, retries = 1 } = {}) {
  const c = gbConfig();
  if (!c) throw pdfError('PDF_CONFIG', 'Dịch vụ PDF chưa được cấu hình đúng. Bạn có thể tải bản Word và chọn "Lưu thành PDF" trong Word.', 'GOTENBERG_URL không hợp lệ (cần dạng https://...)');
  const delay = +process.env.PDF_RETRY_DELAY_MS || 2500;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(c.base + route, { ...init, headers: c.auth ? { Authorization: c.auth } : {}, signal: AbortSignal.timeout(timeout) }); }
    catch (e) {
      if (e && e.name === 'TimeoutError') throw pdfError('PDF_TIMEOUT', 'Dịch vụ PDF phản hồi quá lâu. Hãy thử lại sau ít phút hoặc tải bản Word.', `quá ${Math.round(timeout / 1000)} giây`);
      if (attempt < retries) { await sleep(delay); continue; }
      throw pdfError('PDF_DOWN', 'Không kết nối được dịch vụ PDF. Hãy thử lại sau ít phút hoặc tải bản Word.', (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message));
    }
    if (TRANSIENT.has(res.status) && attempt < retries) { await res.arrayBuffer().catch(() => { }); await sleep(delay); continue; }
    return res;
  }
}

async function viaGotenberg(buf, name) {
  const safe = String(name || 'bieu-mau.docx').replace(/[^\w.\-]/g, '_').replace(/(\.docx)?$/i, '.docx');
  const fd = new FormData(); fd.append('files', new Blob([buf], { type: DOCX_MIME }), safe);
  const res = await gbFetch('/forms/libreoffice/convert', { method: 'POST', body: fd });
  if (res.ok) {
    const out = Buffer.from(await res.arrayBuffer());
    if (out.subarray(0, 4).toString('latin1') !== '%PDF') throw pdfError('PDF_BAD', 'Dịch vụ PDF trả về dữ liệu không phải PDF. Hãy tải bản Word.', 'phản hồi không bắt đầu bằng %PDF');
    return out;
  }
  const detail = `HTTP ${res.status} ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`.trim();
  if (res.status === 401 || res.status === 403) throw pdfError('PDF_AUTH', 'Dịch vụ PDF từ chối đăng nhập. Hãy báo quản trị viên kiểm tra tài khoản dịch vụ PDF; trong lúc đó bạn vẫn tải được bản Word.', detail);
  if (res.status === 400 || res.status === 422) throw pdfError('PDF_REJECT', 'Dịch vụ PDF không đọc được tệp Word này.', detail);
  throw pdfError('PDF_FAIL', 'Dịch vụ PDF đang gặp sự cố (mã ' + res.status + '). Hãy thử lại sau ít phút hoặc tải bản Word.', detail);
}

async function viaSoffice(buf, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-pdf-')), inp = path.join(dir, name);
  try {
    fs.writeFileSync(inp, buf);
    const profile = 'file://' + path.join(dir, 'profile').replace(/\\/g, '/');   // hồ sơ riêng cho mỗi lần chạy: tránh khóa tệp khi chạy song song
    await new Promise((resolve, reject) => {
      const p = spawn(findSoffice(), ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', dir, inp], { stdio: 'ignore' });
      const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Chuyển PDF quá thời gian (90 giây).')); }, 90e3);
      p.on('error', e => { clearTimeout(t); reject(e); });
      p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('LibreOffice thoát với mã ' + code)); });
    });
    const out = path.join(dir, name.replace(/\.docx$/i, '.pdf'));
    if (!fs.existsSync(out)) throw new Error('LibreOffice không tạo ra tệp PDF.');
    return fs.readFileSync(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function docxToPdf(buf, name = 'bieu-mau.docx') {
  if (!available()) { const e = new Error('Máy chủ chưa cài LibreOffice hoặc Gotenberg nên chưa xuất được PDF. Hãy tải bản Word (.docx) rồi chọn "Lưu thành PDF" trong Word.'); e.code = 'NO_PDF'; throw e; }
  const release = await slot();
  try { return process.env.GOTENBERG_URL ? await viaGotenberg(buf, name) : await viaSoffice(buf, name); }
  catch (e) { if (e.code && e.code.startsWith('PDF_')) console.error('[pdf]', e.code, e.detail || e.message); throw e; }
  finally { release(); }
}

/** Tệp Word nhỏ nhất có chữ tiếng Việt, dùng để kiểm tra cả đường chuyển PDF (đăng nhập, LibreOffice, font). */
async function tinyDocx() {
  const z = new (require('jszip'))(), X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  z.file('[Content_Types].xml', X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', X + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/></w:rPr><w:t>Kiểm tra xuất PDF: CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</w:t></w:r></w:p></w:body></w:document>');
  return z.generateAsync({ type: 'nodebuffer' });
}

/** Tình trạng xuất PDF cho trang quản trị: thử chuyển thật một tệp nhỏ, nên xác nhận được cả tài khoản đăng nhập lẫn LibreOffice (/health của Gotenberg không đòi đăng nhập nên không đủ). */
async function status() {
  const m = mode(), t0 = Date.now();
  if (!m) return { mode: null, ok: false, message: 'Chưa cấu hình xuất PDF: đặt GOTENBERG_URL (dịch vụ Gotenberg) hoặc cài LibreOffice trên máy chủ.' };
  if (m === 'gotenberg' && !gbConfig()) return { mode: m, ok: false, message: 'GOTENBERG_URL không hợp lệ (cần dạng https://ten-dich-vu).' };
  try { const out = await docxToPdf(await tinyDocx(), 'kiem-tra.docx'); return { mode: m, ok: true, ms: Date.now() - t0, bytes: out.length }; }
  catch (e) { return { mode: m, ok: false, ms: Date.now() - t0, code: e.code, message: e.message, detail: e.detail }; }
}

/** Đánh thức dịch vụ Gotenberg đang "ngủ" (gói miễn phí hoặc scale về 0) khi người dùng mở tab Biểu mẫu, để lần xuất PDF đầu không phải chờ khởi động. Tối đa mỗi 45 giây một lần. */
let lastWarm = 0;
async function warmup() {
  if (mode() !== 'gotenberg' || !gbConfig()) return { ok: true };
  if (Date.now() - lastWarm < 45e3) return { ok: true, skipped: true };
  lastWarm = Date.now();
  try { const res = await gbFetch('/health', { method: 'GET' }, { timeout: 25e3, retries: 0 }); await res.arrayBuffer().catch(() => { }); return { ok: res.ok }; }
  catch { return { ok: false }; }
}

module.exports = { docxToPdf, available, mode, status, warmup };
