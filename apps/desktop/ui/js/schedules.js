// 예약 작업: the "예약됨" sidebar list and the schedule dialog. The main process keeps the
// schedules and starts the runs; a run shows up here like a task typed into the composer.
(() => {
  const { $, el, svg, api, state, t } = ANB;
  const CLOCK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const DEL_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const RESULT = { done: t('완료'), error: t('오류'), stopped: t('중지됨'), skipped: t('건너뜀'), running: t('실행 중'), interrupted: t('중단됨') };
  const dialog = $('scheduleDialog');
  let items = [];
  let editing = null; // the task (or schedule) the dialog is for
  let savedCallback = null;

  const pad = (n) => String(n).padStart(2, '0');
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function render() {
    $('scheduleLabel').hidden = !items.length;
    $('scheduleList').replaceChildren(...items.map(item));
  }

  function item(s) {
    const li = el('li', s.enabled ? '' : 'off');
    const when = s.enabled ? s.label : `${s.label} · ${t('꺼짐')}`;
    const last = s.lastResult ? ` · ${t('지난 실행: {result}', { result: RESULT[s.lastResult] || s.lastResult })}` : '';
    li.title = `${s.goal}\n${when}${last}`;
    const icon = el('span', 'h-clock');
    icon.append(svg(CLOCK_ICON));
    const text = el('span', 'h-text');
    text.append(el('span', 's-goal', s.goal), el('span', 's-when', when));
    const del = el('button', 'h-act');
    del.append(svg(DEL_ICON));
    del.title = t('예약 삭제');
    del.onclick = (e) => {
      e.stopPropagation();
      api.removeSchedule(s.id);
    };
    li.append(icon, text, del);
    li.onclick = () => open(s);
    return li;
  }

  /** Opens the dialog for a past task ({goal, mode, provider, quality}) or an existing schedule. */
  function open(src, onSaved = null) {
    editing = src;
    savedCallback = onSaved;
    const isSchedule = !!src.repeat;
    $('schGoal').value = src.goal || '';
    $('schMode').value = src.mode || 'browser';
    $('schProvider').value = src.provider || 'gemini';
    $('schRepeat').value = src.repeat || 'daily';
    $('schTime').value = src.time || '09:00';
    $('schDay').value = String(src.day ?? new Date().getDay());
    $('schDate').value = src.date || today();
    $('schMonthDay').value = String(src.monthDay ?? new Date().getDate());
    $('schEvery').value = String(src.every ?? 6);
    $('schUnit').value = src.unit || 'hour';
    $('schEnabled').checked = src.enabled !== false;
    $('schEnabledRow').hidden = !isSchedule;
    $('schDelete').hidden = !isSchedule;
    $('schTitle').textContent = isSchedule ? t('예약 수정') : t('작업 예약');
    $('schError').textContent = '';
    syncFields();
    api.setBrowserCovered(true); // the page view would sit on top of the dialog
    dialog.showModal();
    $('schTime').focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function syncFields() {
    const r = $('schRepeat').value;
    $('schDayRow').hidden = r !== 'weekly';
    $('schDateRow').hidden = r !== 'once';
    $('schMonthDayRow').hidden = r !== 'monthly';
    $('schEveryRow').hidden = $('schUnitRow').hidden = r !== 'interval';
    $('schTimeLabel').textContent = r === 'interval' ? t('기준 시간') : t('시각');
  }

  async function save() {
    const repeat = $('schRepeat').value;
    const s = {
      id: editing?.repeat ? editing.id : undefined,
      goal: $('schGoal').value,
      mode: $('schMode').value,
      provider: $('schProvider').value,
      quality: editing?.quality || 'fast',
      repeat,
      time: $('schTime').value,
      day: repeat === 'weekly' ? Number($('schDay').value) : undefined,
      date: repeat === 'once' ? $('schDate').value : undefined,
      monthDay: repeat === 'monthly' ? Number($('schMonthDay').value) : undefined,
      every: repeat === 'interval' ? Number($('schEvery').value) : undefined,
      unit: repeat === 'interval' ? $('schUnit').value : undefined,
      since: editing?.since,
      enabled: editing?.repeat ? $('schEnabled').checked : true,
    };
    try {
      await api.saveSchedule(s);
      close();
      savedCallback?.();
    } catch (e) {
      $('schError').textContent = errText(e);
    }
  }

  $('schRepeat').onchange = syncFields;
  $('schSave').onclick = save;
  $('schCancel').onclick = close;
  $('schDelete').onclick = () => {
    if (editing?.id) api.removeSchedule(editing.id);
    close();
  };
  dialog.addEventListener('close', () => api.setBrowserCovered(false));
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.isComposing) {
      e.preventDefault();
      save();
    }
  });

  api.onSchedules((list) => {
    items = list || [];
    render();
  });
  // A scheduled run starts: record it as a task, just like one typed into the composer.
  api.onScheduleRun((s) => {
    if (state.running) return;
    const id = Date.now();
    ANB.chat.beginTask({ id, goal: s.goal, time: id, mode: s.mode, provider: s.provider, quality: s.quality, scheduled: s.label || true });
  });
  api
    .listSchedules()
    .then((list) => {
      items = list || [];
      render();
    })
    .catch(() => {});

  ANB.schedules = { open, CLOCK_ICON };
})();
