-- Chạy tự động mỗi lần máy chủ khởi động (an toàn khi chạy lại nhiều lần)
create extension if not exists vector;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null default 'user' check (role in ('user','admin')),
  status text not null default 'pending' check (status in ('pending','approved')),
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users on delete cascade,
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  doc_number text,
  filename text,
  content_hash text,
  active boolean not null default true,
  chunk_count int not null default 0,
  created_at timestamptz not null default now()
);
-- Bản Markdown của tệp gốc (kết quả bước chuyển đổi), dùng để xem lại hoặc tách đoạn lại mà không cần tải lên lần nữa
alter table documents add column if not exists markdown text;
-- Trạng thái lập chỉ mục chạy nền. Tài liệu cũ mặc định 'ready'.
alter table documents add column if not exists status text not null default 'ready';
alter table documents add column if not exists error text;
create table if not exists chunks (
  id bigserial primary key,
  document_id uuid not null references documents on delete cascade,
  heading text,
  content text not null,
  embedding vector(1024)
);
create index if not exists chunks_doc_idx on chunks (document_id);
create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  title text,
  created_at timestamptz not null default now()
);
create table if not exists messages (
  id bigserial primary key,
  conversation_id uuid not null references conversations on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  sources jsonb,
  created_at timestamptz not null default now()
);
create table if not exists settings (key text primary key, value jsonb not null);
