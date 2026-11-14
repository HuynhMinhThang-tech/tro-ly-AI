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
async function callBuf(p, { method = 'GET', token, json, form } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: form || (json ? JSON.stringify(json) : undefined) });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '', disp: res.headers.get('content-disposition') || '' };
}
const fileForm = (name, extra = {}, buf) => {
  const fd = new FormData(); for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([buf || fs.readFileSync(path.join(FX, name))]), name); return fd;
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
async function upload(token, name, extra = {}, buf) {
  const scan = await call('/api/admin/docs/scan', { method: 'POST', token, form: fileForm(name, extra, buf) });
  assert.ok(scan.data.scan_id, 'quét phải trả scan_id: ' + JSON.stringify(scan.data).slice(0, 200));
  const t0 = Date.now();
  const r = await call('/api/admin/docs', { method: 'POST', token, json: { scan_id: scan.data.scan_id, ...extra, force: true } });
  return { ...r, ms: Date.now() - t0, scan: scan.data };
}

test('end-to-end: quyền admin + lập chỉ mục nền + tìm kiếm lai', { skip, timeout: 240000 }, async t => {
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
    assert.match(mock.groqCtx, /Luật mẫu/, 'tìm kiếm lai: tài liệu đang lập chỉ mục vẫn tìm được ngay bằng từ khóa');

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

  await t.test('hỏi thẳng "Điều N" → tra theo tiêu đề, đoạn đúng đứng đầu; số 2 không khớp nhầm Điều 20-29', async () => {
    const q = await call('/api/chat', { method: 'POST', token: root, json: { message: 'Cho tôi xem nội dung Điều 2 nhé' } });
    assert.equal(q.status, 200); assert.equal(q.data.mode, 'hybrid');
    const first = (mock.groqCtx.match(/\n\[1\] ([^\n]*)/) || [])[1] || '';   // nhãn của đoạn đứng đầu trong <tai_lieu>
    assert.match(first, /› Điều 2\. Giải thích từ ngữ/, 'Điều 2 phải đứng đầu: ' + first);
    assert.ok(!/Điều 2\d\./.test(first), 'không được khớp nhầm Điều 20-29');
  });

  await t.test('Voyage lỗi lúc hỏi → vẫn trả lời bằng tìm kiếm từ khóa, kèm lời nhắc', async () => {
    mock.mode = 'down';
    try {
      const q = await call('/api/chat', { method: 'POST', token: root, json: { message: 'Giải thích từ ngữ cứu nạn là gì vậy' } });
      assert.equal(q.status, 200, JSON.stringify(q.data)); assert.equal(q.data.mode, 'keyword');
      assert.match(q.data.notice, /từ khóa/); assert.match(mock.groqCtx, /Điều 2\./);
    } finally { mock.mode = 'ok'; }
  });

  await t.test('vn_fold trong Postgres cho kết quả y hệt hàm bỏ dấu trong JS (mọi chữ cái tiếng Việt, hoa/thường)', async () => {
    const { FROM, fold } = require(path.join(ROOT, 'lib/vn'));
    const sample = FROM + ' Điều 12. NGƯỜI ĐẠI DIỆN ' + [...FROM].map(c => c.normalize('NFD')).join('');
    const sql = (await pool.query('select vn_fold($1) as f', [sample])).rows[0].f;
    assert.equal(sql, fold(sample));
  });

  await t.test('tải lại nội dung đã có → dùng lại vector, dùng được ngay, không tốn lượt Voyage', async () => {
    await sleep(WINDOW + 300);
    const before = mock.accepted;
    const r = await upload(root, 'luat-mau.md', { title: 'Bản sao để thử dùng lại vector' });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    assert.equal(r.data.reused, r.data.chunk_count, 'mọi đoạn đều trùng nên phải dùng lại hết');
    assert.ok(r.scan.stats.reused > 0 && r.scan.stats.est_tokens === 0, 'báo cáo quét phải cho biết số đoạn dùng lại: ' + JSON.stringify(r.scan.stats));
    const { d } = await waitStatus(root, r.data.id, 'ready', 15000);
    assert.equal(d.embedded, d.chunk_count); assert.equal(mock.accepted, before, 'không được gọi Voyage lần nào');
    assert.equal((await call(`/api/admin/docs/${r.data.id}`, { method: 'DELETE', token: root })).status, 200);
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

  await t.test('xóa lịch sử trò chuyện: chỉ xóa được của mình; xóa tất cả không đụng người khác', async () => {
    const list = (await call('/api/conversations', { token: root })).data;
    assert.ok(list.length >= 2, 'cần có sẵn vài cuộc trò chuyện từ các bước trước');
    const target = list[0].id;
    assert.equal((await call('/api/conversations/' + target, { method: 'DELETE', token: u2t })).status, 404, 'không xóa được hội thoại của người khác');
    assert.equal((await call('/api/conversations/' + target, { token: root })).status, 200, 'hội thoại vẫn còn');
    assert.equal((await call('/api/conversations/' + target, { method: 'DELETE', token: root })).status, 200);
    assert.equal((await call('/api/conversations/' + target, { token: root })).status, 404);
    assert.equal((await pool.query('select count(*)::int n from messages where conversation_id = $1', [target])).rows[0].n, 0, 'tin nhắn bị xóa theo');
    assert.equal((await call('/api/conversations/' + target, { method: 'DELETE', token: root })).status, 404, 'xóa lần hai → không tìm thấy');
    assert.equal((await call('/api/conversations/khong-phai-uuid', { method: 'DELETE', token: root })).status, 400);
    assert.equal((await call('/api/conversations/' + target, { method: 'DELETE' })).status, 401, 'phải đăng nhập');

    const u2 = (await pool.query("select id from users where email = 'u2@gmail.com'")).rows[0].id;
    const c2 = (await pool.query("insert into conversations(user_id, title) values ($1, 'của u2') returning id", [u2])).rows[0].id;
    await pool.query("insert into messages(conversation_id, role, content) values ($1, 'user', 'xin chào')", [c2]);

    const all = await call('/api/conversations', { method: 'DELETE', token: root });
    assert.equal(all.status, 200); assert.equal(all.data.deleted, list.length - 1);
    assert.deepEqual((await call('/api/conversations', { token: root })).data, []);
    assert.equal((await pool.query("select count(*)::int n from messages m join conversations c on c.id = m.conversation_id where c.user_id = (select id from users where email = 'root@gmail.com')")).rows[0].n, 0);
    assert.equal((await call('/api/conversations/' + c2, { token: u2t })).status, 200, 'hội thoại của người khác còn nguyên');
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
    // sửa mỗi dòng một chút để không đoạn nào trùng với kho (trùng thì vector được dùng lại và xong ngay, không còn "lúc dở")
    const variant = Buffer.from(fs.readFileSync(path.join(FX, 'luat-mau.md'), 'utf8').split('\n').map(l => l.startsWith('#') || !l.trim() ? l : l + ' (bản sửa)').join('\n'));
    const r = await upload(root, 'luat-mau.md', { title: 'MD mẫu' }, variant);
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

  // ================= Tab Biểu mẫu =================
  await t.test('biểu mẫu Word: admin quét vùng tô màu → lưu → người dùng tải Excel/CSV lên → xuất Word/PDF giữ nguyên định dạng', async () => {
    const JSZip = require('jszip'), ExcelJS = require('exceljs');
    const tplName = 'mau-12-tang-von.docx', orig = fs.readFileSync(path.join(FX, tplName));
    const docText = async b => { const z = await JSZip.loadAsync(b); return [...(await z.file('word/document.xml').async('string')).matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join(''); };
    const nParas = async b => ((await (await JSZip.loadAsync(b)).file('word/document.xml').async('string')).match(/<w:p[ >]/g) || []).length;

    assert.equal((await call('/api/admin/templates/scan', { method: 'POST', token: u2t, form: fileForm(tplName) })).status, 403, 'user thường không được quét mẫu');
    const sc = await call('/api/admin/templates/scan', { method: 'POST', token: root, form: fileForm(tplName) });
    assert.equal(sc.status, 200, JSON.stringify(sc.data).slice(0, 300));
    assert.ok(sc.data.slots.length >= 14 && sc.data.fields.length >= 9, 'phải nhận ra các vùng tô vàng: ' + sc.data.slots.length + '/' + sc.data.fields.length);
    assert.ok(sc.data.slots.some(x => x.src === 'auto' && /chu/.test(x.format)), 'phải tự thêm vùng "bằng chữ"');
    assert.ok(sc.data.fields.some(f => f.key === 'ngay_lap' && f.type === 'date') && sc.data.fields.some(f => f.type === 'money'));

    const cfg = { slots: sc.data.slots, fields: sc.data.fields, clear_highlight: true };
    const bad = await call('/api/admin/templates', { method: 'POST', token: root, form: fileForm(tplName, { name: 'Hỏng', config: JSON.stringify({ ...cfg, slots: [{ ...cfg.slots[0], format: '{{khong_co}}' }] }) }) });
    assert.equal(bad.status, 422, 'trường chưa khai báo phải bị từ chối');
    const mk = await call('/api/admin/templates', { method: 'POST', token: root, form: fileForm(tplName, { name: 'Tăng vốn điều lệ', description: 'Mẫu 12', config: JSON.stringify(cfg) }) });
    assert.equal(mk.status, 201, JSON.stringify(mk.data)); const tid = mk.data.id;

    const list = (await call('/api/templates', { token: u2t })).data, tpl = list.templates.find(x => x.id === tid);
    assert.ok(tpl && tpl.fields.length === cfg.fields.length); assert.equal(typeof list.pdf, 'boolean');
    const fields = tpl.fields;

    // tệp mẫu để điền: Excel và CSV có đúng tiêu đề cột
    const x = await callBuf(`/api/templates/${tid}/sample?format=xlsx`, { token: u2t }); assert.equal(x.status, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buf);
    assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), fields.map(f => f.label));
    const csv = await callBuf(`/api/templates/${tid}/sample?format=csv`, { token: u2t });
    assert.ok(csv.buf.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])) && csv.buf.toString('utf8').includes(fields[0].label));

    // người dùng điền 2 dòng và tải CSV (dấu ; như Excel tiếng Việt) lên
    const val = (f, i) => ({ ten_doanh_nghiep: i ? 'Công ty Hai' : 'Công ty Test', dia_danh: 'Hà Nội', ngay_lap: '15/11/2026', von_dieu_le_sau_khi_thay_doi: '25.000.000.000', von_dieu_le_da_dang_ky: '1.005.000.000' }[f.key]
      ?? ({ money: '5.000.000', percent: '100', date: '01/01/2026', tax_code: '0108123456', id_card: '012345678901', number: '5' }[f.type] || 'Giá trị ' + f.key));
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const csvText = '\uFEFF' + [fields.map(f => q(f.label)).join(';'), ...[0, 1].map(i => fields.map(f => q(val(f, i))).join(';'))].join('\r\n');
    const pr = await call(`/api/templates/${tid}/parse`, { method: 'POST', token: u2t, form: fileForm('du-lieu.csv', {}, Buffer.from(csvText, 'utf8')) });
    assert.equal(pr.status, 200, JSON.stringify(pr.data).slice(0, 200)); assert.equal(pr.data.rows.length, 2);
    assert.ok(Object.values(pr.data.mapping).every(Boolean), 'mọi cột phải tự ghép được: ' + JSON.stringify(pr.data.mapping));
    const rows = pr.data.rows.map(r => Object.fromEntries(pr.data.headers.map((h, i) => [pr.data.mapping[i], r[i]])));

    const ck = await call(`/api/templates/${tid}/check`, { method: 'POST', token: u2t, json: { rows } });
    assert.equal(ck.data.ok, true, JSON.stringify(ck.data.rows[0].issues));
    const badRows = [{ ...rows[0], ma_so_doanh_nghiep_ma_so_thue: '123' }];
    const ck2 = await call(`/api/templates/${tid}/check`, { method: 'POST', token: u2t, json: { rows: badRows } });
    assert.equal(ck2.data.ok, false); assert.match(Object.values(ck2.data.rows[0].issues)[0], /10 hoặc 13/);
    assert.equal((await call(`/api/templates/${tid}/generate`, { method: 'POST', token: u2t, json: { rows: badRows } })).status, 422, 'dữ liệu sai thì không xuất');

    const g1 = await callBuf(`/api/templates/${tid}/generate`, { method: 'POST', token: u2t, json: { rows: [rows[0]], format: 'docx' } });
    assert.equal(g1.status, 200, g1.buf.toString().slice(0, 200)); assert.match(g1.disp, /\.docx/);
    const out = await docText(g1.buf), src = await docText(orig);
    assert.ok(out.includes('CÔNG TY TEST'), 'tên doanh nghiệp (bộ lọc upper)'); assert.ok(out.includes('ngày 15 tháng 11 năm 2026') && out.includes('Hà Nội, ngày'));
    assert.ok(out.includes('25.000.000.000'), 'số tiền có dấu chấm'); assert.ok(out.includes('hai mươi lăm tỷ đồng'), '"bằng chữ" tự khớp số tiền');
    assert.ok(out.includes('một tỷ không trăm lẻ năm triệu đồng'));
    assert.ok(!out.includes('HÙNG DUY') && !out.includes('279.000.000.000') && !out.includes('hai trăm bảy mươi chín tỷ'), 'không còn dữ liệu cũ');
    assert.ok(out.includes('Thời điểm thay đổi vốn: 18/08/2026'), 'phần không được chọn phải giữ nguyên');
    assert.equal(await nParas(g1.buf), await nParas(orig), 'không thêm/bớt đoạn văn');
    assert.ok(!/w:highlight/.test(await (await JSZip.loadAsync(g1.buf)).file('word/document.xml').async('string')), 'đã xóa màu tô');
    assert.ok(!out.includes('{{'), 'không sót chỗ trống');
    for (const n of ['word/styles.xml', 'word/settings.xml', 'word/theme/theme1.xml', 'word/fontTable.xml']) {   // các phần định dạng chép nguyên bản
      assert.ok((await (await JSZip.loadAsync(g1.buf)).file(n).async('nodebuffer')).equals(await (await JSZip.loadAsync(orig)).file(n).async('nodebuffer')), n + ' phải y hệt bản gốc');
    }

    const g2 = await callBuf(`/api/templates/${tid}/generate`, { method: 'POST', token: u2t, json: { rows, format: 'docx' } });
    assert.match(g2.type, /zip/); const zf = Object.keys((await JSZip.loadAsync(g2.buf)).files);
    assert.equal(zf.length, 2); assert.ok(zf.every(n => n.endsWith('.docx')));

    if (list.pdf) {   // máy chạy test có LibreOffice
      const gp = await callBuf(`/api/templates/${tid}/generate`, { method: 'POST', token: u2t, json: { rows: [rows[0]], format: 'pdf' } });
      assert.equal(gp.status, 200, gp.buf.toString().slice(0, 200)); assert.equal(gp.buf.subarray(0, 4).toString(), '%PDF');
    } else assert.equal((await call(`/api/templates/${tid}/generate`, { method: 'POST', token: u2t, json: { rows: [rows[0]], format: 'pdf' } })).status, 501);

    assert.equal((await call(`/api/templates/${tid}/map-ai`, { method: 'POST', token: u2t, json: { headers: ['Cột lạ'], taken: [] } })).status, 200);
    const tst = await callBuf('/api/admin/templates/test', { method: 'POST', token: root, form: (() => { const f = new FormData(); f.append('id', tid); return f; })() });
    assert.equal(tst.status, 200, tst.buf.toString().slice(0, 200)); assert.ok((await docText(tst.buf)).length > 500);

    await call(`/api/admin/templates/${tid}`, { method: 'PUT', token: root, json: { active: false } });
    assert.ok(!(await call('/api/templates', { token: u2t })).data.templates.some(x => x.id === tid), 'mẫu tắt thì người dùng không thấy');
    assert.equal((await call(`/api/templates/${tid}/generate`, { method: 'POST', token: u2t, json: { rows: [rows[0]] } })).status, 404);
    assert.equal((await call(`/api/admin/templates/${tid}`, { method: 'DELETE', token: root })).status, 200);
  });
});
