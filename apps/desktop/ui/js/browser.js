// Tab strip, toolbar and the browser area placeholder (whose bounds the main process follows).
(() => {
  const { $, el, svg, api, state, t } = ANB;
  const CLOSE_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const slot = $('browserSlot');
  function reportBounds() {
    // Inside the card's border: the page view is a native layer with its own rounded corners.
    const r = slot.getBoundingClientRect();
    api.setBrowserBounds({ x: r.left + slot.clientLeft, y: r.top + slot.clientTop, width: slot.clientWidth, height: slot.clientHeight });
  }
  new ResizeObserver(reportBounds).observe(slot);
  window.addEventListener('resize', reportBounds);
  reportBounds();

  function favicon(tab) {
    if (tab.loading) return el('span', 'spin');
    if (!tab.favicon) return el('span', 'fav');
    const img = document.createElement('img');
    img.src = tab.favicon;
    img.alt = '';
    img.onerror = () => img.replaceWith(el('span', 'fav'));
    return img;
  }

  function renderTabs() {
    const box = $('tabs');
    box.replaceChildren(
      ...state.tabs.map((info) => {
        const tab = el('div', 'tab' + (info.id === state.activeTabId ? ' active' : ''));
        tab.title = info.title;
        const close = el('button', 'close');
        close.append(svg(CLOSE_ICON));
        close.title = t('탭 닫기');
        // On press, not click: pressing a tab activates it and redraws the strip, and a click
        // whose button was replaced between press and release never arrives.
        close.onmousedown = (e) => {
          e.stopPropagation();
          if (e.button === 0) api.requestCloseTab(info.id);
        };
        tab.append(favicon(info), el('span', 'title', info.title || t('새 탭')), close);
        tab.onmousedown = (e) => {
          if (e.button === 1) api.requestCloseTab(info.id);
          else if (e.button === 0) api.activateTab(info.id);
        };
        return tab;
      }),
    );
    const active = state.tabs.find((x) => x.id === state.activeTabId);
    if (active) {
      if (document.activeElement !== $('addressInput')) $('addressInput').value = active.url;
      $('backBtn').disabled = !active.canGoBack;
      $('forwardBtn').disabled = !active.canGoForward;
    }
  }

  api.onTabs(({ tabs, activeTabId }) => {
    state.tabs = tabs;
    state.activeTabId = activeTabId;
    renderTabs();
  });

  $('newTabBtn').onclick = () => api.newTab();
  $('backBtn').onclick = () => api.back();
  $('forwardBtn').onclick = () => api.forward();
  $('reloadBtn').onclick = () => api.reload();
  $('homeBtn').onclick = () => api.home();
  $('addressForm').onsubmit = (e) => {
    e.preventDefault();
    api.go($('addressInput').value);
    $('addressInput').blur();
  };
  $('addressInput').addEventListener('focus', (e) => e.target.select());

  // Engine status in the sidebar footer.
  const ENGINE_TEXT = { checking: t('AI 엔진 확인 중…'), starting: t('AI 엔진 시작 중…'), ready: t('AI 엔진 연결됨'), error: t('AI 엔진 연결 실패') };
  api.onServer(({ state: s, message }) => {
    const box = $('engineStatus');
    box.className = 'engine ' + s;
    box.querySelector('.engine-text').textContent = ENGINE_TEXT[s] || s;
    box.title = message || ENGINE_TEXT[s] || '';
    $('retryServerBtn').hidden = s !== 'error';
    state.serverReady = s === 'ready';
    ANB.composer?.update();
  });
  $('retryServerBtn').onclick = () => api.retryServer();

  // Real-Chrome engine: the browser area shows a note instead of an embedded page.
  api.onEngine((info) => {
    const chrome = info?.type === 'chrome';
    document.body.classList.toggle('engine-chrome', chrome);
    $('chromePanel').hidden = !chrome;
    if (chrome) $('chromeName').textContent = info.name || 'Chrome';
    state.engine = info;
  });
  $('chromeShow').onclick = () => api.showChrome();
})();
