const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromiumLayout, bundledBrowser, appDataBase, macPath } = require('../src/platform');
const { desktopRiskOf } = require('../src/desktop/decision');

test('Chromium paths match Chrome for Testing archives on both Mac architectures', () => {
  for (const [arch, target] of [['arm64', 'mac-arm64'], ['x64', 'mac-x64']]) {
    assert.equal(chromiumLayout('darwin', arch).target, target);
    assert.equal(bundledBrowser('/resources', 'darwin', arch), path.join('/resources/vendor', `chrome-${target}`, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
  }
  assert.equal(chromiumLayout('win32', 'x64').executable, 'chrome.exe');
  assert.throws(() => chromiumLayout('linux', 'x64'), /not supported/);
});

test('macOS data ignores APPDATA and uses Application Support', () => {
  assert.equal(appDataBase('darwin', { APPDATA: '/windows' }, '/Users/test'), '/Users/test/Library/Application Support');
  assert.equal(appDataBase('win32', { APPDATA: '/windows' }, '/Users/test'), '/windows');
});

test('Finder PATH gains Homebrew and local CLI locations without duplicates', () => {
  const dirs = macPath('/usr/bin:/opt/homebrew/bin:/custom', '/Users/test').split(':');
  assert.ok(dirs.includes('/Users/test/.local/bin'));
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.ok(dirs.includes('/custom'));
  assert.equal(dirs.filter(p => p === '/opt/homebrew/bin').length, 1);
});

test('macOS terminal command submission still requires approval', () => {
  for (const process of ['Terminal', 'iTerm2', 'Warp']) {
    assert.ok(desktopRiskOf({ type: 'type', text: 'echo hello\n' }, { fg: { process, class: '' } }));
  }
});
