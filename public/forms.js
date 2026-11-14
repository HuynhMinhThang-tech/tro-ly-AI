/* Tab "Biểu mẫu": người dùng điền biểu mẫu từ Excel/CSV, quản trị viên quản lý mẫu Word.
   Dùng lại các hàm chung của index.html: $, esc, toast, api, signOut và biến tok. */
var Forms = (function () {
  "use strict";
  var TYPES = {};
  function h(s) { return esc(s == null ? "" : s); }
  function opt(v, label, sel) { return '<option value="' + h(v) + '"' + (sel ? " selected" : "") + ">" + h(label) + "</option>"; }

  /* Tải tệp về máy (gọi API có kèm đăng nhập) */
  async function download(path, o, fallback) {
    var init = { method: o.method || "GET", headers: { Authorization: "Bearer " + tok } };
    if (o.json) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(o.json); }
    if (o.form) init.body = o.form;
    var res = await fetch(path, init);
    if (res.status === 401) { signOut(true); throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."); }
    if (!res.ok) { var d = await res.json().catch(function () { return {}; }); throw new Error(d.error || "Có lỗi xảy ra."); }
    var cd = res.headers.get("content-disposition") || "", m = cd.match(/filename\*=UTF-8''([^;]+)/);
    var url = URL.createObjectURL(await res.blob()), a = document.createElement("a");
    a.href = url; a.download = m ? decodeURIComponent(m[1]) : fallback; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function busy(btn, on, text) { if (!btn) return; if (on) { btn.dataset.t = btn.textContent; btn.textContent = text || "Đang xử lý…"; btn.disabled = true; } else { btn.textContent = btn.dataset.t || btn.textContent; btn.disabled = false; } }

  /* ================= NGƯỜI DÙNG ================= */
  var U = { tpls: [], cur: null, mode: "file", headers: null, raw: null, mapping: {}, checked: null, fileName: "", hand: {}, touched: {}, pdf: false, maxRows: 50, maxPdf: 10 };

  async function loadUser() {
    try {
      var d = await api("/api/templates"); U.tpls = d.templates; U.pdf = d.pdf; U.maxRows = d.max_rows; U.maxPdf = d.max_pdf_rows; TYPES = d.types || TYPES;
    } catch (e) { toast(e.message); return; }
    if (!U.cur || !U.tpls.some(function (t) { return t.id === U.cur.id; })) U.cur = U.tpls[0] || null;
    else U.cur = U.tpls.find(function (t) { return t.id === U.cur.id; });
    renderAside(); renderMain();
  }
  function renderAside() {
    $("fAside").innerHTML = "<h4>Biểu mẫu</h4>" + (U.tpls.length ? U.tpls.map(function (t) {
      return '<button class="item" data-id="' + h(t.id) + '" aria-current="' + (U.cur && U.cur.id === t.id) + '">' + h(t.name) + "</button>";
    }).join("") : '<p class="sub" style="font-size:13px">Chưa có biểu mẫu nào.</p>');
    $("fAside").querySelectorAll(".item").forEach(function (b) {
      b.onclick = function () { U.cur = U.tpls.find(function (t) { return t.id === b.dataset.id; }); U.headers = U.raw = U.checked = null; U.mapping = {}; U.fileName = ""; U.hand = {}; U.touched = {}; renderAside(); renderMain(); };
    });
  }
  function renderMain() {
    var w = $("fMain").firstElementChild, t = U.cur;
    if (!t) { w.innerHTML = '<div class="empty"><b>Chưa có biểu mẫu</b>Quản trị viên chưa đăng biểu mẫu nào. Vui lòng quay lại sau.</div>'; return; }
    w.innerHTML = "<h2>" + h(t.name) + '</h2><p class="sub">' + h(t.description || "Điền thông tin từ Excel/CSV hoặc nhập tay, hệ thống tự điền vào biểu mẫu và xuất Word/PDF, giữ nguyên định dạng gốc.") + "</p>" +
      '<div class="filters"><button class="chip" data-m="file" aria-pressed="' + (U.mode === "file") + '">Từ Excel / CSV</button><button class="chip" data-m="hand" aria-pressed="' + (U.mode === "hand") + '">Nhập tay</button></div><div id="fmBody"></div>';
    w.querySelectorAll("[data-m]").forEach(function (b) { b.onclick = function () { U.mode = b.dataset.m; renderMain(); }; });
    U.mode === "file" ? renderFile() : renderHand();
  }

  /* Hiển thị kèm đơn vị (chỉ trên giao diện; trong văn bản xuất ra theo đúng mẫu) */
  function uiShown(f, v) {
    if (!v) return "";
    return f.type === "percent" ? v + "%" : f.type === "money" ? v + " đ" : v;
  }

  /* --- Từ Excel / CSV --- */
  function resetFile(msg) {
    U.headers = U.raw = U.checked = null; U.mapping = {}; U.fileName = ""; renderFile();
    if (msg) toast(msg);
  }
  function renderFile() {
    $("fmBody").innerHTML =
      '<div class="card fm-step"><b>1. Tải tệp mẫu để điền</b><p class="sub">Mỗi dòng là một bộ hồ sơ. Cột có nền hồng là bắt buộc. Trong tệp Excel, ô tiền tự hiện dấu chấm ngăn nghìn, ô tỷ lệ hiện %, ô ngày hiện dd/mm/yyyy và có chặn nhập sai; trang "Huong dan" giải thích từng cột.</p>' +
      '<button class="btn" id="fmX">Tải mẫu Excel (.xlsx)</button> <button class="btn" id="fmC">Tải mẫu CSV</button></div>' +
      '<div class="card fm-step"><b>2. Tải dữ liệu đã điền lên</b><p class="sub">Nhận .xlsx hoặc .csv, tối đa ' + U.maxRows + ' dòng. Dữ liệu chỉ dùng để điền biểu mẫu, hệ thống không lưu lại.</p>' +
      '<input type="file" id="fmFile" accept=".xlsx,.csv,.txt" hidden><button class="btn primary" id="fmPick">Chọn tệp Excel / CSV</button> <span id="fmName" class="fm-name"></span></div>' +
      '<div id="fmMap"></div><div id="fmPrev"></div>';
    $("fmX").onclick = function () { download("/api/templates/" + U.cur.id + "/sample?format=xlsx", {}, "du-lieu-mau.xlsx").catch(function (e) { toast(e.message); }); };
    $("fmC").onclick = function () { download("/api/templates/" + U.cur.id + "/sample?format=csv", {}, "du-lieu-mau.csv").catch(function (e) { toast(e.message); }); };
    $("fmPick").onclick = function () { $("fmFile").click(); };
    $("fmFile").onchange = async function () {
      var f = this.files[0]; this.value = ""; if (!f) return;
      var fd = new FormData(); fd.append("file", f); $("fmName").textContent = "Đang đọc " + f.name + "…";
      try {
        var d = await api("/api/templates/" + U.cur.id + "/parse", "POST", fd);
        U.headers = d.headers; U.raw = d.rows; U.mapping = d.mapping; U.fileName = f.name;
        showLoaded(); renderMap(); recheck();
      } catch (e) { $("fmName").textContent = U.headers ? U.fileName + " · " + U.raw.length + " dòng" : ""; toast(e.message); }
    };
    if (U.headers) { showLoaded(); renderMap(); recheck(); }
  }
  function showLoaded() {
    $("fmName").innerHTML = "<b>" + h(U.fileName) + "</b> · " + U.raw.length + ' dòng <button class="btn sm danger" id="fmReset" type="button">Hủy, xóa dữ liệu đã tải</button>';
    $("fmReset").onclick = function () { resetFile("Đã xóa dữ liệu đã tải."); };
  }
  function fieldOpts(sel) {
    return opt("", "— bỏ qua cột này —", !sel) + U.cur.fields.map(function (f) { return opt(f.key, f.label, sel === f.key); }).join("");
  }
  function renderMap() {
    var used = {}, missing = [];
    Object.keys(U.mapping).forEach(function (i) { if (U.mapping[i]) used[U.mapping[i]] = 1; });
    U.cur.fields.forEach(function (f) { if (f.required && !used[f.key]) missing.push(f.label); });
    var unmapped = U.headers.filter(function (_, i) { return !U.mapping[i]; }).length;
    $("fmMap").innerHTML = '<div class="card fm-step"><b>3. Đối chiếu cột</b><p class="sub">Hệ thống đã tự ghép cột trong tệp với trường của biểu mẫu. Kiểm tra lại, chọn lại nếu chưa đúng.</p>' +
      '<div class="scroll"><table><thead><tr><th>Cột trong tệp</th><th>Ví dụ</th><th>Điền vào trường</th></tr></thead><tbody>' +
      U.headers.map(function (hd, i) {
        return "<tr><td>" + h(hd || "(trống)") + "</td><td><small>" + h((U.raw[0] || [])[i] || "") + '</small></td><td><select data-c="' + i + '">' + fieldOpts(U.mapping[i]) + "</select></td></tr>";
      }).join("") + "</tbody></table></div>" +
      (missing.length ? '<p class="fm-bad">Chưa có cột cho trường bắt buộc: ' + h(missing.join(", ")) + "</p>" : "") +
      (unmapped && missing.length ? '<button class="btn sm" id="fmAI">Gợi ý ghép cột bằng AI</button> <small class="sub">Chỉ gửi tiêu đề cột cho AI, không gửi dữ liệu.</small>' : "") + "</div>";
    $("fmMap").querySelectorAll("select").forEach(function (s) {
      s.onchange = function () {
        var i = +s.dataset.c, k = s.value;
        Object.keys(U.mapping).forEach(function (j) { if (k && U.mapping[j] === k) U.mapping[j] = ""; });
        U.mapping[i] = k; renderMap(); recheck();
      };
    });
    var ai = $("fmAI");
    if (ai) ai.onclick = async function () {
      busy(ai, true, "AI đang ghép…");
      try {
        var taken = Object.keys(U.mapping).map(function (i) { return U.mapping[i]; }).filter(Boolean);
        var heads = U.headers.filter(function (_, i) { return !U.mapping[i]; });
        var d = await api("/api/templates/" + U.cur.id + "/map-ai", "POST", { headers: heads, taken: taken }), n = 0;
        U.headers.forEach(function (hd, i) { if (!U.mapping[i] && d.mapping[hd]) { U.mapping[i] = d.mapping[hd]; n++; } });
        toast(n ? "AI đã ghép thêm " + n + " cột, bạn kiểm tra lại nhé." : "AI chưa ghép được cột nào."); renderMap(); recheck();
      } catch (e) { busy(ai, false); toast(e.message); }
    };
  }
  function rowObjs() {
    return U.raw.map(function (r) { var o = {}; U.headers.forEach(function (_, i) { if (U.mapping[i]) o[U.mapping[i]] = r[i]; }); return o; });
  }
  var seq = 0;
  async function recheck() {
    var my = ++seq;
    try {
      var d = await api("/api/templates/" + U.cur.id + "/check", "POST", { rows: rowObjs() });
      if (my !== seq || !U.raw) return; U.checked = d.rows; renderPrev();
    } catch (e) { toast(e.message); }
  }
  function dropRows(idx) {   // bỏ các dòng (chỉ số theo thứ tự hiện tại) khỏi dữ liệu đã tải
    var set = {}; idx.forEach(function (i) { set[i] = 1; });
    U.raw = U.raw.filter(function (_, i) { return !set[i]; });
    if (!U.raw.length) return resetFile("Đã bỏ hết các dòng, hãy tải tệp khác.");
    showLoaded(); renderMap(); recheck();
  }
  function renderPrev() {
    var F = U.cur.fields, rows = U.checked, okN = rows.filter(function (r) { return !Object.keys(r.issues).length; }).length, badN = rows.length - okN;
    $("fmPrev").innerHTML = '<div class="card fm-step"><b>4. Kiểm tra dữ liệu và tạo văn bản</b><p class="sub">' + okN + "/" + rows.length + " dòng hợp lệ." +
      (badN ? " Dòng có lỗi (chữ đỏ) không tạo được: hãy sửa trong tệp rồi tải lại, hoặc bỏ dòng đó (nút ✕)." : "") + "</p>" +
      (badN ? '<p><button class="btn sm danger" id="fmDropBad" type="button">Bỏ ' + badN + " dòng còn lỗi</button></p>" : "") +
      '<div class="scroll"><table class="fm-prev"><thead><tr><th></th>' + F.map(function (f) { return "<th>" + h(f.label) + (f.required ? " *" : "") + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r, i) {
        var ok = !Object.keys(r.issues).length;
        return '<tr><td class="fm-rowc"><input type="checkbox" class="fm-sel" data-i="' + i + '"' + (ok ? " checked" : " disabled") + ' aria-label="Chọn dòng ' + (i + 1) + '"> <button type="button" class="fm-x" data-del="' + i + '" title="Bỏ dòng này" aria-label="Bỏ dòng ' + (i + 1) + '">✕</button></td>' + F.map(function (f) {
          return r.issues[f.key] ? '<td class="fm-bad" title="' + h(r.issues[f.key]) + '">⚠ ' + h(r.issues[f.key]) + "</td>" : "<td>" + h(uiShown(f, r.shown[f.key])) + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>" + genControls("file") + "</div>";
    $("fmPrev").querySelectorAll("[data-del]").forEach(function (b) { b.onclick = function () { dropRows([+b.dataset.del]); }; });
    if ($("fmDropBad")) $("fmDropBad").onclick = function () {
      var bad = []; U.checked.forEach(function (r, i) { if (Object.keys(r.issues).length) bad.push(i); }); dropRows(bad);
    };
    $("fmCancel").onclick = function () { resetFile("Đã hủy, dữ liệu đã tải được xóa."); };
    bindGen(function () { return Array.prototype.map.call($("fmPrev").querySelectorAll(".fm-sel:checked"), function (c) { return rowObjs()[+c.dataset.i]; }); });
  }

  /* --- Nhập tay: ô nhập tự định dạng và ràng buộc theo kiểu dữ liệu --- */
  var PH = { money: "VD: 25.000.000.000", percent: "VD: 100", number: "VD: 5", date: "dd/mm/yyyy, VD: 15/11/2026", tax_code: "10 hoặc 13 chữ số", id_card: "12 chữ số (CMND cũ 9 số)" };
  var IM = { money: "numeric", number: "decimal", percent: "decimal", date: "numeric", tax_code: "numeric", id_card: "numeric" };
  var UNIT = { money: "đồng", percent: "%" };
  function setCaret(el, out, before) {   // giữ con trỏ đúng chỗ sau khi thêm/bớt dấu chấm
    var n = 0, i = 0; while (i < out.length && n < before) { if (/\d/.test(out[i])) n++; i++; }
    try { el.setSelectionRange(i, i); } catch (e) { /* ô không hỗ trợ */ }
  }
  var group = function (d) { return d.replace(/\B(?=(\d{3})+(?!\d))/g, "."); };
  function mask(el) {
    var t = el.dataset.t, v = el.value, pos = el.selectionStart == null ? v.length : el.selectionStart;
    var before = v.slice(0, pos).replace(/\D/g, "").length, out;
    if (t === "money") { out = group(v.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 15)); }
    else if (t === "number" || t === "percent") {
      var dec = t === "percent" ? /[.,]/ : /,/, parts = v.replace(t === "percent" ? /[^\d.,]/g : /[^\d,]/g, "").split(dec);
      var ip = parts[0].replace(/^0+(?=\d)/, "").slice(0, t === "percent" ? 3 : 15), fp = parts.length > 1 ? parts.slice(1).join("").slice(0, t === "percent" ? 2 : 4) : null;
      out = (t === "number" ? group(ip) : ip) + (fp !== null ? "," + fp : "");
      if (t === "percent" && parseFloat(out.replace(",", ".")) > 100) out = el._ok || "";
    } else if (t === "tax_code") out = v.replace(/\D/g, "").slice(0, 13);
    else if (t === "id_card") out = v.replace(/\D/g, "").slice(0, 12);
    else if (t === "date") {
      var c = v.replace(/[^\d\/.\-]/g, "");
      if (/^\d*$/.test(c)) { var d = c.slice(0, 8); c = d.length > 4 ? d.slice(0, 2) + "/" + d.slice(2, 4) + "/" + d.slice(4) : d.length > 2 ? d.slice(0, 2) + "/" + d.slice(2) : d; }
      else c = c.slice(0, 10);
      el.value = c; el._ok = c; return;
    } else return;
    el.value = out; el._ok = out; setCaret(el, out, before);
  }
  function normDate(v) {
    var m = v.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/), i = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return ("0" + m[1]).slice(-2) + "/" + ("0" + m[2]).slice(-2) + "/" + m[3];
    return i ? i[3] + "/" + i[2] + "/" + i[1] : v;
  }
  function handField(f) {
    var id = "hf_" + f.key, unit = UNIT[f.type] || "", isDate = f.type === "date";
    return '<div class="fm-f"><label for="' + id + '">' + h(f.label) + (f.required ? " *" : "") + '</label><div class="fm-inp' + (unit ? " has-unit" : "") + (isDate ? " has-cal" : "") + '">' +
      '<input id="' + id + '" data-k="' + h(f.key) + '" data-t="' + f.type + '" type="text" autocomplete="off" inputmode="' + (IM[f.type] || "text") + '" placeholder="' + h(PH[f.type] || "") + '" value="' + h(U.hand[f.key] || "") + '">' +
      (unit ? '<em class="fm-unit">' + unit + "</em>" : "") +
      (isDate ? '<button type="button" class="fm-cal" data-cal="' + h(f.key) + '" aria-label="Chọn ngày từ lịch">&#128197;</button><input type="date" class="fm-datehid" tabindex="-1" aria-hidden="true" data-calin="' + h(f.key) + '">' : "") +
      '</div><small class="fm-hint" data-h="' + h(f.key) + '"></small></div>';
  }
  function handValues() { var o = {}; $("fmBody").querySelectorAll("[data-k]").forEach(function (i) { o[i.dataset.k] = i.value; }); return o; }
  var hintTimer = null;
  async function refreshHints(all) {   // hỏi máy chủ cùng bộ quy tắc kiểm tra như lúc xuất file, để thông báo luôn khớp
    var d = await api("/api/templates/" + U.cur.id + "/check", "POST", { rows: [handValues()] }), r = d.rows[0], bad = 0, first = null;
    U.cur.fields.forEach(function (f) {
      var el = $("hf_" + f.key), box = $("fmBody").querySelector('[data-h="' + f.key + '"]'); if (!el || !box) return;
      var iss = r.issues[f.key], has = el.value.trim() !== "";
      if (iss && (all || U.touched[f.key])) { box.className = "fm-hint fm-err"; box.textContent = "⚠ " + iss; el.setAttribute("aria-invalid", "true"); bad++; first = first || el; }
      else if (!iss && has) { box.className = "fm-hint fm-ok"; box.textContent = "→ Trong văn bản: " + uiShown(f, r.shown[f.key]) + (r.words[f.key] ? " (" + r.words[f.key] + ")" : ""); el.removeAttribute("aria-invalid"); }
      else { box.className = "fm-hint"; box.textContent = ""; el.removeAttribute("aria-invalid"); if (iss && all) bad++; }
    });
    if (all && first) first.focus();
    return bad;
  }
  function renderHand() {
    var F = U.cur.fields; U.hand = U.hand || {}; U.touched = {};
    $("fmBody").innerHTML = '<div class="card fm-step"><div class="fm-grid">' + F.map(handField).join("") + "</div>" + genControls("hand") + "</div>";
    $("fmBody").querySelectorAll("[data-k]").forEach(function (el) {
      el._ok = el.value;
      el.addEventListener("input", function () { mask(el); U.hand[el.dataset.k] = el.value; clearTimeout(hintTimer); hintTimer = setTimeout(function () { refreshHints(false).catch(function () { }); }, 350); });
      el.addEventListener("blur", function () {
        if (el.dataset.t === "date") el.value = normDate(el.value);
        U.hand[el.dataset.k] = el.value; U.touched[el.dataset.k] = true; refreshHints(false).catch(function () { });
      });
    });
    $("fmBody").querySelectorAll("[data-cal]").forEach(function (b) {
      var inp = $("fmBody").querySelector('[data-calin="' + b.dataset.cal + '"]'), txt = $("hf_" + b.dataset.cal);
      b.onclick = function () { try { inp.showPicker(); } catch (e) { inp.click(); } };
      inp.onchange = function () { if (!inp.value) return; txt.value = normDate(inp.value); U.hand[txt.dataset.k] = txt.value; U.touched[txt.dataset.k] = true; refreshHints(false).catch(function () { }); };
    });
    $("fmClear").onclick = function () { U.hand = {}; U.touched = {}; renderHand(); toast("Đã xóa nội dung đã nhập."); };
    if (Object.keys(U.hand).length) refreshHints(false).catch(function () { });
    bindGen(async function () {
      F.forEach(function (f) { U.touched[f.key] = true; });
      var bad = await refreshHints(true);
      if (bad) { toast("Còn " + bad + " ô chưa hợp lệ, xem chữ đỏ bên dưới từng ô."); return null; }
      return [handValues()];
    });
  }

  /* --- Chung: chọn định dạng + nút tạo --- */
  function genControls(kind) {
    return '<div class="fm-gen"><div class="fm-fmt"><b>Xuất ra:</b> <label><input type="radio" name="fmt" value="docx" checked> Word (.docx)</label>' +
      '<label><input type="radio" name="fmt" value="pdf"' + (U.pdf ? "" : " disabled") + '> PDF</label><label><input type="radio" name="fmt" value="both"' + (U.pdf ? "" : " disabled") + '> Cả hai</label></div>' +
      (U.pdf ? "<small class=\"sub\">PDF tối đa " + U.maxPdf + " dòng mỗi lần.</small>" : '<small class="sub">Máy chủ chưa hỗ trợ xuất PDF: hãy tải Word rồi chọn "Lưu thành PDF" trong Word.</small>') +
      '<div class="fm-btns"><button class="btn primary" id="fmGo" type="button">' + (kind === "hand" ? "Tạo văn bản" : "Tạo văn bản cho các dòng đã chọn") + "</button> " +
      (kind === "hand" ? '<button class="btn" id="fmClear" type="button">Xóa nội dung đã nhập</button>' : '<button class="btn" id="fmCancel" type="button">Hủy, xóa dữ liệu đã tải</button>') + "</div></div>";
  }
  function bindGen(getRows) {
    $("fmGo").onclick = async function () {
      var btn = this, fmt = document.querySelector('input[name="fmt"]:checked').value, rows;
      busy(btn, true, "Đang kiểm tra…");
      try { rows = await getRows(); } catch (e) { busy(btn, false); return toast(e.message); }
      if (!rows) return busy(btn, false);
      if (!rows.length) { busy(btn, false); return toast("Chưa có dòng nào để tạo."); }
      btn.textContent = "Đang tạo văn bản…";
      try { await download("/api/templates/" + U.cur.id + "/generate", { method: "POST", json: { rows: rows, format: fmt } }, "bieu-mau"); toast("Đã tạo xong, tệp đang được tải về."); }
      catch (e) { toast(e.message); }
      busy(btn, false);
    };
  }

  /* ================= QUẢN TRỊ ================= */
  var A = { pdf: false }, ed = null, selRange = null;
  var TYPE_LIST = ["text", "money", "number", "percent", "date", "tax_code", "id_card"];

  async function loadAdmin() {
    var root = $("adminForms");
    try {
      var d = await api("/api/admin/templates"); A.pdf = d.pdf; TYPES = d.types || TYPES; A.list = d.templates;
    } catch (e) { root.innerHTML = '<p class="fm-bad">' + h(e.message) + "</p>"; return; }
    ed = null; renderList();
  }
  function renderList() {
    var root = $("adminForms");
    root.innerHTML = '<h2>Biểu mẫu</h2><p class="sub">Tải lên biểu mẫu Word (.docx) đã tô màu (highlight) các chỗ cần thay. Hệ thống nhận diện các chỗ đó, bạn đặt tên trường, người dùng chỉ cần tải Excel/CSV lên để điền tự động. Định dạng Word được giữ nguyên.</p>' +
      '<div class="drop"><p><b>Thêm biểu mẫu mới</b><br><small>Dùng Word: tô màu vàng đúng những chỗ cần thay (họ tên, số vốn, ngày tháng…), lưu thành .docx rồi tải lên.</small></p>' +
      '<input id="tFile" type="file" accept=".docx" hidden><button class="btn primary" id="tPick">Chọn tệp Word (.docx)</button></div>' +
      (A.pdf ? "" : '<p class="sub" style="color:var(--warn)">Máy chủ chưa có LibreOffice/Gotenberg nên chưa xuất được PDF (vẫn xuất được Word). Xem README mục "Xuất PDF".</p>') +
      '<div class="card"><div class="scroll"><table><thead><tr><th>Biểu mẫu</th><th>Tệp</th><th>Trường</th><th>Vùng</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>' +
      (A.list.length ? A.list.map(function (t) {
        return "<tr><td>" + h(t.name) + "</td><td><span class=\"fname\">" + h(t.filename) + "</span></td><td>" + t.field_count + "</td><td>" + t.slot_count + "</td><td>" +
          (t.active ? '<span class="tag t-ok">Đang dùng</span>' : '<span class="tag">Đã tắt</span>') + '</td><td class="acts"><button class="btn sm" data-a="edit" data-id="' + h(t.id) + '">Sửa</button> <button class="btn sm" data-a="tog" data-id="' + h(t.id) + '">' + (t.active ? "Tắt" : "Bật") + '</button> <button class="btn sm danger" data-a="del" data-id="' + h(t.id) + '">Xóa</button></td></tr>';
      }).join("") : '<tr><td colspan="6"><div class="empty"><b>Chưa có biểu mẫu</b>Tải một tệp Word lên để bắt đầu.</div></td></tr>') + "</tbody></table></div></div>";
    $("tPick").onclick = function () { $("tFile").click(); };
    $("tFile").onchange = async function () {
      var f = this.files[0]; this.value = ""; if (!f) return;
      var fd = new FormData(); fd.append("file", f);
      try {
        var d = await api("/api/admin/templates/scan", "POST", fd);
        ed = { id: null, file: f, name: d.filename.replace(/\.docx$/i, ""), description: "", filename: d.filename, paragraphs: d.paragraphs, warnings: d.warnings, cache: {},
          cfg: { slots: d.slots, fields: d.fields, clear_highlight: true } };
        renderEditor();
      } catch (e) { toast(e.message); }
    };
    root.querySelectorAll("[data-a]").forEach(function (b) {
      b.onclick = async function () {
        var id = b.dataset.id, t = A.list.find(function (x) { return x.id === id; });
        try {
          if (b.dataset.a === "edit") {
            var d = await api("/api/admin/templates/" + id);
            ed = { id: id, file: null, name: d.name, description: d.description || "", filename: d.filename, paragraphs: d.paragraphs, warnings: [], cache: {}, cfg: JSON.parse(JSON.stringify(d.config)) };
            renderEditor();
          } else if (b.dataset.a === "tog") { await api("/api/admin/templates/" + id, "PUT", { active: !t.active }); loadAdmin(); }
          else if (confirm("Xóa biểu mẫu \"" + t.name + "\"? Không hoàn tác được.")) { await api("/api/admin/templates/" + id, "DELETE"); toast("Đã xóa biểu mẫu."); loadAdmin(); }
        } catch (e) { toast(e.message); }
      };
    });
  }

  /* --- Trình chỉnh sửa biểu mẫu --- */
  var REF = /\{\{\s*([a-z][a-z0-9_]*)((?:\s*\|\s*[a-z0-9_]+)*)\s*\}\}/g;
  function refsOf(fmt) { var out = [], m; REF.lastIndex = 0; while ((m = REF.exec(fmt || ""))) out.push(m[1]); return out; }
  function syncFields() {   // trường = những khóa được nhắc tới trong nội dung thay thế của các vùng đang bật
    var need = [], seen = {};
    ed.cfg.slots.forEach(function (s) { if (s.enabled) refsOf(s.format).forEach(function (k) { if (!seen[k]) { seen[k] = 1; need.push(k); } }); });
    ed.cfg.fields.forEach(function (f) { ed.cache[f.key] = f; });
    ed.cfg.fields = need.map(function (k) { return ed.cache[k] || { key: k, label: k, type: "text", required: true, example: "" }; });
  }
  function snippet(s) {
    var p = ed.paragraphs.find(function (x) { return x.part === s.part && x.p === s.p; }) || { text: s.text }, t = p.text;
    var a = Math.max(0, s.start - 30), b = Math.min(t.length, s.end + 18);
    return (a ? "…" : "") + h(t.slice(a, s.start)) + "<mark>" + h(t.slice(s.start, s.end)) + "</mark>" + h(t.slice(s.end, b)) + (b < t.length ? "…" : "");
  }
  function renderEditor() {
    syncFields();
    var root = $("adminForms"), c = ed.cfg;
    root.innerHTML = '<h2>' + (ed.id ? "Sửa biểu mẫu" : "Thiết lập biểu mẫu mới") + '</h2><p class="sub">Tệp: ' + h(ed.filename) + "</p>" +
      (ed.warnings && ed.warnings.length ? '<div class="scan lv-warn"><ul>' + ed.warnings.map(function (w) { return '<li class="i-warn">' + h(w) + "</li>"; }).join("") + "</ul></div>" : "") +
      '<div class="card fm-step fm-grid"><label>Tên biểu mẫu<input id="eName" value="' + h(ed.name) + '"></label><label>Mô tả ngắn<input id="eDesc" value="' + h(ed.description) + '" placeholder="VD: Giấy đề nghị thay đổi vốn điều lệ"></label>' +
      '<label class="fm-chk"><input type="checkbox" id="eClr"' + (c.clear_highlight ? " checked" : "") + '> Xóa màu tô vàng trong bản xuất ra (nên bật)</label></div>' +
      '<div class="card fm-step"><b>1. Các vùng sẽ được thay</b><p class="sub">Mỗi dòng là một chỗ trong văn bản. Cột bên phải là nội dung sẽ điền vào, viết dạng <code>{{tên_trường}}</code>. Có thể thêm bộ lọc: <code>{{von|so}}</code> (279.000.000.000), <code>{{von|chu}}</code> (hai trăm bảy mươi chín tỷ), <code>{{ngay|ngay_thang_nam}}</code>, <code>{{ten|upper}}</code> (IN HOA). Bỏ chọn dòng nào không muốn thay.</p>' +
      '<div class="scroll"><table class="fm-slots"><thead><tr><th></th><th>Vị trí trong văn bản</th><th>Nội dung điền vào</th><th></th></tr></thead><tbody>' +
      c.slots.map(function (s, i) {
        return '<tr><td><input type="checkbox" data-s="' + i + '" class="sOn"' + (s.enabled ? " checked" : "") + ' aria-label="Dùng vùng này"></td><td class="fm-snip">' + snippet(s) +
          '</td><td><input class="sFmt" data-s="' + i + '" value="' + h(s.format) + '"></td><td>' + (s.src === "manual" ? '<button class="btn sm danger sDel" data-s="' + i + '" aria-label="Xóa vùng">✕</button>' : '<small class="sub">' + (s.src === "auto" ? "tự thêm" : "tô màu") + "</small>") + "</td></tr>";
      }).join("") + "</tbody></table></div></div>" +
      '<div class="card fm-step"><b>2. Các trường dữ liệu</b><p class="sub">Đây là các cột người dùng sẽ thấy trong tệp Excel mẫu. Đặt tên dễ hiểu, chọn đúng kiểu để hệ thống kiểm tra dữ liệu.</p>' +
      '<div class="scroll"><table><thead><tr><th>Mã trường</th><th>Tên hiển thị (tiêu đề cột)</th><th>Kiểu</th><th>Bắt buộc</th><th>Ví dụ</th></tr></thead><tbody>' +
      c.fields.map(function (f, i) {
        return "<tr><td><code>" + h(f.key) + '</code></td><td><input class="fLab" data-f="' + i + '" value="' + h(f.label) + '"></td><td><select class="fTyp" data-f="' + i + '">' +
          TYPE_LIST.map(function (t) { return opt(t, TYPES[t] || t, f.type === t); }).join("") + '</select></td><td><input type="checkbox" class="fReq" data-f="' + i + '"' + (f.required ? " checked" : "") +
          '></td><td><input class="fEx" data-f="' + i + '" value="' + h(f.example) + '"></td></tr>';
      }).join("") + "</tbody></table></div></div>" +
      '<div class="card fm-step"><details><summary><b>3. Thêm vùng cần thay mà chưa được tô màu</b></summary><p class="sub">Bôi đen đoạn chữ cần thay trong văn bản dưới đây, rồi bấm "Thêm vùng". (Ví dụ phần "bằng chữ" hoặc ngày tháng chưa tô màu.)</p>' +
      '<div id="eSel" class="fm-sel-bar" hidden></div><div class="fm-full" id="eFull"></div></details></div>' +
      '<div class="fm-actions"><button class="btn primary" id="eSave">Lưu biểu mẫu</button> <button class="btn" id="eTestW">Tạo thử Word (dữ liệu ví dụ)</button>' + (A.pdf ? ' <button class="btn" id="eTestP">Tạo thử PDF</button>' : "") + ' <button class="btn" id="eCancel">Quay lại</button></div>';
    bindEditor(); renderFull();
  }
  function bindEditor() {
    var c = ed.cfg;
    $("eName").oninput = function () { ed.name = this.value; }; $("eDesc").oninput = function () { ed.description = this.value; }; $("eClr").onchange = function () { c.clear_highlight = this.checked; };
    document.querySelectorAll(".sOn").forEach(function (e) { e.onchange = function () { c.slots[+e.dataset.s].enabled = e.checked; keepScroll(renderEditor); }; });
    document.querySelectorAll(".sFmt").forEach(function (e) { e.onchange = function () { c.slots[+e.dataset.s].format = e.value; keepScroll(renderEditor); }; });
    document.querySelectorAll(".sDel").forEach(function (e) { e.onclick = function () { c.slots.splice(+e.dataset.s, 1); keepScroll(renderEditor); }; });
    document.querySelectorAll(".fLab").forEach(function (e) { e.oninput = function () { c.fields[+e.dataset.f].label = e.value; }; });
    document.querySelectorAll(".fTyp").forEach(function (e) { e.onchange = function () { c.fields[+e.dataset.f].type = e.value; }; });
    document.querySelectorAll(".fReq").forEach(function (e) { e.onchange = function () { c.fields[+e.dataset.f].required = e.checked; }; });
    document.querySelectorAll(".fEx").forEach(function (e) { e.oninput = function () { c.fields[+e.dataset.f].example = e.value; }; });
    $("eCancel").onclick = function () { loadAdmin(); };
    $("eSave").onclick = async function () {
      busy(this, true, "Đang lưu…");
      try {
        if (ed.id) await api("/api/admin/templates/" + ed.id, "PUT", { name: ed.name, description: ed.description, config: c });
        else { var fd = new FormData(); fd.append("file", ed.file); fd.append("name", ed.name); fd.append("description", ed.description); fd.append("config", JSON.stringify(c)); await api("/api/admin/templates", "POST", fd); }
        toast("Đã lưu biểu mẫu."); loadAdmin();
      } catch (e) { busy(this, false); toast(e.message); }
    };
    function test(fmt) {
      return async function () {
        busy(this, true, "Đang tạo thử…");
        try {
          var fd = new FormData(); if (ed.id) fd.append("id", ed.id); else fd.append("file", ed.file); fd.append("config", JSON.stringify(c)); fd.append("format", fmt);
          await download("/api/admin/templates/test", { method: "POST", form: fd }, "bieu-mau-thu." + fmt); toast("Đã tạo bản thử, hãy mở ra kiểm tra bố cục.");
        } catch (e) { toast(e.message); }
        busy(this, false);
      };
    }
    $("eTestW").onclick = test("docx"); if ($("eTestP")) $("eTestP").onclick = test("pdf");
  }
  function keepScroll(fn) { var y = ($("fMain") || document.scrollingElement || {}).scrollTop; var p = $("tab-forms"); var st = p ? p.scrollTop : 0; fn(); if (p) p.scrollTop = st; void y; }

  /* --- Toàn văn mẫu: bôi đen để thêm vùng thủ công --- */
  function renderFull() {
    var box = $("eFull"); if (!box) return;
    box.innerHTML = ed.paragraphs.map(function (p, i) {
      if (!p.text.trim()) return "";
      var sl = ed.cfg.slots.filter(function (s) { return s.part === p.part && s.p === p.p; }).sort(function (a, b) { return a.start - b.start; }), pos = 0, html = "";
      sl.forEach(function (s) { html += h(p.text.slice(pos, s.start)) + '<mark class="' + (s.enabled ? "" : "off") + '">' + h(p.text.slice(s.start, s.end)) + "</mark>"; pos = s.end; });
      return '<div class="fm-para" data-i="' + i + '"><span class="fm-t">' + html + h(p.text.slice(pos)) + "</span></div>";
    }).join("");
    box.onmouseup = function () {
      var sel = getSelection(); if (!sel.rangeCount || sel.isCollapsed) return;
      var rg = sel.getRangeAt(0), pe = rg.startContainer.parentElement && rg.startContainer.parentElement.closest(".fm-para"), pe2 = rg.endContainer.parentElement && rg.endContainer.parentElement.closest(".fm-para");
      if (!pe || pe !== pe2) { $("eSel").hidden = true; return; }
      var pre = document.createRange(); pre.selectNodeContents(pe.querySelector(".fm-t")); pre.setEnd(rg.startContainer, rg.startOffset);
      var raw = rg.toString(), lead = raw.length - raw.replace(/^\s+/, "").length, txt = raw.trim(), start = pre.toString().length + lead;
      if (!txt) return;
      var p = ed.paragraphs[+pe.dataset.i]; selRange = { part: p.part, p: p.p, start: start, end: start + txt.length, text: txt };
      var bar = $("eSel"); bar.hidden = false; bar.innerHTML = 'Đã chọn: <b>' + h(txt.length > 60 ? txt.slice(0, 60) + "…" : txt) + '</b> <button class="btn sm primary" id="eAdd">Thêm vùng thay thế</button>';
      $("eAdd").onclick = function () {
        var r = selRange, over = ed.cfg.slots.some(function (s) { return s.part === r.part && s.p === r.p && s.start < r.end && r.start < s.end; });
        if (over) return toast("Vùng này chồng lên một vùng đã có.");
        var n = 1, key; do { key = "truong_" + n++; } while (ed.cfg.fields.some(function (f) { return f.key === key; }) || ed.cache[key]);
        ed.cfg.slots.push({ id: "m" + Date.now(), src: "manual", part: r.part, p: r.p, start: r.start, end: r.end, text: r.text, format: "{{" + key + "}}", enabled: true });
        ed.cfg.slots.sort(function (a, b) { return a.part === b.part ? a.p - b.p || a.start - b.start : a.part < b.part ? -1 : 1; });
        toast("Đã thêm vùng. Hãy đặt tên trường ở bảng trên."); renderEditor();
      };
    };
  }

  return { loadUser: loadUser, loadAdmin: loadAdmin };
})();
