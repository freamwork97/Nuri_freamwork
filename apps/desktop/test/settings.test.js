const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, validate, defaults, riskKind } = require('../src/settings');
const { normalizeInput } = require('../src/tabs');

test('settings: validation rejects bad values', () => {
  assert.strictEqual(validate('general.defaultProvider', 'claude'), 'claude');
  assert.strictEqual(validate('general.defaultProvider', 'evil'), undefined);
  assert.strictEqual(validate('automation.browserMaxSteps', '60'), 60, 'enum numbers come back as numbers');
  assert.strictEqual(validate('automation.browserMaxSteps', 9999), undefined);
  assert.strictEqual(validate('general.homeUrl', 'https://www.daum.net'), 'https://www.daum.net');
  assert.strictEqual(validate('general.homeUrl', 'javascript:alert(1)'), undefined);
  assert.strictEqual(validate('general.homeUrl', 'http://insecure.example'), undefined);
  assert.strictEqual(validate('automation.downloadDir', 'D:\\자료\\다운로드'), 'D:\\자료\\다운로드');
  assert.strictEqual(validate('automation.downloadDir', ''), '');
  assert.strictEqual(validate('automation.downloadDir', '../etc'), undefined);
  assert.strictEqual(validate('notifications.sound', 'yes'), undefined);
  assert.strictEqual(validate('unknown.key', 1), undefined);
});

test('settings: load, update, persist, reset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-set-'));
  const file = path.join(dir, 'anb-settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ 'general.defaultMode': 'autopilot', 'safety.payments': 'nope', junk: 1 }));
    const s = new Settings(file);
    assert.strictEqual(s.get('general.defaultMode'), 'autopilot');
    assert.strictEqual(s.get('safety.payments'), 'ask', 'invalid saved value falls back to the default');
    let changed = null;
    s.on('change', (c) => (changed = c));
    const r = s.update({ 'safety.payments': 'block', 'general.searchEngine': 'naver', 'general.historyLimit': 'x' });
    assert.deepStrictEqual(r.rejected, ['general.historyLimit']);
    assert.deepStrictEqual(changed, { 'safety.payments': 'block', 'general.searchEngine': 'naver' });
    assert.strictEqual(new Settings(file).get('safety.payments'), 'block', 'persisted');
    assert.strictEqual(s.searchUrl('광명 날씨'), 'https://search.naver.com/search.naver?query=%EA%B4%91%EB%AA%85%20%EB%82%A0%EC%94%A8');
    assert.strictEqual(normalizeInput('광명 날씨', s), s.searchUrl('광명 날씨'));
    assert.strictEqual(normalizeInput('', s), 'https://www.google.com');
    s.update({ 'general.homeUrl': 'https://www.daum.net' });
    assert.strictEqual(normalizeInput('', s), 'https://www.daum.net');
    s.reset();
    assert.deepStrictEqual(s.all(), defaults());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: risk kinds for block policies', () => {
  assert.strictEqual(riskKind('"결제하기" button을(를) 누르려고 합니다. 진행할까요?'), 'payments');
  assert.strictEqual(riskKind('"바로 구매" link을(를) 누르려고 합니다.'), 'payments');
  assert.strictEqual(riskKind('"발행" button을(를) 누르려고 합니다.'), 'publish');
  assert.strictEqual(riskKind('KakaoTalk에서 메시지를 전송(enter)하려고 합니다.'), 'publish');
  assert.strictEqual(riskKind('플랫폼 스킬·플러그인으로 다음 작업을 실행할까요?\n\n메일 보내기'), 'skills');
  assert.strictEqual(riskKind('파일을 영구 삭제(Shift+Delete)하려고 합니다.'), 'delete');
  assert.strictEqual(riskKind('"회원 탈퇴" button을(를) 누르려고 합니다.'), 'delete');
  assert.strictEqual(riskKind('터미널(powershell)에서 다음 명령을 실행하려고 합니다. 진행할까요?\n\nnpm i'), 'terminal');
  assert.strictEqual(riskKind('다음 프로그램/파일을 실행하려고 합니다. 진행할까요?\n\nfoo.exe'), 'launch');
  assert.strictEqual(riskKind('notepad에 다음을 입력하려고 합니다. 진행할까요?\n\n전송'), 'typing');
  assert.strictEqual(riskKind('무언가 확인이 필요합니다'), 'other');
});

test('agent.confirm: auto approves without asking, typing approval always asks', async () => {
  const { Agent } = require('../src/agent/agent');
  const settings = { get: (k) => ({ 'safety.publish': 'auto', 'safety.other': 'auto' })[k] };
  const agent = new Agent({ server: {}, tabs: {}, bridge: {}, settings });
  const events = [];
  agent.on('event', (e) => events.push(e.kind));
  assert.strictEqual(await agent.confirm('"발행" button을(를) 누르려고 합니다. 진행할까요?'), true);
  assert.deepStrictEqual(events, ['note']);
  const pending = agent.confirm('notepad에 다음을 입력하려고 합니다. 진행할까요?\n\nhi');
  assert.deepStrictEqual(events, ['note', 'confirm'], 'typing still asks');
  agent.answer(false);
  assert.strictEqual(await pending, false);
  const pay = agent.confirm('"결제하기" button을(를) 누르려고 합니다.');
  assert.deepStrictEqual(events, ['note', 'confirm', 'confirm'], 'unset kinds ask');
  agent.answer(true);
  assert.strictEqual(await pay, true);
});

test('agent.confirm: blocked kinds are declined without asking', async () => {
  const { Agent } = require('../src/agent/agent');
  const settings = { get: (k) => ({ 'safety.payments': 'block', 'safety.publish': 'ask' })[k] };
  const agent = new Agent({ server: {}, tabs: {}, bridge: {}, settings });
  const events = [];
  agent.on('event', (e) => events.push(e.kind));
  assert.strictEqual(await agent.confirm('"결제하기" button을(를) 누르려고 합니다. 진행할까요?'), false);
  assert.deepStrictEqual(events, ['note']);
  const pending = agent.confirm('"발행" button을(를) 누르려고 합니다. 진행할까요?');
  assert.deepStrictEqual(events, ['note', 'confirm'], 'publish still asks');
  agent.answer(true);
  assert.strictEqual(await pending, true);
  assert.strictEqual(await agent.confirm('"발행" button을(를) 누르려고 합니다. 진행할까요?'), true, 'same approval is not asked twice');
  assert.deepStrictEqual(events, ['note', 'confirm', 'note']);
});

test('settings: defaults ask only for payments; old files get the new publish default', () => {
  const d = defaults();
  assert.strictEqual(d['safety.payments'], 'ask');
  for (const k of ['publish', 'terminal', 'delete', 'launch', 'skills', 'other']) assert.strictEqual(d[`safety.${k}`], 'auto', k);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-set-'));
  try {
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({ 'safety.payments': 'ask', 'safety.publish': 'ask' }));
    assert.strictEqual(new Settings(file).get('safety.publish'), 'auto');
    fs.writeFileSync(file, JSON.stringify({ 'safety.publish': 'block' }));
    assert.strictEqual(new Settings(file).get('safety.publish'), 'block', 'explicit block kept');
    fs.writeFileSync(file, JSON.stringify({ 'safety.publish': 'ask', 'safety.other': 'auto' }));
    assert.strictEqual(new Settings(file).get('safety.publish'), 'ask', 'new-format choice kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autopilot: "자동 재시도 후 건너뛰기" retries once, then skips without asking', async () => {
  const { Autopilot } = require('../src/workflow/autopilot');
  const events = [];
  const agent = {
    settings: { get: (k) => (k === 'automation.autopilotOnFail' ? 'retry-skip' : undefined) },
    stopped: false,
    downloads: null,
    workdir: '',
    begin: () => true,
    finish: () => {},
    log: () => {},
    emitEvent: (kind, data) => events.push({ kind, ...data }),
    askUser: async () => {
      throw new Error('must not ask');
    },
  };
  const ap = new Autopilot(agent);
  ap.plan = async () => ({ title: '테스트', steps: [{ id: 1, tool: 'analyze', title: '항상 실패', instruction: 'x', inputs: [], output: '01.md' }, { id: 2, tool: 'analyze', title: '성공', instruction: 'y', inputs: [], output: '02.md' }] });
  let calls = 0;
  ap.runStep = async (_p, _plan, step) => {
    calls++;
    if (step.id === 1) throw new Error('일부러 실패');
    return '완료';
  };
  await ap.run('테스트 목표', 'gemini');
  assert.strictEqual(calls, 3, 'step 1 twice (one retry), step 2 once');
  assert.ok(events.some((e) => e.kind === 'note' && /자동으로 다시 시도/.test(e.text)));
  const steps = events.filter((e) => e.kind === 'plan_step' && e.status !== 'running').map((e) => e.status);
  assert.deepStrictEqual(steps, ['skipped', 'done']);
  assert.ok(events.some((e) => e.kind === 'done'));
  const dir = events.find((e) => e.kind === 'plan')?.dir;
  if (dir && /테스트_목표/.test(dir)) fs.rmSync(dir, { recursive: true, force: true }); // project folder made by this test
});

test('desktop session: minimizing follows the mode and the setting', () => {
  const Module = require('node:module');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { BrowserWindow: function () {}, globalShortcut: { register: () => true, unregister: () => {} }, screen: {}, ipcMain: { on: () => {} } };
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/desktop/session')];
    const { DesktopSession } = require('../src/desktop/session');
    let minimized = 0;
    const win = { minimize: () => minimized++, restore() {}, show() {}, focus() {}, flashFrame() {} };
    const make = (v) => new DesktopSession({ getMainWindow: () => win, onStop() {}, settings: { get: () => v } });
    const s1 = make(true);
    s1.showOverlay = () => {};
    s1.begin({ background: false });
    assert.strictEqual(minimized, 1, 'foreground + setting on: minimized');
    const s2 = make(false);
    s2.showOverlay = () => {};
    s2.begin({ background: false });
    assert.strictEqual(minimized, 1, 'setting off: stays');
    const s3 = make(true);
    s3.showOverlay = () => {};
    s3.begin({ background: true });
    assert.strictEqual(minimized, 1, 'background mode never minimizes');
  } finally {
    Module._load = orig;
  }
});

test('a saved old default start page moves to Google, a chosen one stays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-set-'));
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify({ 'general.homeUrl': 'https://www.naver.com' }));
  assert.strictEqual(new Settings(file).get('general.homeUrl'), 'https://www.google.com');
  fs.writeFileSync(file, JSON.stringify({ 'general.homeUrl': 'https://www.daum.net' }));
  assert.strictEqual(new Settings(file).get('general.homeUrl'), 'https://www.daum.net');
});
