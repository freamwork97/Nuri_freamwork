// Shared helpers and UI state. Loaded first; other modules attach to window.ANB.
window.ANB = (() => {
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // Static, trusted SVG markup only (never page or model content).
  function svg(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  }

  const prefs = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage unavailable: preferences are optional */
      }
    },
  };

  const state = {
    tabs: [],
    activeTabId: null,
    serverReady: false,
    running: false,
    awaiting: null, // null | 'ask' | 'confirm'
    currentTask: null, // id of the task that is running / last run
    viewingTask: null, // id of the task shown in the conversation
    mode: 'browser', // 'browser' | 'desktop' | 'autopilot' | 'assistant'
    quality: 'fast', // 'fast' | 'accurate'
    attachPage: false,
    attachments: [], // files attached in the composer: { path, name, size }
    thread: null, // id of the conversation on screen; tasks in it stay on screen together
    replay: false, // a past task opened from the list is on screen
  };

  const { t, lang, locale, translate } = window.NURI_I18N;
  return { $, el, svg, prefs, state, api: window.anb, t, lang, locale, translate };
})();
