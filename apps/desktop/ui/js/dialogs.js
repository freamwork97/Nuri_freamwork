// Nuri's own question dialog, asked by the main process (src/ui-dialog.js): quit, close tab.
(() => {
  const { $, el, svg, api } = ANB;
  if (!api.onDialog) return; // side panel: the host shows system dialogs
  const box = $('appDialog');
  const ICONS = {
    quit: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v8"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/></svg>',
    busy: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    tab: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M9 13l6 4M15 13l-6 4"/></svg>',
  };
  let current = null;

  function finish(response) {
    if (!current) return;
    const { id } = current;
    const checked = !!box.querySelector('.app-dialog-check input')?.checked;
    current = null;
    box.close();
    api.answerDialog(id, response, checked);
  }

  api.onDialog((q) => {
    if (current) finish(current.cancelId ?? current.buttons.length - 1); // one at a time
    current = q;
    const icon = el('div', 'app-dialog-icon ' + (q.icon || 'quit'));
    icon.append(svg(ICONS[q.icon] || ICONS.quit));
    const text = el('div', 'app-dialog-text');
    text.append(el('h2', 'app-dialog-title', q.title));
    if (q.message) text.append(el('p', 'app-dialog-message', q.message));
    if (q.detail) text.append(el('p', 'app-dialog-detail', q.detail));
    const head = el('div', 'app-dialog-head');
    head.append(icon, text);
    const parts = [head];
    if (q.checkbox) {
      const label = el('label', 'app-dialog-check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      label.append(input, document.createTextNode(q.checkbox));
      parts.push(label);
    }
    const actions = el('div', 'app-dialog-actions');
    // Shown left to right as: cancel-like buttons first, the main choice last.
    const order = q.buttons.map((b, i) => ({ ...b, i })).sort((a, b) => (a.i === q.cancelId ? -1 : b.i === q.cancelId ? 1 : (a.style === 'primary') - (b.style === 'primary')));
    for (const b of order) {
      const btn = el('button', b.style === 'primary' ? 'btn-primary' : b.style === 'danger' ? 'btn-danger' : 'btn-ghost', b.label);
      btn.type = 'button';
      btn.onclick = () => finish(b.i);
      if (b.i === (q.defaultId ?? 0)) btn.dataset.default = 'true';
      actions.append(btn);
    }
    parts.push(actions);
    box.replaceChildren(...parts);
    box.showModal();
    box.querySelector('[data-default="true"]')?.focus();
  });

  // Esc or a click outside the card: cancel.
  box.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (current) finish(current.cancelId ?? current.buttons.length - 1);
  });
  box.addEventListener('mousedown', (e) => {
    if (e.target === box && current) finish(current.cancelId ?? current.buttons.length - 1);
  });
})();
