/**
 * Warm Gemini (Antigravity `agy`) for browser-agent steps: `agy --print= --input-format stream-json`
 * keeps one conversation open and answers each NDJSON user message in ~2-3s instead of ~8s.
 * agy's stream input only accepts text blocks, so screenshots are passed as file paths.
 */

import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { SANDBOX_DIR, safeEnv, writeTempImages, type ImageInput, spawnCli } from './process.js';

const MAX_TURNS = 12;
const IDLE_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 600_000; // a full 25-page proposal took ~4.5 min (2026-10-23)

type Pending = { resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; cleanup: () => void };

class GeminiSession {
  private child: ChildProcess;
  private buf = '';
  private pending: Pending | null = null;
  private stderr = '';
  private system: string;
  turns = 0;
  lastUsed = Date.now();
  dead = false;

  constructor(system: string, model: string) {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    this.system = system;
    const args = ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--disable-slash-commands'];
    this.child = spawnCli('agy', args, { cwd: SANDBOX_DIR, env: safeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (d) => this.onData(String(d)));
    this.child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    this.child.on('close', (code) => this.fail(new Error(`agy session exited (${code}): ${this.stderr.slice(-300)}`)));
    this.child.on('error', (e) => this.fail(e));
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
      if (msg.event === 'result' && this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        p.cleanup();
        const r = msg.result || {};
        if (r.status !== 'SUCCESS') p.reject(new Error(`agy error: ${r.error || r.status}`));
        else p.resolve(String(r.response ?? ''));
      }
    }
  }

  private fail(err: Error) {
    this.dead = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(err);
    }
  }

  ask(text: string, images: ImageInput[] = [], signal?: AbortSignal): Promise<string> {
    if (this.dead) return Promise.reject(new Error('agy session is closed'));
    if (this.pending) return Promise.reject(new Error('agy session is busy'));
    const { files, cleanup } = writeTempImages(images);
    // No system-prompt flag in stream mode: the rules go with the first message of the conversation.
    let body = this.turns === 0 ? `${this.system}\n\n${text}` : text;
    if (files.length) body += `\n\nA screenshot of the current page is saved at: ${files.join(', ')} — open it to see the page.`;
    this.turns++;
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        cleanup();
        reject(new Error('agy session turn timed out'));
      }, TURN_TIMEOUT_MS);
      this.pending = { resolve, reject, timer, cleanup };
      signal?.addEventListener('abort', () => this.close()); // a cancelled turn can't be resumed safely
      this.child.stdin!.write(JSON.stringify({ event: 'user', message: { role: 'user', content: [{ type: 'text', text: body }] } }) + '\n');
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

const sessions = new Map<string, GeminiSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.dead || now - s.lastUsed > IDLE_MS) {
      s.close();
      sessions.delete(id);
    }
  }
}, 60_000).unref();

export async function askGeminiSession(opts: {
  sessionId: string;
  system: string;
  prompt: string;
  images?: ImageInput[];
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  let s = sessions.get(opts.sessionId);
  if (s && (s.dead || s.turns >= MAX_TURNS)) {
    s.close();
    sessions.delete(opts.sessionId);
    s = undefined;
  }
  if (!s) {
    s = new GeminiSession(opts.system, opts.model);
    sessions.set(opts.sessionId, s);
  }
  return s.ask(opts.prompt, opts.images, opts.signal);
}

export function closeGeminiSession(sessionId: string) {
  sessions.get(sessionId)?.close();
  sessions.delete(sessionId);
}

export function closeAllGeminiSessions() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}
