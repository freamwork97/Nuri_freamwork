const test = require('node:test');
const assert = require('node:assert');
const { parseDecision, riskOf, describeAction } = require('../src/agent/decision');

test('parses JSON wrapped in fences and chatter', () => {
  const d = parseDecision('Sure!\n```json\n{"thought":"검색","notes":"1/3","action":{"type":"click","ref":"e12"}}\n``` extra {"x":1}');
  assert.strictEqual(d.action.type, 'click');
  assert.strictEqual(d.action.ref, 'e12');
  assert.strictEqual(d.notes, '1/3');
});

test('handles braces inside strings', () => {
  const d = parseDecision('{"thought":"a } b {","action":{"type":"type","ref":"e1","text":"{hi}"}}');
  assert.strictEqual(d.action.text, '{hi}');
});

test('rejects unknown actions and missing JSON', () => {
  assert.throws(() => parseDecision('no json here'));
  assert.throws(() => parseDecision('{"action":{"type":"rm -rf"}}'));
});

test('payment / publish clicks and delegation require confirmation', () => {
  const refs = new Map([
    ['e1', { role: 'button', name: '결제하기' }],
    ['e2', { role: 'button', name: '장바구니 담기' }],
    ['e3', { role: 'button', name: '발행' }],
  ]);
  assert.ok(riskOf({ type: 'click', ref: 'e1' }, refs));
  assert.strictEqual(riskOf({ type: 'click', ref: 'e2' }, refs), null);
  assert.ok(riskOf({ type: 'click', ref: 'e3' }, refs));
  assert.ok(riskOf({ type: 'delegate', task: 'send mail' }, refs));
  assert.strictEqual(riskOf({ type: 'scroll' }, refs), null);
});

test('describes actions with element names', () => {
  const refs = new Map([['e5', { role: 'textbox', name: '제목' }]]);
  assert.strictEqual(describeAction({ type: 'type', ref: 'e5', text: '안녕' }, refs), '입력: textbox "제목" ← "안녕"');
});

test('consent and sign-in buttons run without an approval card', () => {
  const refs = new Map(['모두 동의', '쿠키 수락', 'Accept all', 'Google로 계속하기', '다음'].map((name, i) => [`e${i}`, { role: 'button', name }]));
  for (const ref of refs.keys()) assert.strictEqual(riskOf({ type: 'click', ref }, refs), null);
});
