/**
 * Server lifetime for the installed app.
 *
 *   GET  /v1/health    (public) also says which build and which token this server has, so an app
 *                      can tell an old server (left from before an update) or another profile's.
 *   POST /v1/lease     {client, release?}  the app says "I still use you" every 30 s, or "done".
 *   POST /v1/shutdown  stop now (the app replacing an outdated server).
 *
 * With ANB_EXIT_WHEN_IDLE=1 (set by the installed app) the server exits once no app holds a
 * lease: after the last app releases it, when leases stop arriving (the app crashed), or when no
 * app ever leased it. Repo/dev servers keep running as before.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readJsonBody, sendJson } from '../http/util.js';

export const LEASE_TTL_MS = 90_000;
export const UNCLAIMED_MS = 5 * 60_000;
const RELEASED_GRACE_MS = 5_000;

/** Same id the app computes from the bundle file on disk (size + whole seconds of mtime). */
export function buildIdOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.size}-${Math.floor(st.mtimeMs / 1000)}`;
  } catch {
    return 'unknown';
  }
}

/** Short public fingerprint of the token: tells apart servers without revealing the secret. */
export function tokenId(token: string | null): string | null {
  return token ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 16) : null;
}

// The started script (server.js, or the single bundled server.mjs when installed).
export const BUILD_ID = buildIdOf(process.argv[1] || fileURLToPath(import.meta.url));

export class Leases {
  private seen = new Map<string, number>();
  private everLeased = false;
  private emptySince: number;

  constructor(private readonly startedAt = Date.now()) {
    this.emptySince = startedAt;
  }

  touch(client: string, now = Date.now()) {
    this.seen.set(client, now);
    this.everLeased = true;
  }

  release(client: string, now = Date.now()) {
    this.seen.delete(client);
    // A released lease ends quickly; an expired one already waited LEASE_TTL_MS.
    if (!this.seen.size) this.emptySince = now - (LEASE_TTL_MS - RELEASED_GRACE_MS);
  }

  /** Drops expired leases; true when the server has no reason to keep running. */
  idle(now = Date.now()): boolean {
    for (const [c, t] of this.seen) {
      if (now - t > LEASE_TTL_MS) {
        this.seen.delete(c);
        this.emptySince = Math.max(this.emptySince, t);
      }
    }
    if (this.seen.size) return false;
    if (!this.everLeased) return now - this.startedAt > UNCLAIMED_MS;
    return now - this.emptySince > LEASE_TTL_MS;
  }

  get count() {
    return this.seen.size;
  }
}

export async function handleLifecycleRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  leases: Leases,
  shutdown: (reason: string) => void,
): Promise<boolean> {
  if (pathname === '/v1/lease' && req.method === 'POST') {
    const body = await readJsonBody(req, 4096);
    const client = String(body.client || '').slice(0, 64) || 'app';
    if (body.release) leases.release(client);
    else leases.touch(client);
    sendJson(res, 200, { ok: true, clients: leases.count });
    return true;
  }
  if (pathname === '/v1/shutdown' && req.method === 'POST') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => shutdown('requested'), 100);
    return true;
  }
  return false;
}
