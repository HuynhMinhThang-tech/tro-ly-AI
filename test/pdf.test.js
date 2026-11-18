// Xuất PDF qua dịch vụ Gotenberg (dùng Gotenberg giả để kiểm tra cách gọi, đăng nhập, thử lại và báo lỗi).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const KEYS = ['GOTENBERG_URL', 'GOTENBERG_USER', 'GOTENBERG_PASSWORD', 'PDF_RETRY_DELAY_MS', 'GOTENBERG_TIMEOUT_MS'];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
test.afterEach(() => { KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });
process.env.PDF_RETRY_DELAY_MS = '5';
const pdf = require('../lib/pdf');

/** Gotenberg giả: ghi lại các yêu cầu, trả lời theo `handler(req, body, n)` (n = số yêu cầu convert đã nhận). */
async function fake(handler) {
  const seen = []; let n = 0;
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks), rec = { method: req.method, url: req.url, auth: req.headers.authorization, ctype: req.headers['content-type'] || '', body: body.toString('latin1') };
      seen.push(rec); if (req.url.startsWith('/forms/')) n++;
      handler(rec, res, n);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + srv.address().port, seen, close: () => new Promise(r => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) };
}
const ok = (rec, res) => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end('%PDF-1.7 fake'); };
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const DOCX = Buffer.from('PK-fake-docx');

test('gọi đúng route LibreOffice của Gotenberg, gửi tệp .docx dưới trường "files" và đăng nhập Basic', async () => {
  const g = await fake(ok); process.env.GOTENBERG_URL = g.url; process.env.GOTENBERG_USER = 'bot'; process.env.GOTENBERG_PASSWORD = 'bí-mật';
  const out = await pdf.docxToPdf(DOCX, 'Biên bản họp (1).docx');
  assert.equal(out.subarray(0, 4).toString(), '%PDF');
  const r = g.seen[0];
  assert.equal(r.method, 'POST'); assert.equal(r.url, '/forms/libreoffice/convert'); assert.match(r.ctype, /^multipart\/form-data/);
  assert.equal(r.auth, basic('bot', 'bí-mật'));
  assert.match(r.body, /name="files"; filename="[\w.\-]+\.docx"/, 'tên tệp được làm sạch, giữ đuôi .docx');
  assert.ok(r.body.includes('PK-fake-docx'));
  await g.close();
});

test('tài khoản viết thẳng trong URL được tách ra gửi bằng header (fetch không nhận user:pass trong URL)', async () => {
  const g = await fake(ok); process.env.GOTENBERG_URL = g.url.replace('http://', 'http://ten%40a:m%3Ak@');
  await pdf.docxToPdf(DOCX, 'a.docx');
  assert.equal(g.seen[0].auth, basic('ten@a', 'm:k')); await g.close();
});

test('biến GOTENBERG_USER/PASSWORD ưu tiên hơn tài khoản trong URL; không có tài khoản thì không gửi Authorization', async () => {
  const g = await fake(ok); process.env.GOTENBERG_URL = g.url.replace('http://', 'http://x:y@'); process.env.GOTENBERG_USER = 'u'; process.env.GOTENBERG_PASSWORD = 'p';
  await pdf.docxToPdf(DOCX, 'a.docx'); assert.equal(g.seen[0].auth, basic('u', 'p'));
  delete process.env.GOTENBERG_USER; delete process.env.GOTENBERG_PASSWORD; process.env.GOTENBERG_URL = g.url;
  await pdf.docxToPdf(DOCX, 'a.docx'); assert.equal(g.seen[1].auth, undefined); await g.close();
});

test('dịch vụ vừa thức dậy (503) thì thử lại một lần rồi thành công; vẫn 503 thì báo lỗi dễ hiểu', async () => {
  let g = await fake((rec, res, n) => n === 1 ? (res.writeHead(503), res.end('starting')) : ok(rec, res));
  process.env.GOTENBERG_URL = g.url;
  assert.equal((await pdf.docxToPdf(DOCX, 'a.docx')).subarray(0, 4).toString(), '%PDF'); assert.equal(g.seen.length, 2); await g.close();
  g = await fake((rec, res) => { res.writeHead(503); res.end('busy'); }); process.env.GOTENBERG_URL = g.url;
  await assert.rejects(pdf.docxToPdf(DOCX, 'a.docx'), e => e.code === 'PDF_FAIL' && /503/.test(e.message) && /Word/.test(e.message));
  assert.equal(g.seen.length, 2, 'chỉ thử lại đúng một lần'); await g.close();
});

test('phân loại lỗi: sai tài khoản, tệp bị từ chối, trả về không phải PDF; chi tiết kỹ thuật nằm ở e.detail, không lộ trong e.message', async () => {
  const cases = [[401, 'unauthorized', 'PDF_AUTH'], [400, 'bad file', 'PDF_REJECT'], [500, 'boom', 'PDF_FAIL']];
  for (const [status, body, code] of cases) {
    const g = await fake((rec, res) => { res.writeHead(status); res.end(body); }); process.env.GOTENBERG_URL = g.url;
    await assert.rejects(pdf.docxToPdf(DOCX, 'a.docx'), e => e.code === code && e.detail.includes(String(status)) && !e.message.includes(body), code);
    await g.close();
  }
  const g = await fake((rec, res) => { res.writeHead(200); res.end('<html>không phải pdf</html>'); }); process.env.GOTENBERG_URL = g.url;
  await assert.rejects(pdf.docxToPdf(DOCX, 'a.docx'), e => e.code === 'PDF_BAD'); await g.close();
});

test('không kết nối được → PDF_DOWN (sau một lần thử lại); quá thời gian → PDF_TIMEOUT, không thử lại', async () => {
  const dead = await fake(ok), url = dead.url; await dead.close();
  process.env.GOTENBERG_URL = url;
  await assert.rejects(pdf.docxToPdf(DOCX, 'a.docx'), e => e.code === 'PDF_DOWN' && /Word/.test(e.message));
  const slow = await fake(() => { /* không trả lời */ }); process.env.GOTENBERG_URL = slow.url; process.env.GOTENBERG_TIMEOUT_MS = '150';
  await assert.rejects(pdf.docxToPdf(DOCX, 'a.docx'), e => e.code === 'PDF_TIMEOUT'); assert.equal(slow.seen.length, 1, 'không thử lại khi quá thời gian');
  await slow.close();
});

test('GOTENBERG_URL sai → không coi là có PDF; status() nói rõ lý do', async () => {
  process.env.GOTENBERG_URL = 'khong-phai-url';
  assert.equal(pdf.available(), false);
  const st = await pdf.status(); assert.equal(st.ok, false); assert.match(st.message, /GOTENBERG_URL/);
  await assert.rejects(pdf.docxToPdf(DOCX, 'a.docx'), e => e.code === 'NO_PDF');
});

test('status(): chuyển thử một tệp Word thật (chữ có dấu) qua dịch vụ; báo ok khi chạy, báo sai tài khoản khi bị từ chối', async () => {
  let g = await fake(ok); process.env.GOTENBERG_URL = g.url;
  const st = await pdf.status(); assert.equal(st.ok, true); assert.equal(st.mode, 'gotenberg'); assert.ok(st.ms >= 0 && st.bytes > 0);
  const JSZip = require('jszip'), m = g.seen[0].body.match(/PK[\s\S]*/)[0];   // phần thân multipart chứa zip của tệp thử
  const z = await JSZip.loadAsync(Buffer.from(m.slice(0, m.lastIndexOf('PK\x05\x06') + 22), 'latin1').subarray(0));
  assert.ok(z.file('word/document.xml'), 'tệp thử là .docx hợp lệ'); assert.match(await z.file('word/document.xml').async('string'), /VIỆT NAM/);
  await g.close();
  g = await fake((rec, res) => { res.writeHead(401); res.end(); }); process.env.GOTENBERG_URL = g.url;
  const bad = await pdf.status(); assert.equal(bad.ok, false); assert.equal(bad.code, 'PDF_AUTH'); await g.close();
});

test('warmup(): gọi /health của Gotenberg (không cần đăng nhập), không gọi dồn trong 45 giây; không dùng Gotenberg thì bỏ qua', async () => {
  const g = await fake((rec, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"up"}'); }); process.env.GOTENBERG_URL = g.url;
  assert.deepEqual(await pdf.warmup(), { ok: true }); assert.equal(g.seen[0].url, '/health');
  assert.equal((await pdf.warmup()).skipped, true); assert.equal(g.seen.length, 1); await g.close();
  delete process.env.GOTENBERG_URL; assert.deepEqual(await pdf.warmup(), { ok: true });
});

test('giới hạn phản hồi (Vercel 4,5 MB): báo rõ khi kết quả quá lớn, tắt được bằng MAX_RESPONSE_MB=0', () => {
  const { tooBig } = require('../lib/templates'), old = [process.env.MAX_RESPONSE_MB, process.env.VERCEL];
  try {
    delete process.env.MAX_RESPONSE_MB; delete process.env.VERCEL;
    assert.equal(tooBig(50 * 1048576), '', 'ngoài Vercel không giới hạn');
    process.env.VERCEL = '1';
    assert.equal(tooBig(3 * 1048576), ''); assert.match(tooBig(4.5 * 1048576), /4\.5 MB.*4 MB.*ít dòng.*Word/);
    process.env.MAX_RESPONSE_MB = '0'; assert.equal(tooBig(50 * 1048576), '');
    process.env.MAX_RESPONSE_MB = '1'; assert.match(tooBig(2 * 1048576), /2\.0 MB.*1 MB/);
  } finally { old[0] === undefined ? delete process.env.MAX_RESPONSE_MB : process.env.MAX_RESPONSE_MB = old[0]; old[1] === undefined ? delete process.env.VERCEL : process.env.VERCEL = old[1]; }
});
