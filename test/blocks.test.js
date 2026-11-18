// Ngắt khoảng (khối): cấu hình lưu được, Excel mẫu có hàng tên khối, đọc lại đúng, ghép cột không lẫn giữa các khối.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { blocksOf } = require('../lib/forms');
const { cleanConfig } = require('../lib/templates');
const { sampleXlsx, sampleCsv, readTable, autoMap, MAX_ROWS } = require('../lib/tabular');

const F = () => [
  { key: 'cty', label: 'Tên công ty', type: 'text', required: true, example: 'ABC', section: 'Thông tin chung' },
  { key: 'ten_1', label: 'Họ và tên', type: 'text', required: true, example: 'Nguyễn A', brk: true, section: 'Thành viên 1' },
  { key: 'cv_1', label: 'Chức vụ', type: 'text', required: true, example: 'Giám đốc' },
  { key: 'von_1', label: 'Giá trị góp vốn', type: 'money', required: true, example: '1000000' },
  { key: 'ten_2', label: 'Họ và tên', type: 'text', required: true, example: 'Trần B', brk: true, section: 'Thành viên 2' },
  { key: 'cv_2', label: 'Chức vụ', type: 'text', required: true, example: 'Phó giám đốc' },
  { key: 'von_2', label: 'Giá trị góp vốn', type: 'money', required: true, example: '2000000' }
];
const load = async buf => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };

test('blocksOf: chia theo đường ngắt, khối chưa đặt tên gọi "Phần N", không ngắt thì một khối không tiêu đề', () => {
  const b = blocksOf(F());
  assert.deepEqual(b.map(x => [x.title, x.fields.length]), [['Thông tin chung', 1], ['Thành viên 1', 3], ['Thành viên 2', 3]]);
  const f = F(); f[4].section = '';
  assert.equal(blocksOf(f)[2].title, 'Phần 3');
  const plain = blocksOf(F().map(x => ({ key: x.key, label: x.label })));
  assert.equal(plain.length, 1); assert.equal(plain[0].title, '');
  assert.deepEqual(blocksOf([]), []);
});

test('cleanConfig: giữ đường ngắt và tên khối, bỏ phần thừa; trường đầu không cần brk', () => {
  const c = cleanConfig({ fields: [
    { key: 'a', label: 'A', type: 'text', brk: true, section: '  Khối đầu  ' },
    { key: 'b', label: 'B', type: 'text', section: 'tên thừa vì b không mở khối' },
    { key: 'c', label: 'C', type: 'text', brk: true, section: 'Khối hai' },
    { key: 'd', label: 'D', type: 'text', brk: 'yes' }
  ] });
  assert.deepEqual(c.fields.map(f => [f.brk, f.section]), [[undefined, 'Khối đầu'], [undefined, undefined], [true, 'Khối hai'], [undefined, undefined]]);
  assert.equal(cleanConfig({ fields: [{ key: 'x', label: 'x', type: 'text', section: 'y'.repeat(200) }] }).fields[0].section.length, 80);
});

test('Excel mẫu nhiều khối: hàng 1 là tên khối (gộp ô), hàng 2 là tiêu đề, hàng 3 là ví dụ; ràng buộc nhập nằm đúng dòng', async () => {
  const ws = (await load(await sampleXlsx(F()))).worksheets[0];
  assert.equal(ws.getCell('A1').value, 'Thông tin chung');
  assert.equal(ws.getCell('B1').value, 'Thành viên 1'); assert.ok(ws.getCell('C1').isMerged && ws.getCell('D1').isMerged);
  assert.equal(ws.getCell('E1').value, 'Thành viên 2');
  assert.equal(ws.getCell('A2').value, 'Tên công ty'); assert.equal(ws.getCell('E2').value, 'Họ và tên');
  assert.equal(ws.getCell('D3').value, 1000000); assert.equal(ws.getCell('D3').numFmt, '#,##0');
  assert.equal(ws.getCell('D4').dataValidation.type, 'whole', 'ô tiền ở dòng dữ liệu đầu tiên sau ví dụ có ràng buộc');
  assert.equal(ws.getCell('D' + (MAX_ROWS + 2)).numFmt, '#,##0', 'đủ số dòng tối đa');
  assert.equal(ws.views[0].ySplit, 2, 'cố định cả hàng tên khối và hàng tiêu đề');
  assert.equal(ws.getCell('B2').border.left.style, 'medium', 'đường dọc đậm ở đầu khối'); assert.equal(ws.getCell('E5').border.left.style, 'medium');
  assert.equal(ws.getCell('A2').border.left, undefined, 'khối đầu không cần đường kẻ bên trái');
  const guide = (await load(await sampleXlsx(F()))).worksheets[1];
  assert.equal(guide.getCell('E5').value, 'Thành viên 1');
});

test('Excel mẫu một khối (chưa ngắt khoảng): bố cục cũ, tiêu đề ở hàng 1', async () => {
  const ws = (await load(await sampleXlsx(F().map(f => ({ key: f.key, label: f.label, type: f.type, required: true, example: f.example }))))).worksheets[0];
  assert.equal(ws.getCell('A1').value, 'Tên công ty'); assert.equal(ws.getCell('D2').value, 1000000); assert.equal(ws.views[0].ySplit, 1);
});

test('đọc lại tệp mẫu nhiều khối: bỏ hàng tên khối, ghép đủ cột, hai cột "Chức vụ" không lẫn', async () => {
  const fields = F(), titles = blocksOf(fields).map(b => b.title);
  const t = await readTable(await sampleXlsx(fields), 'mau.xlsx', { titles });
  assert.deepEqual(t.headers, ['Tên công ty', 'Họ và tên', 'Chức vụ', 'Giá trị góp vốn', 'Họ và tên', 'Chức vụ', 'Giá trị góp vốn']);
  assert.deepEqual(t.bands, ['Thông tin chung', 'Thành viên 1', 'Thành viên 1', 'Thành viên 1', 'Thành viên 2', 'Thành viên 2', 'Thành viên 2']);
  assert.deepEqual(t.rows[0], ['ABC', 'Nguyễn A', 'Giám đốc', '1000000', 'Trần B', 'Phó giám đốc', '2000000']);
  assert.deepEqual(Object.values(autoMap(t.headers, fields, t.bands)), ['cty', 'ten_1', 'cv_1', 'von_1', 'ten_2', 'cv_2', 'von_2']);
});

test('người dùng đảo khối 2 lên trước khối 1: nhờ hàng tên khối vẫn ghép đúng (không có hàng đó thì ghép theo thứ tự xuất hiện)', async () => {
  const fields = F(), titles = blocksOf(fields).map(b => b.title);
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('d');
  ws.addRow(['Thành viên 2', '', 'Thành viên 1', '']); ws.addRow(['Họ và tên', 'Chức vụ', 'Họ và tên', 'Chức vụ']); ws.addRow(['Trần B', 'Phó GĐ', 'Nguyễn A', 'Giám đốc']);
  const t = await readTable(Buffer.from(await wb.xlsx.writeBuffer()), 'd.xlsx', { titles });
  assert.deepEqual(Object.values(autoMap(t.headers, fields, t.bands)), ['ten_2', 'cv_2', 'ten_1', 'cv_1']);
  const naive = await readTable(Buffer.from(await wb.xlsx.writeBuffer()), 'd.xlsx');   // không có titles: hàng tên khối bị coi là tiêu đề
  assert.equal(naive.bands, null);
});

test('hàng đầu không phải tên khối thì giữ nguyên là tiêu đề; CSV mẫu không có hàng tên khối', async () => {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('d');
  ws.addRow(['Họ và tên', 'Chức vụ']); ws.addRow(['A', 'B']);
  const t = await readTable(Buffer.from(await wb.xlsx.writeBuffer()), 'd.xlsx', { titles: ['Thành viên 1', 'Thành viên 2'] });
  assert.deepEqual(t.headers, ['Họ và tên', 'Chức vụ']); assert.equal(t.bands, null);
  assert.equal(sampleCsv(F()).toString('utf8').split('\r\n')[0].replace('\uFEFF', ''), 'Tên công ty;Họ và tên;Chức vụ;Giá trị góp vốn;Họ và tên;Chức vụ;Giá trị góp vốn');
});
