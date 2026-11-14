// BƯỚC 3 của pipeline, chạy NỀN: các đoạn đã được ghi vào database (embedding còn trống) → tạo embedding → ghi vector.
// Trạng thái nằm trong database (documents.status = 'processing' | 'ready' | 'error'), nên:
//   - tải lên xong trả lời ngay, không chờ API embedding;
//   - server khởi động lại giữa chừng thì chạy tiếp đúng chỗ dở (chỉ xử lý các đoạn chưa có vector);
//   - lỗi (hết hạn mức, mất mạng...) chỉ đánh dấu tài liệu 'error', admin bấm "Thử lại" để chạy tiếp, không mất đoạn nào.
// Mỗi lần chỉ chạy một tài liệu, mỗi yêu cầu gửi một lô vừa hạn mức (xem embed() trong lib/ingest.js).
const { embed, fitBatch, modelTag } = require('./ingest');

function createIndexer(pool) {
  let running = false;
  const text = r => r.heading + '\n' + r.content;

  async function processDoc(id) {
    for (;;) {
      const { rows } = await pool.query(
        'select id, heading, content from chunks where document_id = $1 and embedding is null order by id limit 128', [id]);
      if (!rows.length) {
        await pool.query("update documents set status = 'ready', error = null where id = $1 and status = 'processing'", [id]);
        return;
      }
      const part = rows.slice(0, fitBatch(rows.map(text)));
      let vecs;
      try { vecs = await embed(part.map(text), 'document'); }
      catch (e) {
        console.error('Lập chỉ mục lỗi (tài liệu ' + id + '):', e.message);
        await pool.query("update documents set status = 'error', error = $2 where id = $1 and status = 'processing'", [id, String(e.message).slice(0, 300)]);
        return;
      }
      await pool.query(
        'update chunks set embedding = v.e::vector, embed_model = $3 from (select unnest($1::bigint[]) as id, unnest($2::text[]) as e) v where chunks.id = v.id',
        [part.map(r => r.id), vecs.map(v => JSON.stringify(v)), modelTag()]);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    let failed = false;
    try {
      for (;;) {
        const d = (await pool.query("select id from documents where status = 'processing' order by created_at limit 1")).rows[0];
        if (!d) break;
        await processDoc(d.id);
      }
    } catch (e) { failed = true; console.error('Bộ lập chỉ mục gặp lỗi:', e.message); }
    finally { running = false; }
    if (failed) setTimeout(run, 30000).unref();             // lỗi database tạm thời: thử lại sau 30 giây
  }

  return { kick: () => { run(); }, isRunning: () => running };
}

module.exports = { createIndexer };
