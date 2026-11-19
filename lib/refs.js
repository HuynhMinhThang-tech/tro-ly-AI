// Liên kết tham khảo thêm: chỉ hiện khi tài liệu trong kho chưa đủ để trả lời (không phải câu nào cũng có).
// Cách hoạt động: AI được dặn chèn dấu hiệu REF_MARK ở cuối câu trả lời khi thấy thiếu căn cứ hoặc cần đối chiếu văn bản gốc;
// máy chủ gỡ dấu hiệu đó khỏi nội dung và gửi kèm danh sách REF_LINKS để giao diện vẽ khung "Tham khảo thêm".
// Đường link do code quyết định (không để AI tự viết) nên không thể bị bịa. Muốn đổi / thêm trang: sửa REF_LINKS.
const REF_LINKS = [
  { title: 'Cơ sở dữ liệu pháp luật', site: 'dulieuphapluat.vn', url: 'https://dulieuphapluat.vn/' },
  { title: 'Hệ thống văn bản – Cổng thông tin điện tử Chính phủ', site: 'chinhphu.vn', url: 'http://chinhphu.vn/he-thong-van-ban' }
];
const REF_MARK = '[[THAM_KHAO]]';
const REF_RULE = `Tham khảo thêm: nếu tài liệu trong <tai_lieu> không có hoặc chưa đủ căn cứ để trả lời, hoặc câu hỏi cần văn bản pháp luật mới nhất / còn hiệu lực / bản gốc để đối chiếu, thì sau khi trả lời xong hãy thêm một dòng cuối cùng chỉ gồm đúng dấu hiệu ${REF_MARK} (hệ thống sẽ tự hiện liên kết tới dulieuphapluat.vn và chinhphu.vn cho người dùng). Tuyệt đối không tự viết đường link hay địa chỉ trang web. Nếu tài liệu đã trả lời đầy đủ, hoặc câu hỏi không liên quan đến văn bản pháp luật (chào hỏi, hỏi về cách dùng...), thì không thêm dấu hiệu.`;
const NOT_FOUND_RE = /chưa tìm thấy trong tài liệu/i;
const LEGAL_RE = /(luật|nghị định|thông tư|quyết định|nghị quyết|pháp lệnh|văn bản|quy định|điều\s*\d|khoản\s*\d|hiệu lực)/i;
/** Có nên hiện liên kết tham khảo: AI đã đánh dấu, hoặc chính câu trả lời nói chưa tìm thấy, hoặc kho không có đoạn nào mà câu hỏi nghe như hỏi pháp luật. */
function wantsRef({ marked, answer, hitCount, question }) {
  return !!marked || NOT_FOUND_RE.test(answer || '') || (hitCount === 0 && LEGAL_RE.test(question || ''));
}
module.exports = { REF_LINKS, REF_MARK, REF_RULE, wantsRef };
