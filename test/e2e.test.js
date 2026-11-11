// Kiểm thử end-to-end: server thật + PostgreSQL (pgvector) thật + Voyage/Groq giả.
// Tự bỏ qua nếu không đặt TEST_DATABASE_URL. Ví dụ:
//   TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/trolyai_test npm test
// CẢNH BÁO: test XÓA SẠCH dữ liệu trong database đó, nên tên database bắt buộc có chữ "test".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http');
const { spawn } = require('child_process');

const DB = process.env.TEST_DATABASE_URL;
const skip = !DB ? 'chưa đặt TEST_DATABASE_URL' : !/test/i.test(DB.split('/').pop()) ? 'tên database phải chứa "test" (test sẽ xóa sạch dữ liệu)' : false;
const ROOT = path.join(__dirname, '..'), FX = path.join(__dirname, 'fixtures');
const PORT = 3190, MOCK = 4290, BASE = `http://127.0.0.1:${PORT}`;
const WINDOW = 1500;                                         // cửa sổ giới hạn thu nhỏ (thay cho 60 giây) để test chạy nhanh
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Voyage giả: ÁP đúng hạn mức 3 RPM / 10K TPM, vượt là trả 429 thật ----
const mock = { reqs: [], n429: 0, accepted: 0, mode: 'ok', groqCtx: '' };
let mockServer;
function startMock() {
  mockServer = http.createServer((req, res) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => {
      const b = JSON.parse(d || '{}'); res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/groq/chat/completions')) {
        mock.groqCtx = (b.messages[0].content.match(/<tai_lieu>([\s\S]*)<\/tai_lieu>/) || [])[1] || '';
        return res.end(JSON.stringify({ choices: [{ message: { content: 'ok [1]' } }] }));
      }
      const chars = b.input.reduce((a, t) => a + t.length, 0), tokens = Math.ceil(chars / 2.5), now = Date.now();
      mock.reqs = mock.reqs.filter(r => now - r.t < WINDOW);
      if (mock.mode === 'down') { res.writeHead(500, { 'retry-after': '0.05' }); return res.end('{"detail":"down"}'); }
      if (mock.reqs.length + 1 > 3 || mock.reqs.reduce((a, r) => a + r.tokens, 0) + tokens > 10000) {
        mock.n429++; res.writeHead(429, { 'retry-after': '1' }); return res.end('{"detail":"rate limit"}');
      }
      mock.reqs.push({ t: now, tokens }); mock.accepted++;
      res.end(JSON.stringify({ data: b.input.map(() => ({ embedding: Array.from({ length: 1024 }, (_, i) => (i % 7) / 7) })), usage: { total_tokens: tokens } }));
    });
  });
  return new Promise(r => mockServer.listen(MOCK, r));
}

// ---- server ----
let proc;
async function startServer() {
  proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: process.env.E2E_DEBUG ? 'inherit' : 'ignore', env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT),
    VOYAGE_API_KEY: 'test', VOYAGE_URL: `http://127.0.0.1:${MOCK}/v1/embeddings`, GROQ_URL: `http://127.0.0.1:${MOCK}/groq`, GROQ_API_KEY: 'x',
    APP_SECRET: 'test-secret', ADMIN_EMAIL: 'root@gmail.com', EMBED_RPM: '3', EMBED_TPM: '10000', EMBED_WINDOW_MS: String(WINDOW) } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { } await sleep(250); }
  throw new Error('server không khởi động được');
}
const stopServer = async () => { proc.kill(); await new Promise(r => proc.once('exit', r)); };

async function call(p, { method = 'GET', token, json, form } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: form || (json ? JSON.stringify(json) : undefined) });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const fileForm = (name, extra = {}) => {
  const fd = new FormData(); for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([fs.readFileSync(path.join(FX, name))]), name); return fd;
};
const register = email => call('/api/register', { method: 'POST', json: { name: email.split('@')[0], email, password: 'matkhau-dai-123' } });
const login = email => call('/api/login', { method: 'POST', json: { email, password: 'matkhau-dai-123' } });
async function waitStatus(token, id, want, ms = 60000) {
  const t0 = Date.now(), seen = [];
  while (Date.now() - t0 < ms) {
    const d = (await call('/api/admin/docs', { token })).data.find(x => x.id === id);
    if (d && (seen[seen.length - 1] !== d.embedded)) seen.push(d.embedded);
    if (d && d.status === want) return { d, seen };
    await sleep(300);
  }
  throw new Error('quá thời gian chờ trạng thái ' + want);
}
async function upload(token, name, extra = {}) {
  const scan = await call('/api/admin/docs/scan', { method: 'POST', token, form: fileForm(name, extra) });
  assert.ok(scan.data.scan_id, 'quét phải trả scan_id: ' + JSON.stringify(scan.data).slice(0, 200));
  const t0 = Date.now();
  const r = await call('/api/admin/docs', { method: 'POST', token, json: { scan_id: scan.data.scan_id, ...extra, force: true } });
  return { ...r, ms: Date.now() - t0, scan: scan.data };
}

test('end-to-end: quyền admin + lập chỉ mục nền', { skip, timeout: 240000 }, async t => {
  const { Pool } = require(path.join(ROOT, 'node_modules/pg'));
  const pool = new Pool({ connectionString: DB });
  await pool.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  await pool.query('truncate users, documents, settings cascade');
  await startMock(); await startServer();
  t.after(async () => { await stopServer().catch(() => { }); mockServer.close(); await pool.end(); });

  await register('root@gmail.com'); await register('u1@gmail.com'); await register('u2@gmail.com');
  const root = (await login('root@gmail.com')).data.token;
  let u1t, u2t;

  await t.test('cấp / gỡ quyền admin, có đủ chốt an toàn', async () => {
    const users = (await call('/api/admin/users', { token: root })).data;
    const id = e => users.find(u => u.email === e).id;
    assert.equal(users.find(u => u.email === 'root@gmail.com').is_root, true);
    assert.equal((await call('/api/me', { token: root })).data.id, id('root@gmail.com'));
    assert.equal((await login('u1@gmail.com')).status, 403, 'tài khoản chưa duyệt không đăng nhập được');
    const role = (tok, uid, r) => call(`/api/admin/users/${uid}/role`, { method: 'POST', token: tok, json: { role: r } });

    assert.equal((await role(root, id('u1@gmail.com'), 'admin')).status, 400, 'chưa duyệt thì không được cấp quyền admin');
    await call(`/api/admin/users/${id('u1@gmail.com')}/approve`, { method: 'POST', token: root });
    await call(`/api/admin/users/${id('u2@gmail.com')}/approve`, { method: 'POST', token: root });
    u1t = (await login('u1@gmail.com')).data.token; u2t = (await login('u2@gmail.com')).data.token;
    assert.equal((await role(u2t, id('u1@gmail.com'), 'admin')).status, 403, 'user thường không được cấp quyền');
    assert.equal((await role(root, id('u1@gmail.com'), 'bogus')).status, 400);
    assert.equal((await role(root, '00000000-0000-0000-0000-000000000000', 'admin')).status, 404);
    assert.equal((await role(root, 'khong-phai-uuid', 'admin')).status, 400);

    assert.equal((await role(root, id('u1@gmail.com'), 'admin')).status, 200);
    assert.equal((await call('/api/admin/users', { token: u1t })).status, 200, 'có hiệu lực ngay, không cần đăng nhập lại');
    assert.equal((await role(u1t, id('u2@gmail.com'), 'admin')).status, 200, 'admin mới cũng cấp quyền được cho người khác');
    assert.equal((await role(u1t, id('root@gmail.com'), 'user')).status, 400, 'không gỡ được tài khoản gốc');
    assert.equal((await role(u1t, id('u1@gmail.com'), 'user')).status, 400, 'không tự gỡ quyền của mình');
    assert.equal((await role(root, id('u2@gmail.com'), 'user')).status, 200);
    assert.equal((await role(root, id('u1@gmail.com'), 'user')).status, 200);
    assert.equal((await call('/api/admin/users', { token: u1t })).status, 403, 'gỡ quyền có hiệu lực ngay');
    assert.equal((await role(root, id('u1@gmail.com'), 'user')).status, 200, 'gỡ lần nữa không lỗi');
  });

  let lawId;
  await t.test('tải lên trả lời ngay (202), embedding chạy nền, không bao giờ chạm 429, tiến độ tăng dần', async () => {
    mock.n429 = 0;
    const r = await upload(root, 'luat-mau.md', { title: 'Luật mẫu', doc_number: '55/2024/QH15' });
    assert.equal(r.status, 202, JSON.stringify(r.data)); lawId = r.data.id;
    assert.ok(r.ms < 2000, 'phản hồi phải tức thì, không chờ embedding (mất ' + r.ms + 'ms)');
    assert.equal(r.data.status, 'processing');
    const mid = (await call('/api/admin/docs', { token: root })).data.find(d => d.id === lawId);
    assert.equal(mid.status, 'processing'); assert.ok(mid.embedded < mid.chunk_count);

    const q = await call('/api/chat', { method: 'POST', token: root, json: { message: 'Phòng cháy là gì?' } });   // hỏi trong lúc đang lập chỉ mục
    assert.equal(q.status, 200, 'chatbot vẫn trả lời được khi lập chỉ mục nền: ' + JSON.stringify(q.data));
    assert.ok(!/Điều 1\./.test(mock.groqCtx), 'tài liệu chưa xong không được xuất hiện trong kết quả tìm kiếm');

    const { d, seen } = await waitStatus(root, lawId, 'ready');
    assert.equal(mock.n429, 0, 'bộ giữ nhịp không được để Voyage trả 429');
    assert.equal(d.embedded, d.chunk_count); assert.ok(seen.length >= 2, 'tiến độ phải tăng dần: ' + seen);
    const nulls = (await pool.query('select count(*)::int n from chunks where embedding is null')).rows[0].n;
    assert.equal(nulls, 0);
  });

  await t.test('sau khi xong thì tìm kiếm thấy tài liệu', async () => {
    const q = await call('/api/chat', { method: 'POST', token: root, json: { message: 'Cháy là gì?' } });
    assert.equal(q.status, 200); assert.match(mock.groqCtx, /Điều 2\./);
    assert.match(q.data.sources.map(s => s.heading).join('|'), /Chương I – QUY ĐỊNH CHUNG › Điều/);
  });

  await t.test('chat: câu hỏi lặp lại (sau khi chuẩn hóa) không tốn thêm yêu cầu Voyage', async () => {
    await sleep(WINDOW + 300);
    const ask = m => call('/api/chat', { method: 'POST', token: root, json: { message: m } });
    const before = mock.accepted;
    assert.equal((await ask('Quyền tác giả là gì?')).status, 200);
    assert.equal((await ask('  quyền   TÁC giả là gì? ')).status, 200);
    assert.equal((await ask('Quyền tác giả là gì?')).status, 200);
    assert.equal(mock.accepted - before, 1, 'ba lần hỏi cùng một câu chỉ được gọi Voyage một lần');
  });

  await t.test('xác nhận không cần tải lại tệp: scan_id sai/hết hạn → 410, tải trực tiếp vẫn dùng được', async () => {
    const bad = await call('/api/admin/docs', { method: 'POST', token: root, json: { scan_id: 'khong-co' } });
    assert.equal(bad.status, 410); assert.equal(bad.data.expired, true);
    const scan = await call('/api/admin/docs/scan', { method: 'POST', token: root, form: fileForm('quy-che-heading.md') });
    assert.equal((await call('/api/admin/docs', { method: 'POST', token: u2t, json: { scan_id: scan.data.scan_id } })).status, 403);
    const direct = await call('/api/admin/docs', { method: 'POST', token: root, form: fileForm('quy-che-khong-heading.md', { force: 'true' }) });
    assert.equal(direct.status, 202);
    await waitStatus(root, direct.data.id, 'ready');
  });

  await t.test('server khởi động lại giữa chừng → tự chạy tiếp đúng chỗ dở, không trùng, không thiếu đoạn', async () => {
    const r = await upload(root, 'luat-mau.md', { title: 'MD mẫu' });
    const id = r.data.id;
    let before; for (let i = 0; i < 100; i++) { before = (await call('/api/admin/docs', { token: root })).data.find(d => d.id === id); if (before.embedded > 0 && before.embedded < before.chunk_count) break; await sleep(100); }
    assert.ok(before.embedded > 0 && before.embedded < before.chunk_count, 'phải bắt được lúc đang dở');
    await stopServer(); await startServer();
    const { d } = await waitStatus(root, id, 'ready');
    assert.equal(d.embedded, d.chunk_count);
    const cnt = (await pool.query('select count(*)::int n from chunks where document_id = $1', [id])).rows[0].n;
    assert.equal(cnt, d.chunk_count, 'không được nhân đôi đoạn');
  });

  await t.test('Voyage lỗi → tài liệu báo lỗi (không mất đoạn nào) → bấm Thử lại thì chạy tiếp', async () => {
    mock.mode = 'down';
    const r = await upload(root, 'co-anh.md', { title: 'Có ảnh' });
    const { d } = await waitStatus(root, r.data.id, 'error', 30000);
    assert.match(d.error, /500/); assert.equal(d.embedded, 0);
    assert.equal((await call(`/api/admin/docs/${r.data.id}/retry`, { method: 'POST', token: root })).status, 200);
    assert.equal((await call(`/api/admin/docs/${r.data.id}/retry`, { method: 'POST', token: root })).status, 400, 'chỉ thử lại được khi đang lỗi');
    mock.mode = 'ok';
    // lần thử lại đầu có thể rơi vào lúc Voyage còn lỗi; chờ nó kết thúc rồi thử lại tới khi xong
    let fin;
    for (let i = 0; i < 5 && !fin; i++) {
      const cur = (await call('/api/admin/docs', { token: root })).data.find(x => x.id === r.data.id);
      if (cur.status === 'ready') fin = cur;
      else if (cur.status === 'error') await call(`/api/admin/docs/${r.data.id}/retry`, { method: 'POST', token: root });
      await sleep(1500);
    }
    assert.ok(fin, 'sau khi Voyage hồi phục phải lập chỉ mục xong');
    assert.equal(fin.embedded, fin.chunk_count);
  });

  await t.test('xóa tài liệu đang xử lý không làm server lỗi', async () => {
    const r = await upload(root, 'luat-mau.txt', { title: 'Sẽ bị xóa', doc_number: 'x/1' });
    await sleep(500);
    assert.equal((await call(`/api/admin/docs/${r.data.id}`, { method: 'DELETE', token: root })).status, 200);
    await sleep(1500);
    assert.equal((await call('/healthz')).status, 200);
    assert.equal((await pool.query('select count(*)::int n from chunks where document_id = $1', [r.data.id])).rows[0].n, 0);
  });
});
