// Nuri: the agent lives in the browser's side panel (toolbar icon or Alt+Shift+A).
// On first start a welcome tab offers a button that opens it (side panels need a user gesture).

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'anb:openPanel') {
    const windowId = sender.tab?.windowId;
    chrome.sidePanel.open(windowId ? { windowId } : {}).then(() => reply({ ok: true }), (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
  return false;
});
