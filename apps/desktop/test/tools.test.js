const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTool, resolveIn } = require('../src/agent/tools');

test('save_file / copy_file write into the user folders, never elsewhere', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-tools-'));
  const work = path.join(root, 'work');
  const desktop = path.join(root, 'Desktop');
  const other = path.join(root, 'Other');
  fs.mkdirSync(desktop);
  try {
    const xlsx = path.join(desktop, '시황.xlsx');
    const r = await runTool({ type: 'save_file', name: `"${xlsx}"`, content: '## 지수\n| 이름 | 값 |\n| --- | --- |\n| 코스피 | 5469.47 |' }, { workdir: work, userDirs: [desktop] });
    assert.match(r.summary, /saved Excel file 시황\.xlsx/);
    assert.ok(fs.readFileSync(xlsx).subarray(0, 2).equals(Buffer.from('PK')), 'real xlsx (zip)');
    await assert.rejects(runTool({ type: 'save_file', name: path.join(other, 'x.txt'), content: 'x' }, { workdir: work, userDirs: [desktop] }), /can write only/);
    await runTool({ type: 'save_file', name: 'memo.md', content: 'hi' }, { workdir: work, userDirs: [desktop] });
    const c = await runTool({ type: 'copy_file', from: 'memo.md', to: desktop }, { workdir: work, userDirs: [desktop] });
    assert.match(c.summary, /copied memo\.md/);
    assert.strictEqual(fs.readFileSync(path.join(desktop, 'memo.md'), 'utf8'), 'hi');
    assert.throws(() => resolveIn(work, path.join(desktop, '..', 'Other', 'y.txt'), { forWrite: true, userDirs: [desktop] }), /can write only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
