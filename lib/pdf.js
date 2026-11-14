// Chuyển .docx → .pdf. Hai cách, tự chọn theo cấu hình:
//   1. GOTENBERG_URL=http://...  → gọi dịch vụ Gotenberg (LibreOffice đóng gói sẵn trong Docker), hợp với máy chủ không cài được LibreOffice
//   2. LibreOffice cài trên máy chủ (lệnh `soffice`, hoặc đặt SOFFICE_PATH)
// Không có cách nào → available() = false và giao diện tự ẩn lựa chọn PDF.
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
const available = () => !!(process.env.GOTENBERG_URL || findSoffice());

// LibreOffice chạy nặng: xếp hàng, mỗi lần một (đặt PDF_CONCURRENCY để tăng)
let active = 0; const waiting = [], LIMIT = +process.env.PDF_CONCURRENCY || 1;
const slot = () => new Promise(res => { const go = () => { active++; res(() => { active--; waiting.length && waiting.shift()(); }); }; active < LIMIT ? go() : waiting.push(go); });

async function viaGotenberg(buf, name) {
  const fd = new FormData(); fd.append('files', new Blob([buf]), name);
  const res = await fetch(process.env.GOTENBERG_URL.replace(/\/$/, '') + '/forms/libreoffice/convert', { method: 'POST', body: fd, signal: AbortSignal.timeout(90e3) });
  if (!res.ok) throw new Error('Dịch vụ chuyển PDF trả lỗi ' + res.status);
  return Buffer.from(await res.arrayBuffer());
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
  finally { release(); }
}

module.exports = { docxToPdf, available };
