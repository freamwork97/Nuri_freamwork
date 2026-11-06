/**
 * Nuri - Background Service Worker
 * Manages SidePanel behavior, tab navigation, and AI automation bridges.
 */

// Enable opening SidePanel when clicking the extension action icon
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn('sidePanel.setPanelBehavior error:', err);
    });
  }
  console.log('[ANB Background] Extension installed and SidePanel configured.');
});

// Message listener for SidePanel / Content Script requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANB_NAVIGATE_TAB') {
    queryTargetTabs((tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.update(tabs[0].id, { url: message.url }, (updatedTab) => {
          sendResponse({ success: true, tabId: updatedTab?.id });
        });
      } else {
        chrome.tabs.create({ url: message.url }, (newTab) => {
          sendResponse({ success: true, tabId: newTab.id });
        });
      }
    });
    return true; // async sendResponse
  }

  if (message.type === 'ANB_GET_ACTIVE_TAB') {
    queryTargetTabs((tabs) => {
      sendResponse({ tab: tabs[0] || null });
    });
    return true;
  }

  if (message.type === 'ANB_CAPTURE_SNAPSHOT') {
    queryTargetTabs(async (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab?.id) {
        sendResponse({ error: 'No active tab' });
        return;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: extractPageAriaSnapshot
        });
        sendResponse({ success: true, snapshot: results[0]?.result });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (message.type === 'ANB_CLICK_ELEMENT') {
    queryTargetTabs(async (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab?.id) {
        sendResponse({ error: 'No active tab' });
        return;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: performClickBySelector,
          args: [message.selector, message.refText]
        });
        sendResponse({ success: true, result: results[0]?.result });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }

  if (message.type === 'ANB_FILL_INPUT') {
    queryTargetTabs(async (tabs) => {
      const activeTab = tabs[0];
      if (!activeTab?.id) {
        sendResponse({ error: 'No active tab' });
        return;
      }

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: performFillInput,
          args: [message.selector, message.text]
        });
        sendResponse({ success: true, result: results[0]?.result });
      } catch (err) {
        sendResponse({ error: err.message });
      }
    });
    return true;
  }
});

// In-page functions executed via chrome.scripting
function extractPageAriaSnapshot() {
  const elements = [];
  let refCount = 1;

  // 1. Detect CAPTCHA
  const textContent = document.body?.innerText || '';
  const hasCaptcha = /보안문자|로봇이 아닙니다|recaptcha|turnstile|hcaptcha/i.test(textContent) ||
                     !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="turnstile"], .g-recaptcha');

  // 2. Interactive elements
  const interactives = document.querySelectorAll('input:not([type="hidden"]), textarea, button, a[href], select');
  interactives.forEach((el) => {
    if (refCount > 30) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || window.getComputedStyle(el).display === 'none') return;

    const refId = `#ref${refCount++}`;
    el.setAttribute('data-anb-ref', refId);

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const name = el.getAttribute('name') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const text = (el.innerText || el.value || placeholder || ariaLabel || name || '').trim().replace(/\s+/g, ' ').slice(0, 50);

    elements.push({
      refId,
      tag,
      type,
      text,
      selector: el.id ? `#${el.id}` : (name ? `${tag}[name="${name}"]` : `[data-anb-ref="${refId}"]`)
    });
  });

  return {
    url: window.location.href,
    title: document.title,
    hasCaptcha,
    elements
  };
}

function performClickBySelector(selector, refText) {
  let target = selector ? document.querySelector(selector) : null;
  if (!target && refText) {
    const candidates = document.querySelectorAll('button, a, input[type="submit"], [role="button"]');
    for (const el of candidates) {
      if ((el.innerText || el.value || '').includes(refText)) {
        target = el;
        break;
      }
    }
  }

  if (target) {
    // Visual highlight feedback
    target.style.outline = '3px solid #00f0ff';
    target.style.boxShadow = '0 0 12px #00f0ff';
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      target.click();
    }, 200);
    return { success: true, clicked: target.tagName };
  }
  return { success: false, reason: 'Target element not found' };
}

function performFillInput(selector, text) {
  let target = selector ? document.querySelector(selector) : null;
  if (!target) {
    target = document.querySelector('input[type="text"], input[type="search"], input:not([type]), textarea');
  }

  if (target) {
    target.style.outline = '3px solid #a371f7';
    target.focus();
    target.value = text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));

    // If inside a form or search box, prepare submit
    const form = target.closest('form');
    return { success: true, filled: text, hasForm: !!form };
  }
  return { success: false, reason: 'Input target not found' };
}

// Find the active tab of the last focused *normal* browser window.
// The AI cockpit can run in its own app window, so "currentWindow" would point
// at the cockpit itself instead of the page the user wants automated.
function queryTargetTabs(callback) {
  chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] }, (win) => {
    const tab = win?.tabs?.find((t) => t.active);
    if (tab) return callback([tab]);
    chrome.tabs.query({ active: true, windowType: 'normal' }, (tabs) => callback(tabs || []));
  });
}
