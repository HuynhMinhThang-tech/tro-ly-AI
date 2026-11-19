const test = require('node:test'), assert = require('node:assert/strict');
const { makeAnswerFilter } = require('../lib/answer-filter');
const { wantsRef, REF_MARK } = require('../lib/refs');
const run = parts => { const f = makeAnswerFilter(); let o = ''; for (const p of parts) o += f.push(p); o += f.flush(); return { text: o, marked: f.state.marked }; };

test('bỏ khối <think> dù bị cắt giữa thẻ', () => {
  assert.equal(run(['<thi', 'nk>suy nghĩ ', 'dài</th', 'ink>Xin ', 'chào']).text.trim(), 'Xin chào');
  assert.equal(run(['Kết quả <think>x</think>ổn']).text, 'Kết quả ổn');
});
test('gỡ dấu hiệu tham khảo và ghi nhận đã đánh dấu', () => {
  const r = run(['Câu trả lời.\n\n[[THAM', '_KHAO]]']);
  assert.equal(r.text.trim(), 'Câu trả lời.'); assert.equal(r.marked, true);
  assert.equal(run(['Không có dấu hiệu']).marked, false);
});
test('ký tự "<" hoặc "[" bình thường không bị nuốt', () => {
  assert.equal(run(['a < b và [1] ', 'xong']).text, 'a < b và [1] xong');
  assert.equal(run(['giá trị <th']).text, 'giá trị <th');   // dở dang đến hết: trả lại khi flush
});
test('wantsRef: chỉ hiện khi AI đánh dấu, báo chưa tìm thấy, hoặc kho trống mà hỏi pháp luật', () => {
  assert.equal(wantsRef({ marked: true, answer: 'a', hitCount: 3, question: 'x' }), true);
  assert.equal(wantsRef({ marked: false, answer: 'Tôi chưa tìm thấy trong tài liệu hiện có.', hitCount: 2, question: 'x' }), true);
  assert.equal(wantsRef({ marked: false, answer: 'a', hitCount: 0, question: 'Nghị định mới nhất về đất đai?' }), true);
  assert.equal(wantsRef({ marked: false, answer: 'Chào bạn', hitCount: 0, question: 'xin chào' }), false);
  assert.equal(wantsRef({ marked: false, answer: 'đủ căn cứ [1]', hitCount: 4, question: 'Điều 12 nói gì?' }), false);
  assert.ok(REF_MARK.startsWith('[['));
});
