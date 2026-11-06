/**
 * Long-lived Claude Code process (stream-json in/out) for browser-agent steps.
 * Spawning `claude -p` costs ~6-8s per call; a warm session answers follow-up turns in ~1-2s.
 * Sessions are keyed by the agent run, rotated after MAX_TURNS to bound context size,
 * and closed after IDLE_MS of inactivity.
 */

import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { CLAUDE_ISOLATED, SANDBOX_DIR, safeEnv, type ImageInput, spawnCli } from './process.js';

const MAX_TURNS = 12;
const IDLE_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 600_000; // a full 25-page proposal took ~4.5 min (2026-10-23)

type Pending = { resolve: (t: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class ClaudeSession {
  private child: ChildProcess;
  private buf = '';
  private pending: Pending | null = null;
  private stderr = '';
  turns = 0;
  lastUsed = Date.now();
  dead = false;

  constructor(system: string, effort: string, model?: string) {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--tools', '',
      ...CLAUDE_ISOLATED, // includes the subscription-only settings
      '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
      '--system-prompt', system,
      '--effort', effort,
    ];
    if (model) args.push('--model', model);
    this.child = spawnCli('claude', args, { cwd: SANDBOX_DIR, env: safeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (d) => this.onData(String(d)));
    this.child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    this.child.on('close', (code) => this.fail(new Error(`claude session exited (${code}): ${this.stderr.slice(-300)}`)));
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
      if (msg.type === 'result' && this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        if (msg.is_error) p.reject(new Error(`claude error: ${msg.result || msg.subtype}`));
        else p.resolve(String(msg.result ?? ''));
      }
    }
  }

  private fail(err: Error) {
    this.dead = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  ask(text: string, images: ImageInput[] = []): Promise<string> {
    if (this.dead) return Promise.reject(new Error('claude session is closed'));
    if (this.pending) return Promise.reject(new Error('claude session is busy'));
    this.turns++;
    this.lastUsed = Date.now();
    const content: any[] = images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }));
    content.push({ type: 'text', text });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('claude session turn timed out'));
      }, TURN_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      this.child.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
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

const sessions = new Map<string, ClaudeSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.dead || now - s.lastUsed > IDLE_MS) {
      s.close();
      sessions.delete(id);
    }
  }
}, 60_000).unref();

export async function askClaudeSession(opts: {
  sessionId: string;
  system: string;
  prompt: string;
  images?: ImageInput[];
  effort: string;
  model?: string;
}): Promise<string> {
  let s = sessions.get(opts.sessionId);
  if (s && (s.dead || s.turns >= MAX_TURNS)) {
    s.close();
    sessions.delete(opts.sessionId);
    s = undefined;
  }
  if (!s) {
    s = new ClaudeSession(opts.system, opts.effort, opts.model);
    sessions.set(opts.sessionId, s);
  }
  return s.ask(opts.prompt, opts.images);
}

export function closeClaudeSession(sessionId: string) {
  sessions.get(sessionId)?.close();
  sessions.delete(sessionId);
}

export function closeAllClaudeSessions() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}
