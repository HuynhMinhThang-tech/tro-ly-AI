// Tệp Excel/CSV: tệp mẫu có định dạng + ràng buộc nhập, và đọc đúng các kiểu ô (số, ngày, phần trăm, chữ).
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { sampleXlsx, sampleCsv, readTable, autoMap } = require('../lib/tabular');

const FIELDS = [
  { key: 'ten', label: 'Tên doanh nghiệp', type: 'text', required: true, example: 'Công ty A' },
  { key: 'von', label: 'Vốn điều lệ (VNĐ)', type: 'money', required: true, example: '279000000000' },
  { key: 'ty_le', label: 'Tỷ lệ', type: 'percent', required: true, example: '100' },
  { key: 'ngay', label: 'Ngày lập', type: 'date', required: true, example: '28/08/2026' },
  { key: 'mst', label: 'Mã số thuế', type: 'tax_code', required: true, example: '0108123456' }
];
const load = async buf => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };

test('tệp Excel mẫu: ô có định dạng đúng kiểu và ràng buộc nhập (tiền, %, ngày, mã số thuế)', async () => {
  const ws = (await load(await sampleXlsx(FIELDS))).worksheets[0];
  assert.equal(ws.getCell('B2').numFmt, '#,##0'); assert.equal(ws.getCell('B2').value, 279000000000, 'ví dụ tiền là SỐ để định dạng có tác dụng');
  assert.equal(ws.getCell('C2').numFmt, 'General"%"'); assert.equal(ws.getCell('D2').numFmt, 'dd/mm/yyyy');
  assert.ok(ws.getCell('D2').value instanceof Date && ws.getCell('D2').value.toISOString().startsWith('2026-08-28'), 'ví dụ ngày là ngày thật');
  assert.equal(ws.getCell('E2').numFmt, '@'); assert.equal(ws.getCell('E2').value, '0108123456');
  assert.equal(ws.getCell('B30').numFmt, '#,##0', 'ô ở các dòng dưới cũng đã định dạng sẵn');
  assert.equal(ws.getCell('B3').dataValidation.type, 'whole');
  assert.equal(ws.getCell('C3').dataValidation.type, 'decimal'); assert.deepEqual(ws.getCell('C3').dataValidation.formulae, [0, 100]);
  assert.equal(ws.getCell('D3').dataValidation.errorStyle, 'warning', 'ngày chỉ cảnh báo để không chặn nhầm máy dùng định dạng ngày khác');
  assert.match(ws.getCell('E3').dataValidation.formulae[0], /LEN\(E3\)=10.*LEN\(E3\)=13/);
  assert.equal(ws.getCell('A3').dataValidation, undefined, 'trường chữ không bị ràng buộc');
});

test('đọc lại chính tệp mẫu: giá trị đúng kiểu, tự ghép đủ cột', async () => {
  const t = await readTable(await sampleXlsx(FIELDS), 'mau.xlsx');
  assert.deepEqual(t.rows[0], ['Công ty A', '279000000000', '100', '2026-08-28', '0108123456']);
  assert.deepEqual(Object.values(autoMap(t.headers, FIELDS)), ['ten', 'von', 'ty_le', 'ngay', 'mst']);
});

test('ô Excel định dạng % thật (1 = 100%) được quy đổi; ô gõ 100 hiển thị 100% thì giữ nguyên', async () => {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('d');
  ws.addRow(['Tỷ lệ A', 'Tỷ lệ B', 'Tỷ lệ C']); ws.addRow([1, 33.5, 0.3333]);
  ws.getCell('A2').numFmt = '0%'; ws.getCell('B2').numFmt = 'General"%"'; ws.getCell('C2').numFmt = '0.00%';
  const t = await readTable(Buffer.from(await wb.xlsx.writeBuffer()), 'p.xlsx');
  assert.deepEqual(t.rows[0], ['100', '33.5', '33.33']);
});

test('CSV mẫu: dấu ; + BOM, ví dụ hiện đúng dạng chuẩn; đọc lại được kể cả dấu , và tab', async () => {
  const csv = sampleCsv(FIELDS), txt = csv.toString('utf8');
  assert.ok(csv.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])));
  assert.match(txt, /Công ty A;279\.000\.000\.000;100;28\/08\/2026;0108123456/);
  assert.equal((await readTable(csv, 'mau.csv')).rows[0][1], '279.000.000.000');
  assert.equal((await readTable(Buffer.from('a,b\n1,2\n'), 'x.csv')).rows[0][1], '2');
  assert.equal((await readTable(Buffer.from('a\tb\n1\t2\n'), 'x.csv')).rows[0][1], '2');
});

test('tệp không hợp lệ bị từ chối bằng thông báo dễ hiểu', async () => {
  await assert.rejects(readTable(Buffer.from('x'), 'a.pdf'), /xlsx.*csv/i);
  await assert.rejects(readTable(Buffer.from('chỉ một dòng\n'), 'a.csv'), /dòng tiêu đề/);
  await assert.rejects(readTable(Buffer.from('không phải zip'), 'a.xlsx'), /Excel/);
});
