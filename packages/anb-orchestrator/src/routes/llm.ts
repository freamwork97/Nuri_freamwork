import http from 'node:http';
import { readJsonBody, sendJson, HttpError } from '../http/util.js';
import { assertProvider, type ImageInput } from '../llm/process.js';
import { complete } from '../llm/complete.js';
import { closeCodexSession } from '../llm/codexSession.js';
import { closeGeminiSession } from '../llm/geminiSession.js';
import { closeClaudeSession } from '../llm/claudeSession.js';
import { runAssistant, generateImage, capabilities } from '../llm/assistant.js';
import { accountStatus, startLogin, submitLoginCode, loginState } from '../llm/accounts.js';

/** Abort the CLI when the HTTP client disconnects (e.g. the user pressed Stop). */
function abortOnClose(req: http.IncomingMessage, res: http.ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  return ac.signal;
}

function parseImages(raw: unknown): ImageInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i) => i && typeof i.data === 'string' && /^image\/(png|jpeg)$/.test(i.mime))
    .slice(0, 3)
    .map((i) => ({ mime: i.mime, data: i.data }));
}

/** Handles /v1/llm/* routes. Returns false when the path is not an LLM route. */
export async function handleLlmRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/llm/')) return false;
  const method = req.method || 'GET';

  if (pathname === '/v1/llm/complete' && method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.prompt !== 'string' || !body.prompt) throw new HttpError(400, 'prompt is required');
    const started = Date.now();
    const text = await complete({
      provider: assertProvider(body.provider),
      prompt: body.prompt,
      system: typeof body.system === 'string' ? body.system : undefined,
      images: parseImages(body.images),
      sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : undefined,
      quality: body.quality === 'accurate' ? 'accurate' : 'fast',
      signal: abortOnClose(req, res),
    });
    sendJson(res, 200, { text, durationMs: Date.now() - started });
    return true;
  }

  if (pathname === '/v1/llm/session/close' && method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.sessionId === 'string') {
      closeClaudeSession(body.sessionId);
      closeCodexSession(body.sessionId);
      closeGeminiSession(body.sessionId);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/v1/llm/image' && method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.prompt !== 'string' || !body.prompt) throw new HttpError(400, 'prompt is required');
    const rel = String(body.path ?? '');
    if (!/\.png$/i.test(rel) || rel.startsWith('/') || rel.split('/').includes('..')) throw new HttpError(400, 'path must be a .png inside the work folder');
    sendJson(res, 200, await generateImage({ prompt: body.prompt.slice(0, 4000), path: rel, signal: abortOnClose(req, res) }));
    return true;
  }

  if (pathname === '/v1/llm/assistant' && method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.prompt !== 'string' || !body.prompt) throw new HttpError(400, 'prompt is required');
    const started = Date.now();
    const images = Array.isArray(body.images) ? body.images.filter((f: unknown): f is string => typeof f === 'string').slice(0, 10) : [];
    const text = await runAssistant({ provider: assertProvider(body.provider), prompt: body.prompt, images, signal: abortOnClose(req, res) });
    sendJson(res, 200, { text, durationMs: Date.now() - started });
    return true;
  }

  if (pathname === '/v1/llm/accounts' && method === 'GET') {
    sendJson(res, 200, { accounts: await accountStatus(query.get('refresh') === '1') });
    return true;
  }

  if (pathname === '/v1/llm/capabilities' && method === 'GET') {
    sendJson(res, 200, { capabilities: await capabilities(query.get('refresh') === '1') });
    return true;
  }

  if (pathname === '/v1/llm/login' && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 200, await startLogin(assertProvider(body.provider)));
    return true;
  }

  if (pathname === '/v1/llm/login/code' && method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: submitLoginCode(assertProvider(body.provider), String(body.code || '')) });
    return true;
  }

  if (pathname === '/v1/llm/login/state' && method === 'GET') {
    sendJson(res, 200, loginState(assertProvider(query.get('provider'))));
    return true;
  }

  throw new HttpError(404, 'Endpoint not found');
}
