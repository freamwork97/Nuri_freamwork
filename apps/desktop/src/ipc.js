// IPC between the UI renderer (ui/) and the main process. Inputs are validated because the
// renderer is the only trusted caller, but defensive checks keep mistakes from reaching the agent.
const path = require('node:path');
const { app, ipcMain, shell, dialog } = require('electron');
const { WORKSPACE_DIR, LOG_DIR, PROFILE } = require('./config');
const { SCHEMA } = require('./settings');
const { t } = require('./i18n');
const { resolveFiles, pathNote, saveBytes, MAX_FILES } = require('./attachments');

const PROVIDERS = new Set(['gemini', 'claude', 'gpt']);
const str = (v, max = 20_000) => String(v ?? '').slice(0, max);
const provider = (p) => (PROVIDERS.has(p) ? p : 'gemini');

/** Starts a task the way the composer does (also used by 예약 작업). */
function startTask(agent, settings, req = {}) {
  const goal = str(req.goal).trim();
  if (!goal) return;
  if (!agent.running) {
    agent.nextUnattended = req.scheduled === true; // 예약 작업: nobody may be there to answer
    agent.nextSchedule = req.scheduled === true ? req.id : null; // its tabs replace the ones of its last run
  }
  const quality = req.quality === 'accurate' ? 'accurate' : req.quality === 'fast' ? 'fast' : settings.get('general.defaultQuality');
  const { files, missing } = resolveFiles(req.attachments);
  if (missing.length) agent.emitEvent('note', { text: t('첨부 파일을 찾을 수 없어 제외했습니다: {files}', { files: missing.join(', ') }) });
  // Earlier tasks of the conversation on screen, so "그거", "어디까지 됐어?" make sense.
  const context = req.context ? `\n\n${t('[이 대화의 이전 작업 — 참고 자료]')}\n${str(req.context, 6000)}` : '';
  if (req.mode === 'assistant') return agent.assist(goal + context, provider(req.provider), { attachPage: !!req.attachPage, attachments: files });
  const task = goal + pathNote(files) + context;
  if (req.mode === 'desktop') agent.runDesktop(task, provider(req.provider), { quality });
  else if (req.mode === 'autopilot') agent.runAutopilot(task, provider(req.provider), { quality });
  else agent.run(task, provider(req.provider), { quality });
}

// Files that run code, or mount a disk that can, when Windows opens them: never opened from the
// workspace (downloads are untrusted), only shown in Explorer.
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|psd1|ps1xml|psc1|vbs|vbe|js|jse|wsf|wsh|ws|msi|msp|mst|msc|scr|lnk|pif|hta|cpl|jar|reg|url|inf|scf|sct|chm|hlp|appref-ms|application|gadget|xll|xlam|docm|xlsm|pptm|iso|img|vhd|vhdx|settingcontent-ms|library-ms|search-ms|diagcab|appx|appxbundle|msix|msixbundle)$/i;

function registerIpc({ tabs, agent, server, ensureServer, settings, schedules, getWindow, engineInfo, ipc = require('./host/router').makeRouter(ipcMain) }) {
  ipc.on('browser:bounds', (_e, b) => b && tabs.setBounds(b));
  ipc.on('browser:resizing', (_e, on) => tabs.setHidden(on === true, 'resize'));
  ipc.on('browser:covered', (_e, on) => tabs.setHidden(on === true, 'settings')); // settings page open
  // The UI window blocks every navigation it starts itself (main.js will-navigate), reloads too:
  // a reload it asks for is done from here.
  ipc.on('ui:reload', () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.reload();
  });
  ipc.on('browser:showChrome', () => tabs.show?.().catch(() => {}));

  // 설정 page
  ipc.handle('settings:get', () => ({
    values: settings.all(),
    options: Object.fromEntries(Object.entries(SCHEMA).filter(([, s]) => s.values).map(([k, s]) => [k, s.values])),
    info: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      profile: PROFILE || t('기본'),
      userData: app.getPath('userData'),
      workspace: WORKSPACE_DIR,
      downloads: app.getPath('downloads'),
      engine: engineInfo,
    },
  }));
  ipc.handle('settings:set', (_e, patch) => settings.update(patch && typeof patch === 'object' ? patch : {}));
  ipc.handle('settings:reset', () => settings.reset());
  ipc.handle('settings:pickFolder', async () => {
    const opts = { title: t('다운로드 폴더 선택'), properties: ['openDirectory', 'createDirectory'] };
    const w = getWindow();
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0] || null;
  });
  // 입력창 파일 첨부
  ipc.handle('files:pick', async () => {
    const opts = { title: t('첨부할 파일 선택'), properties: ['openFile', 'multiSelections'] };
    const w = getWindow();
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? [] : resolveFiles(r.filePaths.slice(0, MAX_FILES)).files;
  });
  ipc.handle('files:save', (_e, { name, data } = {}) => saveBytes(WORKSPACE_DIR, name, data));
  ipc.on('open:logs', () => shell.openPath(LOG_DIR));
  // Opens a web page in the user's default browser (https only), e.g. Google sign-in.
  ipc.on('open:external', (_e, url) => {
    const u = str(url, 2000);
    if (/^https:\/\/[^\s]+$/i.test(u)) shell.openExternal(u);
  });
  ipc.on('open:downloads', () => shell.openPath(settings.get('automation.downloadDir') || app.getPath('downloads')));
  ipc.on('tabs:new', (_e, url) => tabs.create(url ? str(url, 2000) : undefined, true));
  ipc.on('tabs:close', (_e, id) => tabs.close(Number(id)));
  let askingClose = false;
  ipc.on('tabs:requestClose', async (_e, id) => {
    const tabId = Number(id);
    if (!settings.get('general.confirmTabClose')) return tabs.close(tabId);
    if (askingClose) return;
    askingClose = true;
    try {
      const title = tabs.list().find((t) => t.id === tabId)?.title;
      const opts = { type: 'question', title: 'Nuri', message: t('이 탭을 닫을까요?'), detail: title || undefined, buttons: [t('닫기'), t('취소')], defaultId: 0, cancelId: 1, noLink: true, checkboxLabel: t('다시 묻지 않기') };
      const w = getWindow();
      const r = w ? await dialog.showMessageBox(w, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 0) return;
      if (r.checkboxChecked) settings.update({ 'general.confirmTabClose': false });
      tabs.close(tabId);
    } finally {
      askingClose = false;
    }
  });
  ipc.on('tabs:activate', (_e, id) => tabs.activate(Number(id)));
  ipc.on('nav:go', (_e, input) => tabs.go(str(input, 2000)));
  ipc.on('nav:back', () => {
    const wc = tabs.activeWebContents();
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  });
  ipc.on('nav:forward', () => {
    const wc = tabs.activeWebContents();
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  });
  ipc.on('nav:reload', () => tabs.activeWebContents()?.reload());
  ipc.on('nav:home', () => tabs.go(''));
  ipc.on('server:retry', () => ensureServer());

  ipc.on('agent:run', (_e, req = {}) => startTask(agent, settings, req));
  ipc.on('agent:stop', () => agent.stop('ui'));

  // 예약 작업
  ipc.handle('schedules:list', () => schedules.list());
  ipc.handle('schedules:save', (_e, item) => schedules.save(item && typeof item === 'object' ? item : {}));
  ipc.handle('schedules:remove', (_e, id) => schedules.remove(str(id, 64)));
  ipc.on('agent:answer', (_e, value) => agent.answer(typeof value === 'boolean' ? value : str(value, 4000)));

  ipc.handle('accounts:get', (_e, refresh) => server.request(`/v1/llm/accounts${refresh ? '?refresh=1' : ''}`));
  ipc.handle('caps:get', (_e, refresh) => server.request(`/v1/llm/capabilities${refresh ? '?refresh=1' : ''}`));
  ipc.handle('accounts:login', async (_e, p) => {
    const r = await server.request('/v1/llm/login', { method: 'POST', body: { provider: provider(p) } });
    // System browser: Google/OpenAI sign-in pages often refuse embedded browsers.
    if (r.url && /^https:\/\//i.test(r.url)) shell.openExternal(r.url);
    return r;
  });
  ipc.handle('accounts:code', (_e, { provider: p, code } = {}) =>
    server.request('/v1/llm/login/code', { method: 'POST', body: { provider: provider(p), code: str(code, 500) } }));
  ipc.handle('accounts:loginState', (_e, p) => server.request(`/v1/llm/login/state?provider=${provider(p)}`));
  ipc.on('open:workspace', () => shell.openPath(WORKSPACE_DIR));
  // Opens a file or folder the autopilot produced; only paths inside the workspace.
  ipc.on('open:path', (_e, p) => {
    const full = path.resolve(str(p, 1000));
    const rel = path.relative(WORKSPACE_DIR, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    // Downloaded files are untrusted: never launch programs or scripts from here.
    if (RUNNABLE.test(full)) return shell.showItemInFolder(full);
    shell.openPath(full);
  });
}

module.exports = {
  RUNNABLE, registerIpc, startTask };
