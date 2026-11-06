const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolveUserData, dataDirName } = require('../src/config');

function fakeFs(dirs, { renameFails = false } = {}) {
  const set = new Set(dirs);
  return {
    set,
    existsSync: (p) => set.has(p),
    renameSync: (a, b) => {
      if (renameFails) throw new Error('EBUSY');
      set.delete(a);
      set.add(b);
    },
  };
}

const base = path.join('C:', 'AppData');
const NEW = path.join(base, 'Nuri');
const OLD = path.join(base, 'AI Native Browser');

test('data folder names', () => {
  assert.strictEqual(dataDirName(''), 'Nuri');
  assert.strictEqual(dataDirName('test'), 'Nuri (test)');
});

test('moves the old data folder to the new name once', () => {
  const fs = fakeFs([OLD]);
  assert.strictEqual(resolveUserData(base, '', fs), NEW);
  assert.ok(fs.set.has(NEW) && !fs.set.has(OLD));
});

test('keeps the new folder when both exist, and starts fresh when neither does', () => {
  assert.strictEqual(resolveUserData(base, '', fakeFs([OLD, NEW])), NEW);
  assert.strictEqual(resolveUserData(base, '', fakeFs([])), NEW);
});

test('uses the old folder when it cannot be moved (old app still running)', () => {
  assert.strictEqual(resolveUserData(base, '', fakeFs([OLD], { renameFails: true })), OLD);
});

test('profiles move their own folder', () => {
  const fs = fakeFs([path.join(base, 'AI Native Browser (test)')]);
  assert.strictEqual(resolveUserData(base, 'test', fs), path.join(base, 'Nuri (test)'));
});
