// Window choreography while the AI drives the desktop:
//  - the main ANB window gets out of the way (minimized) and comes back for questions/approvals,
//  - a small always-on-top overlay shows what the AI is doing and has a stop button. It is
//    excluded from screen capture, never takes focus, and steps aside if the AI clicks under it,
//  - a global hotkey stops the run even when the mouse is busy.

const { getLang } = require('../i18n');
const path = require('node:path');
const { BrowserWindow, globalShortcut, screen, ipcMain } = require('electron');

const STOP_HOTKEY = 'Control+Alt+Q';
const OVERLAY = { width: 380, height: 92, margin: 16 };
const CURSOR = { width: 72, height: 60, tipX: 14, tipY: 12 }; // see ui/ai-cursor.html

function hwndOf(win) {
  if (!win || win.isDestroyed()) return 0;
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

class DesktopSession {
  constructor({ getMainWindow, onStop, log, settings }) {
    this.settings = settings; // 설정 > 자동화 > 컴퓨터 제어 중 창 최소화
    this.getMainWindow = getMainWindow;
    this.onStop = onStop;
    this.log = log || (() => {});
    this.overlay = null;
    this.active = false;
    ipcMain.on('overlay:stop', () => this.onStop());
  }

  begin({ background = false } = {}) {
    this.active = true;
    this.background = background; // background computer use: ANB stays where it is
    try {
      if (!globalShortcut.register(STOP_HOTKEY, () => this.onStop())) this.log('stop hotkey busy', STOP_HOTKEY);
    } catch (e) {
      this.log('stop hotkey failed', e.message);
    }
    this.showOverlay();
    if (this.minimizes()) this.getMainWindow()?.minimize();
  }

  minimizes() {
    if (this.background) return false; // nothing on the screen is touched: no need to get out of the way
    return this.settings ? this.settings.get('automation.minimizeDuringDesktop') !== false : true;
  }

  /** Bring ANB back so the user can answer a question or approve an action. */
  pause() {
    const win = this.getMainWindow();
    if (!win) return;
    // Background mode: never pull focus; the question shows in ANB and as a Windows notification.
    if (this.background) return win.flashFrame(true);
    win.restore();
    win.show();
    win.focus();
    this.overlay?.hide();
    this.hideCursor();
  }

  resume() {
    if (!this.active) return;
    this.getMainWindow()?.flashFrame(false);
    this.overlay?.showInactive();
    if (this.minimizes()) this.getMainWindow()?.minimize();
  }

  end() {
    this.active = false;
    globalShortcut.unregister(STOP_HOTKEY);
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    this.overlay = null;
    if (this.cursor && !this.cursor.isDestroyed()) this.cursor.destroy();
    this.cursor = null;
    const win = this.getMainWindow();
    if (win && this.background) {
      win.flashFrame(false); // the result waits in ANB; the user is not interrupted
    } else if (win) {
      win.restore();
      win.show();
      win.focus();
    }
  }

  status(text, kind = 'status') {
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send('overlay:status', { text, kind });
  }

  /** Native handles of our own windows (hidden from the AI's window list). */
  ownHandles() {
    return new Set([hwndOf(this.getMainWindow()), hwndOf(this.overlay), hwndOf(this.cursor)].filter(Boolean));
  }

  /**
   * The AI's own pointer (background mode): a click-through window that glides to where the AI
   * acts, separate from the user's mouse. `point` is in physical screen pixels (helper coords).
   */
  async cursorTo(point, { click = false } = {}) {
    if (!this.active || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const cur = this.ensureCursor();
    const dip = process.platform === 'win32' ? screen.screenToDipPoint({ x: point.x, y: point.y }) : point;
    const to = { x: Math.round(dip.x - CURSOR.tipX), y: Math.round(dip.y - CURSOR.tipY) };
    this.log('ai cursor', point.x, point.y, click ? 'click' : 'move');
    const [fx, fy] = cur.getPosition();
    if (!cur.isVisible()) {
      cur.setPosition(to.x, to.y);
      cur.showInactive();
    } else {
      // Glide there (ease-out) so the user can follow it.
      const frames = Math.max(6, Math.min(24, Math.round(Math.hypot(to.x - fx, to.y - fy) / 30)));
      for (let i = 1; i <= frames && !cur.isDestroyed(); i++) {
        const t = 1 - Math.pow(1 - i / frames, 3);
        cur.setPosition(Math.round(fx + (to.x - fx) * t), Math.round(fy + (to.y - fy) * t));
        await new Promise((r) => setTimeout(r, 16));
      }
    }
    if (click && !cur.isDestroyed()) cur.webContents.executeJavaScript('window.clickFx && window.clickFx()').catch(() => {});
  }

  hideCursor() {
    if (this.cursor && !this.cursor.isDestroyed()) this.cursor.hide();
  }

  ensureCursor() {
    if (this.cursor && !this.cursor.isDestroyed()) return this.cursor;
    const cur = new BrowserWindow({
      width: CURSOR.width,
      height: CURSOR.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    cur.setAlwaysOnTop(true, 'screen-saver');
    cur.setIgnoreMouseEvents(true); // the user's clicks pass straight through it
    cur.setContentProtection(true); // never in the AI's own screenshots
    cur.webContents.on('will-navigate', (e) => e.preventDefault());
    cur.loadFile(path.join(__dirname, '..', '..', 'ui', 'ai-cursor.html'));
    this.cursor = cur;
    return cur;
  }

  /**
   * Runs fn with the overlay hidden if any of the physical-pixel points fall under it, so the
   * AI's click reaches the app underneath.
   */
  async clearOf(points, fn) {
    const ov = this.overlay;
    if (!ov || ov.isDestroyed() || !ov.isVisible()) return fn();
    const r = screen.dipToScreenRect(ov, ov.getBounds());
    const pad = 8;
    const hit = points.some((p) => p && p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad);
    if (!hit) return fn();
    ov.hide();
    try {
      return await fn();
    } finally {
      if (this.active) setTimeout(() => this.active && !ov.isDestroyed() && ov.showInactive(), 400);
    }
  }

  showOverlay() {
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.showInactive();
      return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    const ov = new BrowserWindow({
      width: OVERLAY.width,
      height: OVERLAY.height,
      x: area.x + area.width - OVERLAY.width - OVERLAY.margin,
      y: area.y + area.height - OVERLAY.height - OVERLAY.margin,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    ov.setAlwaysOnTop(true, 'screen-saver');
    ov.setContentProtection(true); // invisible to screenshots, so the AI never sees or targets it
    ov.webContents.on('will-navigate', (e) => e.preventDefault());
    ov.loadFile(path.join(__dirname, '..', '..', 'ui', 'overlay.html'), { query: { lang: getLang() } });
    ov.once('ready-to-show', () => this.active && ov.showInactive());
    this.overlay = ov;
  }
}

module.exports = { DesktopSession, STOP_HOTKEY, hwndOf };
