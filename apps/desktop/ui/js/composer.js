// Prompt box: mode (browser automation / computer use / autopilot / assistant), model, speed, page attachment, submit.
(() => {
  const { $, api, state, prefs, t } = ANB;
  const input = $('promptInput');
  const MAX_ATTACHMENTS = 10;

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  }

  function setToggle(btn, on, labelOn, labelOff) {
    btn.dataset.on = String(on);
    btn.textContent = on ? labelOn : labelOff;
  }

  function update() {
    const answering = state.awaiting === 'ask';
    const confirming = state.awaiting === 'confirm';
    const busy = state.running && !answering;
    $('sendBtn').hidden = busy;
    $('stopBtn').hidden = !state.running;
    $('sendBtn').disabled = (!input.value.trim() && !state.attachments.length) || confirming || (!state.serverReady && !answering);
    $('fileBtn').disabled = busy || confirming;
    $('scheduleBtn').hidden = answering;
    $('scheduleBtn').disabled = !input.value.trim();
    for (const b of document.querySelectorAll('.mode')) b.disabled = state.running;
    $('modelSelect').disabled = state.running;
    $('qualityToggle').disabled = state.running;
    $('attachToggle').disabled = state.running;
    $('qualityToggle').hidden = state.mode === 'assistant';
    $('attachToggle').hidden = state.mode !== 'assistant';
    input.placeholder = answering
      ? t('답변을 입력하세요 (예: 계속, 첫 번째 상품으로 해줘)')
      : state.mode === 'assistant'
        ? t('스킬·플러그인으로 할 일 (예: 이 페이지 요약해 Gmail 초안 저장)')
        : state.mode === 'desktop'
          ? t('PC에서 할 일 (예: 엑셀 열어서 표 만들어줘) · 중지 Ctrl+Alt+Q')
          : state.mode === 'autopilot'
            ? t('긴 작업 목표 (예: 나라장터에서 맞는 공고 찾아 제안서 한글로 작성)')
          : t('무엇이든 시켜보세요 (예: 네이버 블로그에 글 써줘)');
    $('composerHint').textContent = !state.serverReady && !answering ? t('AI 엔진 연결을 기다리는 중…') : t('Enter 실행 · Shift+Enter 줄바꿈');
  }

  function setMode(mode) {
    state.mode = ['assistant', 'desktop', 'autopilot'].includes(mode) ? mode : 'browser';
    for (const b of document.querySelectorAll('.mode')) b.classList.toggle('active', b.dataset.mode === state.mode);
    prefs.set('anb.mode', state.mode);
    update();
  }

  function setQuality(q) {
    state.quality = q === 'accurate' ? 'accurate' : 'fast';
    setToggle($('qualityToggle'), state.quality === 'accurate', t('정확'), t('빠름'));
    prefs.set('anb.quality', state.quality);
  }

  function setAttach(on) {
    state.attachPage = !!on;
    setToggle($('attachToggle'), state.attachPage, t('현재 페이지 첨부됨'), t('현재 페이지 첨부'));
  }

  function renderAttachments() {
    const list = $('attachList');
    list.hidden = !state.attachments.length;
    list.replaceChildren(...state.attachments.map((f) => {
      const chip = ANB.el('span', 'attach-chip');
      chip.title = f.path;
      const remove = ANB.el('button', null, '×');
      remove.type = 'button';
      remove.title = t('첨부 취소');
      remove.onclick = () => setAttachments(state.attachments.filter((x) => x !== f));
      chip.append(ANB.el('span', null, f.name), remove);
      return chip;
    }));
    update();
  }

  function setAttachments(files) {
    state.attachments = files;
    renderAttachments();
  }

  function addAttachments(files) {
    const known = new Set(state.attachments.map((f) => f.path));
    setAttachments([...state.attachments, ...files.filter((f) => !known.has(f.path))].slice(0, MAX_ATTACHMENTS));
  }

  const toBase64 = (buf) => {
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  /** Dropped or pasted files: use the file on disk when there is one, else save a copy. */
  async function addDropped(fileList) {
    const out = [];
    for (const f of fileList) {
      const p = api.pathForFile?.(f);
      if (p) out.push({ path: p, name: f.name, size: f.size });
      else {
        try {
          out.push(await api.saveFile(f.name, toBase64(await f.arrayBuffer())));
        } catch (e) {
          ANB.chat.show({ t: 'note', text: t('첨부하지 못했습니다: {name} ({error})', { name: f.name, error: e.message }) });
        }
      }
    }
    addAttachments(out);
  }

  /** Text form of the attachments, for answers and schedules (which carry no attachment list). */
  const attachmentText = () => (state.attachments.length ? `\n\n${t('첨부 파일:')}\n${state.attachments.map((f) => `- ${f.path}`).join('\n')}` : '');

  function submit() {
    const files = state.attachments;
    const text = input.value.trim() || (files.length ? (state.awaiting === 'ask' ? t('파일을 첨부했습니다') : t('첨부한 파일을 확인하고 핵심 내용을 알려줘')) : '');
    if (!text) return;
    if (state.awaiting === 'ask') {
      ANB.chat.show({ t: 'user', text, files: files.map((f) => f.name) });
      state.awaiting = null;
      ANB.chat.setRunChip('running');
      api.answerAgent(text + attachmentText());
    } else {
      if (state.running || !state.serverReady) return;
      const provider = $('modelSelect').value;
      const id = Date.now();
      const context = state.replay ? '' : ANB.chat.threadContext();
      ANB.chat.beginTask({ id, goal: text, time: id, mode: state.mode, provider, quality: state.quality, attachments: files });
      api.runAgent({ goal: text, provider, mode: state.mode, quality: state.quality, attachPage: state.attachPage, attachments: files, context });
    }
    input.value = '';
    autoGrow();
    setAttachments([]);
  }

  /** Puts a past task back into the composer ("다시 실행"). */
  function prefill(h) {
    setMode(h.mode || 'browser');
    if (h.provider) $('modelSelect').value = h.provider;
    if (h.quality) setQuality(h.quality);
    input.value = h.goal;
    autoGrow();
    setAttachments(h.attachments || []);
    input.focus();
  }

  function bindSuggestions(root) {
    for (const b of root.querySelectorAll('.suggestion')) {
      b.onclick = () => {
        if (state.running) return;
        setMode(b.dataset.mode || 'browser');
        input.value = b.dataset.prompt;
        autoGrow();
        update();
        input.focus();
      };
    }
  }

  input.addEventListener('input', () => {
    autoGrow();
    update();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  $('composer').onsubmit = (e) => {
    e.preventDefault();
    submit();
  };
  $('stopBtn').onclick = () => api.stopAgent();
  $('fileBtn').onclick = async () => addAttachments(await api.pickFiles());
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addDropped(files);
  });
  const composer = $('composer');
  const canDrop = () => !$('fileBtn').disabled;
  composer.addEventListener('dragover', (e) => {
    if (!canDrop() || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    composer.classList.add('dropping');
  });
  composer.addEventListener('dragleave', (e) => {
    if (!composer.contains(e.relatedTarget)) composer.classList.remove('dropping');
  });
  composer.addEventListener('drop', (e) => {
    composer.classList.remove('dropping');
    if (!canDrop() || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    addDropped([...e.dataTransfer.files]);
  });
  // ⏰: schedule the typed task with the current mode and model instead of running it now.
  $('scheduleBtn').onclick = () => {
    const goal = input.value.trim();
    if (!goal) return;
    ANB.schedules.open({ goal: goal + attachmentText(), mode: state.mode, provider: $('modelSelect').value, quality: state.quality }, () => {
      input.value = '';
      autoGrow();
      setAttachments([]);
    });
  };
  for (const b of document.querySelectorAll('.mode')) b.onclick = () => !state.running && setMode(b.dataset.mode);
  $('qualityToggle').onclick = () => setQuality(state.quality === 'fast' ? 'accurate' : 'fast');
  $('attachToggle').onclick = () => setAttach(!state.attachPage);
  $('modelSelect').onchange = (e) => prefs.set('anb.model', e.target.value);

  /** Startup values come from 설정 > 일반 (defaults), falling back to the last used ones. */
  ANB.composer = { update, setMode, setQuality, prefill, bindSuggestions, init(defaults = {}) {
    $('modelSelect').value = defaults['general.defaultProvider'] || prefs.get('anb.model', 'gemini');
    setQuality(defaults['general.defaultQuality'] || prefs.get('anb.quality', 'fast'));
    setAttach(false);
    setMode(defaults['general.defaultMode'] || prefs.get('anb.mode', 'browser'));
    bindSuggestions(document);
  } };
})();
