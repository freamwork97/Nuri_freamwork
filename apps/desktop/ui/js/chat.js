// Conversation panel: renders agent events, records every item into the task transcript,
// replays past tasks from the sidebar, and manages the task history list (pin / delete).
(() => {
  const { $, el, svg, api, state, store, t, locale } = ANB;
  const messages = $('messages');
  const emptyTemplate = $('emptyState').cloneNode(true);
  const PIN_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 6 4 4H6l4-4z"/></svg>';
  const DEL_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const MODEL_NAMES = { gemini: 'Gemini', claude: 'Claude', gpt: 'GPT' };
  const MODE_NAMES = { browser: t('브라우저 자동화'), desktop: t('컴퓨터 제어'), autopilot: t('오토파일럿'), assistant: t('어시스턴트') };
  const TOOL_NAMES = { browser: t('브라우저'), desktop: t('PC 제어'), analyze: t('분석'), document: t('문서 작성'), ask: t('질문') };
  const STEP_STATUS = { running: t('진행 중'), done: t('완료'), skipped: t('건너뜀') };
  let lastStepEl = null;
  let planEl = null; // the autopilot plan card of the task on screen

  const MAX_RESTORED = 30; // tasks put back on screen at start
  const MAX_ON_SCREEN = 1000; // items kept in the live view: the app can run schedules for months

  // ---------- rendering ----------
  const scrollDown = () => (messages.scrollTop = messages.scrollHeight);

  function renderItem(item) {
    $('emptyState')?.remove();
    switch (item.t) {
      case 'user':
        messages.append(el('div', 'msg-user', item.files?.length ? `${item.text}\n${t('첨부')}: ${item.files.join(', ')}` : item.text));
        break;
      case 'step': {
        const row = el('div', 'step');
        const body = el('div', 'step-body');
        if (item.thought) body.append(el('div', 'step-thought', item.thought));
        const chip = el('div', 'step-action');
        chip.append(el('span', null, item.label));
        body.append(chip);
        row.append(el('div', 'step-num', String(item.step)), body);
        messages.append(row);
        lastStepEl = body;
        break;
      }
      case 'fail':
        lastStepEl?.append(el('div', 'step-fail', item.text));
        break;
      case 'card': {
        const card = el('div', 'card ' + item.kind);
        const body = ['result', 'assistant'].includes(item.kind) && window.NURI_RICH ? window.NURI_RICH.render(item.body) : el('div', 'card-body', item.body);
        body.classList.add('card-body');
        card.append(el('div', 'card-title', item.title), body);
        if (item.files?.length || item.dir) card.append(fileList(item.files || [], item.dir));
        messages.append(card);
        break;
      }
      case 'plan':
        planEl = planCard(item);
        messages.append(planEl);
        break;
      case 'plan_step':
        updatePlanStep(item);
        break;
      case 'note':
        messages.append(el('div', 'note', item.text));
        break;
    }
    scrollDown();
  }

  // ---------- autopilot ----------
  function planCard(item) {
    const card = el('div', 'card plan');
    card.append(el('div', 'card-title', t('계획 · {title}', { title: item.title })));
    const list = el('ol', 'plan-steps');
    for (const s of item.steps || []) {
      const li = el('li', 'plan-step');
      const head = el('div', 'plan-head');
      head.append(el('span', 'plan-tool', TOOL_NAMES[s.tool] || s.tool), el('span', 'plan-title', s.title), el('span', 'plan-status', t('대기 중')));
      li.append(head);
      if (s.output) li.append(el('div', 'plan-out', '→ ' + s.output));
      list.append(li);
    }
    card.append(list);
    return card;
  }

  function updatePlanStep(item) {
    const li = planEl?.querySelectorAll('.plan-step')[item.index];
    if (!li) return;
    li.className = 'plan-step ' + (item.status || '');
    li.querySelector('.plan-status').textContent = STEP_STATUS[item.status] || item.status || '';
    if (item.summary) {
      li.querySelector('.plan-summary')?.remove();
      li.append(el('div', 'plan-summary', item.summary));
    }
  }

  /** Output files with "열기" buttons (the main process only opens workspace paths). */
  function fileList(files, dir) {
    const box = el('div', 'files');
    for (const f of files) {
      const row = el('div', 'file-row');
      const open = el('button', 'btn-ghost', t('열기'));
      open.onclick = () => api.openPath(f.path);
      row.append(el('span', 'file-name', f.name), open);
      box.append(row);
    }
    if (dir) {
      const folder = el('button', 'link-btn', t('프로젝트 폴더 열기'));
      folder.onclick = () => api.openPath(dir);
      box.append(folder);
    }
    return box;
  }

  /** Short two-note chime for finished tasks (설정 > 알림 > 알림음). */
  function chime() {
    try {
      const ctx = new AudioContext();
      [880, 1318.5].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        o.type = 'sine';
        const t = ctx.currentTime + i * 0.13;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.4);
      });
      setTimeout(() => ctx.close(), 1000);
    } catch {
      /* audio unavailable */
    }
  }

  /** Render and also store in the running task's transcript. */
  function show(item) {
    renderItem(item);
    while (messages.children.length > MAX_ON_SCREEN) messages.firstElementChild.remove();
    if (state.currentTask) store.appendLog(state.currentTask, item);
  }

  function clear() {
    messages.replaceChildren();
    lastStepEl = null;
    planEl = null;
  }

  function showEmpty() {
    clear();
    const empty = emptyTemplate.cloneNode(true);
    messages.append(empty);
    ANB.composer?.bindSuggestions(empty);
    state.viewingTask = null;
    state.thread = null; // "새 작업" starts a new conversation
    state.replay = false;
    renderHistory();
  }

  /** On start: the latest conversation is back on screen, oldest task first. */
  function restore() {
    const list = store.load().sort((a, b) => b.id - a.id);
    if (!list.length) return;
    const thread = list[0].thread || null; // tasks from before threads existed count as one conversation
    const end = list.findIndex((h) => (h.thread || null) !== thread);
    const tasks = list.slice(0, end < 0 ? list.length : end).slice(0, MAX_RESTORED).reverse();
    state.thread = thread;
    state.viewingTask = list[0].id;
    for (const h of tasks) (h.log?.length ? h.log : [{ t: 'user', text: h.goal }]).forEach(renderItem);
    scrollDown();
  }

  /** Approve / decline card for risky actions (payments, publishing, delegation). */
  function showConfirm(question) {
    $('emptyState')?.remove();
    const card = el('div', 'card confirm');
    card.append(el('div', 'card-title', t('승인이 필요합니다')), el('div', 'card-body', question));
    const actions = el('div', 'confirm-actions');
    const yes = el('button', 'btn-primary', t('승인'));
    const no = el('button', 'btn-ghost', t('거부'));
    const decide = (ok) => {
      yes.disabled = no.disabled = true;
      (ok ? yes : no).textContent = ok ? t('승인됨') : t('거부됨');
      state.awaiting = null;
      setRunChip('running');
      api.answerAgent(ok);
      ANB.composer.update();
    };
    yes.onclick = () => decide(true);
    no.onclick = () => decide(false);
    actions.append(yes, no);
    card.append(actions);
    messages.append(card);
    if (state.currentTask) store.appendLog(state.currentTask, { t: 'card', kind: 'confirm', title: t('승인 요청'), body: question });
    scrollDown();
  }

  function setLive(text) {
    $('liveStatus').hidden = !text || $('messages').hidden;
    if (text) $('liveText').textContent = text;
  }

  function setRunChip(kind) {
    const chip = $('runChip');
    chip.className = 'run-chip ' + (kind || '');
    chip.textContent = { running: t('실행 중'), waiting: t('응답 대기') }[kind] || t('대기');
  }

  // ---------- agent events ----------
  api.onAgent((ev) => {
    switch (ev.kind) {
      case 'start':
        state.running = true;
        setRunChip('running');
        setLive({ assistant: t('어시스턴트에게 요청 중…'), desktop: t('컴퓨터 제어를 시작합니다… (중지: Ctrl+Alt+Q)'), autopilot: t('오토파일럿을 시작합니다…') }[ev.mode] || t('작업을 시작합니다…'));
        break;
      case 'status':
        setLive(ev.text);
        break;
      case 'note':
        show({ t: 'note', text: ev.text });
        if (ev.timeout) {
          // An unattended run stopped waiting for the user: the open question is over.
          state.awaiting = null;
          setRunChip('running');
          for (const b of messages.querySelectorAll('.card.confirm button:not(:disabled)')) b.disabled = true;
          ANB.composer.update();
        }
        break;
      case 'plan':
        show({ t: 'plan', title: ev.title, steps: ev.steps });
        break;
      case 'plan_step':
        show({ t: 'plan_step', index: ev.index, status: ev.status, summary: ev.summary });
        break;
      case 'step':
        show({ t: 'step', step: ev.step, thought: ev.thought, label: ev.label });
        setLive(t('실행 중…'));
        break;
      case 'result':
        if (/^FAILED/.test(ev.result)) show({ t: 'fail', text: ev.result.replace(/^FAILED:\s*/, t('실패: ')) });
        break;
      case 'assistant':
        show({ t: 'card', kind: 'assistant', title: t('스킬·플러그인 작업 결과'), body: ev.text || '' });
        break;
      case 'ask':
        state.awaiting = 'ask';
        setRunChip('waiting');
        setLive('');
        show({ t: 'card', kind: 'ask', title: t('확인이 필요합니다'), body: ev.question });
        $('promptInput').focus();
        break;
      case 'confirm':
        state.awaiting = 'confirm';
        setRunChip('waiting');
        setLive('');
        showConfirm(ev.question);
        break;
      case 'done':
        show({ t: 'card', kind: 'result', title: t('작업 완료'), body: ev.answer || '', files: ev.files, dir: ev.dir });
        // In the background the Windows notification makes the sound instead.
        if (state.settings?.['notifications.sound'] !== false && document.hasFocus()) chime();
        if (state.currentTask) store.update(state.currentTask, { status: 'done' });
        break;
      case 'error':
        show({ t: 'card', kind: 'error', title: t('오류'), body: ev.message });
        if (state.currentTask) store.update(state.currentTask, { status: 'error' });
        break;
      case 'stopped':
        show({ t: 'note', text: t('작업을 중지했습니다') });
        break;
      case 'end':
        state.running = false;
        state.awaiting = null;
        setRunChip('');
        setLive('');
        renderHistory();
        // The language changed during the task: redraw once the result is saved and on screen.
        if (state.reloadWhenIdle) setTimeout(state.reloadWhenIdle, 2500);
        break;
    }
    ANB.composer.update();
  });

  // ---------- history sidebar ----------
  function historyItem(h) {
    const li = el('li', h.id === state.viewingTask ? 'active' : '');
    li.title = h.goal + (MODE_NAMES[h.mode] && h.mode !== 'browser' ? ` (${MODE_NAMES[h.mode]})` : '') + (h.scheduled ? `\n${t('예약 실행')}${typeof h.scheduled === 'string' ? ` · ${h.scheduled}` : ''}` : '');
    const pin = el('button', 'h-act' + (h.pinned ? ' pinned' : ''));
    pin.append(svg(PIN_ICON));
    pin.title = h.pinned ? t('고정 해제') : t('작업 고정');
    pin.onclick = (e) => {
      e.stopPropagation();
      store.update(h.id, { pinned: !h.pinned });
      renderHistory();
    };
    const sch = el('button', 'h-act');
    sch.append(svg(ANB.schedules.CLOCK_ICON));
    sch.title = t('이 작업 예약');
    sch.onclick = (e) => {
      e.stopPropagation();
      ANB.schedules.open({ goal: h.goal, mode: h.mode, provider: h.provider, quality: h.quality });
    };
    const del = el('button', 'h-act');
    del.append(svg(DEL_ICON));
    del.title = t('삭제');
    del.onclick = (e) => {
      e.stopPropagation();
      if (state.running && h.id === state.currentTask) return;
      store.remove(h.id);
      if (state.viewingTask === h.id) showEmpty();
      else renderHistory();
    };
    li.append(el('span', 'h-dot ' + (h.status || '')), el('span', 'h-text', h.goal));
    if (h.scheduled) li.append(el('span', 'h-badge', t('예약')));
    li.append(sch, pin, del);
    li.onclick = () => openTask(h.id);
    return li;
  }

  function renderHistory() {
    const list = store.load();
    const pinned = list.filter((h) => h.pinned);
    const recent = list.filter((h) => !h.pinned);
    $('pinnedLabel').hidden = !pinned.length;
    $('pinnedList').replaceChildren(...pinned.map(historyItem));
    $('historyList').replaceChildren(...recent.map(historyItem));
    if (!recent.length) $('historyList').append(el('li', 'h-empty', pinned.length ? t('최근 작업이 없습니다') : t('아직 작업이 없습니다')));
  }

  /** Shows a past task's full conversation (read-only) with a "다시 실행" shortcut. */
  function openTask(id) {
    if (state.running) return; // keep the live run on screen
    const h = store.get(id);
    if (!h) return;
    state.viewingTask = id;
    state.replay = true;
    clear();
    const head = el('div', 'replay-head');
    const when = new Date(h.time || h.id).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const sched = h.scheduled ? ` · ${t('예약 실행')}${typeof h.scheduled === 'string' ? ` (${h.scheduled})` : ''}` : '';
    head.append(el('span', null, `${when} · ${MODEL_NAMES[h.provider] || ''} · ${MODE_NAMES[h.mode] || t('브라우저 자동화')}${sched}`));
    const rerun = el('button', 'link-btn', t('다시 실행'));
    rerun.onclick = () => ANB.composer.prefill(h);
    head.append(rerun);
    messages.append(head);
    const log = h.log?.length ? h.log : [{ t: 'user', text: h.goal }, { t: 'note', text: t('이 작업은 대화 기록이 저장되기 전에 실행되었습니다') }];
    log.forEach(renderItem);
    renderHistory();
  }

  /** The last tasks of this conversation and how they ended, for the next task's prompt. */
  function threadContext() {
    if (!state.thread) return '';
    const tasks = store.load().filter((h) => h.thread === state.thread).sort((a, b) => a.id - b.id).slice(-3);
    return tasks.map((h) => {
      const end = [...(h.log || [])].reverse().find((i) => i.t === 'card' && ['result', 'error'].includes(i.kind));
      return `${t('요청')}: ${h.goal}\n${t('결과')}: ${(end?.body || t('(끝나지 않음)')).slice(0, 800)}`;
    }).join('\n\n');
  }

  /** Starts a fresh transcript for a new task and renders the user's message. */
  function beginTask(entry) {
    // The conversation keeps growing; only a past task opened from the list leaves the screen.
    if (state.replay) clear();
    lastStepEl = null;
    planEl = null;
    state.replay = false;
    state.thread ||= entry.id;
    state.currentTask = entry.id;
    state.viewingTask = entry.id;
    store.add({ ...entry, thread: state.thread, status: '', log: [] });
    show({ t: 'user', text: entry.goal, files: entry.attachments?.map((f) => f.name) });
    renderHistory();
  }

  // Side panel: the history sidebar is a drawer (☰).
  const root = document.documentElement;
  $('historyBtn').onclick = (e) => {
    e.stopPropagation();
    root.classList.toggle('history-open');
  };
  document.addEventListener('click', (e) => {
    if (root.classList.contains('history-open') && !e.target.closest('.sidebar')) root.classList.remove('history-open');
  });
  for (const id of ['pinnedList', 'historyList']) $(id).addEventListener('click', () => root.classList.remove('history-open'));

  $('newTaskBtn').onclick = () => {
    root.classList.remove('history-open');
    if (state.running) return;
    showEmpty();
    $('promptInput').focus();
  };

  // Google sign-in: the app opens a small Google 로그인 window (real Chromium) and imports the
  // session when the user has signed in. One card follows the states: waiting → done | failed.
  let loginCard = null;
  api.onLoginBlocked((info = {}) => {
    $('emptyState')?.remove();
    const state = info.state || 'manual';
    if (!loginCard || !loginCard.isConnected || (state === 'needed' && loginCard.dataset.state !== 'needed')) {
      loginCard = el('div', 'card ask');
      messages.append(loginCard);
    }
    const text = {
      needed: [t('Google 로그인이 필요합니다'), t('아래 버튼을 누르면 Google 로그인 창이 열립니다. 로그인을 마치면 창은 닫히고, 탭에서 하던 페이지가 로그인된 상태로 열립니다.')],
      waiting: [t('Google 로그인 창에서 로그인해 주세요'), t('로그인을 마치면 창은 자동으로 닫히고, 탭에서 하던 페이지가 로그인된 상태로 열립니다.')],
      done: [t('Google에 로그인되었습니다'), t('로그인 정보를 이 앱으로 가져왔습니다. 하던 페이지를 이어서 엽니다.')],
      failed: [t('Google 로그인을 마치지 못했습니다'), (info.reason ? info.reason + '. ' : '') + t('다시 시도하려면 아래 버튼을 누르세요.')],
      humanCheck: [t('이 사이트는 앱 안 브라우저에서 넘어가지 않습니다'), t('사이트의 보안 확인이 앱 안 브라우저에서는 끝나지 않습니다. 보조 브라우저 창에서 열면 정상적으로 진행됩니다.')],
      chromium: [t('보조 브라우저 창에서 이어갑니다'), t('Google 로그인 상태를 그대로 쓰도록 이 페이지를 보조 브라우저 창에서 열었습니다.')],
      manual: [t('Google이 이 앱 안에서의 로그인을 막았습니다'), t('로그인 창에 쓸 브라우저 파일이 없습니다(vendor 폴더). 평소 쓰는 브라우저에서 로그인해 주세요.')],
    }[state] || ['', ''];
    loginCard.dataset.state = state;
    loginCard.replaceChildren(el('div', 'card-title', text[0]), el('div', 'card-body', text[1]));
    const label = { humanCheck: t('보조 브라우저 창에서 열기'), needed: t('Google 로그인'), waiting: t('로그인 창 다시 보기'), failed: t('Google 로그인 다시 시도'), manual: t('내 브라우저에서 Google 로그인 열기') }[state];
    if (label) {
      const actions = el('div', 'confirm-actions');
      const btn = el('button', state === 'waiting' ? 'btn-ghost' : 'btn-primary', label);
      btn.onclick = () => {
        if (state === 'humanCheck') return api.openInChromium?.(info.url);
        return state === 'manual' ? api.openExternal('https://accounts.google.com/') : api.googleLogin();
      };
      actions.append(btn);
      loginCard.append(actions);
    }
    scrollDown();
  });

  ANB.chat = { show, showEmpty, restore, threadContext, renderHistory, openTask, beginTask, setRunChip, setLive };
})();
