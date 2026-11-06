// Automatic downloads for the browser partition: no "Save as" dialog (it would block the agent),
// files go to the user's Downloads folder (or the running project's folder) with unique names,
// and the agent is told where each file landed.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { log } = require('./logger');

class Downloads {
  constructor({ settings } = {}) {
    this.settings = settings; // 설정 > 자동화 > 다운로드 폴더 ('' = Windows Downloads)
    this.targetDir = null; // project folder while an autopilot task runs
    this.items = []; // { path, name, state, startedAt, doneAt }
  }

  attach(ses) {
    ses.on('will-download', (_e, item) => {
      const dir = this.targetDir || this.settings?.get('automation.downloadDir') || app.getPath('downloads');
      fs.mkdirSync(dir, { recursive: true });
      const file = uniquePath(dir, sanitize(item.getFilename() || 'download'));
      item.setSavePath(file);
      const rec = { path: file, name: path.basename(file), state: 'progressing', startedAt: Date.now(), doneAt: 0 };
      this.items.push(rec);
      if (this.items.length > 100) this.items.shift();
      item.once('done', (_ev, state) => {
        rec.state = state; // completed | cancelled | interrupted
        rec.doneAt = Date.now();
        log('download', state, file);
      });
    });
  }

  folder() {
    return this.targetDir || this.settings?.get('automation.downloadDir') || app.getPath('downloads');
  }

  // Real-Chrome engine: Chrome saves into a staging folder under a GUID name ("allowAndName");
  // when it completes the file is moved to the current folder with its real, unique name.
  chromeBegin({ guid, suggestedFilename }) {
    const rec = { guid, path: '', name: sanitize(suggestedFilename || 'download'), state: 'progressing', startedAt: Date.now(), doneAt: 0 };
    this.items.push(rec);
    if (this.items.length > 100) this.items.shift();
  }

  chromeProgress({ guid, state }, stagingDir) {
    const rec = this.items.find((d) => d.guid === guid);
    if (!rec || state === 'inProgress') return;
    rec.doneAt = Date.now();
    if (state !== 'completed') {
      rec.state = 'cancelled';
      return;
    }
    try {
      const dir = this.folder();
      fs.mkdirSync(dir, { recursive: true });
      const file = uniquePath(dir, rec.name);
      try {
        fs.renameSync(path.join(stagingDir, guid), file);
      } catch {
        fs.copyFileSync(path.join(stagingDir, guid), file); // staging on another drive
        fs.rmSync(path.join(stagingDir, guid), { force: true });
      }
      rec.path = file;
      rec.name = path.basename(file);
      rec.state = 'completed';
      log('download completed', file);
    } catch (e) {
      rec.state = 'interrupted';
      log('download move failed', e.message);
    }
  }

  /** Downloads that started after `since` (ms). Waits briefly for running ones to finish. */
  async since(since, waitMs = 15_000) {
    const list = () => this.items.filter((d) => d.startedAt >= since);
    const deadline = Date.now() + waitMs;
    while (list().some((d) => d.state === 'progressing') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
    return list();
  }
}

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180);
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let file = path.join(dir, name);
  for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${base} (${i})${ext}`);
  return file;
}

module.exports = { Downloads, sanitize, uniquePath };
