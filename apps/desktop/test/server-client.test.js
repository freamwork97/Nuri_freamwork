const test = require('node:test');
const assert = require('node:assert');
const { ServerClient } = require('../src/server-client');

test('request waits for the server to come up, then retries once', async () => {
  const realFetch = global.fetch;
  let up = false;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (!up) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  };
  try {
    const c = new ServerClient();
    c.start = async () => { up = true; };
    assert.deepStrictEqual(await c.request('/v1/x'), { ok: 1 });
    assert.strictEqual(calls, 2);
  } finally {
    global.fetch = realFetch;
  }
});

test('concurrent ensure calls share one start', async () => {
  const c = new ServerClient();
  let starts = 0;
  c.start = () => new Promise((r) => { starts++; setTimeout(r, 20); });
  await Promise.all([c.ensure(), c.ensure(), c.ensure()]);
  assert.strictEqual(starts, 1);
  await c.ensure();
  assert.strictEqual(starts, 2);
});

test('server mode: WSL unless a subscription CLI is installed on Windows', () => {
  const { serverMode, windowsClis } = require('../src/server-client');
  assert.strictEqual(serverMode('auto', 'win32', () => []), 'wsl');
  assert.strictEqual(serverMode('auto', 'win32', () => ['claude', 'codex']), 'wsl'); // agy missing
  assert.strictEqual(serverMode('auto', 'win32', () => ['claude', 'codex', 'agy']), 'native');
  assert.strictEqual(serverMode('wsl', 'win32', () => ['codex']), 'wsl');
  assert.strictEqual(serverMode('native', 'win32', () => []), 'native');
  assert.strictEqual(serverMode('auto', 'linux', () => []), 'native');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-clis-'));
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '');
  assert.deepStrictEqual(windowsClis({ PATH: dir, APPDATA: dir }), ['codex']);
  fs.rmSync(dir, { recursive: true, force: true });
});

const { judgeServer, tokenIdOf } = require('../src/server-client');
const { profilePort } = require('../src/config');

test('installed app: reuse only its own current server', () => {
  const token = 'a'.repeat(64);
  const mine = { tokenId: tokenIdOf(token), build: '10-20' };
  assert.strictEqual(judgeServer(mine, { token, build: '10-20' }), 'ok');
  assert.strictEqual(judgeServer(mine, { token, build: '11-30' }), 'outdated', 'left over from before an update');
  assert.strictEqual(judgeServer({ build: '10-20' }, { token, build: '10-20' }), 'outdated', 'old server without lifecycle');
  assert.strictEqual(judgeServer({ tokenId: tokenIdOf('b'.repeat(64)), build: '10-20' }, { token, build: '10-20' }), 'foreign');
  assert.strictEqual(judgeServer(mine, { token: null, build: '10-20' }), 'foreign');
  assert.strictEqual(judgeServer(mine, { token, build: 'unknown' }), 'ok');
});

test('each installed profile gets its own stable server port', () => {
  assert.strictEqual(profilePort(''), 3466);
  assert.strictEqual(profilePort('install'), profilePort('install'));
  assert.notStrictEqual(profilePort('install'), 3466);
  for (const p of ['test', 'check', 'tray', 'install', 'firstrun']) assert.ok(profilePort(p) >= 3467 && profilePort(p) < 3967);
});
