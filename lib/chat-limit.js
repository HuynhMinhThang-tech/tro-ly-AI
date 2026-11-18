// Giới hạn tần suất chat để một tài khoản không đốt hết hạn mức Groq/Voyage.
// Đếm bằng bảng messages nên đúng cả khi có nhiều phiên bản chạy (serverless); thêm chốt "đang xử lý" trong RAM (theo từng phiên bản) để chặn gửi dồn song song.
// Chỉnh bằng biến môi trường CHAT_PER_MINUTE (8), CHAT_PER_DAY (300), CHAT_PARALLEL (2).
function makeChatLimiter(pool, env = process.env) {
  const perMin = +env.CHAT_PER_MINUTE || 8, perDay = +env.CHAT_PER_DAY || 300, parallel = +env.CHAT_PARALLEL || 2;
  const busy = new Map();
  /** Trả null nếu được hỏi; ngược lại { wait: số giây nên chờ, error: lời nhắn cho người dùng }. */
  async function check(uid) {
    if ((busy.get(uid) || 0) >= parallel) return { wait: 5, error: 'Bạn đang gửi nhiều câu hỏi cùng lúc. Vui lòng chờ câu trả lời trước rồi hỏi tiếp.' };
    const { rows: [c] } = await pool.query(`select count(*) filter (where m.created_at > now() - interval '1 minute')::int as per_min, count(*)::int as per_day
        from messages m join conversations c on c.id = m.conversation_id
       where c.user_id = $1 and m.role = 'user' and m.created_at > now() - interval '1 day'`, [uid]);
    if (c.per_min >= perMin) return { wait: 30, error: `Bạn hỏi hơi nhanh (tối đa ${perMin} câu mỗi phút). Vui lòng chờ khoảng nửa phút rồi hỏi tiếp.` };
    if (c.per_day >= perDay) return { wait: 3600, error: `Hôm nay bạn đã dùng hết ${perDay} câu hỏi. Vui lòng quay lại vào ngày mai hoặc liên hệ quản trị viên.` };
    return null;
  }
  /** Chạy fn trong khi giữ một chỗ "đang xử lý" của uid; luôn nhả chỗ khi xong, kể cả khi lỗi. */
  async function hold(uid, fn) {
    busy.set(uid, (busy.get(uid) || 0) + 1);
    try { return await fn(); }
    finally { const n = (busy.get(uid) || 1) - 1; n > 0 ? busy.set(uid, n) : busy.delete(uid); }
  }
  return { check, hold, limits: { perMin, perDay, parallel } };
}
module.exports = { makeChatLimiter };
