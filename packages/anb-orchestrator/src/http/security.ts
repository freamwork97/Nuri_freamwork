/**
 * Request guard for the local control server.
 *
 * Threats handled:
 *  - Other machines on the LAN: the server binds to 127.0.0.1 only (see server.ts).
 *  - Websites in any browser (incl. the app's own tabs) calling http://127.0.0.1:3456 (CSRF):
 *    cross-site requests are rejected by Origin / Sec-Fetch-Site checks.
 *  - DNS rebinding (evil.com resolving to 127.0.0.1): rejected by the Host check.
 *  - Every API endpoint except /v1/health (LLM bridge and the legacy task/tab API, which can
 *    drive a browser) additionally needs a per-install secret token read from disk.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const EXTENSION_ORIGIN = 'chrome-extension://pgilknmfgggkflkimlehmjbbbmamaebp';
export const TOKEN_HEADER = 'x-anb-token';

export function loadOrCreateToken(dataDir: string): string {
  const file = path.join(dataDir, 'auth-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* create below */
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export interface GuardOptions {
  port: number;
  token: string | null; // null disables token checks (unit tests)
}

/** Public paths: liveness check and the plain status page. Everything else needs the token. */
export function needsToken(pathname: string): boolean {
  return pathname !== '/v1/health' && pathname !== '/';
}

/** Returns an error message when the request must be rejected, otherwise null. */
export function checkRequest(req: http.IncomingMessage, pathname: string, opts: GuardOptions): { status: number; error: string } | null {
  const host = String(req.headers.host || '').toLowerCase();
  const allowedHosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, '127.0.0.1', 'localhost'];
  if (!allowedHosts.includes(host)) return { status: 421, error: 'Invalid Host header' };

  const origin = req.headers.origin ? String(req.headers.origin) : '';
  const sameOrigins = [`http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`];
  const originAllowed = !origin || sameOrigins.includes(origin) || origin === EXTENSION_ORIGIN;
  if (!originAllowed) return { status: 403, error: 'Cross-origin request blocked' };

  const site = String(req.headers['sec-fetch-site'] || '');
  if ((site === 'cross-site' || site === 'same-site') && origin !== EXTENSION_ORIGIN) {
    return { status: 403, error: 'Cross-site request blocked' };
  }

  if (opts.token && needsToken(pathname)) {
    const given = String(req.headers[TOKEN_HEADER] || '');
    if (!given || !safeEqual(given, opts.token)) return { status: 401, error: 'Missing or invalid token' };
  }
  return null;
}
