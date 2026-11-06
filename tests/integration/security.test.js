import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from '../../packages/anb-orchestrator/dist/server.js';
import { loadOrCreateToken } from '../../packages/anb-orchestrator/dist/http/security.js';

// Raw requests so we can set Host / Origin / Sec-Fetch-Site like a browser would.
function request(port, { method = 'GET', path: p = '/v1/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Control server security', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-sec-test-'));
  const PORT = 3988;
  const token = loadOrCreateToken(dir);
  let server;

  before(async () => {
    server = createServer(dir, { token });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  });
  after(async () => {
    await new Promise((r) => server.close(r));
  });

  it('creates a stable 256-bit token', () => {
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.strictEqual(loadOrCreateToken(dir), token);
  });

  it('allows plain local requests', async () => {
    assert.strictEqual((await request(PORT)).status, 200);
  });

  it('rejects DNS-rebinding style Host headers', async () => {
    assert.strictEqual((await request(PORT, { headers: { Host: 'evil.example:3988' } })).status, 421);
  });

  it('rejects cross-origin and cross-site browser requests', async () => {
    assert.strictEqual((await request(PORT, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.strictEqual((await request(PORT, { path: '/v1/tasks', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });

  it('allows the bundled extension origin', async () => {
    const res = await request(PORT, { headers: { Origin: 'chrome-extension://pgilknmfgggkflkimlehmjbbbmamaebp' } });
    assert.strictEqual(res.status, 200);
  });

  it('requires the token for LLM endpoints', async () => {
    assert.strictEqual((await request(PORT, { path: '/v1/llm/accounts' })).status, 401);
    assert.strictEqual((await request(PORT, { path: '/v1/llm/accounts', headers: { 'X-ANB-Token': 'wrong' } })).status, 401);
    const bad = await request(PORT, {
      method: 'POST',
      path: '/v1/llm/complete',
      headers: { 'X-ANB-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'not-a-model', prompt: 'x' }),
    });
    assert.strictEqual(bad.status, 400);
  });

  it('no longer exposes the open web proxy', async () => {
    assert.strictEqual((await request(PORT, { path: '/v1/proxy?url=http://example.com', headers: { 'X-ANB-Token': token } })).status, 404);
  });

  it('requires the token for the legacy task and tab API', async () => {
    for (const p of ['/v1/tasks', '/v1/tabs', '/v1/tabs/active/aria', '/v1/skills', '/v1/providers', '/sidepanel']) {
      assert.strictEqual((await request(PORT, { path: p })).status, 401, p);
    }
    assert.strictEqual((await request(PORT, { method: 'POST', path: '/v1/tabs', headers: { 'Content-Type': 'application/json' }, body: '{"url":"https://example.com"}' })).status, 401);
    assert.notStrictEqual((await request(PORT, { path: '/v1/skills', headers: { 'X-ANB-Token': token } })).status, 401);
    assert.strictEqual((await request(PORT, { path: '/v1/health' })).status, 200);
  });

  it('rejects oversized bodies', async () => {
    const res = await request(PORT, {
      method: 'POST',
      path: '/v1/tasks',
      headers: { 'Content-Type': 'application/json', 'X-ANB-Token': token },
      body: 'x'.repeat(9 * 1024 * 1024),
    }).catch(() => ({ status: 413 }));
    assert.strictEqual(res.status, 413);
  });
});
