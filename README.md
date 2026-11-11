# Trợ lý AI – Chatbot hỏi đáp tài liệu nội bộ

Node.js (Express) · **Neon** (Postgres + pgvector) · **Voyage AI** (embedding) · **Groq Cloud** (mô hình trả lời).
Tên, giọng điệu của trợ lý do quản trị viên đặt trong giao diện, không gắn tên riêng.

## Cách hoạt động
1. Admin chọn tệp **PDF / Word (.docx) / HTML / TXT / Markdown** → hệ thống **chuyển sang Markdown** rồi **quét trước** (chưa lưu gì). Tệp chỉ tải lên **một lần**: kết quả quét được giữ ở máy chủ 20 phút, bước xác nhận chỉ gửi mã quét. Admin xem báo cáo và bản Markdown xem trước rồi xác nhận.
2. Markdown được tách đoạn theo cây tiêu đề (**Chương › Mục › Điều**) và ghi vào Neon **ngay lập tức** (trả lời trong chưa đầy 1 giây).
3. Embedding (Voyage) chạy **nền**, từng lô nhỏ đúng hạn mức, có thanh tiến độ trong bảng tài liệu. Tài liệu chỉ vào kết quả tìm kiếm khi đã lập chỉ mục xong. Server khởi động lại giữa chừng thì tự chạy tiếp; lỗi thì bấm **Thử lại**, không mất đoạn nào.
3. Người dùng hỏi → tìm 6 đoạn liên quan nhất (chỉ trong văn bản còn hiệu lực) → model Groq trả lời, ghi nhãn [số] và hiện nguồn.
4. Đăng ký → **chờ duyệt** → admin duyệt mới đăng nhập được. Mật khẩu băm bcrypt, phiên là token ngẫu nhiên lưu bản băm trong database.

## Pipeline lập chỉ mục

```
tệp tải lên ─▶ lib/markdown.js ─▶ lib/chunker.js ─▶ ghi Neon ─▶ lib/indexer.js (NỀN) ─▶ embedding Voyage
               toMarkdown()        chunkMarkdown()   documents + chunks   từng lô nhỏ, giữ nhịp 3 RPM/10K TPM
```

| Loại tệp | Cách chuyển sang Markdown |
|---|---|
| PDF (có lớp chữ) | `pdf-parse` lấy chữ → nối dòng bị ngắt cứng, bỏ số trang → nhận diện **Chương / Mục / Điều** (chịu lỗi OCR như `Điều 2 1 .`, `ChưongI`) |
| Word `.docx` | `mammoth` (giữ Heading, danh sách, bảng) → `turndown`. Nếu người soạn không dùng style Heading mà gõ tay "Điều 1." (kể cả in đậm), vẫn được nâng lên đúng cấp tiêu đề. Chỉ lấy chữ, ảnh bị bỏ (có ghi chú cho admin) |
| HTML | `turndown` (bỏ script/style/ảnh) |
| Markdown | giữ nguyên, chuẩn hóa tiêu đề Chương/Mục/Điều |
| TXT | như PDF |

Cấp tiêu đề cố định: `#` tên văn bản · `##` Chương · `###` Mục · `####` Điều. Tệp Word có Heading riêng thì giữ cấp của tác giả.

**Tách đoạn** (`chunkMarkdown`): mỗi Điều/mục là một đơn vị riêng, không bao giờ gộp hai Điều vào một đoạn. Nhãn trích dẫn là đường dẫn đầy đủ, ví dụ `Chương I – QUY ĐỊNH CHUNG › Điều 12. Ngày toàn dân…`. Mục dài (mặc định > 1800 ký tự, đổi bằng `CHUNK_MAX_CHARS`) được tách ở ranh giới Khoản/điểm và đánh dấu `(phần 1/3)`; bảng được giữ nguyên, bảng quá dài tách theo hàng và lặp lại hàng tiêu đề; chỉ khi một đoạn văn đơn lẻ vẫn quá dài mới tách theo câu (có gối đầu), cuối cùng mới cắt cứng.

Muốn **thay bộ chuyển đổi** (ví dụ thêm OCR cho PDF scan bằng Docling/Marker/dịch vụ OCR): chỉ sửa `pdfToMarkdown()` trong `lib/markdown.js` để trả về `{ text, markdown }`, các bước sau không đổi.

## Lập chỉ mục nền và hạn mức Voyage
Gói Voyage **chưa thanh toán** chỉ cho **3 yêu cầu/phút và 10.000 token/phút**. Một bộ luật dài (~75 đoạn, ~45.000 token) vẫn lập chỉ mục được, chỉ mất khoảng **5 phút chạy nền** (admin không phải chờ). Hệ thống chia lô theo token, chờ đủ chỗ trong hạn mức trước khi gửi và luôn chừa lại 1 yêu cầu/phút cho câu hỏi của người dùng nên chatbot vẫn trả lời bình thường trong lúc lập chỉ mục. Báo cáo quét hiển thị thời gian ước tính.

**Câu hỏi của người dùng cũng tốn 1 yêu cầu Voyage mỗi câu**, nên ở gói chưa thanh toán chatbot chỉ trả lời tối đa khoảng 3 câu hỏi *khác nhau* mỗi phút. Câu hỏi giống hệt câu đã hỏi (sau khi chuẩn hóa chữ hoa/khoảng trắng) dùng lại kết quả cũ, không tốn thêm yêu cầu. Vượt hạn mức thì chatbot báo rõ "thử lại sau khoảng N giây" thay vì lỗi chung. Nếu thấy lỗi khác, thông báo sẽ cho biết đó là lỗi Voyage, sai API key Voyage hay lỗi database, và nguyên nhân chi tiết nằm trong log máy chủ.

Muốn nhanh hơn: thêm phương thức thanh toán ở Voyage rồi đặt `EMBED_RPM` và `EMBED_TPM` theo hạn mức ghi trên trang Voyage của bạn (xem `.env.example`). Hạn mức Voyage hiện hành do Voyage quy định và có thể thay đổi, hãy đối chiếu trên trang của họ.

## Quản lý quyền admin
Trang **Người dùng** có nút **Cấp quyền admin** / **Gỡ quyền admin** (bấm hai lần để xác nhận). Có hiệu lực ngay, không cần đăng nhập lại. Chốt an toàn: chỉ cấp được cho tài khoản **đã duyệt**; không tự gỡ quyền của chính mình; không gỡ được tài khoản gốc (`ADMIN_EMAIL`); luôn còn ít nhất một admin. Mỗi lần đổi quyền được ghi vào log máy chủ.

## Bước quét tệp trước khi tải lên
Kết quả có 3 mức: **Hợp lệ** (xác nhận là xong), **Có cảnh báo** (phải bấm "Vẫn tải lên"), **Không thể tải lên** (không có nút xác nhận).
Máy chủ quét lại lần nữa khi xác nhận nên không thể lách bằng cách gọi API trực tiếp.

| Kiểm tra | Mức |
|---|---|
| Tệp lớn hơn `MAX_FILE_MB` (chặn ngay ở trình duyệt, không tải lên) | Chặn |
| Tệp lớn hơn `WARN_FILE_MB` | Cảnh báo |
| Hỏng, có mật khẩu, không phải văn bản/PDF/DOCX, `.doc`/RTF/Excel/PowerPoint, rỗng, PDF scan không có chữ | Chặn |
| Số đoạn > `MAX_CHUNKS` / > `WARN_CHUNKS` | Chặn / Cảnh báo |
| Dung lượng database sau khi thêm vượt `DB_LIMIT_MB` / vượt 80% | Chặn / Cảnh báo |
| Ký tự lạ, chữ bị tách rời, ký tự lỗi mã hóa (dấu hiệu lỗi OCR) | Cảnh báo |
| Trùng nội dung hoặc trùng số hiệu với tài liệu đã có | Cảnh báo |
| Cần nhiều token embedding (> 500.000) | Cảnh báo |

## Cài đặt
1. **Neon** (neon.com): tạo project → copy chuỗi kết nối dạng *pooled* (có `-pooler`) làm `DATABASE_URL`.
   Không cần chạy SQL thủ công: máy chủ tự tạo bảng khi khởi động.
2. **Voyage AI**: lấy API key làm `VOYAGE_API_KEY`.
3. Chọn một chuỗi bí mật dài (≥ 32 ký tự) làm `APP_SECRET`. Dùng để mã hóa API key Groq lưu trong database. **Đừng đổi sau khi đã lưu khóa**, nếu đổi phải nhập lại khóa.
4. Đặt `ADMIN_EMAIL` là Gmail của bạn: đăng ký bằng Gmail này sẽ tự thành admin đã duyệt.
5. Chạy thử trên máy: sao chép `.env.example` thành `.env`, điền, rồi `npm install && npm start` (http://localhost:3000).

## Triển khai trên Render
- Đẩy thư mục này lên GitHub → Render: **New → Blueprint** (đọc `render.yaml`) hoặc **New → Web Service** (Build: `npm install`, Start: `npm start`, Health check: `/healthz`).
- Thêm biến môi trường: `DATABASE_URL`, `VOYAGE_API_KEY`, `ADMIN_EMAIL`, `APP_SECRET` (blueprint tự sinh giá trị này).
- Gói miễn phí của Render sẽ "ngủ" khi không có người dùng, lần mở đầu tiên chậm vài chục giây. Phiên đăng nhập nằm trong database nên không bị mất.

## Cấu hình AI (Groq) trong giao diện
Vào **Quản trị → Mô hình AI**: dán API key Groq → bấm **Kiểm tra khóa và tải danh sách model** → chọn model → **Lưu thay đổi**.
- Khóa được mã hóa (AES-256-GCM) trước khi lưu và không bao giờ trả lại trình duyệt, chỉ hiện 4 ký tự cuối.
- Danh sách model lấy trực tiếp từ Groq (đã lọc bỏ model giọng nói, kiểm duyệt). Đổi khóa hay model có hiệu lực ngay.
- Có thể đặt sẵn `GROQ_API_KEY` / `GROQ_MODEL` ở biến môi trường làm giá trị mặc định; khóa admin lưu trong giao diện được ưu tiên.
- Model suy luận (có thẻ `<think>`) vẫn dùng được: phần suy luận được lược bỏ trước khi hiển thị.

## Lưu ý
- Tên, cách xưng hô, giọng điệu, lời chào, câu gợi ý: **Quản trị → Thiết lập bot**.
- Văn bản mới thay văn bản cũ: tải bản mới lên, rồi bấm **Tắt hiệu lực** ở bản cũ.
- Tệp lớn mất nhiều thời gian lập chỉ mục vì xử lý trong một yêu cầu. Giữ `MAX_CHUNKS` ở mức vừa phải.
- Bản scan (không có lớp chữ) bị chặn: cần OCR trước.
- Bot là công cụ hỗ trợ tra cứu, không thay thế ý kiến pháp lý chính thức.

## Kiểm thử
`npm test` chạy 24 bài kiểm tra không cần database hay API key (chuyển Markdown, tách đoạn, bộ giữ nhịp embedding), dùng tệp mẫu trong `test/fixtures/`.

Bài kiểm thử end-to-end (`test/e2e.test.js`: phân quyền admin, lập chỉ mục nền với Voyage giả **thật sự trả 429 nếu vượt hạn mức**, khởi động lại giữa chừng, lỗi và thử lại) chỉ chạy khi có database thử:
```
TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/trolyai_test npm test
```
Tên database bắt buộc chứa chữ `test` vì bài kiểm tra **xóa sạch dữ liệu** trong đó (cần PostgreSQL có pgvector). Không bao giờ trỏ vào database thật.

## Nâng cấp từ bản cũ
Khởi động lại là xong: `schema.sql` tự thêm các cột `documents.markdown`, `status`, `error` (tài liệu cũ mặc định `ready`). Tài liệu đã lập chỉ mục trước đây vẫn tra cứu bình thường nhưng chưa có bản Markdown và nhãn trích dẫn chưa có đường dẫn Chương. Muốn có, tải lại tệp (tắt/xóa bản cũ). Lưu ý: số tự động đánh bằng chức năng đánh số của Word có thể không nằm trong chữ của tệp `.docx`, hãy kiểm tra ở bản Markdown xem trước.

## Chưa có
OCR tự động, trả lời dạng streaming, 👍/👎, giới hạn số câu hỏi mỗi người, đặt lại mật khẩu, lập chỉ mục chạy nền.
