# Trợ lý AI – Chatbot hỏi đáp tài liệu nội bộ

Node.js (Express) · **Neon** (Postgres + pgvector) · **Voyage AI** (embedding) · **Groq Cloud** (mô hình trả lời).
Tên, giọng điệu của trợ lý do quản trị viên đặt trong giao diện, không gắn tên riêng.

## Cách hoạt động
1. Admin chọn tệp **Markdown (.md) hoặc văn bản (.txt)** → hệ thống **đọc nguyên văn, không chuyển đổi gì** rồi **quét trước** (chưa lưu gì). Tệp định dạng khác (PDF, Word, HTML...) bị từ chối kèm thông báo yêu cầu chuyển sang `.md` hoặc `.txt`. Tệp chỉ tải lên **một lần**: kết quả quét được giữ ở máy chủ 20 phút, bước xác nhận chỉ gửi mã quét. Admin xem báo cáo và nội dung xem trước rồi xác nhận.
2. Nội dung được tách đoạn theo cây tiêu đề Markdown (**Chương › Mục › Điều**) và ghi vào Neon **ngay lập tức** (trả lời trong chưa đầy 1 giây).
3. Embedding (Voyage) chạy **nền**, từng lô nhỏ đúng hạn mức, có thanh tiến độ trong bảng tài liệu. Tài liệu **tìm được bằng từ khóa ngay khi vừa tải lên**; tìm theo ngữ nghĩa (vector) bổ sung dần khi embedding xong (xem "Tìm kiếm lai").
3. Người dùng hỏi → tìm 6 đoạn liên quan nhất (chỉ trong văn bản còn hiệu lực) → model Groq trả lời, ghi nhãn [số] và hiện nguồn.
4. Đăng ký → **chờ duyệt** → admin duyệt mới đăng nhập được. Mật khẩu băm bcrypt, phiên là token ngẫu nhiên lưu bản băm trong database.

## Pipeline lập chỉ mục

```
tệp .md/.txt ─▶ lib/markdown.js ─▶ lib/chunker.js ─▶ ghi Neon ─▶ lib/indexer.js (NỀN) ─▶ embedding Voyage
                 readTextFile()     chunkMarkdown()   documents + chunks   từng lô nhỏ, giữ nhịp 3 RPM/10K TPM
```

Hệ thống **không chuyển đổi** định dạng. Chỉ nhận `.md`, `.markdown`, `.txt` (UTF-8); BOM và xuống dòng Windows (CRLF) được chuẩn hóa, nội dung còn lại giữ nguyên. Muốn dùng PDF/Word, hãy chuyển sang Markdown hoặc txt bằng công cụ bên ngoài trước khi tải lên.

**Tách đoạn** (`chunkMarkdown`) dựa vào các dòng tiêu đề Markdown (`#`, `##`, `###`, `####`). Với tệp `.md` đã có tiêu đề (ví dụ `## Chương I`, `#### Điều 1.`), mỗi Điều/mục là một đơn vị riêng, không bao giờ gộp hai Điều vào một đoạn, và nhãn trích dẫn là đường dẫn đầy đủ như `Chương I – QUY ĐỊNH CHUNG › Điều 12. Ngày toàn dân…`. Tệp `.txt` không có dòng tiêu đề `#` sẽ được cắt theo độ dài đoạn và trích dẫn không có tên mục. Mục dài (mặc định > 1800 ký tự, đổi bằng `CHUNK_MAX_CHARS`) được tách ở ranh giới Khoản/điểm và đánh dấu `(phần 1/3)`; bảng được giữ nguyên, bảng quá dài tách theo hàng và lặp lại hàng tiêu đề; chỉ khi một đoạn văn đơn lẻ vẫn quá dài mới tách theo câu (có gối đầu), cuối cùng mới cắt cứng.

## Lập chỉ mục nền và hạn mức Voyage
Gói Voyage **chưa thanh toán** chỉ cho **3 yêu cầu/phút và 10.000 token/phút**. Một bộ luật dài (~75 đoạn, ~45.000 token) vẫn lập chỉ mục được, chỉ mất khoảng **5 phút chạy nền** (admin không phải chờ). Hệ thống chia lô theo token, chờ đủ chỗ trong hạn mức trước khi gửi và luôn chừa lại 1 yêu cầu/phút cho câu hỏi của người dùng nên chatbot vẫn trả lời bình thường trong lúc lập chỉ mục. Báo cáo quét hiển thị thời gian ước tính.

**Câu hỏi của người dùng cũng tốn 1 yêu cầu Voyage mỗi câu**, nên ở gói chưa thanh toán chatbot chỉ trả lời tối đa khoảng 3 câu hỏi *khác nhau* mỗi phút. Câu hỏi giống hệt câu đã hỏi (sau khi chuẩn hóa chữ hoa/khoảng trắng) dùng lại kết quả cũ, không tốn thêm yêu cầu. Vượt hạn mức thì chatbot báo rõ "thử lại sau khoảng N giây" thay vì lỗi chung. Nếu thấy lỗi khác, thông báo sẽ cho biết đó là lỗi Voyage, sai API key Voyage hay lỗi database, và nguyên nhân chi tiết nằm trong log máy chủ.

Muốn nhanh hơn: thêm phương thức thanh toán ở Voyage rồi đặt `EMBED_RPM` và `EMBED_TPM` theo hạn mức ghi trên trang Voyage của bạn (xem `.env.example`). Hạn mức Voyage hiện hành do Voyage quy định và có thể thay đổi, hãy đối chiếu trên trang của họ.

## Tìm kiếm lai (từ khóa + ngữ nghĩa)
Mỗi câu hỏi đi qua ba nguồn (`lib/search.js`), rồi gộp bằng RRF và lấy 6 đoạn tốt nhất gửi cho AI:
1. **"Điều N"**: câu hỏi nhắc "Điều 12", "điều 5 và 6", "Điều 78a" thì tra thẳng theo tiêu đề đoạn bằng SQL, không cần embedding, nên chính xác tuyệt đối. Nếu câu hỏi nêu tên luật hoặc số hiệu thì chỉ giữ điều của văn bản đó.
2. **Từ khóa** (full-text của Postgres, bỏ dấu, cộng điểm cho cụm hai từ liền nhau): tìm được ngay cả tài liệu **đang lập chỉ mục** và khi Voyage đang bận.
3. **Ngữ nghĩa** (pgvector): hiểu câu hỏi diễn đạt khác với văn bản. Dùng `hnsw.ef_search = 100`, và quét lặp (`iterative_scan`) khi pgvector từ 0.8 trở lên, để bộ lọc "còn hiệu lực" không làm thiếu kết quả.

Nếu không tạo được vector cho câu hỏi (Voyage bận, lỗi hoặc chưa cấu hình khóa), chatbot **vẫn trả lời bằng từ khóa** và kèm một dòng lưu ý cho người dùng, thay vì báo lỗi.

**Dùng lại vector:** mỗi đoạn có `content_hash` (SHA-256 của tiêu đề + nội dung). Khi tải lên tài liệu có đoạn y hệt đoạn đã lập chỉ mục (ví dụ bản sửa đổi của một văn bản), vector được chép lại, không tốn lượt Voyage. Báo cáo quét tệp cho biết số đoạn dùng lại và thời gian ước tính chỉ tính phần còn lại. Chỉ dùng lại vector của đúng model đang chạy (`chunks.embed_model`).

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

## Biểu mẫu tự động điền (tab "Biểu mẫu")
Admin đăng biểu mẫu Word (.docx); người dùng tải Excel/CSV lên, hệ thống điền vào mẫu và xuất Word/PDF **giữ nguyên định dạng**.

**Admin** (Quản trị → Biểu mẫu): trong Word, tô màu (highlight) đúng những chỗ cần thay rồi tải tệp lên. Hệ thống:
- nhận diện từng vùng tô màu, gợi ý tên trường (theo chữ đứng trước, tiêu đề bảng...), các vùng cùng giá trị (ví dụ số vốn xuất hiện 3 lần) dùng chung một trường;
- tự thêm phần "bằng chữ" đi kèm số tiền dù chưa tô màu, để số và chữ luôn khớp;
- cho bôi đen thêm vùng chưa tô màu (ví dụ "Thời điểm thay đổi vốn");
- cho đặt tên cột, kiểu dữ liệu (chữ, số tiền, phần trăm, ngày, mã số thuế, CCCD), bắt buộc hay không, ví dụ; có nút "Tạo thử" để kiểm tra bố cục.

Nội dung điền vào mỗi vùng viết dạng `{{tên_trường}}` kèm bộ lọc tùy chọn: `upper`, `lower`, `title`, `so` (279.000.000.000), `chu` (hai trăm bảy mươi chín tỷ), `chu_hoa`, `ngay`, `thang`, `nam`, `ngay1`, `thang1`, `dmy`, `ngay_thang_nam`. Ví dụ `{{dia_danh}}, ngày {{ngay_lap|ngay}} tháng {{ngay_lap|thang}} năm {{ngay_lap|nam}}`.

**Người dùng**: chọn biểu mẫu → tải tệp Excel/CSV mẫu → điền → tải lên → kiểm tra đối chiếu cột (AI chỉ gợi ý ghép cột, và chỉ nhận **tiêu đề cột**, không nhận dữ liệu) → xem lỗi từng ô → tạo văn bản (một dòng một tệp, nhiều dòng thành ZIP). Cũng có chế độ nhập tay.

**Vì sao không lệch định dạng:** chỉ chữ bên trong các thẻ `<w:t>` của đúng vùng được chọn bị đổi; mọi thứ khác (kiểu chữ, bảng, lề, đầu/chân trang, font...) chép nguyên từ tệp gốc (`lib/docx-template.js`). Số, chữ, ngày do code xác định, không dùng AI. Dữ liệu người dùng xử lý trong bộ nhớ rồi bỏ; chỉ ghi ai dùng mẫu nào và số dòng (`template_runs`).

**Xuất PDF** cần LibreOffice trên máy chủ (hoặc một dịch vụ Gotenberg):
- Máy có LibreOffice: tự phát hiện lệnh `soffice` (hoặc đặt `SOFFICE_PATH`).
- Máy chủ khác: đặt `GOTENBERG_URL=http://...` (Gotenberg là LibreOffice đóng gói sẵn).
- Triển khai bằng Docker: dùng `Dockerfile` kèm theo (đã cài LibreOffice và font Liberation, tương thích Times New Roman).
- Không có cả hai (ví dụ Vercel/Render bản Node thường): giao diện tự khóa lựa chọn PDF, vẫn xuất Word; người dùng mở Word và chọn "Lưu thành PDF".
PDF do LibreOffice dựng nên ngắt dòng có thể lệch rất nhẹ so với Word nếu máy chủ thiếu font Times New Roman. Giới hạn: `MAX_FORM_ROWS` (50 dòng/lần), `MAX_PDF_ROWS` (10 dòng/lần).

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
Khởi động lại là xong (chạy `npm install` trước vì có thêm thư viện): `schema.sql` tự thêm hàm `vn_fold`, các cột `chunks.content_hash`, `embed_model`, `tsv` (kèm chỉ mục) và hai bảng `templates`, `template_runs`; vector cũ được gán nhãn model đang cấu hình. Lần khởi động đầu có thể mất vài giây nếu kho đã nhiều đoạn. Trước đó `schema.sql` đã tự thêm các cột `documents.markdown`, `status`, `error` (tài liệu cũ mặc định `ready`). Tài liệu đã lập chỉ mục trước đây vẫn tra cứu bình thường nhưng chưa có bản Markdown và nhãn trích dẫn chưa có đường dẫn Chương. Muốn có, tải lại tệp (tắt/xóa bản cũ). Lưu ý: số tự động đánh bằng chức năng đánh số của Word có thể không nằm trong chữ của tệp `.docx`, hãy kiểm tra ở bản Markdown xem trước.

## Chưa có
OCR tự động, trả lời dạng streaming, 👍/👎, giới hạn số câu hỏi mỗi người, đặt lại mật khẩu, lập chỉ mục chạy nền.
