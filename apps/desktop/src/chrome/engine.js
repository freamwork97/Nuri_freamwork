// "진짜 Chrome" browser engine (설정 > 일반 > 브라우저 엔진).
// ANB starts the user's installed Google Chrome (or Microsoft Edge) as a SEPARATE window with
// its own profile in ANB's data folder, and automates it over the DevTools protocol. Because it
// is the real browser, sites that refuse embedded browsers (Google sign-in) work normally; the
// user signs in there once and the profile keeps the session.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { t } = require('../i18n');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright-core');

const CANDIDATES = [
  ['Google Chrome', ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'], 'Google\\Chrome\\Application\\chrome.exe'],
  ['Microsoft Edge', ['PROGRAMFILES(X86)', 'PROGRAMFILES'], 'Microsoft\\Edge\\Application\\msedge.exe'],
];

/** The installed browser to use: { name, exe } or null. */
function findBrowser(env = process.env) {
  for (const [name, roots, rel] of CANDIDATES) {
    for (const root of roots) {
      const base = env[root];
      if (!base) continue;
      const exe = path.join(base, rel);
      if (fs.existsSync(exe)) return { name, exe };
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ChromeEngine extends EventEmitter {
  /**
   * @param {{profileDir: string, homeUrl: () => string, log: Function, port?: number}} opts
   */
  constructor({ profileDir, homeUrl, log, port, exe, name, extraArgs = [], startUrl } = {}) {
    super();
    // `exe`: the browser bundled with ANB (Nuri = Chrome for Testing + our extension).
    this.browserInfo = exe ? { name: name || 'Nuri', exe } : findBrowser();
    this.extraArgs = extraArgs;
    this.startUrl = startUrl || null; // e.g. the welcome page on the first start
    this.profileDir = profileDir;
    this.homeUrl = homeUrl || (() => 'https://www.naver.com');
    this.log = log || (() => {});
    this.fixedPort = port || null;
    this.port = null;
    this.proc = null;
    this.browser = null; // Playwright Browser (connectOverCDP)
    this.connecting = null;
  }

  available() {
    return !!this.browserInfo;
  }

  async alive() {
    if (!this.port) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Starts the browser window if it is not running. */
  async launch() {
    if (await this.alive()) return;
    if (!this.browserInfo) throw new Error(t('Chrome 또는 Edge가 설치되어 있지 않습니다'));
    this.port = this.fixedPort || (await freePort());
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${this.port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      ...this.extraArgs,
      // Start on a blank page and navigate after the automation connection is up: a first page
      // that is still loading can stall the connection on a brand-new profile.
      'about:blank',
    ];
    this.proc = spawn(this.browserInfo.exe, args, { detached: false, stdio: 'ignore', windowsHide: false });
    this.proc.on('exit', () => {
      this.proc = null;
      this.browser = null;
      this.emit('closed');
    });
    for (let i = 0; i < 60; i++) {
      if (await this.alive()) {
        this.log('chrome engine started', this.browserInfo.name, 'port', this.port);
        return;
      }
      await sleep(250);
    }
    throw new Error(t('{name}을(를) 시작하지 못했습니다', { name: this.browserInfo.name }));
  }

  /** Playwright connection to the browser (launching it when needed). */
  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.launch();
      // A brand-new profile (first start) can take a while before the browser answers.
      let browser;
      for (let attempt = 1; ; attempt++) {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, { timeout: 45_000 });
          break;
        } catch (e) {
          if (attempt >= 2 || !(await this.alive())) throw e;
          this.log('browser connect retry', e.message);
        }
      }
      browser.on('disconnected', () => {
        this.browser = null;
        this.emit('disconnected');
      });
      this.browser = browser;
      this.emit('connected', browser);
      return browser;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  context() {
    return this.browser?.contexts()[0] || null;
  }

  /** Closes ANB's browser window (on app exit). */
  async close() {
    try {
      if (this.browser?.isConnected()) {
        const cdp = await this.browser.newBrowserCDPSession();
        await cdp.send('Browser.close').catch(() => {});
      } else if (this.proc) this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { ChromeEngine, findBrowser };
