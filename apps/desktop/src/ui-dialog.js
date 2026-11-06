// Questions to the user in the app's own dialog (ui/js/dialogs.js), styled like the rest of Nuri.
// When the window cannot show it (hidden in the tray, still loading, side-panel mode), the
// system message box is used instead, so a question is never lost.
//
// ask({ icon, title, message, detail, buttons: [{ label, style }], defaultId, cancelId, checkbox })
//   -> { response: button index, checked: checkbox state }
// style: 'primary' | 'danger' | 'ghost'; icon: 'quit' | 'busy' | 'tab'

const { ipcMain, dialog } = require('electron');

function createUiDialog({ getWindow, tabs }) {
  let seq = 0;
  const waiting = new Map();

  ipcMain.on('dialog:answer', (e, a) => {
    const win = getWindow();
    if (!win || e.sender !== win.webContents) return; // only the app's own UI may answer
    const done = waiting.get(a?.id);
    if (!done) return;
    waiting.delete(a.id);
    done({ response: Number(a.response), checked: !!a.checked });
  });

  async function systemDialog(win, o) {
    const opts = {
      type: 'question',
      title: 'Nuri',
      message: o.message ? `${o.title}\n\n${o.message}` : o.title,
      detail: o.detail || undefined,
      buttons: o.buttons.map((b) => b.label),
      defaultId: o.defaultId ?? 0,
      cancelId: o.cancelId ?? o.buttons.length - 1,
      noLink: true,
      checkboxLabel: o.checkbox || undefined,
    };
    const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return { response: r.response, checked: r.checkboxChecked };
  }

  return async function ask(o) {
    const win = getWindow();
    const canShow = win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !win.webContents.isLoading();
    if (!canShow) return systemDialog(win, o);
    const id = ++seq;
    // The page view is a native layer above the UI: hide it while the dialog is open.
    tabs.setHidden(true, 'dialog');
    try {
      return await new Promise((resolve) => {
        waiting.set(id, resolve);
        win.webContents.send('dialog:ask', { id, ...o });
        // The UI went away (reload, crash) before answering: treat as cancel.
        const gone = () => waiting.has(id) && (waiting.delete(id), resolve({ response: o.cancelId ?? o.buttons.length - 1, checked: false }));
        win.webContents.once('did-start-loading', gone);
        win.webContents.once('render-process-gone', gone);
      });
    } finally {
      tabs.setHidden(false, 'dialog');
    }
  };
}

module.exports = { createUiDialog };
