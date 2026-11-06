// Resizable sidebar (history) and agent panel: drag the dividers, double-click to reset.
// The page view is a native layer above the UI and would swallow the mouse, so it is hidden
// while a divider is dragged. Widths are remembered per user.
(() => {
  const { $, prefs, api } = ANB;
  const root = document.documentElement;
  const MIN_BROWSER = 420;
  const PANELS = {
    sidebar: { el: $('sidebarResizer'), css: '--sidebar-w', key: 'anb.sidebarW', def: 248, min: 180, max: 480, edge: 'left' },
    agent: { el: $('agentResizer'), css: '--agent-w', key: 'anb.agentW', def: 400, min: 340, max: 820, edge: 'right' },
  };

  const width = (p) => parseFloat(getComputedStyle(root).getPropertyValue(p.css)) || p.def;

  function clamp(p, w) {
    const other = p === PANELS.sidebar ? PANELS.agent : PANELS.sidebar;
    const room = window.innerWidth - width(other) - MIN_BROWSER;
    return Math.round(Math.max(p.min, Math.min(p.max, room, w)));
  }

  function apply(p, w, save) {
    root.style.setProperty(p.css, clamp(p, w) + 'px');
    if (save) prefs.set(p.key, String(width(p)));
  }

  for (const p of Object.values(PANELS)) {
    const saved = Number(prefs.get(p.key, ''));
    if (saved) apply(p, saved, false);

    p.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      p.el.setPointerCapture(e.pointerId);
      p.el.classList.add('active');
      document.body.classList.add('resizing');
      api.setResizing(true);
      const move = (ev) => apply(p, p.edge === 'left' ? ev.clientX : window.innerWidth - ev.clientX, false);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        p.el.removeEventListener('pointermove', move);
        p.el.classList.remove('active');
        document.body.classList.remove('resizing');
        apply(p, width(p), true);
        api.setResizing(false);
      };
      p.el.addEventListener('pointermove', move);
      p.el.addEventListener('pointerup', end, { once: true });
      p.el.addEventListener('lostpointercapture', end, { once: true });
    });
    p.el.addEventListener('dblclick', () => apply(p, p.def, true));
  }

  // Keep panels valid when the window shrinks.
  window.addEventListener('resize', () => {
    for (const p of Object.values(PANELS)) apply(p, width(p), false);
  });
})();
