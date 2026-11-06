const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDecision } = require('../src/agent/decision');
const { DESKTOP_ACTIONS, resolveTarget, toScreen, desktopRiskOf, describeDesktopAction } = require('../src/desktop/decision');
const { buildDesktopStepPrompt } = require('../src/desktop/prompt');

// A 1920x1080 monitor at (0,0), screenshot scaled to 1366 px wide.
const obs = {
  screen: { x: 0, y: 0, width: 1920, height: 1080 },
  scale: 1366 / 1920,
  width: 1366,
  height: 768,
  screens: 1,
  foreground: { hwnd: 10, process: 'notepad', title: '제목 없음 - 메모장', rect: [0, 0, 1920, 1040] },
  elements: [
    { id: 'd1', role: 'button', name: '닫기', x: 1860, y: 0, w: 60, h: 40, area: 'window' },
    { id: 'd2', role: 'document', name: '텍스트 편집기', x: 0, y: 100, w: 1920, h: 900, area: 'window' },
    { id: 'd3', role: 'button', name: '시작', x: 900, y: 1040, w: 40, h: 40, area: 'taskbar' },
    { id: 'd4', role: 'button', name: '보내기', x: 100, y: 500, w: 80, h: 30, area: 'window' },
  ],
};

test('desktop actions parse with the desktop action set only', () => {
  const d = parseDecision('{"thought":"t","action":{"type":"key","keys":"ctrl+s"}}', DESKTOP_ACTIONS);
  assert.equal(d.action.keys, 'ctrl+s');
  assert.throws(() => parseDecision('{"action":{"type":"navigate","url":"x"}}', DESKTOP_ACTIONS), /알 수 없는 action/);
});

test('element ids resolve to the element center in physical pixels', () => {
  const t = resolveTarget({ type: 'click', id: 'd1' }, obs);
  assert.deepEqual([t.x, t.y], [1890, 20]);
  assert.equal(t.element.name, '닫기');
  assert.throws(() => resolveTarget({ id: 'd99' }, obs), /unknown element id/);
});

test('screenshot coordinates scale back to the screen (and multi-monitor offsets)', () => {
  const t = resolveTarget({ x: 683, y: 384 }, obs);
  assert.deepEqual([t.x, t.y], [960, 540]);
  assert.deepEqual(toScreen({ ...obs, screen: { x: -1920, y: 0 } }, 0, 0), { x: -1920, y: 0 });
  assert.throws(() => resolveTarget({ x: 5000, y: 10 }, obs), /outside/);
  assert.equal(resolveTarget({ type: 'key' }, obs), null);
});

test('risky desktop actions need approval', () => {
  const fg = obs.foreground;
  assert.match(desktopRiskOf({ type: 'click', id: 'd4' }, { target: resolveTarget({ id: 'd4' }, obs), fg }), /보내기/);
  assert.equal(desktopRiskOf({ type: 'click', id: 'd1' }, { target: resolveTarget({ id: 'd1' }, obs), fg }), null);
  assert.equal(desktopRiskOf({ type: 'launch', target: 'notepad' }, { fg }), null);
  assert.equal(desktopRiskOf({ type: 'launch', target: 'https://www.naver.com' }, { fg }), null);
  assert.match(desktopRiskOf({ type: 'launch', target: 'C:\\temp\\setup.exe' }, { fg }), /setup\.exe/);
  assert.match(desktopRiskOf({ type: 'launch', target: 'cmd /c del *' }, { fg }), /실행하려고/);
  assert.match(desktopRiskOf({ type: 'key', keys: 'shift + delete' }, { fg }), /영구 삭제/);
  assert.match(desktopRiskOf({ type: 'key', keys: 'delete' }, { fg: { process: 'explorer' } }), /삭제/);
  assert.equal(desktopRiskOf({ type: 'key', keys: 'delete' }, { fg }), null);
  // Typing is automatic (설정 > 글자 입력 = 자동); running a command (Enter) still asks.
  const term = { process: 'WindowsTerminal', class: 'CASCADIA_HOSTING_WINDOW_CLASS' };
  assert.equal(desktopRiskOf({ type: 'type', text: 'dir' }, { fg: term }), null);
  assert.match(desktopRiskOf({ type: 'type', text: 'dir\n' }, { fg: term }), /명령을 실행/);
  assert.match(desktopRiskOf({ type: 'key', keys: 'enter' }, { fg: term }), /명령을 실행/);
  assert.match(desktopRiskOf({ type: 'type', text: 'dir' }, { fg: term, typing: 'ask' }), /입력하려고/);
  // A normal window that a PowerShell script created is not a terminal.
  const psForm = { process: 'powershell', class: 'WindowsForms10.Window.8.app.0.141b42a_r6_ad1' };
  assert.equal(desktopRiskOf({ type: 'type', text: '김철수\n' }, { fg: psForm }), null);
  assert.equal(desktopRiskOf({ type: 'key', keys: 'enter' }, { fg: psForm }), null);
  assert.match(desktopRiskOf({ type: 'key', keys: 'enter' }, { fg: { process: 'cmd' } }), /명령을 실행/, 'no class info: fall back to the process name');
  assert.match(desktopRiskOf({ type: 'key', keys: 'enter' }, { fg: { process: 'KakaoTalk' } }), /전송/);
  assert.match(desktopRiskOf({ type: 'type', text: '안녕\n' }, { fg: { process: 'KakaoTalk' } }), /전송/);
  assert.equal(desktopRiskOf({ type: 'type', text: '안녕' }, { fg: { process: 'KakaoTalk' } }), null);
  assert.match(desktopRiskOf({ type: 'delegate', task: 'x' }, {}), /스킬/);
});

test('step prompt lists elements in screenshot coordinates and separates the taskbar', () => {
  const p = buildDesktopStepPrompt({ goal: 'g', notes: '', history: [], obs, windows: [{ hwnd: 10, process: 'notepad', title: '메모장' }], step: 1 });
  assert.match(p, /\[d1\] button "닫기" @1345,14/);
  assert.match(p, /1\. notepad: 메모장 \(foreground\)/);
  assert.match(p, /TASKBAR:\n\[d3\] button "시작"/);
  assert.ok(!/ELEMENTS[^]*\[d3\][^]*TASKBAR/.test(p), 'taskbar items are not listed as window elements');
});

test('labels describe what the action does', () => {
  assert.equal(describeDesktopAction({ type: 'click', id: 'd1' }, resolveTarget({ id: 'd1' }, obs)), '클릭: button "닫기"');
  assert.equal(describeDesktopAction({ type: 'type', text: 'a\nb' }, null), '입력 ← "a⏎b"');
  assert.equal(describeDesktopAction({ type: 'key', keys: 'down', repeat: 3 }), '키 입력: down ×3');
});

test('desktop: read_text / pick_file actions and file paths', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { parseDecision } = require('../src/agent/decision');
  const { DESKTOP_ACTIONS, describeDesktopAction, desktopRiskOf } = require('../src/desktop/decision');
  const { pickPath } = require('../src/desktop/runner');
  const d = parseDecision('{"thought":"t","actions":[{"type":"read_text"},{"type":"pick_file","path":"a.pdf"}]}', DESKTOP_ACTIONS);
  assert.deepStrictEqual(d.actions.map((a) => a.type), ['read_text', 'pick_file']);
  assert.strictEqual(describeDesktopAction({ type: 'read_text', window: 2 }), '화면 글자 읽기: 창 2');
  assert.strictEqual(describeDesktopAction({ type: 'pick_file', path: 'C:\\x\\제안서.pdf' }), '파일 선택 창에 지정: 제안서.pdf');
  assert.strictEqual(desktopRiskOf({ type: 'read_text' }, {}), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-pick-'));
  try {
    fs.writeFileSync(path.join(dir, '제안서 [최종].pdf'), 'x');
    assert.strictEqual(pickPath('제안서 [최종].pdf', dir), path.join(dir, '제안서 [최종].pdf'));
    assert.strictEqual(pickPath(path.join(dir, '제안서 [최종].pdf'), '/elsewhere'), path.join(dir, '제안서 [최종].pdf'));
    assert.throws(() => pickPath('없음.pdf', dir), /not found/);
    assert.throws(() => pickPath('../x.pdf', dir), /inside/);
    assert.throws(() => pickPath('', dir), /needs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
