const test = require('node:test');
const assert = require('node:assert');
const { toCsv, asText } = require('../src/automation/script-runner');
const { csvRows } = require('../src/documents/xlsx');
const { parseDecision, riskOf, describeAction } = require('../src/agent/decision');

test('script rows become CSV that the Excel writer reads back', () => {
  const csv = asText([{ 이름: '사과, 국산', 가격: 1200 }, { 이름: '배 "특"', 비고: '산지 직송' }]);
  assert.strictEqual(csv.split('\n')[0], '이름,가격,비고');
  assert.deepStrictEqual(csvRows(csv), [
    ['이름', '가격', '비고'],
    ['사과, 국산', '1200', ''],
    ['배 "특"', '', '산지 직송'],
  ]);
  assert.strictEqual(toCsv([['a', 'b'], [1, null]]), 'a,b\n1,');
  assert.strictEqual(asText('본문'), '본문');
  assert.strictEqual(asText({ n: 1 }), '{\n  "n": 1\n}');
});

test('a script ends the chain and asks first when its code can pay, publish or delete', () => {
  const d = parseDecision('{"actions":[{"type":"script","code":"log(1)"},{"type":"click","ref":"e1"}]}');
  assert.deepStrictEqual(d.actions.map((a) => a.type), ['script']);
  assert.strictEqual(riskOf({ type: 'script', code: "const rows = await page.$$eval('.item', (e) => e.length); log(rows);" }), null);
  assert.match(riskOf({ type: 'script', code: "await page.locator('text=발행').click();" }), /"발행" 동작/);
  assert.match(riskOf({ type: 'script', code: "await page.click('#checkout')" }), /checkout/);
  assert.strictEqual(describeAction({ type: 'script', title: '공고 수집' }), '스크립트 실행: 공고 수집');
});
