// The Google session of the bundled Chromium (the profile the login window uses). Google trusts this
// browser, but asks "verify it's you" again and again for cookies copied into the app, so tasks
// like a YouTube upload run here. Chrome keeps and rotates the session itself in this profile;
// check() opens it once a day so an unused session does not expire unnoticed.
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { ChromeEngine } = require('./chrome/engine');
const { ChromeTabs } = require('./chrome/tabs');
const { t } = require('./i18n');

const CHECK_EVERY_MS = 24 * 60 * 60_000;
const CHECK_URL = 'https://studio.youtube.com/';
const OFF_SCREEN = '--window-position=-32000,-32000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GoogleBrowser extends EventEmitter {
  /**
   * @param {{exe: string, profileDir: string, stateFile: string, settings: any, downloads?: any,
   *   loginOpen: () => boolean, agentBusy: () => boolean, log?: Function, now?: () => number}} opts
   */
  constructor({ exe, profileDir, stateFile, settings, downloads, loginOpen, agentBusy, log = () => {}, now = () => Date.now() }) {
    super();
    Object.assign(this, { exe, profileDir, stateFile, settings, downloads, loginOpen, agentBusy, log, now });
    this.settleMs = 8000;
    this.shown = null; // why the real window is on screen: 'sign-in', 'user', or null (out of sight)
    this.checking = null; // the daily check in progress
    this.engine = null;
    this.tabs = null;
  }

  newEngine(extraArgs) {
    return new ChromeEngine({ exe: this.exe, name: t('Google 세션'), profileDir: this.profileDir, log: this.log, extraArgs: ['--disable-extensions', ...extraArgs] });
  }

  /** The browser window for a task; stays open with its tabs until the user or the app closes it. */
  async open() {
    await this.checking; // Chrome allows one browser per profile
    if (this.engine && this.tabs) {
      await this.engine.connect();
      return this.tabs;
    }
    if (this.loginOpen()) throw new Error(t('Google 로그인 창을 닫은 뒤 다시 시도하세요'));
    // The window works out of sight; the app shows it in a tab (see startLive). Sign-in and
    // verification are never done through that picture: for those the real window comes forward.
    const engine = this.newEngine([OFF_SCREEN, '--window-size=1280,860', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']);
    engine.on('closed', () => {
      if (this.engine !== engine) return;
      this.engine = null;
      this.tabs = null;
      this.live = null;
      this.shown = null;
      this.emit('closed');
    });
    this.engine = engine;
    this.tabs = new ChromeTabs({ engine, settings: this.settings, log: this.log, downloads: this.downloads });
    await engine.connect(); // the tabs attach themselves on 'connected'
    this.tabs.on('change', () => this.follow());
    this.emit('opened');
    return this.tabs;
  }

  async close() {
    const engine = this.engine;
    this.engine = null;
    this.tabs = null;
    this.live = null;
    this.shown = null;
    await engine?.close().catch(() => {});
  }

  /** Opens a page for the user in this browser (a site the app's tabs cannot get past). */
  async openPage(url) {
    const tabs = await this.open();
    await tabs.create(url, true);
  }

  /** Keeps the live picture on the tab in front; a Google sign-in page brings the real window forward. */
  follow() {
    const entry = this.tabs?.tabs.get(this.tabs.activeId);
    if (!entry) return;
    this.emit('page', { title: entry.title, url: entry.url });
    const signingIn = /^https:\/\/accounts\.google\.com\//i.test(entry.url);
    // Only the window sign-in brought up goes away by itself: the user may be working in the others.
    if (signingIn && !this.shown) this.show('sign-in').catch(() => {});
    else if (!signingIn && this.shown === 'sign-in') this.hide().catch(() => {});
    if (this.live?.page !== entry.page) this.startLive(entry.page).catch((e) => this.log('live view failed', e.message));
  }

  async startLive(page) {
    const previous = this.live;
    const cdp = await page.context().newCDPSession(page);
    this.live = { page, cdp };
    await previous?.cdp.send('Page.stopScreencast').catch(() => {});
    await previous?.cdp.detach().catch(() => {});
    cdp.on('Page.screencastFrame', (f) => {
      this.emit('frame', f.data);
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 860 });
  }

  async placeWindow(left, top) {
    const page = this.tabs?.tabs.get(this.tabs.activeId)?.page;
    if (!page) return;
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top } });
    await cdp.detach().catch(() => {});
  }

  /** The real window, for what only the user can do (sign-in, verification, human checks). */
  async show(why = 'user') {
    this.shown = why;
    await this.placeWindow(120, 60);
    await this.tabs?.tabs.get(this.tabs.activeId)?.page.bringToFront();
  }

  async hide() {
    this.shown = null;
    await this.placeWindow(-32000, -32000);
  }

  readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /** The daily session check: skipped while anything uses the profile or before anyone signed in. */
  async check() {
    if (this.engine || this.loginOpen() || this.agentBusy() || !fs.existsSync(this.profileDir)) return null;
    const state = this.readState();
    if (this.now() - (state.at || 0) < CHECK_EVERY_MS) return null;
    const run = this.runCheck(state);
    this.checking = run.finally(() => (this.checking = null));
    return run;
  }

  async runCheck(state) {
    const engine = this.newEngine([OFF_SCREEN, '--window-size=900,700']);
    this.engine = engine;
    try {
      const browser = await engine.connect();
      const ctx = browser.contexts()[0];
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(this.settleMs); // let the page refresh its cookies
      // Only the sign-in page means signed out: an account without a channel leaves the studio too.
      const ok = !/^https:\/\/accounts\.google\.com\//i.test(page.url());
      const signedIn = ok || !!state.signedIn;
      fs.writeFileSync(this.stateFile, JSON.stringify({ at: this.now(), ok, signedIn }));
      this.log('google session check', ok ? 'ok' : 'signed out');
      if (!ok && signedIn) this.emit('expired'); // a profile that never signed in has nothing to expire
      return ok;
    } catch (e) {
      this.log('google session check failed', e.message);
      return null;
    } finally {
      await engine.close().catch(() => {});
      if (this.engine === engine) this.engine = null;
    }
  }
}

module.exports = { GoogleBrowser };
