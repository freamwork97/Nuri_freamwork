// The macOS helper (native/mac/DesktopHelperMac.swift) cannot be built or run on this Windows PC;
// these checks keep it in step with what the app sends in background mode.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { helperPath, HELPER_EXE, MAC_HELPER } = require('../src/desktop/helper');
const { MAC_RULES } = require('../src/desktop/prompt');

const swift = fs.readFileSync(path.join(__dirname, '..', 'native', 'mac', 'DesktopHelperMac.swift'), 'utf8');
const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop', 'runner.js'), 'utf8');
// Commands only the Windows helper has: the foreground ("화면 직접 제어") mode, never used on a Mac.
const FOREGROUND_ONLY = new Set(['observe', 'mouse', 'key', 'type', 'scroll', 'drag', 'focus', 'setvalue', 'at']);

test('the Mac helper handles every command the app sends in background mode', () => {
  const macCmds = new Set([...swift.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]));
  const used = new Set([...runner.matchAll(/(?:helper|local)\.call\('([a-z]+)'/g)].map((m) => m[1]));
  const missing = [...used].filter((c) => !FOREGROUND_ONLY.has(c) && !macCmds.has(c));
  assert.deepStrictEqual(missing, []);
});

test('helper binary per platform', () => {
  assert.strictEqual(helperPath('win32'), HELPER_EXE);
  assert.strictEqual(helperPath('darwin'), MAC_HELPER);
  assert.strictEqual(helperPath('linux'), null);
});

test('the Mac helper speaks the same protocol (ready line, ids, ok/error)', () => {
  assert.match(swift, /reply\(\["ready": true/);
  assert.match(swift, /res\["id"\] = id/);
  assert.match(swift, /res\["ok"\] = true/);
  assert.match(swift, /\["ok": false, "error":/);
  // wobserve returns what the runner reads
  for (const key of ['image', 'width', 'height', 'scale', 'screen', 'foreground', 'userForeground', 'elements']) assert.match(swift, new RegExp(`res\\["${key}"\\]`));
});

test('Mac prompt rules use cmd shortcuts', () => {
  assert.match(MAC_RULES, /cmd\+s/);
});
