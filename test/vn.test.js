// Kiểm thử các hàm thuần (không cần database): bỏ dấu, đọc số thành chữ, đọc số/ngày, nhận diện "Điều N", từ khóa, RRF.
const test = require('node:test');
const assert = require('node:assert/strict');
const vn = require('../lib/vn');
const { buildTsQueries, rrf, pickDocs, articlePattern } = require('../lib/search');

test('foldVN: bỏ dấu, kể cả chữ đ/Đ và chữ dạng tổ hợp (NFD)', () => {
  assert.equal(vn.fold('Điều 12. NGƯỜI ĐẠI DIỆN theo pháp luật'), 'dieu 12. nguoi dai dien theo phap luat');
  assert.equal(vn.fold('ệ'.normalize('NFD')), 'e');
  assert.equal(vn.FROM.length, vn.TO.length);
});

test('numberToWords: các trường hợp khó của tiếng Việt', () => {
  const w = vn.numberToWords;
  assert.equal(w(279e9), 'hai trăm bảy mươi chín tỷ');
  assert.equal(w(122e9), 'một trăm hai mươi hai tỷ');
  assert.equal(w(0), 'không');
  assert.equal(w(15), 'mười lăm');
  assert.equal(w(21), 'hai mươi mốt');
  assert.equal(w(25), 'hai mươi lăm');
  assert.equal(w(105), 'một trăm lẻ năm');
  assert.equal(w(1000005), 'một triệu không trăm lẻ năm');
  assert.equal(w(2500000), 'hai triệu năm trăm nghìn');
  assert.equal(w(1e12), 'một nghìn tỷ');
  assert.equal(w(1234567891), 'một tỷ hai trăm ba mươi bốn triệu năm trăm sáu mươi bảy nghìn tám trăm chín mươi mốt');
  assert.equal(w(10e9 + 1000), 'mười tỷ không trăm lẻ một nghìn');
  assert.equal(w(100000), 'một trăm nghìn');
});

test('parseNumber / formatNumber / parseDate', () => {
  for (const [raw, want] of [['279.000.000.000 đồng', 279e9], ['279,000,000,000', 279e9], ['1,5 tỷ', 1.5e9], ['33,33', 33.33], ['12000', 12000], ['1.000', 1000], ['7,5 triệu', 7.5e6], ['1.234,56', 1234.56], ['33%', 33]])
    assert.equal(vn.parseNumber(raw), want, raw);
  assert.ok(Number.isNaN(vn.parseNumber('abc'))); assert.ok(Number.isNaN(vn.parseNumber('')));
  assert.equal(vn.formatNumber(279e9), '279.000.000.000'); assert.equal(vn.formatNumber(33.5), '33,5'); assert.equal(vn.formatNumber(100), '100');
  assert.deepEqual(vn.parseDate('28/08/2026'), { y: 2026, m: 8, d: 28 });
  assert.deepEqual(vn.parseDate('2026-08-28'), { y: 2026, m: 8, d: 28 });
  assert.deepEqual(vn.parseDate(new Date(Date.UTC(2026, 7, 28))), { y: 2026, m: 8, d: 28 });
  assert.equal(vn.parseDate('31/02/2026'), null); assert.equal(vn.parseDate('hôm nay'), null);
});

test('parseArticleRefs: nhận "Điều N", danh sách, điều có chữ cái; bỏ qua "điều kiện"', () => {
  const r = vn.parseArticleRefs;
  assert.deepEqual(r('Điều 12 Luật Doanh nghiệp quy định gì?'), ['12']);
  assert.deepEqual(r('nội dung điều 5 và 6, điều 78a'), ['5', '6', '78a']);
  assert.deepEqual(r('Điều 5, 6, 7 và 8'), ['5', '6', '7', '8']);
  assert.deepEqual(r('điều kiện kinh doanh, điều lệ công ty'), []);
  const re = new RegExp(articlePattern(['2']));
  assert.ok(re.test('chuong i - quy dinh chung › dieu 2. giai thich tu ngu'));
  assert.ok(!re.test('chuong ii › dieu 20. ten') && !re.test('dieu 2a. ten') && !re.test('dieu 12. ten'));
});

test('buildTsQueries: từ khóa nối OR, bỏ từ dừng, thêm cụm 2 từ liền nhau', () => {
  const q = buildTsQueries('Vốn điều lệ của công ty cổ phần được tăng như thế nào?');
  assert.match(q.any, /von \| le \| cong \| ty/); assert.ok(!/\bcua\b/.test(q.any));
  assert.match(q.phrase, /\(von <-> dieu\)/);
  assert.equal(buildTsQueries('của và là'), null);
});

test('rrf: đoạn đứng cao ở cả hai danh sách lên đầu', () => {
  const a = [{ id: 1 }, { id: 2 }, { id: 3 }], b = [{ id: 3 }, { id: 2 }, { id: 9 }];
  assert.deepEqual(rrf([a, b]).map(r => r.id), [3, 2, 1, 9]);   // 3 và 2 có mặt ở cả hai danh sách; 3 hơn nhờ đứng đầu một danh sách
});

test('pickDocs: nêu tên luật / số hiệu thì chỉ giữ điều của văn bản đó', () => {
  const rows = [
    { id: 1, doc_id: 'a', title: 'Luật Doanh nghiệp 2020', doc_number: '59/2020/QH14' },
    { id: 2, doc_id: 'b', title: 'Luật Phòng cháy, chữa cháy', doc_number: '55/2024/QH15' }];
  assert.deepEqual(pickDocs(rows, 'Điều 12 Luật Doanh nghiệp').map(r => r.id), [1]);
  assert.deepEqual(pickDocs(rows, 'Điều 12 của 55/2024/QH15').map(r => r.id), [2]);
  assert.deepEqual(pickDocs(rows, 'Điều 12 quy định gì').map(r => r.id), [1, 2]);
});
