// Local WebSocket bridge between the ANB host (this process) and the agent side panel inside
// the Nuri (Chromium extension). Only 127.0.0.1, only our extension's origin, and
// only with the per-run token written into the extension folder (host.json) are accepted.
//
// Messages (JSON):
//   panel -> host  {t:'send', ch, args}            fire-and-forget command
//                  {t:'invoke', id, ch, args}       request; answered with {t:'result', id, ok, value|error}
//   host  -> panel {t:'event', ch, payload}         agent events, tab/server/settings state

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

class BridgeServer {
  /**
   * @param {{router: ReturnType<import('./router').makeRouter>, allowedOrigin: string, log: Function,
   *          onConnect?: Function, onMessage?: Function}} opts
   */
  constructor({ router, allowedOrigin, log, onConnect, onMessage }) {
    this.router = router;
    this.allowedOrigin = allowedOrigin;
    this.log = log || (() => {});
    this.onConnect = onConnect || (() => {});
    this.onMessage = onMessage || (() => {});
    this.token = crypto.randomBytes(24).toString('hex');
    this.clients = new Set();
    this.port = 0;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.http = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      this.wss = new WebSocketServer({
        server: this.http,
        maxPayload: 8 * 1024 * 1024,
        verifyClient: ({ origin, req }, done) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          const ok = origin === this.allowedOrigin && url.searchParams.get('token') === this.token;
          if (!ok) this.log('bridge refused', origin || '(no origin)');
          done(ok, 403);
        },
      });
      this.wss.on('connection', (ws) => this.accept(ws));
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => {
        this.port = this.http.address().port;
        this.log('bridge listening', this.port);
        resolve(this.port);
      });
    });
  }

  accept(ws) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg.ch !== 'string') return;
      const args = Array.isArray(msg.args) ? msg.args : [];
      const event = { sender: { bridge: true }, ws };
      if (this.onMessage(msg, ws)) return; // handled by the host itself (e.g. focus reports)
      if (msg.t === 'send') {
        try {
          this.router.dispatchSend(msg.ch, args, event);
        } catch (e) {
          this.log('bridge send failed', msg.ch, e.message);
        }
      } else if (msg.t === 'invoke') {
        let reply;
        try {
          reply = { t: 'result', id: msg.id, ok: true, value: await this.router.dispatchInvoke(msg.ch, args, event) };
        } catch (e) {
          reply = { t: 'result', id: msg.id, ok: false, error: String(e?.message || e) };
        }
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
      }
    });
    this.onConnect(ws);
  }

  /** Sends an event to every connected side panel (or to one socket). */
  broadcast(channel, payload, only = null) {
    const text = JSON.stringify({ t: 'event', ch: channel, payload });
    for (const ws of only ? [only] : this.clients) if (ws.readyState === ws.OPEN) ws.send(text);
  }

  close() {
    for (const ws of this.clients) ws.terminate();
    this.wss?.close();
    this.http?.close();
  }
}

module.exports = { BridgeServer };
