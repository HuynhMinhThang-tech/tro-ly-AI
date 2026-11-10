// Chạy: npm test   (không cần database hay API key)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { toMarkdown, textToMarkdown, promoteLegalHeadings } = require('../lib/markdown');
const { chunkMarkdown } = require('../lib/chunker');
const { analyze } = require('../lib/ingest');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const heads = md => md.split('\n').filter(l => /^#{1,6} /.test(l));
const dieuNums = md => heads(md).map(h => (h.match(/^#### Điều (\d+)\./) || [])[1]).filter(Boolean).map(Number);

test('TXT luật → Markdown: có tên luật, Chương, và các Điều theo đúng thứ tự', async () => {
  const r = await toMarkdown(fx('luat-mau.txt'), 'luat-mau.txt');
  assert.equal(r.type, 'text');
  assert.match(heads(r.markdown)[0], /^# LUẬT PHÒNG CHÁY/);
  assert.ok(heads(r.markdown).some(h => /^## Chương I – QUY ĐỊNH CHUNG$/.test(h)));
  const nums = dieuNums(r.markdown);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('Chịu được các lỗi OCR thường gặp ở tiêu đề: "Điều 2 1 .", "Điêu 50.", "ChưongI", "Chuong V in"', () => {
  const md = textToMarkdown([
    'ChưongI', 'QUY ĐỊNH CHUNG', 'Điều 2 1 . Phòng cháy đối vói nhà ở', '1. Nội dung khoản một.',
    'Điêu 50. Ngân sách nhà nưóc bảo đảm', 'cho hoạt động phòng cháy', '1. Nội dung khoản một của điều năm mươi.',
    'Chuong V in', 'ĐIÈƯ KHOẢN THI HÀNH', 'Điều 53. Sửa đổi', '1. Nội dung khoản.'
  ].join('\n'));
  const h = md.split('\n').filter(l => l.startsWith('#'));
  assert.deepEqual(h, ['## Chương I – QUY ĐỊNH CHUNG', '#### Điều 21. Phòng cháy đối vói nhà ở',
    '#### Điều 50. Ngân sách nhà nưóc bảo đảm cho hoạt động phòng cháy', '## Chương V – ĐIÈƯ KHOẢN THI HÀNH', '#### Điều 53. Sửa đổi']);
});

test('TXT luật → Markdown: nối dòng ngắt cứng, bỏ số trang, tách riêng Khoản', async () => {
  const md = (await toMarkdown(fx('luat-mau.txt'), 'x.txt')).markdown;
  assert.ok(!/^\s*\d{1,3}\s*$/m.test(md), 'không còn dòng chỉ có số trang');
  assert.ok(!/E-pas/i.test(md));
  assert.match(md, /^1\. Cháy là phản ứng hóa học[^\n]+trật tự\.$/m, 'Khoản 1 Điều 2 gói trong đúng một dòng');
  assert.match(md, /^Luật số: 55\/2024\/QH15$/m, 'dòng ngắn ở phần mở đầu không bị dính vào dòng khác');
  assert.match(md, /Cơ sở thuộc diện quản lý[^\n]+hoạt động thương mại, làm việc/, 'câu bị ngắt do sang trang được nối lại');
  assert.match(md, /#### Điều 4\. Chính sách của Nhà nước về phòng cháy, chữa cháy, cứu nạn, cứu hộ\n/, 'tiêu đề Điều bị ngắt dòng được nối');
});

test('Tiêu đề Điều dài 3 dòng được nối đủ, không để rơi vào nội dung', () => {
  const md = textToMarkdown([
    'Điều 16. Yêu cầu về phòng cháy, chữa cháy khi lập, điều chỉnh dự án', 'đầu tư xây dựng công trình, thiết kế công trình, cải tạo, thay đổi công năng sử',
    'dụng công trình, sản xuất, lắp ráp, đóng mới, hoán cải phương tiện giao thông', '1. Khi lập dự án phải có giải pháp phòng cháy và chữa cháy phù hợp.'
  ].join('\n'));
  assert.match(md, /^#### Điều 16\. .+năng sử dụng công trình, sản xuất, lắp ráp, đóng mới, hoán cải phương tiện giao thông$/m);
  assert.match(md, /\n\n1\. Khi lập dự án/);
});

test('PDF thật cho cùng cấu trúc với TXT', async () => {
  const r = await toMarkdown(fx('luat-mau.pdf'), 'luat-mau.pdf');
  assert.equal(r.type, 'pdf'); assert.equal(r.pages, 6);
  const nums = dieuNums(r.markdown);
  assert.deepEqual(nums.slice(0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('DOCX có style Heading → giữ tiêu đề, danh sách, bảng', async () => {
  const r = await toMarkdown(fx('quy-che-heading.docx'), 'a.docx');
  assert.equal(r.type, 'docx');
  assert.match(r.markdown, /^# QUY CHẾ PHÒNG CHÁY CHỮA CHÁY NỘI BỘ$/m);
  assert.match(r.markdown, /^## Chương I – QUY ĐỊNH CHUNG$/m);
  assert.match(r.markdown, /^#### Điều 2\. Trách nhiệm$/m);
  assert.match(r.markdown, /^- +Ban hành nội quy phòng cháy;$/m);
  assert.match(r.markdown, /^\| Thiết bị \| Số lượng \| Chu kỳ kiểm tra \|\n\| --- \| --- \| --- \|\n\| Bình chữa cháy \| 24 \| 6 tháng \|/m);
});

test('DOCX KHÔNG có style Heading (chỉ gõ "Điều 1." / in đậm) vẫn ra đúng cấp tiêu đề', async () => {
  const md = (await toMarkdown(fx('quy-che-khong-heading.docx'), 'b.docx')).markdown;
  assert.match(md, /^## Chương I – QUY ĐỊNH CHUNG$/m, 'CHƯƠNG I + dòng in hoa kế tiếp gộp thành một tiêu đề');
  assert.match(md, /^#### Điều 1\. Phạm vi điều chỉnh$/m, 'tiêu đề in đậm → bỏ ** và lên cấp tiêu đề');
  assert.match(md, /^#### Điều 3\. Điều khoản thi hành$/m, 'tiêu đề không in đậm cũng nhận ra');
  assert.match(md, /^# QUY CHẾ AN TOÀN PHÒNG CHÁY CHỮA CHÁY TẠI KHO HÀNG$/m, 'tên văn bản "QUY CHẾ" + dòng in hoa kế tiếp thành tiêu đề cấp 1');
  assert.ok(!md.includes('**'));
  assert.match(md, /^1\. Hàng hóa dễ cháy/m, 'không bị escape "1\\."');
});

test('HTML → Markdown: bỏ script/style/ảnh, giữ bảng và tiêu đề', async () => {
  const html = '<!doctype html><html><head><title>t</title><style>p{}</style></head><body><script>alert(1)</script>' +
    '<h2>Điều 5. Nguyên tắc</h2><p>Nội dung <b>quan trọng</b>.</p><img src="data:image/png;base64,AAAA">' +
    '<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2 | 3</td></tr></table></body></html>';
  const r = await toMarkdown(Buffer.from(html), 'f.html');
  assert.equal(r.type, 'html');
  assert.match(r.markdown, /^#### Điều 5\. Nguyên tắc$/m);
  assert.ok(!/alert|base64|p\{\}/.test(r.markdown));
  assert.match(r.markdown, /\| 1 \| 2 \\\| 3 \|/);
});

test('Markdown có sẵn: giữ nguyên, chuẩn hóa Chương/Điều', async () => {
  const src = '# Tên\n\n**Điều 1. Mục đích**\n\nNội dung.\n\n## Phần khác\n\nChữ.\n';
  const r = await toMarkdown(Buffer.from(src), 'a.md');
  assert.equal(r.type, 'markdown');
  assert.match(r.markdown, /^#### Điều 1\. Mục đích$/m);
  assert.match(r.markdown, /^## Phần khác$/m);
});

test('Tệp không hỗ trợ trả về lỗi dễ hiểu', async () => {
  assert.match((await toMarkdown(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), 'a.doc')).error, /\.doc/);
  assert.match((await toMarkdown(Buffer.from('{\\rtf1 abc'), 'a.rtf')).error, /RTF/);
  assert.match((await toMarkdown(Buffer.from([1, 2, 0, 3, 4]), 'a.bin')).error, /không phải văn bản/);
  assert.match((await toMarkdown(Buffer.from('%PDF-1.4 hỏng'), 'a.pdf')).error, /PDF/);
  assert.match((await toMarkdown(Buffer.from('PK\x03\x04 không phải docx'), 'a.docx')).error, /DOCX/);
});

// ---------------- Chunker ----------------
test('Chunker: mỗi Điều một đoạn, nhãn có đường dẫn Chương › Điều, không đoạn nào quá dài', async () => {
  const md = (await toMarkdown(fx('luat-mau.txt'), 'x.txt')).markdown;
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length >= 14);
  for (const c of chunks) {
    assert.ok(c.content.length <= 1800 * 1.25, `đoạn quá dài (${c.content.length}): ${c.heading}`);
    assert.ok(!/^#{1,6} /m.test(c.content), 'nội dung đoạn không chứa dòng tiêu đề của mục khác');
  }
  const d1 = chunks.find(c => /Điều 1\. /.test(c.heading));
  assert.equal(d1.heading, 'Chương I – QUY ĐỊNH CHUNG › Điều 1. Phạm vi điều chỉnh');
  assert.ok(chunks.some(c => /Điều 8\..* \(phần 1\/\d+\)$/.test(c.heading)), 'Điều dài được tách và đánh dấu phần');
  const d2parts = chunks.filter(c => /Điều 2\. /.test(c.heading));
  assert.ok(d2parts.length >= 2 && d2parts.every(c => /\(phần \d+\/\d+\)$/.test(c.heading)));
  assert.ok(d2parts.every(c => /(^|\n)\d+\. /.test(c.content)), 'tách ở ranh giới Khoản: mỗi phần bắt đầu bằng Khoản đầy đủ');
});

test('Chunker: bảng dài được tách theo hàng và lặp lại hàng tiêu đề', () => {
  const rows = Array.from({ length: 60 }, (_, i) => `| Mục ${i} | Giá trị ${i} |`);
  const md = '## Bảng\n\n| Tên | Giá trị |\n| --- | --- |\n' + rows.join('\n') + '\n';
  const chunks = chunkMarkdown(md, { max: 500 });
  assert.ok(chunks.length > 2);
  for (const c of chunks) assert.match(c.content, /^\| Tên \| Giá trị \|\n\| --- \| --- \|\n\| Mục \d+/);
  assert.equal(chunks.map(c => c.content.match(/\| Mục \d+ /g).length).reduce((a, b) => a + b), 60, 'không mất hàng nào');
});

test('Chunker: đoạn văn dài tách theo câu có gối đầu; câu quá dài bị cắt cứng', () => {
  const sent = i => `Câu số ${i} nói về an toàn phòng cháy chữa cháy trong kho hàng.`;
  const long = Array.from({ length: 80 }, (_, i) => sent(i)).join(' ');
  const chunks = chunkMarkdown('## A\n\n' + long, { max: 600 });
  assert.ok(chunks.length > 4);
  chunks.forEach(c => assert.ok(c.content.length <= 600 * 1.25));
  assert.ok(chunks[1].content.slice(0, 60).split(' ').slice(0, 3).join(' ') !== sent(0).split(' ').slice(0, 3).join(' '));
  const all = chunks.map(c => c.content).join(' ');
  for (let i = 0; i < 80; i++) assert.ok(all.includes(sent(i)), 'không mất câu nào: ' + i);
  const huge = chunkMarkdown('## B\n\n' + 'x'.repeat(5000), { max: 1000 });
  assert.ok(huge.length >= 5 && huge.every(c => c.content.length <= 1000));
});

test('Chunker: văn bản không có tiêu đề vẫn tách được; mục cha rỗng không tạo đoạn', () => {
  const plain = chunkMarkdown('Đoạn một khá dài để vượt ngưỡng tối thiểu của bộ tách.\n\nĐoạn hai cũng đủ dài như vậy.');
  assert.equal(plain.length, 1); assert.equal(plain[0].heading, 'Phần mở đầu');
  const tree = chunkMarkdown('# Tên văn bản\n\n## Chương I – CHUNG\n\n#### Điều 1. Một\n\nNội dung điều một ở đây.\n');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].heading, 'Chương I – CHUNG › Điều 1. Một');
});

// ---------------- analyze() ----------------
test('analyze(): TXT luật hợp lệ, hash tính trên chữ gốc (tương thích tài liệu đã lập chỉ mục)', async () => {
  const buf = fx('luat-mau.txt');
  const a = await analyze(buf, 'luat-mau.txt');
  assert.ok(a.chunks.length > 10);
  assert.ok(a.markdown.startsWith('# LUẬT'));
  assert.deepEqual(a.issues.filter(i => i.level === 'block'), []);
  assert.equal(a.hash, crypto.createHash('sha256').update(buf.toString('utf8').replace(/\s+/g, ' ').trim()).digest('hex'));
});

test('analyze(): vẫn cảnh báo lỗi OCR (chữ bị tách rời) như trước', async () => {
  const ocr = 'Điều 1. Phạm vi\n' + 'Hoạt động c ứ u nạn, c ứ u hộ và c ứ u trợ. '.repeat(8) + '\nĐiều 2. Khác\n' + 'Nội dung điều hai khá dài để đủ ngưỡng. '.repeat(5);
  const a = await analyze(Buffer.from(ocr), 'ocr.txt');
  assert.ok(a.issues.some(i => i.level === 'warn' && /chữ bị tách rời/.test(i.text)));
  assert.ok(a.chunks.some(c => /Điều 2\./.test(c.heading)));
});

test('analyze(): tệp quá ngắn / định dạng không hỗ trợ bị chặn', async () => {
  const empty = await analyze(Buffer.from('ngắn quá'), 'a.txt');
  assert.ok(empty.issues.some(i => i.level === 'block' && /trống hoặc quá ngắn/.test(i.text)));
  const bad = await analyze(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]), 'a.doc');
  assert.ok(bad.issues.some(i => i.level === 'block'));
});

test('analyze(): DOCX có ảnh → chỉ lấy chữ, không nhúng base64, có ghi chú cho admin', async () => {
  const a = await analyze(fx('co-anh.docx'), 'co-anh.docx');
  assert.ok(!/base64|data:image/.test(a.markdown));
  assert.ok(a.issues.some(i => i.level === 'info' && /1 hình ảnh/.test(i.text)));
  assert.match(a.markdown, /^# Hướng dẫn thoát hiểm$/m);
  assert.deepEqual(a.issues.filter(i => i.level === 'block'), []);
});
