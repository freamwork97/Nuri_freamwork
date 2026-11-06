// Client for the native helper: native/anb-desktop.exe on Windows (screenshots, UI Automation,
// mouse/keyboard) or native/mac/anb-desktop-mac on macOS (same protocol, background commands
// only; see native/mac/DesktopHelperMac.swift). One long-lived child process; JSON lines in both
// directions, matched by request id.

const path = require('node:path');
const { t } = require('../i18n');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { NATIVE_DIR } = require('../config');

const HELPER_EXE = path.join(NATIVE_DIR, 'anb-desktop.exe');
const MAC_HELPER = path.join(NATIVE_DIR, 'mac', 'anb-desktop-mac');

/** The helper binary for this platform, or null where there is none. */
function helperPath(platform = process.platform) {
  return platform === 'win32' ? HELPER_EXE : platform === 'darwin' ? MAC_HELPER : null;
}

class DesktopHelper {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.waiting = new Map();
  }

  available() {
    const file = helperPath();
    return !!file && fs.existsSync(file);
  }

  start() {
    if (this.ready) return this.ready;
    if (!this.available()) {
      return Promise.reject(new Error(process.platform === 'darwin'
        ? t('컴퓨터 제어 도우미(anb-desktop-mac)가 없습니다. apps/desktop/native/mac/build-mac.sh 로 빌드하세요.')
        : t('컴퓨터 제어 도우미(anb-desktop.exe)가 없습니다. apps/desktop/native/build.cmd 로 빌드하세요.')));
    }
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn(helperPath(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      let buf = '';
      let started = false;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            this.log('desktop helper: bad line', line.slice(0, 200));
            continue;
          }
          if (msg.ready && !started) {
            started = true;
            resolve();
            continue;
          }
          const w = this.waiting.get(msg.id);
          if (!w) continue;
          this.waiting.delete(msg.id);
          clearTimeout(w.timer);
          if (msg.ok) w.resolve(msg);
          else w.reject(new Error(msg.error || 'desktop helper error'));
        }
      });
      proc.stderr.on('data', (d) => this.log('desktop helper stderr', String(d).slice(0, 300)));
      const fail = (err) => {
        if (!started) reject(err);
        for (const w of this.waiting.values()) {
          clearTimeout(w.timer);
          w.reject(new Error(t('컴퓨터 제어 도우미가 종료되었습니다')));
        }
        this.waiting.clear();
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
      };
      proc.on('error', fail);
      proc.on('exit', (code) => fail(new Error(`desktop helper exited (${code})`)));
    });
    return this.ready;
  }

  async call(cmd, params = {}, timeoutMs = 15_000) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`desktop helper timeout (${cmd})`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...params }) + '\n');
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { DesktopHelper, HELPER_EXE, MAC_HELPER, helperPath };
