// API cho tab "Biểu mẫu": admin tải mẫu Word, người dùng tải Excel/CSV lên để điền tự động và xuất Word/PDF.
const JSZip = require('jszip');
const { scanDocx, validateConfig, fillDocx } = require('./docx-template');
const { normalizeValue, defaultText, TYPES, KEY_RE } = require('./forms');
const { readTable, autoMap, sampleXlsx, sampleCsv, MAX_ROWS } = require('./tabular');
const pdf = require('./pdf');
const { slug } = require('./vn');

const MAX_PDF_ROWS = +process.env.MAX_PDF_ROWS || 10;
const str = (v, n) => String(v ?? '').slice(0, n);
const fixName = n => { try { const u = Buffer.from(String(n), 'latin1').toString('utf8'); return u.includes('\uFFFD') ? String(n) : u; } catch { return String(n); } };

/** Chỉ giữ các thuộc tính hợp lệ của cấu hình do trình duyệt gửi lên (không tin dữ liệu từ client). */
function cleanConfig(c) {
  c = c && typeof c === 'object' ? c : {};
  const slots = (Array.isArray(c.slots) ? c.slots : []).slice(0, 400).map((s, i) => ({
    id: str(s.id || 's' + (i + 1), 20), src: ['highlight', 'auto', 'manual'].includes(s.src) ? s.src : 'manual', part: str(s.part, 60),
    p: Number.isInteger(s.p) ? s.p : -1, start: Number.isInteger(s.start) ? s.start : -1, end: Number.isInteger(s.end) ? s.end : -1,
    text: str(s.text, 3000), format: str(s.format, 2000), enabled: s.enabled !== false
  }));
  const fields = (Array.isArray(c.fields) ? c.fields : []).slice(0, 150).map(f => ({
    key: str(f.key, 60), label: str(f.label || f.key, 120), type: TYPES[f.type] ? f.type : 'text', required: f.required !== false, example: str(f.example, 200)
  }));
  return { slots, fields, clear_highlight: c.clear_highlight !== false };
}
const parseJSON = s => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };

/** Đánh giá một dòng dữ liệu thô theo danh sách trường → giá trị chuẩn hóa, lỗi từng trường, và chữ hiển thị. */
function evalRow(fields, raw) {
  const values = Object.create(null), issues = {}, shown = {};
  for (const f of fields) {
    const v = raw && Object.prototype.hasOwnProperty.call(raw, f.key) ? raw[f.key] : '';
    const r = normalizeValue(f, typeof v === 'object' && v !== null ? '' : v);
    if (r.error) issues[f.key] = r.error; else { values[f.key] = r.value; shown[f.key] = defaultText(f, r.value); }
  }
  return { values, issues, shown };
}
const disposition = name => `attachment; filename="${name.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function mountTemplates(app, { pool, auth, admin, up, groqKey, GROQ, getSettings, DEFAULT_MODEL }) {
  const load = async (id, onlyActive) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows: [t] } = await pool.query('select * from templates where id = $1' + (onlyActive ? ' and active' : ''), [id]);
    return t || null;
  };
  const fieldsOf = t => (t.config && t.config.fields) || [];

  // ================= Quản trị =================
  app.get('/api/admin/templates', auth, admin, async (q, r) => {
    const { rows } = await pool.query(`select id, name, description, filename, active, created_at, updated_at,
      jsonb_array_length(coalesce(config->'fields', '[]'::jsonb)) as field_count, jsonb_array_length(coalesce(config->'slots', '[]'::jsonb)) as slot_count
      from templates order by created_at desc`);
    r.json({ templates: rows, pdf: pdf.available(), types: TYPES });
  });

  // Quét tệp Word: nhận diện vùng tô màu, gợi ý trường (chưa lưu gì)
  app.post('/api/admin/templates/scan', auth, admin, up.single('file'), async (q, r) => {
    if (!q.file || !/\.docx$/i.test(q.file.originalname)) return r.status(400).json({ error: 'Hãy chọn tệp Word đuôi .docx.' });
    try { r.json({ filename: fixName(q.file.originalname), ...(await scanDocx(q.file.buffer)), clear_highlight: true }); }
    catch (e) { r.status(400).json({ error: e.message }); }
  });

  app.post('/api/admin/templates', auth, admin, up.single('file'), async (q, r) => {
    if (!q.file || !/\.docx$/i.test(q.file.originalname)) return r.status(400).json({ error: 'Hãy chọn tệp Word đuôi .docx.' });
    const cfg = cleanConfig(parseJSON(q.body.config)), errs = await validateConfig(q.file.buffer, cfg).catch(e => [e.message]);
    if (errs.length) return r.status(422).json({ error: errs[0], errors: errs });
    if (!cfg.fields.length) return r.status(422).json({ error: 'Biểu mẫu cần có ít nhất một vùng thay thế.' });
    const fname = fixName(q.file.originalname), name = str(q.body.name, 120).trim() || fname.replace(/\.docx$/i, '');
    const { rows: [t] } = await pool.query('insert into templates(name, description, filename, file, config) values ($1,$2,$3,$4,$5) returning id',
      [name, str(q.body.description, 500).trim(), fname, q.file.buffer, cfg]);
    r.status(201).json({ id: t.id });
  });

  // Tạo thử bằng dữ liệu ví dụ (mẫu chưa lưu: gửi kèm file; mẫu đã lưu: gửi id). Dùng để admin kiểm tra trước khi cho người dùng dùng.
  app.post('/api/admin/templates/test', auth, admin, up.single('file'), async (q, r) => {
    let buf = q.file && q.file.buffer, cfg = cleanConfig(parseJSON(q.body.config));
    if (!buf && q.body.id) { const t = await load(String(q.body.id)); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' }); buf = t.file; if (!q.body.config) cfg = t.config; }
    if (!buf) return r.status(400).json({ error: 'Thiếu tệp mẫu.' });
    const errs = await validateConfig(buf, cfg).catch(e => [e.message]);
    if (errs.length) return r.status(422).json({ error: errs[0], errors: errs });
    const ex = {}; cfg.fields.forEach(f => { ex[f.key] = f.example; });
    const { values, issues } = evalRow(cfg.fields.map(f => ({ ...f, required: false })), ex);
    const bad = Object.keys(issues);
    if (bad.length) return r.status(422).json({ error: `Giá trị ví dụ của trường "${bad[0]}" chưa hợp lệ: ${issues[bad[0]]}` });
    const wantPdf = q.body.format === 'pdf';
    try {
      let out = await fillDocx(buf, cfg, values, { clearHighlight: cfg.clear_highlight !== false });
      if (wantPdf) out = await pdf.docxToPdf(out, 'thu.docx');
      r.set('Content-Type', wantPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      r.set('Content-Disposition', disposition(wantPdf ? 'bieu-mau-thu.pdf' : 'bieu-mau-thu.docx')); r.send(out);
    } catch (e) { r.status(e.code === 'NO_PDF' ? 501 : 422).json({ error: e.message }); }
  });

  app.get('/api/admin/templates/:id', auth, admin, async (q, r) => {
    const t = await load(q.params.id); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    const sc = await scanDocx(t.file).catch(() => ({ paragraphs: [], parts: [] }));
    r.json({ id: t.id, name: t.name, description: t.description, filename: t.filename, active: t.active, config: t.config, paragraphs: sc.paragraphs, parts: sc.parts, pdf: pdf.available() });
  });
  app.get('/api/admin/templates/:id/file', auth, admin, async (q, r) => {
    const t = await load(q.params.id); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    r.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); r.set('Content-Disposition', disposition(t.filename || 'bieu-mau.docx')); r.send(t.file);
  });
  app.put('/api/admin/templates/:id', auth, admin, async (q, r) => {
    const t = await load(q.params.id); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    const b = q.body || {}; let cfg = t.config;
    if (b.config) {
      cfg = cleanConfig(b.config); const errs = await validateConfig(t.file, cfg).catch(e => [e.message]);
      if (errs.length) return r.status(422).json({ error: errs[0], errors: errs });
    }
    await pool.query('update templates set name = $2, description = $3, active = $4, config = $5, updated_at = now() where id = $1',
      [t.id, str(b.name ?? t.name, 120).trim() || t.name, str(b.description ?? t.description, 500).trim(), b.active === undefined ? t.active : !!b.active, cfg]);
    r.json({ ok: true });
  });
  app.delete('/api/admin/templates/:id', auth, admin, async (q, r) => {
    const t = await load(q.params.id); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    await pool.query('delete from templates where id = $1', [t.id]); r.json({ ok: true });
  });

  // ================= Người dùng =================
  app.get('/api/templates', auth, async (q, r) => {
    const { rows } = await pool.query('select id, name, description, config from templates where active order by name');
    r.json({ pdf: pdf.available(), max_rows: MAX_ROWS, max_pdf_rows: MAX_PDF_ROWS, types: TYPES,
      templates: rows.map(t => ({ id: t.id, name: t.name, description: t.description, fields: fieldsOf(t) })) });
  });

  app.get('/api/templates/:id/sample', auth, async (q, r) => {
    const t = await load(q.params.id, true); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    const fields = fieldsOf(t), base = 'du-lieu-mau_' + slug(t.name, 30);
    if (q.query.format === 'csv') { r.set('Content-Type', 'text/csv; charset=utf-8'); r.set('Content-Disposition', disposition(base + '.csv')); return r.send(sampleCsv(fields)); }
    r.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); r.set('Content-Disposition', disposition(base + '.xlsx')); r.send(await sampleXlsx(fields));
  });

  // Đọc tệp Excel/CSV người dùng tải lên, tự ghép cột; trình duyệt cho người dùng chỉnh lại ghép cột rồi gọi /check
  app.post('/api/templates/:id/parse', auth, up.single('file'), async (q, r) => {
    const t = await load(q.params.id, true); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    if (!q.file) return r.status(400).json({ error: 'Chưa chọn tệp.' });
    try {
      const { headers, rows } = await readTable(q.file.buffer, fixName(q.file.originalname));
      r.json({ headers, rows, mapping: autoMap(headers, fieldsOf(t)) });
    } catch (e) { r.status(400).json({ error: e.message }); }
  });

  // Nhờ AI ghép các cột còn lại. CHỈ gửi tiêu đề cột và định nghĩa trường cho AI, không gửi dữ liệu trong bảng.
  app.post('/api/templates/:id/map-ai', auth, async (q, r) => {
    const t = await load(q.params.id, true); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    const key = await groqKey(); if (!key) return r.status(503).json({ error: 'Chưa cấu hình khóa Groq nên chưa dùng được gợi ý bằng AI.' });
    const headers = (Array.isArray(q.body.headers) ? q.body.headers : []).slice(0, 80).map(h => str(h, 100));
    const taken = new Set(Array.isArray(q.body.taken) ? q.body.taken : []);
    const free = fieldsOf(t).filter(f => !taken.has(f.key));
    if (!headers.length || !free.length) return r.json({ mapping: {} });
    const s = await getSettings();
    const res = await fetch(GROQ + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30e3),
      body: JSON.stringify({ model: s.groq_model || DEFAULT_MODEL, temperature: 0, max_tokens: 800, messages: [
        { role: 'system', content: 'Bạn ghép tiêu đề cột của một bảng dữ liệu với các trường của biểu mẫu. Chỉ trả về một đối tượng JSON dạng {"mapping": {"<tiêu đề cột>": "<mã trường hoặc null>"}}. Mỗi mã trường dùng tối đa một lần. Nếu không chắc chắn thì trả null. Không giải thích.' },
        { role: 'user', content: JSON.stringify({ truong: free.map(f => ({ ma: f.key, ten: f.label, kieu: f.type })), tieu_de_cot: headers }) }] })
    }).catch(() => null);
    if (!res || !res.ok) return r.status(502).json({ error: 'Dịch vụ AI đang bận, bạn hãy ghép cột thủ công hoặc thử lại sau.' });
    let m = {}; try { const txt = (await res.json()).choices[0].message.content; m = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)).mapping || {}; } catch { /* trả rỗng */ }
    const ok = new Set(free.map(f => f.key)), used = new Set(), out = {};
    for (const h of headers) { const k = m[h]; if (typeof k === 'string' && ok.has(k) && !used.has(k)) { out[h] = k; used.add(k); } }
    r.json({ mapping: out });
  });

  // Kiểm tra dữ liệu: trả về lỗi từng ô và chữ sẽ được điền
  app.post('/api/templates/:id/check', auth, async (q, r) => {
    const t = await load(q.params.id, true); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    const rows = Array.isArray(q.body.rows) ? q.body.rows.slice(0, MAX_ROWS) : [], f = fieldsOf(t);
    const out = rows.map(raw => { const { issues, shown } = evalRow(f, raw); return { issues, shown }; });
    r.json({ rows: out, ok: out.length > 0 && out.every(x => !Object.keys(x.issues).length) });
  });

  app.post('/api/templates/:id/generate', auth, async (q, r) => {
    const t = await load(q.params.id, true); if (!t) return r.status(404).json({ error: 'Không tìm thấy biểu mẫu.' });
    const f = fieldsOf(t), rows = Array.isArray(q.body.rows) ? q.body.rows : [], fmt = ['docx', 'pdf', 'both'].includes(q.body.format) ? q.body.format : 'docx';
    if (!rows.length) return r.status(400).json({ error: 'Chưa có dòng dữ liệu nào.' });
    if (rows.length > MAX_ROWS) return r.status(400).json({ error: `Tối đa ${MAX_ROWS} dòng mỗi lần.` });
    if (fmt !== 'docx') {
      if (!pdf.available()) return r.status(501).json({ error: 'Máy chủ chưa hỗ trợ xuất PDF. Hãy tải bản Word (.docx) rồi chọn "Lưu thành PDF" trong Word.' });
      if (rows.length > MAX_PDF_ROWS) return r.status(400).json({ error: `Xuất PDF tối đa ${MAX_PDF_ROWS} dòng mỗi lần (mỗi tệp mất vài giây). Hãy tải Word hoặc chia nhỏ.` });
    }
    const evals = rows.map(raw => evalRow(f, raw)), bad = evals.findIndex(e => Object.keys(e.issues).length);
    if (bad >= 0) return r.status(422).json({ error: `Dòng ${bad + 1} còn lỗi dữ liệu: ${Object.values(evals[bad].issues)[0]}`, row: bad + 1 });
    const nameField = f.find(x => x.type === 'text' && /^ten_/.test(x.key));
    const files = [];
    try {
      for (let i = 0; i < evals.length; i++) {
        const nm = nameField && evals[i].values[nameField.key] ? slug(String(evals[i].values[nameField.key]), 40) : '';
        const base = slug(t.name, 30) + '_' + (nm || String(i + 1).padStart(2, '0'));
        const docx = await fillDocx(t.file, t.config, evals[i].values, { clearHighlight: t.config.clear_highlight !== false });
        if (fmt !== 'pdf') files.push({ name: base + '.docx', data: docx });
        if (fmt !== 'docx') files.push({ name: base + '.pdf', data: await pdf.docxToPdf(docx, base + '.docx') });
      }
    } catch (e) { return r.status(e.code === 'NO_PDF' ? 501 : 500).json({ error: 'Không tạo được văn bản: ' + e.message }); }
    await pool.query('insert into template_runs(template_id, user_id, row_count, format) values ($1,$2,$3,$4)', [t.id, q.me.id, rows.length, fmt]).catch(() => { });
    if (files.length === 1) {
      r.set('Content-Type', files[0].name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      r.set('Content-Disposition', disposition(files[0].name)); return r.send(files[0].data);
    }
    const zip = new JSZip(), seen = new Map();
    for (const x of files) {   // tên trùng (cùng tên doanh nghiệp) thì thêm số thứ tự
      const n = seen.get(x.name) || 0; seen.set(x.name, n + 1);
      zip.file(n ? x.name.replace(/(\.\w+)$/, `_${n + 1}$1`) : x.name, x.data);
    }
    r.set('Content-Type', 'application/zip'); r.set('Content-Disposition', disposition(slug(t.name, 30) + '.zip'));
    r.send(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  });
}

module.exports = { mountTemplates, cleanConfig, evalRow };
