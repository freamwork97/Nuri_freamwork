/**
 * ANB local control server (runs inside WSL, listens on 127.0.0.1 only).
 *   /v1/health        liveness
 *   /v1/llm/*         subscription-CLI bridge for the desktop app
 *   /v1/lease, /v1/shutdown   server lifetime for the installed app (routes/lifecycle.ts)
 *   /v1/...           legacy task API (Edge extension fallback, tests)
 * Everything except /v1/health and / needs the per-install token (http/security.ts).
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskOrchestrator } from './orchestrator.js';
import { sendJson, HttpError } from './http/util.js';
import { checkRequest, loadOrCreateToken } from './http/security.js';
import { handleLlmRoute } from './routes/llm.js';
import { handleLegacyRoute } from './routes/legacy.js';
import { BUILD_ID, Leases, handleLifecycleRoute, tokenId } from './routes/lifecycle.js';
import { closeAllClaudeSessions } from './llm/claudeSession.js';
import { closeAllCodexSessions } from './llm/codexSession.js';
import { closeAllGeminiSessions } from './llm/geminiSession.js';

export interface ServerOptions {
  /** Secret required for /v1/llm/*. Omit (null) only in tests. */
  token?: string | null;
  /** Called on POST /v1/shutdown. Default: close sessions and exit the process. */
  onShutdown?: (reason: string) => void;
  leases?: Leases;
}

function closeSessions() {
  closeAllClaudeSessions();
  closeAllCodexSessions();
  closeAllGeminiSessions();
}

export function exitServer(reason: string) {
  console.log(`[Nuri] server stopping (${reason})`);
  closeSessions();
  process.exit(0);
}

const STATUS_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Nuri</title>
<style>body{font-family:system-ui,'Malgun Gothic',sans-serif;max-width:560px;margin:80px auto;color:#18181b;line-height:1.6}code{background:#f4f4f5;padding:2px 6px;border-radius:6px}</style>
</head><body><h1>Nuri</h1><p>AI 엔진 서버가 실행 중입니다. 화면은 <code>AI-Native-Browser.exe</code>(데스크톱 앱)에서 사용하세요.</p></body></html>`;

export function createServer(orchestratorOrDir: TaskOrchestrator | string, options: ServerOptions = {}): http.Server {
  const orchestrator = typeof orchestratorOrDir === 'string' ? new TaskOrchestrator(orchestratorOrDir) : orchestratorOrDir;
  const token = options.token ?? null;
  const leases = options.leases ?? new Leases();
  const onShutdown = options.onShutdown ?? exitServer;
  const health = { status: 'ok', service: 'Nuri Control API', build: BUILD_ID, tokenId: tokenId(token), pid: process.pid };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    const denied = checkRequest(req, pathname, { port: req.socket.localPort || 0, token });
    if (denied) {
      sendJson(res, denied.status, { error: denied.error });
      return;
    }

    if (pathname === '/v1/health') {
      sendJson(res, 200, { ...health, timestamp: new Date().toISOString() });
      return;
    }
    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(STATUS_PAGE);
      return;
    }
    if (await handleLifecycleRoute(req, res, pathname, leases, onShutdown)) return;
    if (await handleLlmRoute(req, res, pathname, url.searchParams)) return;
    if (await handleLegacyRoute(req, res, pathname, orchestrator)) return;

    throw new HttpError(404, 'Endpoint not found');
  };

  // Any thrown error becomes an HTTP error response instead of crashing the server.
  return http.createServer((req, res) => {
    handle(req, res).catch((err: any) => {
      const msg = err instanceof Error ? err.message : String(err);
      const status = err?.status ?? (/currently active/.test(msg) ? 409 : 500);
      if (!res.headersSent) sendJson(res, status, { error: msg });
      else res.end();
    });
  });
}

export function startServer(orchestratorOrDir: TaskOrchestrator | string, port = 3456, options: ServerOptions = {}): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(orchestratorOrDir, options);
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// Auto-start when executed directly as a CLI script
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const port = parseInt(process.env.PORT || '3456', 10);
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.anb-data');
  const token = loadOrCreateToken(dataDir);

  process.on('unhandledRejection', (err) => console.error('[Nuri] unhandled rejection:', err));
  process.on('uncaughtException', (err) => console.error('[Nuri] uncaught exception:', err));
  process.on('SIGTERM', () => exitServer('SIGTERM'));
  process.on('SIGINT', () => exitServer('SIGINT'));

  const leases = new Leases();
  if (process.env.ANB_EXIT_WHEN_IDLE === '1') {
    // Installed app: never outlive it (see routes/lifecycle.ts).
    setInterval(() => {
      if (leases.idle()) exitServer('no app is using this server');
    }, 15_000).unref();
  }

  startServer(dataDir, port, { token, leases })
    .then(() => console.log(`[Nuri] server listening on http://127.0.0.1:${port} (token: ${path.join(dataDir, 'auth-token')})`))
    .catch((err) => {
      console.error('[Nuri] failed to start:', err.message);
      process.exit(1);
    });
}
