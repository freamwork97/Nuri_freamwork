const test = require('node:test');
const assert = require('node:assert');
const { compactSnapshot, shortenUrl } = require('../src/automation/snapshot');

const RAW = `- generic [ref=e1] [box=0,0,1100,2950]:
  - generic [box=0,0,1100,0]:
    - link "상단영역 바로가기" [ref=e2] [cursor=pointer] [box=0,-30,140,30]:
      - /url: "#topAsideButton"
  - banner [ref=e42] [box=30,40,1280,347]:
    - combobox "검색어를 입력해 주세요." [active] [ref=e64] [box=320,100,600,40]
    - iframe [ref=e48] [box=30,236,1000,130]:
      - link "광고" [ref=f7e22] [cursor=pointer] [box=267,20,580,120]:
        - /url: https://ad.example.com/click?id=1&q=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  - contentinfo [ref=e90] [box=0,5000,1100,200]:
    - link "회사소개" [ref=e91] [box=10,5010,80,20]`;

test('keeps near-viewport content and drops off-screen subtrees', () => {
  const r = compactSnapshot(RAW, { width: 1100, height: 900 });
  assert.ok(r.text.includes('combobox "검색어를 입력해 주세요." [active] [ref=e64]'));
  assert.ok(!r.text.includes('상단영역 바로가기'), 'zero-height / negative boxes are hidden');
  assert.ok(!r.text.includes('회사소개'), 'content far below the fold is dropped');
  assert.ok(!r.text.includes('[box='), 'boxes are stripped from LLM text');
  assert.ok(!r.text.includes('[cursor=pointer]'));
});

test('translates iframe-relative boxes to page coordinates', () => {
  const r = compactSnapshot(RAW, { width: 1100, height: 900 });
  const ad = r.refs.get('f7e22');
  assert.deepStrictEqual({ x: ad.box.x, y: ad.box.y }, { x: 297, y: 256 });
  assert.ok(r.visibleRefs.some((v) => v.ref === 'e64'));
});

test('re-indents after dropping unnamed generic containers', () => {
  const r = compactSnapshot(RAW, { width: 1100, height: 900 });
  assert.ok(r.text.split('\n')[0].startsWith('- banner'), r.text);
});

test('shortens long URLs and respects maxChars', () => {
  assert.ok(shortenUrl('https://a.com/' + 'x'.repeat(200) + '?q=1').length < 100);
  const big = Array.from({ length: 500 }, (_, i) => `- link "item ${i}" [ref=e${i}] [box=0,${i},10,10]`).join('\n');
  const r = compactSnapshot(big, { width: 1000, height: 900 }, { maxChars: 1000 });
  assert.ok(r.text.length <= 1000);
  assert.ok(r.truncated > 0);
});

test('a scrolled root container does not hide its on-screen content (나라장터)', () => {
  const raw = [
    '- generic [ref=e1] [box=0,-1381,878,724]:',
    '  - banner [ref=e4] [box=0,0,878,70]:',
    '    - link "나라장터" [ref=e8] [box=335,12,208,46]',
    '  - table "결과" [ref=e9] [box=-1307,263,2165,443]:',
    '    - rowgroup [ref=e10] [box=-1307,263,2165,400]:',
    '      - row [ref=e11] [box=-1307,300,2165,40]:',
    '        - cell "1" [ref=e12] [box=-1307,300,40,40]',
    '        - cell "홈페이지 유지관리 용역" [ref=e13] [box=-987,300,400,40]',
    '        - cell [ref=e14] [box=700,300,60,40]:',
    '          - link "투찰" [ref=e15] [box=700,300,60,40]',
  ].join('\n');
  const r = compactSnapshot(raw, { width: 888, height: 724 });
  assert.match(r.text, /link "나라장터"/);
  assert.match(r.text, /row \[ref=e11\]: 1 \| 홈페이지 유지관리 용역 \| link "투찰" \[ref=e15\]/);
});
