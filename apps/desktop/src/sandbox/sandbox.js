// "AI 작업 PC": a Windows Sandbox (built into Windows Pro) where computer use runs, so the agent's
// mouse and keyboard never collide with the user's own work.
//
// Layout (host side, in the app's userData/sandbox):
//   bin/  -> C:\anb     (read-only in the sandbox): anb-desktop.exe, start.ps1, token.txt
//   io/   -> C:\anb-io  (read-write): ip.txt written by the sandbox when the helper listens
//   WORKSPACE_DIR -> C:\work (read-write): the agent's work folder, visible on both sides
// The sandbox runs the helper with --listen; this process connects over TCP with the token and
// speaks the same JSON-lines protocol as the local helper (see desktop/helper.js).

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { t } = require('../i18n');

const PORT = 47321;
const BOOT_TIMEOUT_S = 480;
const SANDBOX_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The .wsb configuration for the AI 작업 PC. */
function wsbConfig({ binDir, ioDir, workDir, memoryMB = 4096 }) {
  const map = (host, guest, ro) => `    <MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${guest}</SandboxFolder><ReadOnly>${ro}</ReadOnly></MappedFolder>`;
  return `<Configuration>
  <Networking>Enable</Networking>
  <vGPU>Enable</vGPU>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <AudioInput>Disable</AudioInput>
  <VideoInput>Disable</VideoInput>
  <MemoryInMB>${memoryMB}</MemoryInMB>
  <MappedFolders>
${map(binDir, 'C:\\anb', 'true')}
${map(ioDir, 'C:\\anb-io', 'false')}
${map(workDir, 'C:\\work', 'false')}
  </MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\\anb\\start.ps1</Command></LogonCommand>
</Configuration>
`;
}

// Runs inside the sandbox at logon: allow the helper port, start the helper, report the address.
const START_PS1 = `$ErrorActionPreference = 'SilentlyContinue'
New-NetFirewallRule -DisplayName 'ANB helper' -Direction Inbound -Protocol TCP -LocalPort ${PORT} -Action Allow | Out-Null
Start-Process -FilePath 'C:\\anb\\anb-desktop.exe' -ArgumentList '--listen','${PORT}','C:\\anb\\token.txt' -WindowStyle Hidden
for ($i = 0; $i -lt 60; $i++) {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
  if ($ip) { break }
  Start-Sleep -Seconds 1
}
Set-Content -Path 'C:\\anb-io\\ip.txt' -Value $ip -Encoding ascii
`;

/** Helper client over TCP, with the same interface as DesktopHelper (available/start/call/stop). */
class RemoteHelper {
  constructor({ connect, log }) {
    this.connectInfo = connect; // async () => ({ host, port, token })
    this.log = log || (() => {});
    this.sock = null;
    this.ready = null;
    this.nextId = 1;
    this.waiting = new Map();
  }

  available() {
    return true;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const { host, port, token } = await this.connectInfo();
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host, port });
        this.sock = sock;
        let buf = '';
        let started = false;
        sock.setNoDelay(true);
        sock.setEncoding('utf8');
        sock.on('connect', () => sock.write(JSON.stringify({ token }) + '\n'));
        sock.on('data', (chunk) => {
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
            else w.reject(new Error(msg.error || 'helper error'));
          }
        });
        const fail = (err) => {
          if (!started) reject(err);
          for (const w of this.waiting.values()) {
            clearTimeout(w.timer);
            w.reject(new Error(t('AI 작업 PC와 연결이 끊겼습니다')));
          }
          this.waiting.clear();
          if (this.sock === sock) {
            this.sock = null;
            this.ready = null;
          }
        };
        sock.on('error', fail);
        sock.on('close', () => fail(new Error(t('AI 작업 PC 연결이 닫혔습니다 (토큰이 맞지 않거나 작업 PC가 꺼짐)'))));
      });
    })().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  async call(cmd, params = {}, timeoutMs = 15_000) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(t('AI 작업 PC 응답 없음 ({cmd})', { cmd })));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, cmd, ...params }) + '\n');
    });
  }

  stop() {
    this.sock?.destroy();
    this.sock = null;
    this.ready = null;
  }
}

class SandboxPC extends EventEmitter {
  /**
   * @param {{dir: string, helperExe: string, workDir: string, log?: Function}} opts
   */
  constructor({ dir, helperExe, workDir, log }) {
    super();
    this.dir = dir;
    this.binDir = path.join(dir, 'bin');
    this.ioDir = path.join(dir, 'io');
    this.helperExe = helperExe;
    this.workDir = workDir;
    this.log = log || (() => {});
    this.token = null;
    this.proc = null;
    this.helper = new RemoteHelper({ connect: () => this.ensure(), log: this.log });
  }

  /** Windows Sandbox is installed (Windows Pro/Enterprise with the feature turned on). */
  available() {
    return process.platform === 'win32' && fs.existsSync(SANDBOX_EXE);
  }

  /** Maps a host path under the work folder to the sandbox's C:\work path (else null). */
  guestPath(hostPath) {
    const rel = path.relative(path.resolve(this.workDir), path.resolve(hostPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return 'C:\\work\\' + rel.split(path.sep).join('\\');
  }

  readIp() {
    try {
      const ip = fs.readFileSync(path.join(this.ioDir, 'ip.txt'), 'ascii').trim();
      return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
    } catch {
      return null;
    }
  }

  async reachable(ip) {
    return new Promise((resolve) => {
      const s = net.connect({ host: ip, port: PORT });
      const done = (ok) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(1500, () => done(false));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
    });
  }

  /** Starts the AI 작업 PC if needed; resolves with the helper's address and token. */
  async ensure() {
    if (!this.available()) throw new Error(t('AI 작업 PC를 쓰려면 Windows 샌드박스 기능을 켜야 합니다 (Windows Pro, 설정 > 자동화 참고)'));
    // The sandbox outlives app restarts, so reuse the token it was started with.
    if (!this.token) {
      try {
        this.token = fs.readFileSync(path.join(this.binDir, 'token.txt'), 'ascii').trim() || null;
      } catch {}
    }
    const ip = this.readIp();
    if (this.token && ip && (await this.reachable(ip))) return { host: ip, port: PORT, token: this.token };
    // Windows runs only one sandbox at a time; another one (opened by the user) would block ours.
    if (this.otherSandboxRunning()) {
      throw new Error(t('다른 Windows 샌드박스 창이 이미 열려 있습니다. 그 창을 닫은 뒤 다시 시도해 주세요.'));
    }

    this.emit('state', { state: 'starting' });
    this.log('sandbox: starting');
    fs.mkdirSync(this.binDir, { recursive: true });
    fs.mkdirSync(this.ioDir, { recursive: true });
    fs.mkdirSync(this.workDir, { recursive: true });
    fs.rmSync(path.join(this.ioDir, 'ip.txt'), { force: true });
    this.token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(path.join(this.binDir, 'token.txt'), this.token, 'ascii');
    fs.copyFileSync(this.helperExe, path.join(this.binDir, 'anb-desktop.exe'));
    fs.writeFileSync(path.join(this.binDir, 'start.ps1'), '\uFEFF' + START_PS1, 'utf8');
    const wsb = path.join(this.dir, 'ai-work-pc.wsb');
    fs.writeFileSync(wsb, wsbConfig({ binDir: this.binDir, ioDir: this.ioDir, workDir: this.workDir }), 'utf8');
    this.proc = spawn(SANDBOX_EXE, [wsb], { detached: true, stdio: 'ignore' });
    this.proc.unref();

    // Booting takes ~30-60 s; the very first start also installs Windows updates (~5-7 min).
    for (let i = 0; i < BOOT_TIMEOUT_S; i++) {
      await sleep(1000);
      const now = this.readIp();
      if (now && (await this.reachable(now))) {
        this.log('sandbox: ready at', now);
        this.emit('state', { state: 'ready' });
        return { host: now, port: PORT, token: this.token };
      }
    }
    this.emit('state', { state: 'failed' });
    throw new Error(t('AI 작업 PC가 {n}분 안에 준비되지 않았습니다', { n: BOOT_TIMEOUT_S / 60 }));
  }

  /** True when a Windows Sandbox is running (only called when ours is not reachable). */
  otherSandboxRunning() {
    if (process.platform !== 'win32') return false;
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WindowsSandboxRemoteSession.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      return /WindowsSandboxRemoteSession/i.test(out);
    } catch {
      return false;
    }
  }

  stop() {
    this.helper.stop();
  }
}

module.exports = { SandboxPC, RemoteHelper, wsbConfig, START_PS1, PORT };
