// Lọc câu trả lời của AI khi nhận từng mảnh (stream): bỏ khối <think>…</think> và dấu hiệu [[THAM_KHAO]].
// Mảnh có thể cắt giữa thẻ (ví dụ "<thi" rồi "nk>"), nên phần đuôi có thể là đầu của thẻ được giữ lại chờ mảnh sau.
const { REF_MARK } = require('./refs');
const OPEN = '<think>', CLOSE = '</think>';
const holdLen = (s, tag) => { for (let k = Math.min(s.length, tag.length - 1); k > 0; k--) if (tag.startsWith(s.slice(-k))) return k; return 0; };

function makeAnswerFilter() {
  let a = '', inThink = false, b = '';   // a: đang chờ lọc <think>; b: đang chờ lọc dấu hiệu
  const state = { marked: false };
  function stripThink(chunk) {
    a += chunk; let out = '';
    for (;;) {
      if (inThink) {
        const i = a.indexOf(CLOSE);
        if (i < 0) { a = a.slice(a.length - holdLen(a, CLOSE)); break; }
        a = a.slice(i + CLOSE.length); inThink = false;
      } else {
        const i = a.indexOf(OPEN);
        if (i < 0) { const h = holdLen(a, OPEN); out += a.slice(0, a.length - h); a = a.slice(a.length - h); break; }
        out += a.slice(0, i); a = a.slice(i + OPEN.length); inThink = true;
      }
    }
    return out;
  }
  function stripMark(chunk) {
    b += chunk; let out = '';
    for (;;) {
      const i = b.indexOf(REF_MARK);
      if (i < 0) { const h = holdLen(b, REF_MARK); out += b.slice(0, b.length - h); b = b.slice(b.length - h); break; }
      state.marked = true; out += b.slice(0, i); b = b.slice(i + REF_MARK.length);
    }
    return out;
  }
  return {
    state,
    push: chunk => stripMark(stripThink(String(chunk))),
    flush() { const t = inThink ? '' : a; a = ''; const o = stripMark(t) + b; b = ''; return o; }
  };
}
module.exports = { makeAnswerFilter };
