# Dịch vụ PDF (Gotenberg) cho app chạy trên Vercel

Vercel không cài được LibreOffice, nên việc chuyển Word → PDF được giao cho một dịch vụ nhỏ chạy riêng: **Gotenberg** (LibreOffice đóng gói sẵn trong Docker). App gọi nó qua HTTPS, có đăng nhập. Thư mục này chứa `Dockerfile` đã cấu hình sẵn.

```
Người dùng ──> App (Vercel) ──HTTPS + tài khoản──> Dịch vụ PDF (Gotenberg) ──> PDF
```

Dịch vụ không lưu tệp giữa các lần gọi. Tệp Word gửi sang có thể chứa thông tin cá nhân (họ tên, CCCD, mã số thuế), nên hãy chọn nơi chạy bạn tin tưởng và luôn bật đăng nhập (đã bật sẵn trong `Dockerfile`).

## Bước 1. Chạy dịch vụ ở một nơi có Docker

Dịch vụ cần nơi chạy được container từ `Dockerfile`, **có địa chỉ HTTPS công khai** và tự cấp biến `PORT` (Cloud Run, Render, Railway… đều có). Dù chọn nơi nào, bạn cần:

| Cài đặt | Giá trị |
|---|---|
| Nguồn | repo này, **thư mục gốc (Root Directory) = `gotenberg`**, dùng `Dockerfile` trong đó |
| Biến môi trường | `GOTENBERG_API_BASIC_AUTH_USERNAME` = tên tùy ý, `GOTENBERG_API_BASIC_AUTH_PASSWORD` = mật khẩu dài, ngẫu nhiên |
| RAM | bắt đầu từ 2 GB; nếu thấy dịch vụ tự khởi động lại hoặc báo hết bộ nhớ thì tăng |
| Vùng (region) | gần vùng chạy hàm của Vercel (xem Vercel → Settings → Functions) để gọi nhanh |

Ví dụ với **Google Cloud Run** (chạy từ thư mục gốc của repo, đã `gcloud auth login` và chọn project):

```bash
gcloud run deploy gotenberg --source gotenberg --region us-east1 --memory 2Gi --max-instances 2 \
  --allow-unauthenticated \
  --set-env-vars GOTENBERG_API_BASIC_AUTH_USERNAME=pdf,GOTENBERG_API_BASIC_AUTH_PASSWORD=DAT-MAT-KHAU-DAI-O-DAY
```

`--allow-unauthenticated` ở đây không có nghĩa là mở: Cloud Run chỉ cho request đi vào, còn đăng nhập do chính Gotenberg kiểm tra (`/health` là đường duy nhất không cần đăng nhập). Với **Render** hoặc **Railway**: tạo dịch vụ Docker từ repo này, đặt Root Directory là `gotenberg`, thêm hai biến môi trường ở trên (giao diện từng nơi có thể khác đôi chút, hãy xem tài liệu của họ).

Thử nhanh khi dịch vụ đã chạy (thay địa chỉ và mật khẩu):

```bash
curl -u pdf:MAT-KHAU https://dia-chi-dich-vu/forms/libreoffice/convert -F files=@mau.docx -o mau.pdf
```

**Dịch vụ "ngủ":** nhiều nơi cho scale về 0 khi không dùng (tiết kiệm nhưng lần gọi đầu chậm vài chục giây). App đã xử lý: khi người dùng mở tab Biểu mẫu, app gọi nhẹ để đánh thức dịch vụ; khi gặp lỗi 502/503/504 hoặc mất kết nối, app tự thử lại một lần. Muốn luôn nhanh thì đặt tối thiểu 1 phiên bản chạy (thường tốn phí).

## Bước 2. Khai báo trên Vercel

Vercel → Project → Settings → Environment Variables, thêm (nên đánh dấu Sensitive cho mật khẩu):

| Biến | Giá trị |
|---|---|
| `GOTENBERG_URL` | địa chỉ HTTPS của dịch vụ, ví dụ `https://gotenberg-xxxx.a.run.app` (không có dấu `/` ở cuối) |
| `GOTENBERG_USER` | đúng `GOTENBERG_API_BASIC_AUTH_USERNAME` ở bước 1 |
| `GOTENBERG_PASSWORD` | đúng `GOTENBERG_API_BASIC_AUTH_PASSWORD` ở bước 1 |

Sau đó **Redeploy** (biến môi trường chỉ có hiệu lực với bản triển khai mới).

## Bước 3. Kiểm tra

Đăng nhập admin → tab Biểu mẫu → hộp **Xuất PDF** ở đầu trang. Hộp này chuyển thử một tệp Word thật qua dịch vụ nên báo được: *Sẵn sàng* (kèm thời gian), hay *sai tài khoản*, *không kết nối được*, *quá thời gian*… Bấm **Kiểm tra lại** sau mỗi lần đổi cấu hình. Khi Sẵn sàng, các nút PDF và "Cả hai" của người dùng tự mở.

## Giới hạn cần biết trên Vercel

- Phản hồi của một hàm tối đa **4,5 MB**. Khi kết quả (một tệp hoặc tệp ZIP) vượt quá 4 MB, app báo lỗi rõ ràng và gợi ý chọn ít dòng hơn hoặc chỉ xuất Word (đổi bằng `MAX_RESPONSE_MB`). Mỗi tệp PDF của một biểu mẫu thường chỉ vài chục đến vài trăm KB nên hiếm khi chạm giới hạn này.
- Thời gian tối đa của một hàm là 300 giây, đủ cho `MAX_PDF_ROWS=10` dòng mỗi lần (mỗi tệp mất vài giây).
- Tệp tải lên (ví dụ tệp Word mẫu) cũng bị giới hạn 4,5 MB mỗi request.

## Chạy thử trên máy (Windows)

- Cách 1: cài LibreOffice (<https://www.libreoffice.org>), app tự tìm `soffice.exe`. Không cần đặt `GOTENBERG_URL`.
- Cách 2: cài Docker Desktop rồi chạy `docker run --rm -p 3001:3000 gotenberg/gotenberg:9` và đặt `GOTENBERG_URL=http://localhost:3001` trong `.env` (cổng 3001 để không trùng cổng 3000 của app).
