// window.anb for the agent side panel: the same API as the desktop app's preload, carried over a
// local WebSocket to the ANB host (127.0.0.1, per-run token from host.json). Loaded before the
// UI scripts, so ANB's UI code runs unchanged inside the browser.
(() => {
  // Text in the interface language (ui/js/i18n.js loads after this file, so look it up late).
  const tr = (ko) => (window.NURI_I18N ? window.NURI_I18N.t(ko) : ko);
  const listeners = new Map(); // channel -> Set<cb>
  // State channels remember their last value: the connection can come up before the UI scripts
  // have registered their listeners, so a late listener gets the current state right away.
  const STICKY = new Set(['browser:engine', 'server:state', 'tabs:state', 'settings:changed']);
  const last = new Map();
  const pending = new Map(); // invoke id -> {resolve, reject}
  const queue = [];
  let ws = null;
  let nextId = 1;
  let retry = 0;

  function connected() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  function post(msg) {
    if (connected()) ws.send(JSON.stringify(msg));
    else queue.push(msg);
  }

  function emit(channel, payload) {
    if (STICKY.has(channel)) last.set(channel, payload);
    for (const cb of listeners.get(channel) || []) {
      try {
        cb(payload);
      } catch (e) {
        console.error(e);
      }
    }
  }

  async function connect() {
    let host;
    try {
      host = await (await fetch(chrome.runtime.getURL('host.json'), { cache: 'no-store' })).json();
    } catch {
      return setTimeout(connect, 1500);
    }
    ws = new WebSocket(`ws://127.0.0.1:${host.port}/?token=${encodeURIComponent(host.token)}`);
    ws.onopen = () => {
      retry = 0;
      emit('server:state', { state: 'checking' });
      while (queue.length && connected()) ws.send(JSON.stringify(queue.shift()));
      post({ t: 'send', ch: 'ui:focus', args: [document.hasFocus()] });
    };
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.t === 'event') emit(msg.ch, msg.payload);
      else if (msg.t === 'result' && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
      }
    };
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error(tr('Nuri 호스트와 연결이 끊겼습니다')));
      pending.clear();
      emit('server:state', { state: 'error', message: tr('호스트 연결 끊김 — 다시 연결 중') });
      setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
    };
  }

  const send = (ch, ...args) => post({ t: 'send', ch, args });
  const invoke = (ch, ...args) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ t: 'invoke', id, ch, args });
    });
  const listen = (ch) => (cb) => {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    listeners.get(ch).add(cb);
    if (last.has(ch)) setTimeout(() => cb(last.get(ch)), 0);
    return () => listeners.get(ch).delete(cb);
  };

  window.anb = {
    panel: true, // UI runs in the browser side panel (no embedded page view)
    // browser
    setBrowserBounds: () => {},
    setResizing: () => {},
    setBrowserCovered: () => {},
    // settings
    getSettings: () => invoke('settings:get'),
    setSettings: (patch) => invoke('settings:set', patch),
    resetSettings: () => invoke('settings:reset'),
    pickFolder: () => invoke('settings:pickFolder'),
    pickFiles: () => invoke('files:pick'),
    saveFile: (name, data) => invoke('files:save', { name, data }),
    openLogs: () => send('open:logs'),
    openExternal: (url) => send('open:external', url),
    showChrome: () => send('browser:showChrome'),
    onEngine: listen('browser:engine'),
    onLoginBlocked: listen('browser:loginBlocked'),
    googleLogin: () => send('google:login'),
    openDownloads: () => send('open:downloads'),
    onSettings: listen('settings:changed'),
    newTab: (url) => send('tabs:new', url),
    closeTab: (id) => send('tabs:close', id),
    requestCloseTab: (id) => send('tabs:requestClose', id),
    activateTab: (id) => send('tabs:activate', id),
    go: (input) => send('nav:go', input),
    back: () => send('nav:back'),
    forward: () => send('nav:forward'),
    reload: () => send('nav:reload'),
    home: () => send('nav:home'),
    // agent
    runAgent: (req) => send('agent:run', req),
    stopAgent: () => send('agent:stop'),
    answerAgent: (value) => send('agent:answer', value),
    listSchedules: () => invoke('schedules:list'),
    saveSchedule: (item) => invoke('schedules:save', item),
    removeSchedule: (id) => invoke('schedules:remove', id),
    onSchedules: listen('schedules:changed'),
    onScheduleRun: listen('schedule:run'),
    // engine / accounts
    retryServer: () => send('server:retry'),
    getAccounts: (refresh) => invoke('accounts:get', refresh),
    getCapabilities: (refresh) => invoke('caps:get', refresh),
    login: (provider) => invoke('accounts:login', provider),
    submitLoginCode: (provider, code) => invoke('accounts:code', { provider, code }),
    loginState: (provider) => invoke('accounts:loginState', provider),
    openWorkspace: () => send('open:workspace'),
    openPath: (p) => send('open:path', p),
    // events
    onTabs: listen('tabs:state'),
    onServer: listen('server:state'),
    onAgent: listen('agent:event'),
  };

  // The host only sends Windows notifications while the panel is not being looked at.
  window.addEventListener('focus', () => send('ui:focus', true));
  window.addEventListener('blur', () => send('ui:focus', false));
  document.documentElement.classList.add('panel');
  connect();
})();
