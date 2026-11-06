const test = require('node:test');
const assert = require('node:assert');
const { heavyTabs } = require('../src/tab-memory');

const tab = (id, pid, extra) => ({ id, ...extra, view: { webContents: { getOSProcessId: () => pid } } });
const usage = (pid, mb, key = 'privateBytes') => ({ pid, memory: { [key]: mb * 1024 } });

test('heavyTabs: only pages over the limit, never the live picture', () => {
  const tabs = [tab(1, 10), tab(2, 20), tab(3, 30, { mirror: {} }), tab(4, 40)];
  const metrics = [usage(10, 1500), usage(20, 300), usage(30, 2000)];
  assert.deepStrictEqual(heavyTabs(tabs, metrics, 1024).map((t) => t.id), [1]);
});

test('heavyTabs: falls back to the working set where private bytes are not reported', () => {
  assert.strictEqual(heavyTabs([tab(1, 10)], [usage(10, 1500, 'workingSetSize')], 1024).length, 1);
});
