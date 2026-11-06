const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { SandboxPC, wsbConfig, START_PS1, PORT } = require('../src/sandbox/sandbox');

test('AI 작업 PC: sandbox config maps only the helper (read-only), io and work folders', () => {
  const x = wsbConfig({ binDir: 'C:\\u\\bin', ioDir: 'C:\\u\\io', workDir: 'D:\\w&k' });
  assert.match(x, /<HostFolder>C:\\u\\bin<\/HostFolder><SandboxFolder>C:\\anb<\/SandboxFolder><ReadOnly>true<\/ReadOnly>/);
  assert.match(x, /<HostFolder>C:\\u\\io<\/HostFolder><SandboxFolder>C:\\anb-io<\/SandboxFolder><ReadOnly>false<\/ReadOnly>/);
  assert.match(x, /<HostFolder>D:\\w&amp;k<\/HostFolder><SandboxFolder>C:\\work<\/SandboxFolder>/, 'xml-escaped');
  assert.strictEqual((x.match(/<MappedFolder>/g) || []).length, 3);
  assert.match(x, /<ClipboardRedirection>Disable/);
  assert.ok(START_PS1.includes(`'--listen','${PORT}','C:\\anb\\token.txt'`), 'helper listens with the token file');
});

test('AI 작업 PC: work-folder paths map to C:\\work', () => {
  const work = path.resolve('/tmp/anb-ws');
  const pc = new SandboxPC({ dir: '/tmp/x', helperExe: '/tmp/h.exe', workDir: work });
  assert.strictEqual(pc.guestPath(path.join(work, 'proj', 'a.pdf')), 'C:\\work\\proj\\a.pdf');
  assert.strictEqual(pc.guestPath('/tmp/other/a.pdf'), null);
  assert.strictEqual(pc.available(), process.platform === 'win32' && pc.available());
});
