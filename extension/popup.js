document.getElementById('openSidepanelBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && chrome.sidePanel && chrome.sidePanel.open) {
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
  }
});
