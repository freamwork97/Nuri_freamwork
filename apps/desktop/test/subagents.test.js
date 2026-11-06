const test = require('node:test');
const assert = require('node:assert');
const { normalizeTasks, formatResults, subGoal, SUB_FORBIDDEN } = require('../src/agent/subagents');
const { parseDecision, describeAction } = require('../src/agent/decision');
const { buildStepPrompt } = require('../src/agent/prompt');

test('parallel tasks are validated against the setting', () => {
  const two = { tasks: [{ title: '쿠팡', goal: 'a', url: 'www.coupang.com' }, 'b'] };
  assert.match(normalizeTasks(two, 0).error, /turned off/);
  const ok = normalizeTasks(two, 3).tasks;
  assert.deepStrictEqual(ok[0], { title: '쿠팡', goal: 'a', url: 'https://www.coupang.com' });
  assert.deepStrictEqual(ok[1], { title: '작업 2', goal: 'b', url: '' });
  assert.match(normalizeTasks({ tasks: ['only one'] }, 3).error, /at least 2/);
  assert.match(normalizeTasks({ tasks: ['a', 'b', 'c', 'd'] }, 3).error, /at most 3/);
  assert.strictEqual(normalizeTasks({ tasks: [{ goal: 'a', url: 'file:///C:/x' }, 'b'] }, 3).tasks[0].url, '', 'only web pages');
});

test('reports come back as tool output', () => {
  const r = formatResults([
    { title: 'A', tabId: 4, ok: true, answer: '최저가 10,000원' },
    { title: 'B', ok: false, error: '중지됨' },
  ]);
  assert.match(r.summary, /1\/2/);
  assert.match(r.output, /하위 에이전트 1: A \(tab 4\)\n최저가 10,000원/);
  assert.match(r.output, /FAILED: 중지됨/);
});

test('sub-agents work alone and never act for the user', () => {
  const g = subGoal({ goal: '가격 조사' });
  assert.match(g, /^가격 조사/);
  assert.match(g, /never pay/);
  for (const t of ['new_tab', 'ask_user', 'parallel', 'delegate']) assert.ok(SUB_FORBIDDEN.has(t), t);
  assert.ok(!SUB_FORBIDDEN.has('save_file'));
});

test('the model can ask for sub-agents; the prompt says when they are available', () => {
  const d = parseDecision('{"thought":"t","action":{"type":"parallel","tasks":[{"title":"a","goal":"x"},{"title":"b","goal":"y"}]}}');
  assert.strictEqual(d.action.type, 'parallel');
  assert.match(describeAction(d.action), /하위 에이전트 2개/);
  const obs = { url: 'about:blank', title: '', width: 1, height: 1, scrollY: 0, scrollMax: 0, snapshot: '' };
  const base = { goal: 'g', notes: '', history: [], tabs: [], obs, step: 1, hasImage: false };
  assert.match(buildStepPrompt({ ...base, subagents: 3 }), /SUB-AGENTS: available, up to 3/);
  assert.match(buildStepPrompt(base), /SUB-AGENTS: not available/);
});
