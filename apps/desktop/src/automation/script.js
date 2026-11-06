// 스크립트 자동화: the browser agent may run a short Playwright script on its tab for repetitive or
// bulk work (many pages, many rows, many files) that would otherwise take dozens of model turns.
// The script runs in script-runner.js, a separate Node process under the permission model;
// this side starts it, saves the files it asks for (work folder or the user's folders only) and
// stops it on timeout or when the user stops the task.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runTool, resolveIn } = require('../agent/tools');
const { t } = require('../i18n');

const RUNNER = path.join(__dirname, 'script-runner.js');
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

/** Folders the runner may read: the app's own code and its modules. Nothing else. */
function readable() {
  const pkgRoot = (name) => path.dirname(require.resolve(`${name}/package.json`));
  return [path.join(__dirname, '..', '..', '..'), path.dirname(pkgRoot('playwright-core'))];
}

/** The CDP target id of a Playwright page (the runner attaches to the same tab). */
async function targetOf(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * @param {{code:string, seconds?:number}} action
 * @param {{page:any, port:number, workdir:string, userDirs?:string[], signal?:AbortSignal, log?:Function}} ctx
 * @returns {Promise<{summary:string, output:string}>}
 */
async function runScript(action, { page, port, workdir, userDirs, signal, log = () => {} }) {
  const code = String(action.code || '').trim();
  if (!code) return { summary: 'FAILED: script code is empty', output: '' };
  if (!port) return { summary: 'FAILED: this browser does not allow scripts', output: '' };
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(5_000, (Number(action.seconds) || 0) * 1000 || DEFAULT_TIMEOUT_MS));
  const targetId = await targetOf(page);
  const tmp = path.join(os.tmpdir(), 'anb-script');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  const args = ['--permission', ...[...readable(), tmp].map((d) => `--allow-fs-read=${path.join(d, '*')}`), `--allow-fs-write=${path.join(tmp, '*')}`, RUNNER];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  const saved = [];
  const t0 = Date.now();

  const result = await new Promise((resolve) => {
    let ended = false;
    const finish = (r) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ error: t('시간 초과 ({n}초)', { n: timeoutMs / 1000 }) }), timeoutMs);
    const onAbort = () => finish({ error: t('사용자가 작업을 중지했습니다') });
    signal?.addEventListener('abort', onAbort);
    child.on('error', (e) => finish({ error: e.message }));
    child.on('exit', (c) => finish({ error: `${t('스크립트 프로세스가 종료되었습니다 ({code})', { code: c })} ${stderr.trim().split('\n').pop() || ''}`.trim() }));
    child.on('message', async (m) => {
      if (m.op === 'done') return finish(m);
      try {
        let summary;
        if (m.op === 'save') {
          summary = (await runTool({ type: 'save_file', name: m.name, content: m.text }, { workdir, userDirs })).summary;
        } else if (m.op === 'file') {
          const file = resolveIn(workdir, m.name, { forWrite: true, userDirs });
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(m.base64, 'base64'));
          summary = `saved ${path.basename(file)} at ${file}`;
        } else throw new Error(`unknown request ${m.op}`);
        if (summary.startsWith('FAILED')) throw new Error(summary.slice(8));
        saved.push(summary);
        if (!ended) child.send({ reply: m.id, summary });
      } catch (e) {
        if (!ended) child.send({ reply: m.id, error: e.message });
      }
    });
    child.send({ port, targetId, code });
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log('script', result.error ? `failed: ${result.error}` : 'ok', `${secs}s`, `${saved.length} files`);
  const logs = String(result.logs || '').trim();
  const files = saved.length ? `\nFILES:\n${saved.join('\n')}` : '';
  const output = `SCRIPT OUTPUT (${action.title || 'script'}, ${secs}s):\n${logs || '(nothing logged)'}${files}${result.error ? `\nERROR: ${result.error}` : ''}`;
  const head = result.error ? `FAILED: script error: ${result.error}` : `script ran in ${secs}s`;
  return { summary: `${head}${saved.length ? `; ${saved.length} file(s) saved` : ''} (output shown below once)`, output };
}

module.exports = { runScript };
