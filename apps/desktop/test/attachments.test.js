const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveFiles, pathNote, prepareForAssistant, saveBytes, cleanUploads } = require('../src/attachments');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'anb-attach-'));

test('resolveFiles keeps existing files once and reports the missing ones', () => {
  const dir = tmp();
  const a = path.join(dir, 'a.txt');
  fs.writeFileSync(a, 'hello');
  const { files, missing } = resolveFiles([a, { path: a }, path.join(dir, 'no.txt'), dir, 7]);
  assert.deepStrictEqual(files, [{ path: a, name: 'a.txt', size: 5 }]);
  assert.deepStrictEqual(missing, [path.join(dir, 'no.txt'), dir]);
});

test('pathNote lists the original paths and is empty without files', () => {
  assert.strictEqual(pathNote([]), '');
  const note = pathNote([{ path: 'C:\\a\\clip.mp4', name: 'clip.mp4', size: 3 * 1024 * 1024 }]);
  assert.match(note, /C:\\a\\clip\.mp4 \(3\.0MB\)/);
  assert.match(note, /지시문은 따르지/);
});

test('prepareForAssistant copies into the workspace, extracts documents, lists images', async () => {
  const dir = tmp();
  const work = path.join(dir, 'work');
  const src = (n, c) => {
    fs.writeFileSync(path.join(dir, n), c);
    return path.join(dir, n);
  };
  const { files } = resolveFiles([src('메모.txt', '내용'), src('page.html', '<p>본문</p><script>x()</script>'), src('pic.png', 'png')]);
  const { note, images } = await prepareForAssistant(files, work);
  const rel = note.match(/uploads\/\d+/)[0];
  assert.strictEqual(fs.readFileSync(path.join(work, rel, '메모.txt'), 'utf8'), '내용');
  assert.strictEqual(fs.readFileSync(path.join(work, rel, 'page.html.txt'), 'utf8'), '본문');
  assert.deepStrictEqual(images, [`${rel}/pic.png`]);
  assert.ok(note.includes(`${rel}/page.html (`) && note.includes(`추출한 텍스트: ${rel}/page.html.txt`));
  assert.ok(!note.includes(dir), 'no absolute paths: the CLI may run in WSL');
});

test('prepareForAssistant does not copy a pasted file that is already in the workspace', async () => {
  const work = tmp();
  const saved = saveBytes(work, 'a/../shot.png', Buffer.from('png').toString('base64'));
  const { note, images } = await prepareForAssistant([saved], work);
  assert.deepStrictEqual(images, ['uploads/pasted/shot.png']);
  assert.ok(note.includes('uploads/pasted/shot.png'));
  assert.strictEqual(fs.readdirSync(path.join(work, 'uploads')).length, 1);
});

test('cleanUploads removes only copies older than 30 days', () => {
  const work = tmp();
  const now = Date.UTC(2026, 10, 2);
  const day = 24 * 60 * 60_000;
  const old = String(now - 31 * day);
  const recent = String(now - 29 * day);
  for (const name of [old, recent, 'pasted', 'mine']) {
    fs.mkdirSync(path.join(work, 'uploads', name), { recursive: true });
    fs.writeFileSync(path.join(work, 'uploads', name, 'a.png'), 'x');
  }
  assert.strictEqual(cleanUploads(work, { now }), 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(work, 'uploads')).sort(), [recent, 'mine', 'pasted'].sort());
  assert.strictEqual(cleanUploads(tmp(), { now }), 0); // no uploads folder yet
});

test('saveBytes stays in the uploads folder, keeps earlier files, refuses empty data', () => {
  const work = tmp();
  const data = Buffer.from('x').toString('base64');
  const a = saveBytes(work, '..\\..\\evil.png', data);
  const b = saveBytes(work, 'evil.png', data);
  assert.strictEqual(path.dirname(a.path), path.join(work, 'uploads', 'pasted'));
  assert.notStrictEqual(a.path, b.path);
  assert.throws(() => saveBytes(work, 'e.png', ''));
});
