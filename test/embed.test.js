// Bộ giữ nhịp embedding: dùng Voyage giả, không cần mạng hay API key.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let server, url, log = [], script = [];
test.before(async () => {
  server = http.createServer((req, res) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => {
      const b = JSON.parse(d), chars = b.input.reduce((a, t) => a + t.length, 0);
      log.push({ t: Date.now(), n: b.input.length, chars });
      const act = script.shift();
      if (act === '429') { res.writeHead(429, { 'retry-after': '0.3', 'content-type': 'application/json' }); return res.end('{"detail":"rate limit"}'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: b.input.map(t => ({ embedding: [t.length] })), usage: { total_tokens: Math.ceil(chars / 3) } }));
    });
  });
  await new Promise(r => server.listen(0, r));
  url = `http://127.0.0.1:${server.address().port}/v1/embeddings`;
  process.env.VOYAGE_URL = url; process.env.VOYAGE_API_KEY = 'test';
});
test.after(() => server.close());
test.beforeEach(() => { log = []; script = []; });

const ing = () => { delete require.cache[require.resolve('../lib/ingest')]; return require('../lib/ingest'); };
const texts = (n, len = 1800) => Array.from({ length: n }, (_, i) => String(i).padStart(3, '0') + 'x'.repeat(len - 3));

test('fitBatch: không lô nào vượt trần token của một yêu cầu (gói chưa thanh toán: 3 RPM / 10K TPM)', () => {
  delete process.env.EMBED_RPM; delete process.env.EMBED_TPM;
  const { fitBatch, estTokens, batchTokens } = ing();
  const t = texts(40);
  let i = 0, batches = 0;
  while (i < t.length) {
    const n = fitBatch(t.slice(i, i + 128)); assert.ok(n >= 1);
    assert.ok(t.slice(i, i + n).reduce((a, x) => a + estTokens(x), 0) <= batchTokens(), 'lô vượt trần token');
    i += n; batches++;
  }
  assert.ok(batches >= 8, 'phải chia nhỏ (bản cũ gửi 32 đoạn ≈ 28K token trong một yêu cầu)');
});

test('embed(document): chia lô, giữ đúng thứ tự, và không vượt số yêu cầu mỗi cửa sổ', async () => {
  Object.assign(process.env, { EMBED_RPM: '3', EMBED_TPM: '10000', EMBED_WINDOW_MS: '500' });
  const { embed, resetLimiter } = ing(); resetLimiter();
  const t = texts(12), t0 = Date.now();
  const out = await embed(t, 'document');
  assert.deepEqual(out.map(v => v[0]), t.map(x => x.length));
  assert.equal(log.reduce((a, x) => a + x.n, 0), 12);
  assert.ok(log.length >= 3);
  // RPM 3 chừa 1 cho câu hỏi người dùng → lập chỉ mục chỉ dùng 2 yêu cầu mỗi cửa sổ 500ms
  for (let i = 2; i < log.length; i++) assert.ok(log[i].t - log[i - 2].t >= 450, `yêu cầu ${i} đến quá sớm`);
  assert.ok(Date.now() - t0 >= 450);
});

test('embed(document): gặp 429 thì chờ Retry-After rồi thử lại, không mất dữ liệu', async () => {
  Object.assign(process.env, { EMBED_RPM: '100', EMBED_TPM: '1000000', EMBED_WINDOW_MS: '200' });
  const { embed, resetLimiter } = ing(); resetLimiter();
  script = ['429'];
  const t0 = Date.now(), out = await embed(texts(3), 'document');
  assert.equal(out.length, 3); assert.equal(log.length, 2);
  assert.ok(Date.now() - t0 >= 280, 'phải chờ theo Retry-After');
});

test('embed(query): hết chỗ trong hạn mức và phải chờ quá lâu thì báo bận ngay, không treo trình duyệt', async () => {
  Object.assign(process.env, { EMBED_RPM: '1', EMBED_TPM: '10000', EMBED_WINDOW_MS: '40000' });
  const { embed, resetLimiter } = ing(); resetLimiter();
  await embed(['câu hỏi một'], 'query');
  const t0 = Date.now();
  await assert.rejects(embed(['câu hỏi hai'], 'query'), e => e.busy === true && /giới hạn tốc độ.*giây/.test(e.message) && e.retryAfter > 0);
  assert.ok(Date.now() - t0 < 1000);
});

test('estMinutes: gói chưa thanh toán ≈ vài phút cho một bộ luật; sau khi nâng hạn mức thì dưới 1-2 phút', () => {
  delete process.env.EMBED_RPM; delete process.env.EMBED_TPM; delete process.env.EMBED_WINDOW_MS;
  assert.equal(ing().estMinutes(45000), 5);
  Object.assign(process.env, { EMBED_RPM: '2000', EMBED_TPM: '3000000' });
  assert.equal(ing().estMinutes(45000), 1);
});
