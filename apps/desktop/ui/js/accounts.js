// "연결 · 스킬" panel: subscription account status, web login, installed skills/plugins/MCP.
(() => {
  const { $, el, api, state, t } = ANB;
  const LOGOS = { gemini: 'G', claude: 'C', gpt: 'O' };
  const PROVIDER_LABEL = { gemini: 'Gemini (Antigravity)', claude: 'Claude', gpt: 'GPT (Codex)' };
  const MCP_STATUS = { connected: t('연결됨'), 'needs-auth': t('인증 필요 (CLI에서 /mcp)'), off: t('미설정') };
  let loginProvider = null;
  let loginPoll = 0; // increments to cancel an older poll loop

  const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function showView(view) {
    for (const b of document.querySelectorAll('.panel-tab')) b.classList.toggle('active', b.dataset.view === view);
    const chat = view === 'chat';
    $('messages').hidden = !chat;
    $('composer').hidden = !chat;
    $('liveStatus').hidden = !chat || !state.running || !$('liveText').textContent;
    $('accountsView').hidden = view !== 'accounts';
    if (!chat) loadAccounts(false);
  }

  async function loadAccounts(refresh) {
    const box = $('accountList');
    try {
      const { accounts } = await api.getAccounts(refresh);
      box.replaceChildren(...accounts.map(accountCard));
    } catch (e) {
      box.replaceChildren(el('div', 'caps-empty', t('AI 엔진에 연결할 수 없습니다: ') + cleanError(e)));
    }
    loadCaps(false);
  }

  function accountCard(a) {
    const card = el('div', 'acc-card');
    const info = el('div', 'acc-info');
    const name = el('div', 'acc-name', a.label);
    name.append(
      a.connected && a.subscription
        ? el('span', 'badge ok', t('구독 연결됨'))
        : a.connected
          ? el('span', 'badge warn', t('종량제 - 재연결 필요'))
          : el('span', 'badge off', t('미연결')),
    );
    info.append(name, el('div', 'acc-detail', a.detail));
    info.title = a.detail;
    card.append(el('div', 'acc-logo ' + a.provider, LOGOS[a.provider]), info);
    if (a.canLogin) {
      const ok = a.connected && a.subscription;
      const btn = el('button', ok ? 'btn-ghost' : 'btn-primary', ok ? t('재연결') : t('웹 로그인'));
      btn.onclick = () => startLogin(a.provider, btn);
      card.append(btn);
    }
    return card;
  }

  async function startLogin(provider, btn) {
    btn.disabled = true;
    btn.textContent = t('여는 중…');
    try {
      const r = await api.login(provider);
      if (r.url) {
        loginProvider = provider;
        $('codeBox').hidden = false;
        btn.textContent = t('브라우저에서 로그인 중');
        pollLogin(provider);
      } else {
        btn.textContent = r.message || t('완료');
        setTimeout(() => loadAccounts(true), 1500);
      }
    } catch (e) {
      btn.textContent = t('실패');
      btn.title = cleanError(e);
      btn.disabled = false;
    }
  }

  async function pollLogin(provider) {
    const ticket = ++loginPoll;
    for (let i = 0; i < 200 && ticket === loginPoll; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const st = await api.loginState(provider);
        if (st.done) {
          $('codeBox').hidden = true;
          loginProvider = null;
          loadAccounts(true);
          return;
        }
      } catch {
        /* server busy; keep polling */
      }
    }
  }

  $('codeSubmit').onclick = async () => {
    const code = $('codeInput').value.trim();
    if (!code || !loginProvider) return;
    await api.submitLoginCode(loginProvider, code).catch(() => {});
    $('codeInput').value = '';
  };

  function chipGroup(group, title, items) {
    group.append(el('div', 'caps-cat', `${title} ${items.length}`));
    const chips = el('div', 'chips');
    if (!items.length) chips.append(el('span', 'caps-empty', t('없음')));
    for (const it of items) {
      const isObj = typeof it !== 'string';
      const chip = el('span', 'chip ' + (isObj ? it.status : ''), isObj ? it.name : it);
      if (isObj) chip.title = MCP_STATUS[it.status] || '';
      chips.append(chip);
    }
    group.append(chips);
  }

  async function loadCaps(refresh) {
    const box = $('capsList');
    box.replaceChildren(el('div', 'acc-loading', t('불러오는 중…')));
    try {
      const { capabilities } = await api.getCapabilities(refresh);
      box.replaceChildren(
        ...capabilities.map((c) => {
          const g = el('div', 'caps-group');
          g.append(el('h4', null, PROVIDER_LABEL[c.provider]));
          chipGroup(g, t('플러그인'), c.plugins);
          chipGroup(g, t('MCP 커넥터'), c.mcp);
          chipGroup(g, t('스킬'), c.skills);
          return g;
        }),
      );
    } catch (e) {
      box.replaceChildren(el('div', 'caps-empty', t('불러오기 실패: ') + cleanError(e)));
    }
  }

  for (const b of document.querySelectorAll('.panel-tab')) b.onclick = () => showView(b.dataset.view);
  $('capsRefresh').onclick = () => loadCaps(true);
  $('openWorkspace').onclick = () => api.openWorkspace();

  ANB.accounts = { showView, loadAccounts };
})();
