/**
 * Nuri - In-page Content Script
 * Displays live AI automation overlay badges and visual highlights.
 */

window.__ANB_INSTALLED = true;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ANB_SHOW_STATUS') {
    showAgentBanner(msg.text);
    sendResponse({ ok: true });
  }
});

function showAgentBanner(text) {
  let banner = document.getElementById('__anb_agent_banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = '__anb_agent_banner';
    banner.style.cssText = `
      position: fixed;
      top: 16px;
      right: 16px;
      background: rgba(13, 17, 23, 0.95);
      border: 1px solid #58a6ff;
      border-radius: 8px;
      color: #e6edf3;
      padding: 10px 16px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      z-index: 2147483647;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s ease;
    `;
    document.body.appendChild(banner);
  }

  banner.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:#2ea043;border-radius:50%;animation:anb_pulse 1s infinite"></span> <span>${text}</span>`;
  banner.style.display = 'flex';

  clearTimeout(banner._timeout);
  banner._timeout = setTimeout(() => {
    banner.style.display = 'none';
  }, 4000);
}
