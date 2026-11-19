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

## Giao diện
Một **thanh bên trái** dùng chung cho mọi tài khoản. Bấm nút ☰ ở thanh trên để thu gọn thành dải biểu tượng hoặc mở rộng (máy tính nhớ lựa chọn của bạn; điện thoại là ngăn kéo, chạm nền mờ hoặc nhấn Esc để đóng):
- **Trò chuyện** và **Biểu mẫu** có ở mọi tài khoản. Khi ở Trò chuyện, thanh bên hiện nút cuộc trò chuyện mới và danh sách gần đây; khi ở Biểu mẫu thì hiện danh sách biểu mẫu để chọn.
- Tài khoản admin có thêm nút chuyển **Người dùng / Quản trị** ở đầu thanh bên. Ở chế độ Quản trị, nhóm **Quản trị** (Tài liệu, Người dùng, Thiết lập bot, Quản lý biểu mẫu, Mô hình AI) hiện ra bên dưới; Trò chuyện và Biểu mẫu vẫn dùng được ngay mà không phải đổi chế độ. Tài khoản thường không thấy nút chuyển lẫn nhóm Quản trị (máy chủ vẫn kiểm tra quyền ở từng API).

## Giới hạn tần suất và thời gian chờ
- Mỗi tài khoản hỏi tối đa **8 câu/phút**, **300 câu/ngày** và **2 câu đang xử lý cùng lúc** (đổi bằng `CHAT_PER_MINUTE`, `CHAT_PER_DAY`, `CHAT_PARALLEL`). Vượt thì báo lời nhắn rõ ràng kèm mã 429. Số đếm lấy từ bảng `messages` nên đúng cả khi chạy nhiều phiên bản; xóa cuộc trò chuyện thì các tin trong đó không còn được đếm.
- Gọi Groq chờ tối đa 45 giây (`GROQ_TIMEOUT_MS`), gọi Voyage 30 giây (`VOYAGE_TIMEOUT_MS`): quá thì báo lỗi; riêng câu hỏi gặp lỗi Voyage vẫn được trả lời bằng tìm kiếm từ khóa.
- `schema.sql` có thêm hai chỉ mục cho `messages` và `conversations` (tự tạo khi khởi động).

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

## Trả lời trong khung chat
- **Hiệu ứng:** khi hỏi, bong bóng hiện vòng xoay "Đang tra cứu tài liệu" rồi "Đã tìm thấy N đoạn liên quan, đang soạn câu trả lời"; câu trả lời được máy chủ gửi về từng mảnh (SSE, `stream: true` trong `POST /api/chat`) và hiện dần ra từng chữ. Bỏ `stream` thì `/api/chat` vẫn trả JSON một lần như cũ.
- **Tham khảo thêm:** khi tài liệu trong kho không có hoặc chưa đủ, hoặc câu hỏi cần văn bản mới nhất / bản gốc, câu trả lời có thêm khung liên kết tới `dulieuphapluat.vn` và `chinhphu.vn/he-thong-van-ban`. AI chỉ chèn dấu hiệu `[[THAM_KHAO]]` (hệ thống gỡ khỏi nội dung), đường link do code quyết định nên không bị bịa. Đổi hoặc thêm trang: sửa `REF_LINKS` trong `lib/refs.js`. Khung này được lưu theo từng tin nhắn (cột `messages.ref`, tự thêm khi khởi động).

## Biểu mẫu tự động điền (tab "Biểu mẫu")
Admin đăng biểu mẫu Word (.docx); người dùng tải Excel/CSV lên, hệ thống điền vào mẫu và xuất Word (.docx) **giữ nguyên định dạng**.

**Admin** (Quản trị → Biểu mẫu): trong Word, tô màu (highlight) đúng những chỗ cần thay rồi tải tệp lên. Hệ thống:
- nhận diện từng vùng tô màu, gợi ý tên trường (theo chữ đứng trước, tiêu đề bảng...), các vùng cùng giá trị (ví dụ số vốn xuất hiện 3 lần) dùng chung một trường;
- tự thêm phần "bằng chữ" đi kèm số tiền dù chưa tô màu, để số và chữ luôn khớp;
- cho bôi đen thêm vùng chưa tô màu (ví dụ "Thời điểm thay đổi vốn");
- cho đặt tên cột, kiểu dữ liệu (chữ, số tiền, phần trăm, ngày, mã số thuế, CCCD), bắt buộc hay không, ví dụ; có nút "Tạo thử" để kiểm tra bố cục.

Nội dung điền vào mỗi vùng viết dạng `{{tên_trường}}` kèm bộ lọc tùy chọn: `upper`, `lower`, `title`, `so` (279.000.000.000), `chu` (hai trăm bảy mươi chín tỷ), `chu_hoa`, `ngay`, `thang`, `nam`, `ngay1`, `thang1`, `dmy`, `ngay_thang_nam`. Ví dụ `{{dia_danh}}, ngày {{ngay_lap|ngay}} tháng {{ngay_lap|thang}} năm {{ngay_lap|nam}}`.

**Người dùng**: chọn biểu mẫu → tải tệp Excel/CSV mẫu → điền → tải lên → kiểm tra đối chiếu cột (AI chỉ gợi ý ghép cột, và chỉ nhận **tiêu đề cột**, không nhận dữ liệu) → xem lỗi từng ô → tạo văn bản (một dòng một tệp, nhiều dòng thành ZIP). Có nút **Hủy / xóa dữ liệu đã tải** và nút ✕ (hoặc "Bỏ các dòng còn lỗi") để loại dòng thiếu dữ liệu. Cũng có chế độ nhập tay.

**Ngắt khoảng (chia biểu mẫu thành khối):** trong bước "2. Các trường dữ liệu và ngắt khoảng", mặc định có một đường kẻ ở đầu và một ở cuối danh sách trường (cả biểu mẫu là một khối). Bấm **＋ Ngắt khoảng ở đây** giữa hai trường để chia khối, đặt tên cho từng khối (VD "Thành viên 1", "Thành viên 2"); bấm **✕ Bỏ ngắt** để gộp lại. Các trường nằm giữa hai đường kẻ là một khối:
- **Nhập tay:** mỗi khối là một nhóm riêng có tiêu đề, đánh số và viền màu, nên thuộc tính của người 1 không còn lẫn với người 2.
- **Excel mẫu:** thêm hàng tên khối (gộp ô, mỗi khối một màu) phía trên hàng tiêu đề, kèm đường dọc đậm ở đầu mỗi khối; trang "Huong dan" có thêm cột "Thuộc khối". Khi đọc lại, hàng tên khối được bỏ đi và dùng để ghép cột: hai cột cùng tên "Chức vụ" của hai khối không bị lẫn, kể cả khi người dùng đổi thứ tự cột. CSV mẫu không có hàng tên khối (vẫn một hàng tiêu đề).
- **Bảng kiểm tra dữ liệu** và ô chọn trường ở bước đối chiếu cột cũng nhóm theo khối.
- Chưa ngắt khoảng thì mọi thứ giữ nguyên như trước. Cấu hình lưu ở `brk` (trường mở khối mới) và `section` (tên khối) trong `templates.config.fields`; không cần đổi database.

**Định dạng và ràng buộc nhập:**
- Nhập tay: ô tiền chỉ nhận chữ số và tự thêm dấu chấm ngăn nghìn (25.000.000.000, kèm "đồng" và dòng "bằng chữ" để đối chiếu); ô tỷ lệ có ký hiệu % và không cho vượt 100; ô ngày luôn là dd/mm/yyyy (tự thêm dấu `/`, có nút lịch, không phụ thuộc ngôn ngữ trình duyệt); mã số thuế và CCCD chỉ nhận chữ số đúng độ dài. Thông báo lỗi lấy từ cùng bộ quy tắc kiểm tra của máy chủ nên luôn khớp với lúc xuất file.
- Tệp Excel mẫu: ô tiền định dạng `#,##0` (Excel hiện dấu chấm nghìn theo máy), ô tỷ lệ hiện %, ô ngày hiện dd/mm/yyyy, ô mã số thuế/CCCD là chữ (không mất số 0 đầu); có chặn nhập sai và hộp gợi ý khi chọn ô. Ví dụ trong CSV mẫu cũng hiện đúng dạng chuẩn.
- Khi đọc Excel, ô định dạng phần trăm thật của Excel (gõ 100% lưu là 1) được quy đổi về 100.

**Vì sao không lệch định dạng:** chỉ chữ bên trong các thẻ `<w:t>` của đúng vùng được chọn bị đổi; mọi thứ khác (kiểu chữ, bảng, lề, đầu/chân trang, font...) chép nguyên từ tệp gốc (`lib/docx-template.js`). Số, chữ, ngày do code xác định, không dùng AI. Dữ liệu người dùng xử lý trong bộ nhớ rồi bỏ; chỉ ghi ai dùng mẫu nào và số dòng (`template_runs`).

**Xuất file:** chỉ xuất Word (.docx), không còn xuất PDF. Muốn có PDF thì mở tệp Word rồi chọn "Lưu thành PDF" trong Word.
- Vercel giới hạn phản hồi của hàm ở 4,5 MB: kết quả lớn hơn `MAX_RESPONSE_MB` (mặc định 4 trên Vercel) sẽ báo lỗi rõ ràng thay vì lỗi mơ hồ. Giới hạn số dòng mỗi lần: `MAX_FORM_ROWS` (50 dòng/lần).

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
- Việc lập chỉ mục chạy nền nằm trong tiến trình của máy chủ. Trên Vercel/serverless, tiến trình có thể bị dừng khi phản hồi đã gửi xong, nên một tài liệu có thể kẹt ở "đang lập chỉ mục" (chưa kiểm chứng trên Vercel; nếu gặp thì tải lại tệp). Muốn chạy bền vững, dùng máy chủ chạy liên tục (Docker, Render).
- Tên, cách xưng hô, giọng điệu, lời chào, câu gợi ý: **Quản trị → Thiết lập bot**.
- Văn bản mới thay văn bản cũ: tải bản mới lên, rồi bấm **Tắt hiệu lực** ở bản cũ.
- Tệp lớn mất nhiều thời gian lập chỉ mục vì xử lý trong một yêu cầu. Giữ `MAX_CHUNKS` ở mức vừa phải.
- Bản scan (không có lớp chữ) bị chặn: cần OCR trước.
- Bot là công cụ hỗ trợ tra cứu, không thay thế ý kiến pháp lý chính thức.

## Kiểm thử
`npm test` chạy 51 bài kiểm tra không cần database hay API key (chuyển Markdown, tách đoạn, bộ giữ nhịp embedding), dùng tệp mẫu trong `test/fixtures/`.

Bài kiểm thử end-to-end (`test/e2e.test.js`: phân quyền admin, lập chỉ mục nền với Voyage giả **thật sự trả 429 nếu vượt hạn mức**, khởi động lại giữa chừng, lỗi và thử lại) chỉ chạy khi có database thử:
```
TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/trolyai_test npm test
```
Tên database bắt buộc chứa chữ `test` vì bài kiểm tra **xóa sạch dữ liệu** trong đó (cần PostgreSQL có pgvector). Không bao giờ trỏ vào database thật.

## Nâng cấp từ bản cũ
Khởi động lại là xong (chạy `npm install` trước vì có thêm thư viện): `schema.sql` tự thêm hàm `vn_fold`, các cột `chunks.content_hash`, `embed_model`, `tsv` (kèm chỉ mục) và hai bảng `templates`, `template_runs`; vector cũ được gán nhãn model đang cấu hình. Lần khởi động đầu có thể mất vài giây nếu kho đã nhiều đoạn. Trước đó `schema.sql` đã tự thêm các cột `documents.markdown`, `status`, `error` (tài liệu cũ mặc định `ready`). Tài liệu đã lập chỉ mục trước đây vẫn tra cứu bình thường nhưng chưa có bản Markdown và nhãn trích dẫn chưa có đường dẫn Chương. Muốn có, tải lại tệp (tắt/xóa bản cũ). Lưu ý: số tự động đánh bằng chức năng đánh số của Word có thể không nằm trong chữ của tệp `.docx`, hãy kiểm tra ở bản Markdown xem trước.

## Chưa có
OCR tự động, trả lời dạng streaming, 👍/👎, đặt lại mật khẩu, đổi thứ tự trường biểu mẫu bằng kéo thả.
