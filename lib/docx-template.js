// Động cơ biểu mẫu Word (.docx).
//
// NGUYÊN TẮC GIỮ NGUYÊN ĐỊNH DẠNG: tệp .docx là một gói XML. Ta chỉ đổi CHỮ bên trong các thẻ <w:t> của đúng những vùng được chọn;
// mọi thứ khác (kiểu chữ, đoạn, bảng, lề, đầu/chân trang, số trang, font, ảnh...) được chép nguyên bản, không dựng lại tài liệu.
//
// Vùng cần thay = "slot": một khoảng ký tự [start, end) trong một đoạn văn. Mặc định được nhận diện từ phần chữ TÔ MÀU (highlight)
// trong Word; admin có thể thêm vùng thủ công. Mỗi slot có "format" – chuỗi mẫu như "{{ten_cong_ty|upper}}" – xem lib/forms.js.
const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { fold, slug } = require('./vn');
const { renderFormat, refsOf, checkFormat, KEY_RE, TYPES } = require('./forms');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PART_RE = /^word\/(document|header\d*|footer\d*)\.xml$/;
const CONTAINERS = ['hyperlink', 'smartTag', 'ins', 'sdt', 'sdtContent', 'customXml', 'fldSimple'];

const isW = (n, name) => n && n.nodeType === 1 && n.namespaceURI === W && n.localName === name;
const kids = n => Array.from(n.childNodes).filter(c => c.nodeType === 1);
const wAttr = (n, a) => n.getAttributeNS(W, a) || n.getAttribute('w:' + a) || '';

// ---------- Mô hình đoạn văn ----------
function collectRuns(node, out) {
  for (const c of kids(node)) {
    if (isW(c, 'r')) out.push(c);
    else if (CONTAINERS.some(n => isW(c, n))) collectRuns(c, out);     // không đi vào đoạn lồng (hộp văn bản) hay phần đã xóa (w:del)
  }
}
function runSig(rPr) {   // chữ ký định dạng của run, bỏ qua tô màu / ngôn ngữ / mã sửa đổi
  if (!rPr) return '';
  return kids(rPr).filter(k => !['highlight', 'lang', 'noProof', 'rPrChange', 'iCs', 'bCs', 'szCs'].some(n => isW(k, n)))
    .map(k => k.localName + '(' + Array.from(k.attributes).filter(a => !/rsid/i.test(a.name)).map(a => a.name + '=' + a.value).sort().join(',') + ')').sort().join(';');
}
const tText = r => kids(r).filter(k => isW(k, 't')).map(k => k.textContent).join('');
/** Mô hình của một đoạn: các run "chỉ có chữ" kèm vị trí ký tự; run đặc biệt (tab, xuống dòng, ảnh, trường...) không tính vào văn bản. */
function paraModel(p) {
  const els = []; collectRuns(p, els);
  const runs = []; let off = 0, text = '';
  for (const el of els) {
    const content = kids(el).filter(k => !isW(k, 'rPr'));
    const textOnly = content.every(k => isW(k, 't') || isW(k, 'lastRenderedPageBreak'));
    const rPr = kids(el).find(k => isW(k, 'rPr'));
    const hlEl = rPr && kids(rPr).find(k => isW(k, 'highlight')), hlv = hlEl ? wAttr(hlEl, 'val') : '';
    const t = textOnly ? tText(el) : '';
    runs.push({ el, special: !textOnly, text: t, off, hl: !!hlEl && hlv !== 'none', sig: runSig(rPr) });
    off += t.length; text += t;
  }
  return { runs, text, el: p };
}

// ---------- Ngữ cảnh (nhãn) để gợi ý tên trường ----------
const cellText = tc => Array.from(tc.getElementsByTagNameNS(W, 't')).map(t => t.textContent).join('').replace(/\s+/g, ' ').trim();
const noParen = s => s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
function tableContext(p) {
  let n = p.parentNode; while (n && !isW(n, 'tc')) n = n.parentNode;
  if (!n) return null;
  const tr = n.parentNode, tbl = tr && tr.parentNode, cells = kids(tr).filter(k => isW(k, 'tc')), idx = cells.indexOf(n);
  const first = tbl && kids(tbl).find(k => isW(k, 'tr')), head = first ? kids(first).filter(k => isW(k, 'tc'))[idx] : null;
  const row = cells.slice(0, idx).map(cellText).find(t => t && !/^[\d.\s]+$/.test(t)) || '';
  const col = head && head !== n ? noParen(cellText(head)).split(' ').slice(0, 3).join(' ') : '';
  return [row, col].filter(Boolean).join(' – ');
}
function prevParagraphLabel(p) {   // đoạn liền trước có chữ trong cùng khung (vd "NGƯỜI ĐẠI DIỆN THEO PHÁP LUẬT" phía trên chỗ ký tên)
  for (let n = p.previousSibling; n; n = n.previousSibling) {
    if (!isW(n, 'p')) continue;
    const t = noParen(Array.from(n.getElementsByTagNameNS(W, 't')).map(x => x.textContent).join('')).replace(/[\/\d]+/g, ' ').replace(/[:：\s\-–]+$/, '').replace(/\s+/g, ' ').trim();
    if (t) return t.split(/\s+/).slice(0, 6).join(' ');
  }
  return '';
}
function labelBefore(text, start) {
  const before = noParen(text.slice(0, start)).replace(/[:：\s\-–]+$/, '');
  const last = before.split(/[.;!?]\s+/).pop().trim();
  return last.split(/\s+/).slice(-7).join(' ');
}

// ---------- Phân tích một vùng chữ → gợi ý nội dung thay thế ----------
const HINT_KEYS = { so: 'so_van_ban', ong: 'danh_xung', ba: 'danh_xung' };
const KEY_LABELS = { so_van_ban: 'Số văn bản', danh_xung: 'Danh xưng (Ông/Bà)', ngay_lap: 'Ngày lập văn bản', dia_danh: 'Địa danh' };
function analyze(core, ctx) {
  let m;
  if ((m = core.match(/^(.*?)(,?\s*ngày\s+)(\d{1,2})(\s+tháng\s+)(\d{1,2})(\s+năm\s+)(\d{4})$/i))) {
    const pad = m[3].length === 2 || m[5].length === 2;
    return { kind: 'dateline', sig: 'date:' + m[3] + '/' + m[5] + '/' + m[7], place: m[1].trim(), build: (k, place) =>
      (place ? `{{${place}}}` : '') + `${m[2]}{{${k}|${pad ? 'ngay' : 'ngay1'}}}${m[4]}{{${k}|${pad ? 'thang' : 'thang1'}}}${m[6]}{{${k}|nam}}`, example: `${m[3].padStart(2, '0')}/${m[5].padStart(2, '0')}/${m[7]}`, exPlace: m[1].trim() };
  }
  if ((m = core.match(/^(\d{1,3}(?:\.\d{3})+)(\s*(?:đồng|VNĐ|VND|đ))?$/i)))
    return { kind: 'money', type: 'money', sig: 'n:' + m[1].replace(/\D/g, ''), build: k => `{{${k}|so}}${m[2] || ''}`, example: m[1].replace(/\./g, '') };
  if ((m = core.match(/^(.*?[:：]\s*)([.…_\s]{3,})$/)))
    return { kind: 'label', type: 'text', sig: 'l:' + fold(m[1]), hint: HINT_KEYS[fold(m[1].replace(/[:：]\s*$/, '')).trim()] || slug(m[1].replace(/[:：]\s*$/, '')), build: k => `${m[1]}{{${k}}}`, example: '' };
  if ((m = core.match(/^\(([^()]+)\)$/)))
    return { kind: 'paren', type: 'text', sig: 'p:' + fold(m[1]), hint: HINT_KEYS[fold(m[1])], build: k => `({{${k}}})`, example: m[1] };
  if (/^\d{10}(?:-?\d{3})?$/.test(core)) return { kind: 'text', type: 'tax_code', sig: 't:' + core, build: k => `{{${k}}}`, example: core };
  if (/^\d{12}$/.test(core)) return { kind: 'text', type: 'id_card', sig: 't:' + core, build: k => `{{${k}}}`, example: core };
  if (/^\d{1,3}$/.test(core)) return { kind: 'num', type: /ty le|%/.test(fold(ctx)) ? 'percent' : 'number', sig: 'n:' + core, build: k => `{{${k}}}`, example: core };
  if (core === core.toUpperCase() && /\p{L}/u.test(core)) return { kind: 'upper', type: 'text', sig: 't:' + fold(core), build: k => `{{${k}|upper}}`, example: core };
  return { kind: 'text', type: 'text', sig: 't:' + fold(core), build: k => `{{${k}}}`, example: core };
}

/** Quét mẫu: trả về danh sách đoạn, các vùng (slot) gợi ý, các trường gợi ý và cảnh báo. */
async function scanDocx(buf) {
  let zip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw new Error('Không đọc được tệp. Hãy dùng tệp Word đuôi .docx (không phải .doc).'); }
  if (!zip.file('word/document.xml')) throw new Error('Tệp không phải biểu mẫu Word (.docx) hợp lệ.');
  const parts = Object.keys(zip.files).filter(n => PART_RE.test(n)).sort((a, b) => (b === 'word/document.xml') - (a === 'word/document.xml') || a.localeCompare(b));
  const paragraphs = [], raw = [], warnings = [];
  for (const part of parts) {
    const doc = new DOMParser().parseFromString(await zip.file(part).async('string'), 'text/xml');
    Array.from(doc.getElementsByTagNameNS(W, 'p')).forEach((p, i) => {
      const m = paraModel(p), groups = [];
      let cur = null;
      for (const r of m.runs) {
        if (r.special || !r.hl) { cur = null; continue; }
        if (!r.text) continue;
        if (cur && cur.sig === r.sig && cur.end === r.off) { cur.end = r.off + r.text.length; }
        else groups.push(cur = { start: r.off, end: r.off + r.text.length, sig: r.sig });
      }
      // vùng chỉ có khoảng trắng nằm giữa hai vùng cùng định dạng thì gộp cả ba thành một
      for (let g = 1; g < groups.length - 1; g++) {
        const a = groups[g - 1], b = groups[g], c = groups[g + 1];
        if (!m.text.slice(b.start, b.end).trim() && a.end === b.start && b.end === c.start && a.sig === c.sig && m.text.slice(a.start, a.end).trim()) { a.end = c.end; groups.splice(g, 2); g--; }
      }
      paragraphs.push({ part, p: i, text: m.text, table: tableContext(p) || undefined });
      for (const g of groups) raw.push({ part, p: i, start: g.start, end: g.end, text: m.text.slice(g.start, g.end), model: m, el: p });
    });
  }

  // Đặt tên trường. Các vùng có cùng giá trị gốc (vd tên công ty xuất hiện 2 lần, số vốn xuất hiện 3 lần) dùng chung một trường;
  // nhãn lấy từ lần xuất hiện có ngữ cảnh rõ nhất: chữ đứng trước trong đoạn > tiêu đề hàng/cột của bảng > đoạn liền trước.
  const items = [];
  for (const r of raw) {
    if (!/[\p{L}\p{N}]|[.…_]{3,}/u.test(r.text)) continue;   // chỉ có dấu câu / khoảng trắng: không phải chỗ điền (màu tô vẫn được xóa khi xuất)
    const lead = r.text.match(/^\s*/)[0], trail = r.text.slice(lead.length).match(/\s*$/)[0], core = r.text.trim();
    const own = labelBefore(r.model.text, r.start), tbl = tableContext(r.el) || '', prev = prevParagraphLabel(r.el);
    const label = own || tbl || prev, rank = own ? 3 : tbl ? 2 : prev ? 1 : 0;
    items.push({ r, lead, trail, core, label, rank, a: analyze(core, label) });
  }
  const best = new Map();
  for (const it of items) { const cur = best.get(it.a.sig); if (!cur || it.rank > cur.rank) best.set(it.a.sig, it); }
  const slots = [], fields = {}, keyOf = new Map(), usedKeys = new Set();
  const newKey = base => { const k = KEY_RE.test(base) ? base : 'truong'; let n = 1, c = k; while (usedKeys.has(c)) c = k + '_' + (++n); usedKeys.add(c); return c; };
  const addField = (key, label, type, example) => { if (!fields[key]) fields[key] = { key, label: KEY_LABELS[key] || label || key, type, required: true, example: example ?? '' }; };
  const up1 = s => { s = s && s === s.toUpperCase() && /\p{L}/u.test(s) ? s.toLowerCase() : s; return s ? s[0].toUpperCase() + s.slice(1) : s; };   // chữ IN HOA → viết thường, hoa chữ đầu
  let counter = 0;
  const keyFor = (sig, base, label, type, example) => {
    if (!keyOf.has(sig)) { const k = newKey(base || 'truong_' + (++counter)); keyOf.set(sig, k); addField(k, up1(label), type, example); }
    return keyOf.get(sig);
  };
  for (const it of items) {
    const { a, lead, trail, r } = it, bst = best.get(a.sig);
    let format;
    if (a.kind === 'dateline') {
      const key = keyFor(a.sig, 'ngay_lap', '', 'date', a.example);
      const place = a.place ? keyFor('place:' + fold(a.place), 'dia_danh', '', 'text', a.exPlace) : null;
      format = lead + a.build(key, place) + trail;
    } else {
      const key = keyFor(a.sig, a.hint || slug(bst.label), bst.label, bst.a.type, bst.a.example);
      format = lead + a.build(key) + trail;
    }
    slots.push({ id: '', src: 'highlight', part: r.part, p: r.p, start: r.start, end: r.end, text: r.text, format, enabled: true, _money: a.kind === 'money' ? keyOf.get(a.sig) : null });
  }

  // "bằng chữ: ..." không tô màu nhưng phụ thuộc số tiền: tự thêm để số và chữ luôn khớp nhau
  for (const s of [...slots]) {
    if (!s._money) continue;
    const pm = paragraphs.find(x => x.part === s.part && x.p === s.p), re = /bằng chữ:\s*([^()]+?)\s*\)/iu, m = re.exec(pm.text);
    if (!m) continue;
    const start = m.index + m[0].indexOf(m[1]), end = start + m[1].length;
    if (slots.some(o => o.part === s.part && o.p === s.p && o.start < end && o.end > start)) continue;
    slots.push({ id: 's' + (slots.length + 1), src: 'auto', part: s.part, p: s.p, start, end, text: m[1], enabled: true,
      format: `{{${s._money}|chu}}${/\s+đồng$/i.test(m[1]) ? ' đồng' : ''}` });
    warnings.push(`Đoạn có số tiền "${s.text}" kèm phần "bằng chữ" không tô màu; hệ thống đã tự thêm vùng "bằng chữ" để số và chữ luôn khớp nhau.`);
  }
  slots.forEach(s => delete s._money);
  slots.sort((a, b) => parts.indexOf(a.part) - parts.indexOf(b.part) || a.p - b.p || a.start - b.start).forEach((s, i) => { s.id = 's' + (i + 1); });
  if (!slots.length) warnings.push('Không thấy vùng chữ nào được tô màu (highlight) trong tệp. Hãy tô màu các chỗ cần thay trong Word, hoặc thêm vùng thủ công bên dưới.');
  return { parts, paragraphs, slots, fields: Object.values(fields), warnings };
}

/** Kiểm tra cấu hình (slots + fields) có khớp tệp mẫu không. Trả về danh sách lỗi (rỗng = hợp lệ). */
async function validateConfig(buf, config) {
  const errs = [], { slots = [], fields = [] } = config || {};
  const byKey = Object.create(null); for (const f of fields) {
    if (!KEY_RE.test(f.key || '')) errs.push(`Tên trường "${f.key}" không hợp lệ (chỉ gồm chữ thường không dấu, số và dấu gạch dưới, bắt đầu bằng chữ).`);
    if (byKey[f.key]) errs.push(`Trường "${f.key}" bị trùng.`);
    if (!TYPES[f.type]) errs.push(`Trường "${f.key}" có kiểu không hợp lệ.`);
    byKey[f.key] = f;
  }
  const zip = await JSZip.loadAsync(buf), docs = {};
  for (const s of slots) {
    if (!s.enabled) continue;
    if (!PART_RE.test(s.part || '') || !zip.file(s.part)) { errs.push(`Vùng ${s.id}: không tìm thấy phần "${s.part}" trong tệp.`); continue; }
    docs[s.part] ||= Array.from(new DOMParser().parseFromString(await zip.file(s.part).async('string'), 'text/xml').getElementsByTagNameNS(W, 'p')).map(p => paraModel(p).text);
    const t = docs[s.part][s.p];
    if (t === undefined || !(s.start >= 0 && s.end > s.start) || t.slice(s.start, s.end) !== s.text) errs.push(`Vùng ${s.id} ("${String(s.text).slice(0, 30)}") không còn khớp với tệp mẫu. Hãy quét lại tệp.`);
    for (const e of checkFormat(s.format, byKey)) errs.push(`Vùng ${s.id} ("${String(s.text).slice(0, 30)}"): ${e}`);
  }
  const en = slots.filter(s => s.enabled);
  for (let i = 0; i < en.length; i++) for (let j = i + 1; j < en.length; j++)
    if (en[i].part === en[j].part && en[i].p === en[j].p && en[i].start < en[j].end && en[j].start < en[i].end) errs.push(`Vùng ${en[i].id} và ${en[j].id} chồng lên nhau.`);
  const used = new Set(en.flatMap(s => refsOf(s.format).map(r => r.key)));
  for (const f of fields) if (!used.has(f.key)) errs.push(`Trường "${f.key}" không được dùng ở vùng nào. Hãy xóa trường hoặc gán vào một vùng.`);
  return errs;
}

// ---------- Điền giá trị ----------
function setRunText(doc, run, text) {
  // Tái dùng thẻ <w:t> sẵn có (giữ nguyên thuộc tính của nó); chỉ thêm xml:space="preserve" khi chữ có khoảng trắng đầu/cuối/liên tiếp
  const old = kids(run).filter(k => isW(k, 't')), lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const mk = (ln, el) => {
    const t = el || doc.createElementNS(W, 'w:t');
    while (t.firstChild) t.removeChild(t.firstChild);
    t.appendChild(doc.createTextNode(ln));
    if (/^\s|\s$|\s{2}/.test(ln)) t.setAttribute('xml:space', 'preserve');
    return t;
  };
  old.slice(1).forEach(k => run.removeChild(k));
  lines.forEach((ln, i) => {
    if (i === 0 && old[0]) { mk(ln, old[0]); return; }
    if (i) run.appendChild(doc.createElementNS(W, 'w:br'));
    run.appendChild(mk(ln));
  });
}
function replaceRange(doc, model, start, end, text) {
  const hit = model.runs.filter(r => !r.special && r.text && r.off < end && r.off + r.text.length > start);
  if (!hit.length) throw new Error('Không tìm thấy chữ cần thay trong đoạn.');
  const first = hit[0], last = hit[hit.length - 1];
  const cur = r => tText(r.el);                                     // chữ HIỆN TẠI của run (có thể đã bị slot khác sửa trong cùng run)
  const pre = cur(first).slice(0, start - first.off);
  const post = cur(last).slice(end - last.off);
  if (first === last) { setRunText(doc, first.el, pre + text + post); return; }
  setRunText(doc, first.el, pre + text);                            // dùng định dạng của run đầu tiên
  for (const r of hit.slice(1, -1)) r.el.parentNode.removeChild(r.el);
  if (post) setRunText(doc, last.el, post); else last.el.parentNode.removeChild(last.el);
}

/**
 * Điền giá trị vào mẫu. values: {khóa: giá trị đã chuẩn hóa}. Trả về Buffer .docx mới.
 * opts.clearHighlight (mặc định true): xóa màu tô trong bản xuất (màu tô chỉ là dấu hiệu soạn mẫu).
 */
async function fillDocx(buf, config, values, opts = {}) {
  const zip = await JSZip.loadAsync(buf), fields = Object.create(null), clear = opts.clearHighlight !== false;
  for (const f of config.fields || []) fields[f.key] = f;
  const byPart = new Map();
  for (const s of (config.slots || []).filter(s => s.enabled)) { if (!byPart.has(s.part)) byPart.set(s.part, []); byPart.get(s.part).push(s); }
  if (clear) for (const n of Object.keys(zip.files)) if (PART_RE.test(n) && !byPart.has(n)) byPart.set(n, []);
  for (const [part, slots] of byPart) {
    const orig = await zip.file(part).async('string'), doc = new DOMParser().parseFromString(orig, 'text/xml');
    if (!slots.length && !doc.getElementsByTagNameNS(W, 'highlight').length) continue;      // không có gì để đổi: giữ nguyên byte
    const paras = Array.from(doc.getElementsByTagNameNS(W, 'p')), models = new Map();
    for (const s of slots) {
      if (!models.has(s.p)) models.set(s.p, paraModel(paras[s.p]));
      if (models.get(s.p).text.slice(s.start, s.end) !== s.text) throw new Error(`Vùng ${s.id} không còn khớp với tệp mẫu.`);
    }
    for (const s of [...slots].sort((a, b) => b.p - a.p || b.start - a.start))     // từ cuối lên đầu để vị trí các vùng phía trước không bị lệch
      replaceRange(doc, models.get(s.p), s.start, s.end, renderFormat(s.format, values, fields));
    if (clear) for (const h of Array.from(doc.getElementsByTagNameNS(W, 'highlight'))) {
      const rPr = h.parentNode; rPr.removeChild(h);
      if (isW(rPr, 'rPr') && !kids(rPr).length && isW(rPr.parentNode, 'r')) rPr.parentNode.removeChild(rPr);
    }
    // giữ nguyên dòng khai báo XML gốc (Word dùng \r\n), phần còn lại do bộ tuần tự hóa ghi lại y hệt
    const head = (orig.match(/^\s*<\?xml[^>]*\?>\s*/) || [''])[0];
    zip.file(part, head + new XMLSerializer().serializeToString(doc).replace(/^\s*<\?xml[^>]*\?>\s*/, ''), { createFolders: false });
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
}

module.exports = { scanDocx, validateConfig, fillDocx, paraModel };
