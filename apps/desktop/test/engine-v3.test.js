const test = require('node:test');
const assert = require('node:assert');
const { parseDecision, riskOf } = require('../src/agent/decision');
const { compactSnapshot } = require('../src/automation/snapshot');
const { siteHints } = require('../src/agent/site-hints');
const { listFiles } = require('../src/automation/actions');

test('parses an action chain and cuts it at a terminal action', () => {
  const d = parseDecision('{"thought":"t","actions":[{"type":"type","ref":"e1","text":"a"},{"type":"click","ref":"e2"},{"type":"navigate","url":"x"},{"type":"click","ref":"e3"}]}');
  assert.deepStrictEqual(d.actions.map((a) => a.type), ['type', 'click', 'navigate']);
  assert.strictEqual(d.action.type, 'type');
  const single = parseDecision('{"action":{"type":"upload","files":["C:\\\\a.mp4"]}}');
  assert.strictEqual(single.actions.length, 1);
});

test('publish, upload and payment clicks always get an approval card', () => {
  const refs = new Map([['e1', { role: 'button', name: '발행' }], ['e2', { role: 'button', name: '결제하기' }], ['e3', { role: 'button', name: 'Upload' }], ['e4', { role: 'button', name: '저장' }]]);
  assert.match(riskOf({ type: 'click', ref: 'e1' }, refs), /발행/);
  assert.match(riskOf({ type: 'click', ref: 'e2' }, refs), /결제/);
  assert.match(riskOf({ type: 'click', ref: 'e3' }, refs), /Upload/);
  assert.strictEqual(riskOf({ type: 'click', ref: 'e4' }, refs), null);
});

test('snapshot keeps off-screen controls by name and ref', () => {
  const raw = [
    '- banner [box=0,0,1000,60]:',
    '  - button "발행" [ref=e1] [box=900,-500,60,30]',
    '- main [box=0,60,1000,700]:',
    '  - textbox "제목" [ref=e2] [box=10,100,500,40]',
    '- contentinfo [box=0,5000,1000,100]:',
    '  - link "고객센터" [ref=e3] [box=10,5010,80,20]',
  ].join('\n');
  const s = compactSnapshot(raw, { width: 1000, height: 800 });
  assert.match(s.text, /제목/);
  assert.doesNotMatch(s.text, /발행/);
  const byName = Object.fromEntries(s.offscreen.map((o) => [o.name, o]));
  assert.strictEqual(byName['발행'].where, 'above');
  assert.strictEqual(byName['발행'].ref, 'e1');
  assert.strictEqual(byName['고객센터'].where, 'below');
  assert.ok(s.refs.has('e1'), 'off-screen refs stay clickable');
});

test('site hints match by URL or goal', () => {
  assert.match(siteHints('https://blog.naver.com/x/postwrite', '')[0], /발행/);
  assert.match(siteHints('about:blank', '유튜브 쇼츠 업로드해줘')[0], /YOUTUBE/);
  assert.strictEqual(siteHints('https://example.com', '날씨 알려줘').length, 0);
});

test('list_files reports unreadable folders instead of throwing', () => {
  assert.match(listFiles('/definitely/not/here'), /cannot read/);
});

test('off-screen list keeps controls and footer links on very long pages', () => {
  const lines = ['- main [box=0,0,1000,800]:'];
  for (let i = 0; i < 300; i++) lines.push(`  - link "본문링크${i}" [ref=e${i}] [box=10,${2000 + i * 20},80,20]`);
  lines.push('  - button "더보기" [ref=b1] [box=10,9000,80,20]');
  lines.push('  - link "개인정보처리방침" [ref=f1] [box=10,9500,80,20]');
  const s = compactSnapshot(lines.join('\n'), { width: 1000, height: 800 });
  const names = s.offscreen.map((o) => o.name);
  assert.ok(s.offscreen.length <= 80);
  assert.ok(names.includes('더보기'));
  assert.ok(names.includes('개인정보처리방침'));
});

test('new_tab opens http(s) pages only and ends the chain', async () => {
  const { execute } = require('../src/automation/actions');
  const opened = [];
  const tabs = { create: async (url) => opened.push(url) };
  const d = parseDecision('{"thought":"t","actions":[{"type":"new_tab","url":"example.com"},{"type":"click","ref":"e1"}]}');
  assert.deepStrictEqual(d.actions.map((a) => a.type), ['new_tab']);
  assert.match(await execute({ tabs }, { type: 'new_tab', url: 'example.com' }), /opened a new tab/);
  assert.match(await execute({ tabs }, { type: 'new_tab' }), /opened a new tab/);
  assert.match(await execute({ tabs }, { type: 'new_tab', url: 'file:///C:/secret.txt' }), /FAILED/);
  assert.deepStrictEqual(opened, ['https://example.com', undefined]);
});
