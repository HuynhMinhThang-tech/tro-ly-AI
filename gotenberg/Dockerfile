# Dịch vụ chuyển Word -> PDF cho tab Biểu mẫu khi app chạy trên Vercel (Vercel không cài được LibreOffice).
# Gotenberg = LibreOffice đóng gói sẵn; image đã có font Liberation (cùng kích thước chữ với Times New Roman) nên ngắt dòng gần như giống Word.
# Hướng dẫn triển khai: gotenberg/README.md
FROM gotenberg/gotenberg:9

# Một số nơi chạy (Cloud Run…) không khởi động được container nếu tini không thuộc user chạy dịch vụ.
USER root
RUN chown gotenberg: /usr/bin/tini
USER gotenberg

# API_PORT_FROM_ENV=PORT : nghe đúng cổng do nơi chạy cấp (Cloud Run, Render, Railway… đều đặt biến PORT).
# API_ENABLE_BASIC_AUTH  : bắt buộc đăng nhập. Phải đặt GOTENBERG_API_BASIC_AUTH_USERNAME và GOTENBERG_API_BASIC_AUTH_PASSWORD, thiếu thì dịch vụ không chạy (an toàn hơn là chạy mở).
# API_TIMEOUT            : cho phép LibreOffice khởi động lần đầu mà không bị cắt sớm (mặc định của Gotenberg chỉ 30 giây).
# Các dòng còn lại tắt những thứ app không dùng (Chromium, tải tệp từ URL, webhook) để thu hẹp bề mặt tấn công.
ENV API_PORT_FROM_ENV=PORT \
    API_ENABLE_BASIC_AUTH=true \
    API_TIMEOUT=60s \
    API_START_TIMEOUT=60s \
    LIBREOFFICE_AUTO_START=true \
    CHROMIUM_DISABLE_ROUTES=true \
    API_DISABLE_DOWNLOAD_FROM=true \
    WEBHOOK_DISABLE=true
