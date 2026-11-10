# Trợ lý AI – Chatbot hỏi đáp tài liệu nội bộ

Node.js (Express) · **Neon** (Postgres + pgvector) · **Voyage AI** (embedding) · **Groq Cloud** (mô hình trả lời).
Tên, giọng điệu của trợ lý do quản trị viên đặt trong giao diện, không gắn tên riêng.

## Cách hoạt động
1. Admin chọn tệp **PDF / Word (.docx) / HTML / TXT / Markdown** → hệ thống **chuyển sang Markdown** rồi **quét trước** (chưa lưu gì). Admin xem báo cáo và bản Markdown xem trước, sau đó mới xác nhận lập chỉ mục.
2. Markdown được tách đoạn theo cây tiêu đề (**Chương › Mục › Điều**), tạo embedding bằng Voyage, lưu vào Neon cùng bản Markdown của tệp.
3. Người dùng hỏi → tìm 6 đoạn liên quan nhất (chỉ trong văn bản còn hiệu lực) → model Groq trả lời, ghi nhãn [số] và hiện nguồn.
4. Đăng ký → **chờ duyệt** → admin duyệt mới đăng nhập được. Mật khẩu băm bcrypt, phiên là token ngẫu nhiên lưu bản băm trong database.

## Pipeline lập chỉ mục

```
tệp tải lên ─▶ lib/markdown.js ─▶ lib/chunker.js ─▶ embed() (Voyage) ─▶ Neon (documents.markdown + chunks)
               toMarkdown()        chunkMarkdown()
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
`npm test` (không cần database hay API key) chạy 18 bài kiểm tra cho bước chuyển Markdown và tách đoạn, dùng tệp mẫu trong `test/fixtures/`.

## Nâng cấp từ bản cũ
Khởi động lại là xong: `schema.sql` tự thêm cột `documents.markdown`. Tài liệu đã lập chỉ mục trước đây vẫn tra cứu bình thường nhưng chưa có bản Markdown và nhãn trích dẫn chưa có đường dẫn Chương. Muốn có, tải lại tệp (tắt/xóa bản cũ). Lưu ý: số tự động đánh bằng chức năng đánh số của Word có thể không nằm trong chữ của tệp `.docx`, hãy kiểm tra ở bản Markdown xem trước.

## Chưa có
OCR tự động, trả lời dạng streaming, 👍/👎, giới hạn số câu hỏi mỗi người, đặt lại mật khẩu, lập chỉ mục chạy nền.
