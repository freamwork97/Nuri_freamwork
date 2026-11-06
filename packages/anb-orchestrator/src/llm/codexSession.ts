/**
 * Warm Codex for browser-agent steps via `codex app-server` (JSON-RPC over stdio).
 * `codex exec` pays ~7s of start-up per call; a thread on a running app-server answers in ~2-3s.
 * One app-server process hosts one thread per agent run (sessionId). Threads are ephemeral,
 * read-only, never ask for approval, and are rotated after MAX_TURNS to bound context size.
 */

import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { CODEX_SUBSCRIPTION_FLAG, SANDBOX_DIR, safeEnv, type ImageInput, spawnCli } from './process.js';

const MAX_TURNS = 12;
const IDLE_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 600_000; // a full 25-page proposal took ~4.5 min (2026-10-23)

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };
type Turn = { text: string; resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class AppServer {
  private child: ChildProcess;
  private buf = '';
  private nextId = 1;
  private waiting = new Map<number, Waiter>();
  private turns = new Map<string, Turn>(); // threadId -> running turn
  private stderr = '';
  ready: Promise<void>;
  dead = false;

  constructor() {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    this.child = spawnCli('codex', ['app-server', '-c', CODEX_SUBSCRIPTION_FLAG], { cwd: SANDBOX_DIR, env: safeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (d) => this.onData(String(d)));
    this.child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    this.child.on('close', (code) => this.fail(new Error(`codex app-server exited (${code}): ${this.stderr.slice(-300)}`)));
    this.child.on('error', (e) => this.fail(e));
    this.ready = this.request('initialize', { clientInfo: { name: 'nuri', version: '2' } }).then(() => {
      this.notify('initialized');
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && !msg.method) {
        const w = this.waiting.get(msg.id);
        if (!w) continue;
        this.waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(`codex: ${msg.error.message || JSON.stringify(msg.error)}`));
        else w.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // Server-initiated request (approvals etc.): decline; step decisions need no tools.
        this.write({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } });
      } else if (msg.method) {
        this.onNotification(msg.method, msg.params || {});
      }
    }
  }

  private onNotification(method: string, params: any) {
    const threadId = params.threadId || params.thread?.id;
    const turn = threadId ? this.turns.get(threadId) : undefined;
    if (!turn) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') turn.text = String(params.item.text ?? '');
    if (method === 'turn/completed') {
      this.turns.delete(threadId);
      clearTimeout(turn.timer);
      const status = params.turn?.status;
      if (status === 'failed') turn.reject(new Error(`codex turn failed: ${JSON.stringify(params.turn?.error || '').slice(0, 300)}`));
      else turn.resolve(turn.text);
    }
  }

  private write(obj: unknown) {
    this.child.stdin!.write(JSON.stringify(obj) + '\n');
  }

  private notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.dead) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private fail(err: Error) {
    this.dead = true;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    for (const t of this.turns.values()) {
      clearTimeout(t.timer);
      t.reject(err);
    }
    this.turns.clear();
  }

  async startThread(system: string, model?: string): Promise<string> {
    await this.ready;
    const r = await this.request('thread/start', {
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      baseInstructions: system,
      cwd: SANDBOX_DIR,
      ...(model ? { model } : {}),
    });
    const id = r?.thread?.id;
    if (!id) throw new Error('codex: thread/start returned no id');
    return id;
  }

  runTurn(threadId: string, text: string, images: ImageInput[], effort: string, signal?: AbortSignal): Promise<string> {
    const input: any[] = images.map((img) => ({ type: 'image', url: `data:${img.mime};base64,${img.data}` }));
    input.push({ type: 'text', text });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(threadId);
        this.request('turn/interrupt', { threadId }).catch(() => {});
        reject(new Error('codex turn timed out'));
      }, TURN_TIMEOUT_MS);
      this.turns.set(threadId, { text: '', resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        const t = this.turns.get(threadId);
        if (!t) return;
        this.turns.delete(threadId);
        clearTimeout(t.timer);
        this.request('turn/interrupt', { threadId }).catch(() => {});
        t.reject(new Error('aborted'));
      });
      this.request('turn/start', { threadId, input, effort }).catch((e) => {
        const t = this.turns.get(threadId);
        if (!t) return;
        this.turns.delete(threadId);
        clearTimeout(t.timer);
        t.reject(e);
      });
    });
  }

  close() {
    this.dead = true;
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

let server: AppServer | null = null;
const threads = new Map<string, { id: string; turns: number; lastUsed: number }>();

function appServer(): AppServer {
  if (!server || server.dead) {
    server = new AppServer();
    threads.clear(); // threads belonged to the old process
  }
  return server;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, t] of threads) if (now - t.lastUsed > IDLE_MS) threads.delete(key);
  if (server && !threads.size && !server.dead) {
    server.close(); // nothing running: free the process
    server = null;
  }
}, 60_000).unref();

export async function askCodexSession(opts: {
  sessionId: string;
  system: string;
  prompt: string;
  images?: ImageInput[];
  effort: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const srv = appServer();
  let t = threads.get(opts.sessionId);
  if (!t || t.turns >= MAX_TURNS) {
    t = { id: await srv.startThread(opts.system, opts.model), turns: 0, lastUsed: Date.now() };
    threads.set(opts.sessionId, t);
  }
  t.turns++;
  t.lastUsed = Date.now();
  return srv.runTurn(t.id, opts.prompt, opts.images || [], opts.effort, opts.signal);
}

export function closeCodexSession(sessionId: string) {
  threads.delete(sessionId);
}

export function closeAllCodexSessions() {
  threads.clear();
  server?.close();
  server = null;
}
