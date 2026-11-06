// Runs one agent script (스크립트 자동화) against one tab. Started by script.js with Node's
// permission model: no file access outside its temp folder and no child processes, because the
// code is written by a model that reads web pages. Files are saved by the app, through messages.

const vm = require('node:vm');
const { chromium } = require('playwright-core');

const MAX_LOG = 40_000;
const MAX_FILE = 100 * 1024 * 1024;

/** Array of objects or of arrays -> CSV text (Excel-friendly quoting). */
function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  if (rows.every(Array.isArray)) return rows.map((r) => r.map(cell).join(',')).join('\n');
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
  return [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r?.[k])).join(','))].join('\n');
}

/** What save() writes for a value: text as is, rows as CSV, anything else as JSON. */
function asText(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data) && data.length && data.every((r) => r && typeof r === 'object')) return toCsv(data);
  return JSON.stringify(data, null, 2);
}

async function findPage(browser, targetId) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const cdp = await ctx.newCDPSession(page).catch(() => null);
      const info = cdp && (await cdp.send('Target.getTargetInfo').catch(() => null));
      await cdp?.detach().catch(() => {});
      if (info?.targetInfo.targetId === targetId) return page;
    }
  }
  throw new Error('스크립트가 작업 탭을 찾지 못했습니다');
}

function main() {
  let asked = 0;
  const waiting = new Map();
  const ask = (msg) =>
    new Promise((resolve, reject) => {
      const id = ++asked;
      waiting.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.summary)));
      process.send({ ...msg, id });
    });

  process.on('message', async (m) => {
    if (m.reply) return waiting.get(m.reply)?.(m);
    let logs = '';
    const log = (...args) => {
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      if (logs.length < MAX_LOG) logs += (logs.length + line.length > MAX_LOG ? line.slice(0, MAX_LOG - logs.length) + ' …(잘림)' : line) + '\n';
    };
    let error = null;
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${m.port}`, { timeout: 20_000 });
      const page = await findPage(browser, m.targetId);
      page.setDefaultTimeout(10_000);
      const sandbox = {
        page,
        console: { log, info: log, warn: log, error: log },
        log,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 30_000))),
        /** Full text of the page and its frames. */
        text: async (p = page) => (await Promise.all(p.frames().map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => '')))).join('\n'),
        save: (name, data) => ask({ op: 'save', name: String(name), text: asText(data) }),
        /** Downloads a URL with the browser's cookies into the work folder. */
        download: async (url, name) => {
          const res = await page.request.get(String(url), { timeout: 60_000 });
          if (!res.ok()) throw new Error(`다운로드 실패 ${res.status()} ${url}`);
          const body = await res.body();
          if (body.length > MAX_FILE) throw new Error('100MB가 넘는 파일은 내려받지 않습니다');
          const file = name || decodeURIComponent(new URL(res.url()).pathname.split('/').pop() || 'download');
          return ask({ op: 'file', name: String(file), base64: body.toString('base64') });
        },
      };
      await new vm.Script(`(async () => {\n${m.code}\n})()`, { filename: 'agent-script.js' }).runInContext(vm.createContext(sandbox));
    } catch (e) {
      error = String(e?.message || e).split('\n')[0].slice(0, 500);
    }
    // No browser.close(): exiting drops the CDP connection and leaves the app's browser running.
    process.send({ op: 'done', logs, error }, () => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = { toCsv, asText };
