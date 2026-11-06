// Task history persisted in localStorage: goal, status, settings, pin flag and full transcript.
(() => {
  const KEY = 'anb.history.v1';
  // 설정 > 일반 > 작업 기록 보관 개수 (default 50).
  const maxUnpinned = () => Number(ANB.state.settings?.['general.historyLimit']) || 50;
  const MAX_LOG_ITEMS = 300;
  const MAX_TEXT = 6000;

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  }

  function save(list) {
    // Pinned tasks are never trimmed; unpinned history keeps the latest MAX_UNPINNED.
    const pinned = list.filter((h) => h.pinned);
    const rest = list.filter((h) => !h.pinned).slice(0, maxUnpinned());
    try {
      localStorage.setItem(KEY, JSON.stringify([...pinned, ...rest]));
    } catch {
      // Quota exceeded: drop the oldest transcripts and retry once.
      for (const h of rest.slice(10)) delete h.log;
      try {
        localStorage.setItem(KEY, JSON.stringify([...pinned, ...rest]));
      } catch {
        /* give up silently: history is a convenience */
      }
    }
  }

  function get(id) {
    return load().find((h) => h.id === id) || null;
  }

  function add(entry) {
    const list = load();
    list.unshift(entry);
    save(list);
  }

  function update(id, patch) {
    const list = load();
    const item = list.find((h) => h.id === id);
    if (item) Object.assign(item, patch);
    save(list);
  }

  function remove(id) {
    save(load().filter((h) => h.id !== id));
  }

  function appendLog(id, item) {
    const list = load();
    const h = list.find((x) => x.id === id);
    if (!h) return;
    const copy = { ...item };
    for (const k of ['text', 'thought', 'body']) if (typeof copy[k] === 'string') copy[k] = copy[k].slice(0, MAX_TEXT);
    (h.log = h.log || []).push(copy);
    if (h.log.length > MAX_LOG_ITEMS) h.log.splice(1, h.log.length - MAX_LOG_ITEMS);
    save(list);
  }

  function clearUnpinned() {
    save(load().filter((h) => h.pinned));
  }

  ANB.store = { load, get, add, update, remove, appendLog, clearUnpinned };
})();
