# Dùng khi cần xuất PDF cho tab Biểu mẫu (LibreOffice + font tương thích Times New Roman).
# Ví dụ trên Render: tạo Web Service kiểu "Docker" trỏ vào repo này.
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-writer fonts-liberation fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
