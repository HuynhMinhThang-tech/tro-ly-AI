// Chạy: npm test   (không cần database hay API key)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { readTextFile } = require('../lib/markdown');
const { chunkMarkdown } = require('../lib/chunker');
const { analyze } = require('../lib/ingest');

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const luatMd = () => fx('luat-mau.md').toString('utf8');

// ---------------- Đọc tệp: chỉ .md / .txt, không chuyển đổi ----------------
test('Markdown: giữ nguyên nội dung, không chỉnh gì', () => {
  const src = '# Tên\n\n**Điều 1. Mục đích**\n\nNội dung.\n\n## Phần khác\n\nChữ.\n';
  const r = readTextFile(Buffer.from(src), 'a.md');
  assert.equal(r.type, 'markdown'); assert.equal(r.markdown, src); assert.equal(r.text, src);
});

test('TXT: giữ nguyên nội dung, không tự thêm tiêu đề #', () => {
  const src = 'LUẬT\nChương I\nĐiều 1. Phạm vi\nNội dung.\n';
  const r = readTextFile(Buffer.from(src), 'a.txt');
  assert.equal(r.type, 'text'); assert.equal(r.markdown, src); assert.ok(!/^#/m.test(r.markdown));
});

test('Chỉ chuẩn hóa BOM và xuống dòng Windows (CRLF)', () => {
  const r = readTextFile(Buffer.from('\uFEFFdòng một\r\ndòng hai\r\n'), 'a.TXT');
  assert.equal(r.markdown, 'dòng một\ndòng hai\n');
});

test('Tệp khác .md/.txt bị từ chối, thông báo yêu cầu chuyển về Markdown hoặc txt', () => {
  for (const name of ['a.pdf', 'a.docx', 'a.doc', 'a.html', 'a.rtf', 'a.xlsx', 'khong-duoi']) {
    const r = readTextFile(Buffer.from('nội dung'), name);
    assert.ok(r.error, name); assert.match(r.error, /Markdown \(\.md\) hoặc văn bản \(\.txt\)/, name);
  }
  assert.match(readTextFile(Buffer.from('x'), 'a.pdf').error, /\.pdf/);
});

test('Đuôi .txt/.md nhưng nội dung nhị phân hoặc UTF-16 → báo lỗi dễ hiểu', () => {
  const r = readTextFile(Buffer.from([0xff, 0xfe, 0x41, 0, 0x42, 0]), 'a.txt');
  assert.match(r.error, /UTF-8/);
  assert.match(readTextFile(Buffer.from([1, 2, 0, 3]), 'a.md').error, /UTF-8/);
});

// ---------------- Chunker ----------------
test('Chunker: mỗi Điều một đoạn, nhãn có đường dẫn Chương › Điều, không đoạn nào quá dài', async () => {
  const md = luatMd();
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
test('analyze(): MD luật hợp lệ, hash tính trên chữ gốc (tương thích tài liệu đã lập chỉ mục)', async () => {
  const buf = fx('luat-mau.md');
  const a = await analyze(buf, 'luat-mau.md');
  assert.ok(a.chunks.length > 10);
  assert.ok(a.markdown.startsWith('# LUẬT'));
  assert.deepEqual(a.issues.filter(i => i.level === 'block'), []);
  assert.equal(a.hash, crypto.createHash('sha256').update(buf.toString('utf8').replace(/\s+/g, ' ').trim()).digest('hex'));
});

test('analyze(): TXT không có tiêu đề # vẫn nhận, tách theo độ dài và báo cho admin', async () => {
  const a = await analyze(fx('luat-mau.txt'), 'luat-mau.txt');
  assert.deepEqual(a.issues.filter(i => i.level === 'block'), []);
  assert.ok(a.chunks.length >= 1);
  assert.ok(a.issues.some(i => i.level === 'info' && /không thấy tiêu đề/i.test(i.text)));
});

test('analyze(): vẫn cảnh báo lỗi OCR (chữ bị tách rời) như trước', async () => {
  const ocr = '#### Điều 1. Phạm vi\n' + 'Hoạt động c ứ u nạn, c ứ u hộ và c ứ u trợ. '.repeat(8) + '\n#### Điều 2. Khác\n' + 'Nội dung điều hai khá dài để đủ ngưỡng. '.repeat(5);
  const a = await analyze(Buffer.from(ocr), 'ocr.md');
  assert.ok(a.issues.some(i => i.level === 'warn' && /chữ bị tách rời/.test(i.text)));
  assert.ok(a.chunks.some(c => /Điều 2\./.test(c.heading)));
});

test('analyze(): tệp quá ngắn bị chặn; PDF/Word bị chặn kèm hướng dẫn chuyển về .md/.txt', async () => {
  const empty = await analyze(Buffer.from('ngắn quá'), 'a.txt');
  assert.ok(empty.issues.some(i => i.level === 'block' && /trống hoặc quá ngắn/.test(i.text)));
  for (const name of ['a.pdf', 'a.docx', 'a.doc', 'a.html']) {
    const bad = await analyze(Buffer.from('%PDF-1.4 hoặc PK nội dung bất kỳ'), name);
    assert.ok(bad.issues.some(i => i.level === 'block' && /\.md\) hoặc văn bản \(\.txt/.test(i.text)), name);
    assert.equal(bad.chunks.length, 0);
  }
});
