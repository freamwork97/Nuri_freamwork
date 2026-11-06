// Narrow, typed bridge between the UI renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('anb', {
  // interface language ('ko' | 'en'), 설정 > 화면 > 언어; the UI reloads when it changes
  lang: ipcRenderer.sendSync('i18n:lang'),
  // browser
  setBrowserBounds: (rect) => ipcRenderer.send('browser:bounds', rect),
  setResizing: (on) => ipcRenderer.send('browser:resizing', !!on), // hides the page view while a divider is dragged
  setBrowserCovered: (on) => ipcRenderer.send('browser:covered', !!on), // hides the page view while 설정 is open
  // settings (설정)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  reloadUi: () => ipcRenderer.send('ui:reload'), // redraws the UI (language change); the page itself may not navigate
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  pickFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  openLogs: () => ipcRenderer.send('open:logs'),
  openExternal: (url) => ipcRenderer.send('open:external', url), // https only, user's default browser
  showChrome: () => ipcRenderer.send('browser:showChrome'), // real-Chrome engine: bring its window forward
  onEngine: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on('browser:engine', handler);
    return () => ipcRenderer.removeListener('browser:engine', handler);
  },
  onLoginBlocked: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on('browser:loginBlocked', handler);
    return () => ipcRenderer.removeListener('browser:loginBlocked', handler);
  },
  googleLogin: () => ipcRenderer.send('google:login'),
  openInChromium: (url) => ipcRenderer.send('browser:openChromium', url),
  openDownloads: () => ipcRenderer.send('open:downloads'),
  onSettings: (cb) => {
    const handler = (_e, v) => cb(v);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },
  newTab: (url) => ipcRenderer.send('tabs:new', url),
  closeTab: (id) => ipcRenderer.send('tabs:close', id),
  requestCloseTab: (id) => ipcRenderer.send('tabs:requestClose', id), // asks first (설정 > 일반)
  activateTab: (id) => ipcRenderer.send('tabs:activate', id),
  go: (input) => ipcRenderer.send('nav:go', input),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  home: () => ipcRenderer.send('nav:home'),
  // files attached in the composer: [{ path, name, size }]
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  saveFile: (name, data) => ipcRenderer.invoke('files:save', { name, data }), // base64, for pasted images
  pathForFile: (file) => webUtils.getPathForFile(file), // dropped files; '' when the file has no path
  // agent: { goal, provider, mode: 'browser'|'assistant'|'desktop'|'autopilot', quality: 'fast'|'accurate', attachPage, attachments }
  runAgent: (req) => ipcRenderer.send('agent:run', req),
  stopAgent: () => ipcRenderer.send('agent:stop'),
  answerAgent: (value) => ipcRenderer.send('agent:answer', value), // string or boolean (confirm)
  // 예약 작업: { id?, goal, mode, provider, quality, repeat: once|daily|weekdays|weekly, time 'HH:MM', day?, date?, enabled }
  listSchedules: () => ipcRenderer.invoke('schedules:list'),
  saveSchedule: (item) => ipcRenderer.invoke('schedules:save', item),
  removeSchedule: (id) => ipcRenderer.invoke('schedules:remove', id),
  onSchedules: listen('schedules:changed'),
  onScheduleRun: listen('schedule:run'),
  // engine / accounts
  retryServer: () => ipcRenderer.send('server:retry'),
  getAccounts: (refresh) => ipcRenderer.invoke('accounts:get', refresh),
  getCapabilities: (refresh) => ipcRenderer.invoke('caps:get', refresh),
  login: (provider) => ipcRenderer.invoke('accounts:login', provider),
  submitLoginCode: (provider, code) => ipcRenderer.invoke('accounts:code', { provider, code }),
  loginState: (provider) => ipcRenderer.invoke('accounts:loginState', provider),
  openWorkspace: () => ipcRenderer.send('open:workspace'),
  openPath: (p) => ipcRenderer.send('open:path', p), // workspace files/folders only
  // events
  onTabs: listen('tabs:state'),
  onServer: listen('server:state'),
  onAgent: listen('agent:event'),
});
