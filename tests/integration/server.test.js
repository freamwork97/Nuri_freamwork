import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from '../../packages/anb-orchestrator/dist/server.js';

describe('ANB Control API & Server Endpoints', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-server-test-'));
  let server;
  const PORT = 3987;
  const BASE_URL = `http://127.0.0.1:${PORT}`;

  before(async () => {
    server = createServer(tmpDir);
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('serves a status page at GET /', async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Nuri'));
  });

  it('returns healthy status on GET /v1/health', async () => {
    const res = await fetch(`${BASE_URL}/v1/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'Nuri Control API');
  });

  it('lists providers and reports Google Antigravity CLI status on GET /v1/providers', async () => {
    const res = await fetch(`${BASE_URL}/v1/providers`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    const agy = body.find(p => p.id === 'google-agy');
    assert.ok(agy);
    assert.strictEqual(agy.isDefault, true);
    assert.ok(agy.models.includes('gemini-3.8-flash-medium'));
  });

  it('manages tabs via GET and POST /v1/tabs', async () => {
    // List initial tabs
    const listRes = await fetch(`${BASE_URL}/v1/tabs`);
    const initialTabs = await listRes.json();
    assert.strictEqual(initialTabs.length, 1);

    // Open new tab
    const openRes = await fetch(`${BASE_URL}/v1/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://news.ycombinator.com', title: 'Hacker News' })
    });
    assert.strictEqual(openRes.status, 201);
    const newTab = await openRes.json();
    assert.strictEqual(newTab.title, 'Hacker News');

    // Navigate tab
    const navRes = await fetch(`${BASE_URL}/v1/tabs/navigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://ai.google.dev',
        mockContent: '<h1>Google AI</h1>',
        mockTitle: 'Google AI'
      })
    });
    assert.strictEqual(navRes.status, 200);
    const navResult = await navRes.json();
    assert.strictEqual(navResult.title, 'Google AI');
  });
});
