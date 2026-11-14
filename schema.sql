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

-- ===== Tìm kiếm lai (từ khóa + ngữ nghĩa) =====
-- vn_fold(): bỏ dấu tiếng Việt, hạ chữ thường. IMMUTABLE nên dùng được trong cột sinh tự động và chỉ mục.
-- Bảng ký tự PHẢI khớp lib/vn.js (test e2e đối chiếu hai bên).
create or replace function vn_fold(t text) returns text language sql immutable parallel safe as $$
  select translate(lower(regexp_replace(coalesce(t, ''), '[\u0300-\u036f]', '', 'g')),
    'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd')
$$;
-- Mã băm nội dung từng đoạn: đoạn trùng với kho thì dùng lại vector, không gọi lại Voyage.
alter table chunks add column if not exists content_hash text;
alter table chunks add column if not exists embed_model text;
update chunks set content_hash = encode(sha256(convert_to(coalesce(heading, '') || E'\n' || content, 'UTF8')), 'hex') where content_hash is null;
create index if not exists chunks_hash_idx on chunks (content_hash) where embedding is not null;
-- Cột tìm kiếm từ khóa (tiêu đề có trọng số cao hơn nội dung). Tài liệu tìm được ngay khi vừa tải lên, không cần chờ embedding.
alter table chunks add column if not exists tsv tsvector generated always as (
  setweight(to_tsvector('simple', vn_fold(heading)), 'A') || setweight(to_tsvector('simple', vn_fold(content)), 'B')
) stored;
create index if not exists chunks_tsv_idx on chunks using gin (tsv);

-- ===== Biểu mẫu tự động điền =====
-- Tệp Word gốc lưu nguyên trong database (vài chục KB; máy chủ serverless không giữ được tệp trên đĩa).
-- config = { slots: [vùng thay thế], fields: [trường dữ liệu], clear_highlight }
create table if not exists templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  filename text,
  file bytea not null,
  config jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Chỉ ghi ai đã dùng biểu mẫu nào, bao nhiêu dòng; KHÔNG lưu dữ liệu người dùng nhập (có thể chứa CCCD, mã số thuế)
create table if not exists template_runs (
  id bigserial primary key,
  template_id uuid references templates on delete set null,
  user_id uuid references users on delete set null,
  row_count int not null,
  format text not null,
  created_at timestamptz not null default now()
);
