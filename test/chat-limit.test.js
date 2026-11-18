// Giới hạn tần suất chat: theo phút, theo ngày, và chặn gửi dồn song song.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeChatLimiter } = require('../lib/chat-limit');
const poolOf = (per_min, per_day) => { const calls = []; return { calls, query: async (sql, args) => { calls.push(args); return { rows: [{ per_min, per_day }] }; } }; };

test('trong hạn mức thì cho hỏi; truy vấn theo đúng người dùng', async () => {
  const p = poolOf(2, 10), l = makeChatLimiter(p, {});
  assert.equal(await l.check('u1'), null); assert.deepEqual(p.calls[0], ['u1']);
  assert.deepEqual(l.limits, { perMin: 8, perDay: 300, parallel: 2 });
});

test('quá số câu mỗi phút → chờ ngắn; quá số câu mỗi ngày → chờ lâu; lời nhắn nêu đúng con số', async () => {
  let r = await makeChatLimiter(poolOf(8, 20), {}).check('u');
  assert.equal(r.wait, 30); assert.match(r.error, /tối đa 8 câu mỗi phút/);
  r = await makeChatLimiter(poolOf(1, 300), {}).check('u');
  assert.equal(r.wait, 3600); assert.match(r.error, /300 câu hỏi/);
  r = await makeChatLimiter(poolOf(3, 5), { CHAT_PER_MINUTE: '3', CHAT_PER_DAY: '5' }).check('u');
  assert.equal(r.wait, 30, 'phút được kiểm tra trước ngày; biến môi trường đổi được hạn mức');
});

test('gửi dồn song song: quá CHAT_PARALLEL yêu cầu đang xử lý thì chặn, xử lý xong (kể cả lỗi) thì nhả chỗ', async () => {
  const l = makeChatLimiter(poolOf(0, 0), { CHAT_PARALLEL: '2' });
  const releases = []; const slow = () => new Promise(r => releases.push(r));
  const a = l.hold('u', slow), b = l.hold('u', slow);
  const blocked = await l.check('u'); assert.equal(blocked.wait, 5); assert.match(blocked.error, /cùng lúc/);
  assert.equal(await l.check('người khác'), null, 'người dùng khác không bị ảnh hưởng');
  releases.forEach(r => r()); await a; await b;
  assert.equal(await l.check('u'), null);
  await assert.rejects(l.hold('u', async () => { throw new Error('lỗi giữa chừng'); }), /lỗi giữa chừng/);
  assert.equal(await l.check('u'), null, 'lỗi cũng phải nhả chỗ');
});
