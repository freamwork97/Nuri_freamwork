// Desktop ("computer use") agent loop: screenshot + UI elements -> LLM picks one action ->
// mouse/keyboard via the native helper -> repeat. Shares the Agent's LLM, ask/confirm and events.

const { parseDecision } = require('../agent/decision');
const { DESKTOP_SYSTEM_PROMPT, BACKGROUND_RULES, SANDBOX_RULES, MAC_RULES, MAX_DESKTOP_STEPS, buildDesktopStepPrompt } = require('./prompt');
const { DESKTOP_ACTIONS, resolveTarget, toScreen, desktopRiskOf, describeDesktopAction } = require('./decision');

const fs = require('node:fs');
const path = require('node:path');
const { runTool, TOOL_TYPES, resolveIn } = require('../agent/tools');
const { t, forAi } = require('../i18n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The AI 작업 PC needs no overlay, minimizing or "stay clear of the user" logic.
const QUIET_SESSION = { begin() {}, end() {}, pause() {}, resume() {}, status() {}, ownHandles: () => new Set(), clearOf: (_pts, fn) => fn() };
// How long the UI usually needs after each kind of action before the next one / screenshot.
const SETTLE_MS = { click: 450, double_click: 700, type: 250, key: 350, scroll: 300, drag: 400, focus_window: 300, launch: 0, wait: 0 };
const short = (e) => String(e?.message || e).split('\n')[0].slice(0, 200);

/**
 * Background mode: the same actions, sent to the target window through UI Automation / window
 * messages (helper "bg*" commands). No real mouse or keyboard, no focus change.
 * `bgs` = { target (hwnd), set(hwnd) }.
 */
async function executeBackground({ helper, session }, action, target, obs, windows, bgs) {
  const el = target?.element?.id;
  const at = target ? { x: target.x, y: target.y } : {};
  // The AI's own pointer glides to where it acts (the user's mouse is never moved).
  if (target && ['click', 'double_click', 'type', 'scroll'].includes(action.type)) {
    await session?.cursorTo?.(at, { click: action.type !== 'scroll' }).catch(() => {});
  }
  const need = () => {
    if (!bgs.target) throw new Error('no target window yet: use focus_window N or launch an app first');
  };
  switch (action.type) {
    case 'click':
    case 'double_click': {
      need();
      if (!target) return 'FAILED: click needs "id" or "x","y"';
      const r = await helper.call('bgclick', { el, ...at, double: action.type === 'double_click', right: action.button === 'right' });
      return `ok (${r.method})`;
    }
    case 'type': {
      need();
      const r = await helper.call('bgtype', { el, hwnd: bgs.target, text: String(action.text ?? ''), clear: !!action.clear }, 15_000 + String(action.text ?? '').length * 20);
      return `ok (${r.method})`;
    }
    case 'key': {
      need();
      const r = await helper.call('bgkey', { hwnd: bgs.target, keys: String(action.keys || ''), repeat: Math.max(1, Math.min(50, Number(action.repeat) || 1)) });
      return `ok (${r.method})`;
    }
    case 'scroll': {
      need();
      const dir = String(action.direction || 'down');
      const n = Math.max(1, Math.min(30, Number(action.amount) || 5));
      const r = await helper.call('bgscroll', { el, ...at, amount: dir === 'up' || dir === 'left' ? n : -n, horizontal: dir === 'left' || dir === 'right' });
      return `ok (${r.method})`;
    }
    case 'drag': {
      // Window messages from "from" to "to"; a slider given by id is set through UI Automation.
      need();
      if (!action.from || !action.to) return 'FAILED: drag needs "from" and "to"';
      const a = resolveTarget(action.from, obs);
      const b = resolveTarget(action.to, obs);
      if (!a || !b) return 'FAILED: drag needs x,y (or id) for "from" and "to"';
      await session?.cursorTo?.(a, { click: true }).catch(() => {});
      const r = await helper.call('bgdrag', { el: a.element?.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      await session?.cursorTo?.(b, { click: false }).catch(() => {});
      return `ok (${r.method})`;
    }
    case 'focus_window': {
      const w = windows[Number(action.window) - 1];
      if (!w) return `FAILED: no window number ${action.window}`;
      bgs.set(w.hwnd);
      return `"${w.title.slice(0, 40)}" is now your target window (it stays where it is; the user's screen is not changed)`;
    }
    case 'launch': {
      const t = String(action.target || '').trim();
      if (!t) return 'FAILED: launch needs "target"';
      const userFg = (await helper.call('foreground').catch(() => null))?.window?.hwnd || 0;
      const before = new Set((await helper.call('windows')).windows.map((w) => w.hwnd));
      await helper.call('launch', { target: t });
      for (let i = 0; i < 16; i++) {
        await sleep(500);
        const now = (await helper.call('windows')).windows;
        const win = now.find((w) => !before.has(w.hwnd) && !bgs.own().has(w.hwnd));
        if (win) {
          await sleep(400); // let it finish opening before it is moved behind the user's windows
          await helper.call('bgplace', { hwnd: win.hwnd, restore: userFg }).catch(() => {});
          bgs.set(win.hwnd);
          return `launched ${t}; its window "${win.title.slice(0, 50)}" is now your target (behind the user's windows)`;
        }
      }
      // No new window: the app reused an open one (a URL opens as a tab in the user's browser).
      // If it jumped to the front, put it back behind and return the focus to the user.
      const fg = (await helper.call('foreground').catch(() => null))?.window;
      if (fg?.hwnd && fg.hwnd !== userFg && !bgs.own().has(fg.hwnd)) {
        await helper.call('bgplace', { hwnd: fg.hwnd, restore: userFg }).catch(() => {});
        bgs.set(fg.hwnd);
        return `launched ${t}; it opened in the existing window "${String(fg.title).slice(0, 50)}", which is now your target (moved back behind the user's windows)`;
      }
      return `launched ${t}, but no new window appeared (it may have opened in an already-open window, e.g. a new tab in the user's browser: pick that window with focus_window)`;
    }
    case 'wait':
      await sleep(Math.max(0.5, Math.min(10, Number(action.seconds) || 2)) * 1000);
      return 'ok';
    case 'pick_file': {
      need();
      const r = await helper.call('filedialog', { hwnd: bgs.target, path: action.resolvedPath }, 10_000);
      return r.closed ? `selected "${action.resolvedPath}" with "${r.button}"; the dialog closed` : `put "${r.value}" into the dialog and pressed "${r.button}", but the dialog is still open: look at the screen`;
    }
    default:
      return `FAILED: unsupported action ${action.type}`;
  }
}

async function executeDesktop({ helper, session }, action, target, obs, windows) {
  const at = target ? { x: target.x, y: target.y } : null;
  switch (action.type) {
    case 'click':
    case 'double_click': {
      if (!at) return 'FAILED: click needs "id" or "x","y"';
      const mode = action.type === 'double_click' ? 'double_click' : action.button === 'right' ? 'right_click' : 'click';
      await session.clearOf([at], () => helper.call('mouse', { action: mode, ...at, button: action.button === 'right' ? 'right' : 'left' }));
      return 'ok';
    }
    case 'type': {
      const text = String(action.text ?? '');
      const enter = /\n$/.test(text);
      const body = enter ? text.slice(0, -1) : text;
      // Single-line text into a real edit field: set the value directly through UI Automation.
      // Keyboard injection into fields with autocomplete (file dialogs, address bars) loses or
      // mixes characters; SetValue doesn't, and it replaces the old content in one go.
      const role = target?.element?.role;
      if (at && (role === 'edit' || role === 'combobox') && !body.includes('\n') && action.clear !== false) {
        try {
          const r = await helper.call('setvalue', { ...at, text: body });
          if (String(r.value).replace(/\s/g, '') === body.replace(/\s/g, '')) {
            if (enter) await helper.call('key', { keys: 'enter' });
            return `set field to "${body.slice(0, 60)}"${enter ? ' + Enter' : ''}`;
          }
        } catch {
          /* not settable: type with the keyboard below */
        }
      }
      if (at) {
        await session.clearOf([at], () => helper.call('mouse', { action: 'click', ...at }));
        await sleep(150);
      }
      // Keys only go to the window that has focus now (after the click above, or the one the
      // model looked at); the helper stops mid-text if focus moves elsewhere.
      const guard = at ? (await helper.call('foreground').catch(() => null))?.window?.hwnd : obs.foreground?.hwnd;
      if (action.clear) {
        await helper.call('key', { keys: 'ctrl+a', hwnd: guard });
        await helper.call('key', { keys: 'delete', hwnd: guard });
      }
      await helper.call('type', { text, hwnd: guard }, 15_000 + text.length * 30);
      return `typed ${text.length} chars`;
    }
    case 'key':
      await helper.call('key', { keys: String(action.keys || ''), repeat: Math.max(1, Math.min(50, Number(action.repeat) || 1)), hwnd: obs.foreground?.hwnd });
      return 'ok';
    case 'scroll': {
      const dir = String(action.direction || 'down');
      const n = Math.max(1, Math.min(30, Number(action.amount) || 5));
      let p = at;
      if (!p) {
        const r = obs.foreground?.rect;
        p = r ? { x: r[0] + Math.round(r[2] / 2), y: r[1] + Math.round(r[3] / 2) } : toScreen(obs, obs.width / 2, obs.height / 2);
      }
      const horizontal = dir === 'left' || dir === 'right';
      const amount = dir === 'up' || dir === 'right' ? n : -n;
      await session.clearOf([p], () => helper.call('scroll', { ...p, amount, horizontal }));
      return 'ok';
    }
    case 'drag': {
      if (!action.from || !action.to) return 'FAILED: drag needs "from" and "to"';
      const a = resolveTarget(action.from, obs);
      const b = resolveTarget(action.to, obs);
      if (!a || !b) return 'FAILED: drag needs x,y (or id) for "from" and "to"';
      await session.clearOf([a, b], () => helper.call('drag', { x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
      return 'ok';
    }
    case 'focus_window': {
      const w = windows[Number(action.window) - 1];
      if (!w) return `FAILED: no window number ${action.window}`;
      const r = await helper.call('focus', { hwnd: w.hwnd });
      return r.focused ? `"${w.title.slice(0, 40)}" is now in front` : 'FAILED: Windows refused to switch; try clicking it in the taskbar';
    }
    case 'launch': {
      const t = String(action.target || '').trim();
      if (!t) return 'FAILED: launch needs "target"';
      const before = new Set((await helper.call('windows')).windows.map((w) => w.hwnd));
      await helper.call('launch', { target: t });
      // Windows keeps apps started from a background process behind the current window, so
      // find the new window (or the app's existing one, e.g. Notepad tabs) and bring it forward.
      const exe = t.split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
      for (let i = 0; i < 12; i++) {
        await sleep(500);
        const now = (await helper.call('windows')).windows.filter((w) => !session.ownHandles().has(w.hwnd));
        // Only a NEW window is brought forward: an already-open window of the same app may be
        // one of the user's own documents, so the model must choose it explicitly.
        const win = now.find((w) => !before.has(w.hwnd));
        if (!win && i >= 5) {
          const existing = now.filter((w) => w.process.toLowerCase() === exe);
          if (existing.length) {
            return `launched ${t}; no new window appeared. Already open ${exe} windows (the user's own — don't modify them unless the goal says so): ${existing.map((w) => `"${w.title.slice(0, 50)}"`).join(', ')}. If the app opened as a tab or start screen, look at the screenshot.`;
          }
        }
        if (win) {
          let r = await helper.call('focus', { hwnd: win.hwnd }).catch(() => ({}));
          if (!r.focused) {
            await sleep(700); // freshly created windows (UWP apps) often refuse focus for a moment
            r = await helper.call('focus', { hwnd: win.hwnd }).catch(() => ({}));
          }
          return `launched ${t}; window "${win.title.slice(0, 50)}" ${r.focused ? 'is now in front' : 'opened (could not bring it to front; click it in the taskbar)'}`;
        }
      }
      return `launched ${t}, but no window appeared yet (it may still be loading)`;
    }
    case 'wait':
      await sleep(Math.max(0.5, Math.min(10, Number(action.seconds) || 2)) * 1000);
      return 'ok';
    case 'pick_file': {
      // Standard Open/Save dialog: path goes into the file-name box via UI Automation, then OK.
      const fg = (await helper.call('foreground').catch(() => null))?.window;
      if (!fg?.hwnd) return 'FAILED: no window in front';
      const r = await helper.call('filedialog', { hwnd: fg.hwnd, path: action.resolvedPath }, 10_000);
      return r.closed ? `selected "${action.resolvedPath}" with "${r.button}"; the dialog closed` : `put "${r.value}" into the dialog and pressed "${r.button}", but the dialog is still open (an error message or a folder was opened): look at the screen`;
    }
    default:
      return `FAILED: unsupported action ${action.type}`;
  }
}

/** @param {import('../agent/agent').Agent} agent */
const unavailable = () => t('컴퓨터 제어는 Windows 데스크톱 앱에서만 사용할 수 있습니다 (apps/desktop/native/anb-desktop.exe 필요).');

/** UI entry point for the 컴퓨터 제어 mode. */
async function runDesktop(agent, goal, provider = 'gemini', opts = {}) {
  const { helper } = agent.desktop || {};
  if (!helper || !helper.available()) {
    agent.emitEvent('error', { message: unavailable() });
    return;
  }
  if (!agent.begin('desktop', { goal, provider })) return;
  try {
    const answer = await desktopLoop(agent, goal, provider, opts);
    if (agent.stopped || answer === null) agent.emitEvent('stopped', {});
    else agent.emitEvent('done', { answer });
  } catch (e) {
    if (agent.stopped) agent.emitEvent('stopped', {});
    else {
      agent.log('desktop error', e.message);
      agent.emitEvent('error', { message: short(e) });
    }
  } finally {
    agent.finish();
  }
}

/**
 * The computer-use loop. Returns the final answer, null when stopped; throws on fatal errors.
 * Used directly by the autopilot for its desktop steps.
 */
async function desktopLoop(agent, goal, provider = 'gemini', { quality = 'fast', maxSteps = agent.settings?.get('automation.desktopMaxSteps') || MAX_DESKTOP_STEPS } = {}) {
  // 설정 > 자동화 > 컴퓨터 제어 위치: "sandbox" runs everything inside the AI 작업 PC (Windows
  // Sandbox), with the real mouse/keyboard of THAT machine, so the user's own PC is never touched.
  const sandbox = agent.settings?.get('automation.desktopTarget') === 'sandbox' ? agent.desktop?.sandbox : null;
  const local = agent.desktop?.helper;
  const helper = sandbox ? sandbox.helper : local;
  const session = sandbox ? QUIET_SESSION : agent.desktop?.session;
  if (!local || !local.available()) throw new Error(unavailable());
  if (sandbox && !sandbox.available()) throw new Error(t('AI 작업 PC(Windows 샌드박스)가 꺼져 있습니다. 설정 > 자동화 > 컴퓨터 제어 위치를 "내 PC"로 바꾸거나 Windows 샌드박스 기능을 켜 주세요.'));
  const sessionId = `desk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let toolOutput = '';
  const history = [];
  let notes = '';
  let badReplies = 0;
  let failures = 0;
  agent.log('desktop run', provider, quality, agent.unattended ? '(예약 작업)' : goal);

  const status = (text) => {
    agent.emitEvent('status', { text });
    session.status(text);
  };
  const ask = async (q) => {
    session.pause();
    try {
      return await agent.askUser(q);
    } finally {
      session.resume();
    }
  };
  const confirm = async (q) => {
    session.pause();
    try {
      return await agent.confirm(q);
    } finally {
      session.resume();
    }
  };

  try {
    if (sandbox) status(t('AI 작업 PC 준비 중… (보통 30초~1분, 맨 처음에는 Windows 업데이트 때문에 5~7분)'));
    await helper.start();
    // Files always go to the user's real folders (the host), also when working in the AI 작업 PC.
    const folders = await local.call('folders').catch(() => ({}));
    // 설정 > 자동화 > 컴퓨터 제어 방식: background (default) never touches the real mouse,
    // keyboard or focus; foreground drives the visible screen like a person. The AI 작업 PC is
    // the agent's own machine: there it always works like a person (foreground).
    // The Mac helper has the background commands only.
    const bgMode = !sandbox && (process.platform === 'darwin' || agent.settings?.get('automation.desktopMode') !== 'foreground');
    const bgs = { target: null, parents: [], own: () => session.ownHandles(), set(h) { this.target = h; this.parents = []; } };
    agent.log('desktop mode', bgMode ? 'background' : 'foreground', `maxSteps=${maxSteps}`);
    session.begin({ background: bgMode });
    await sleep(600); // let the minimize animation finish before the first screenshot

    for (let step = 1; step <= maxSteps && !agent.stopped; step++) {
      status(t('화면 확인 중…'));
      const own = session.ownHandles();
      const shot = { maxWidth: quality === 'accurate' ? 1920 : 1600, quality: quality === 'accurate' ? 82 : 72 };
      let obs = null;
      let closedNote = '';
      if (bgMode && bgs.target) {
        try {
          obs = await helper.call('wobserve', { hwnd: bgs.target, ...shot }, 20_000);
          obs.background = true;
        } catch (e) {
          // The target window closed (e.g. a dialog finished): go back to the window that opened it.
          const prev = bgs.parents.pop() || null;
          closedNote = `the target window closed${prev ? '; you are back in the window that opened it' : ''}`;
          bgs.target = prev;
          if (prev) obs = await helper.call('wobserve', { hwnd: prev, ...shot }, 20_000).then((o) => ({ ...o, background: true })).catch(() => null);
          if (!obs) bgs.target = null;
        }
      }
      if (!obs) {
        obs = await helper.call('observe', bgMode ? { ...shot, maxElements: 0, marks: false } : shot, 20_000);
        if (bgMode) Object.assign(obs, { background: true, noTarget: true, userForeground: obs.foreground });
      }
      if (closedNote) history.push({ step, summary: closedNote });
      const wl = await helper.call('windows');
      if (agent.stopped) break;
      const windows = wl.windows.filter((w) => !own.has(w.hwnd)).slice(0, 25);

      status(t('다음 행동을 판단 중…'));
      let decision;
      try {
        const raw = await agent.llm({
          provider,
          quality,
          sessionId,
          system: forAi((sandbox ? DESKTOP_SYSTEM_PROMPT + SANDBOX_RULES : bgMode ? DESKTOP_SYSTEM_PROMPT + BACKGROUND_RULES : DESKTOP_SYSTEM_PROMPT) + (process.platform === 'darwin' ? MAC_RULES : '')),
          prompt: buildDesktopStepPrompt({ goal, notes, history, obs, windows, step, folders, toolOutput, workdir: agent.workdir, maxSteps }),
          images: [{ mime: 'image/jpeg', data: obs.image }],
        });
        if (agent.stopped) break;
        decision = parseDecision(raw, DESKTOP_ACTIONS);
        badReplies = 0;
        toolOutput = '';
      } catch (e) {
        if (agent.stopped) break;
        if (/JSON|action/.test(e.message) && ++badReplies <= 2) {
          history.push({ step, summary: `Your reply was invalid (${e.message}). Reply with one JSON object only.` });
          continue;
        }
        throw e;
      }

      const { thought, actions } = decision;
      if (decision.notes) notes = decision.notes;
      agent.log('desktop step', step, obs.foreground?.process, JSON.stringify(actions).slice(0, 300));

      const first = actions[0];
      if (first.type === 'done') {
        agent.emitEvent('step', { step, thought, action: first, label: t('완료'), url: obs.foreground?.title || '' });
        return first.answer || thought;
      }
      if (first.type === 'ask_user') {
        agent.emitEvent('step', { step, thought, action: first, label: t('사용자에게 질문'), url: obs.foreground?.title || '' });
        const ans = await ask(first.question || thought);
        if (ans === null) break;
        history.push({ step, summary: `asked user "${first.question}" -> "${ans}"` });
        continue;
      }

      // Resolve every target against this observation up front (ids are only valid for it).
      const planned = [];
      for (const action of actions) {
        if (['done', 'ask_user'].includes(action.type)) break; // handled next turn after a fresh look
        let target = null;
        let error = null;
        try {
          target = ['click', 'double_click', 'type', 'scroll', 'read_text'].includes(action.type) ? resolveTarget(action, obs) : null;
          if (action.type === 'pick_file') {
            action.resolvedPath = pickPath(action.path, agent.workdir);
            if (sandbox) {
              // The AI 작업 PC sees only the work folder (as C:\work): copy other files there first.
              action.resolvedPath = sandbox.guestPath(action.resolvedPath) || (() => { throw new Error('in the AI 작업 PC only work-folder files can be picked: copy_file it into the work folder first'); })();
            }
          }
          if (!bgMode && target && !target.element && (action.type === 'click' || action.type === 'double_click' || action.type === 'type')) {
            const r = await helper.call('at', { x: target.x, y: target.y }).catch(() => null);
            if (r?.element) target.element = r.element;
          }
        } catch (e) {
          error = short(e);
        }
        planned.push({ action, target, error, label: describeDesktopAction(action, target) });
      }
      agent.emitEvent('step', { step, thought, action: first, label: planned.map((p) => p.label).join('  →  '), url: obs.foreground?.title || '' });
      session.status(thought || planned[0]?.label || '');

      const results = [];
      let chainFailed = false;
      for (let i = 0; i < planned.length && !agent.stopped; i++) {
        const { action, target, error, label } = planned[i];
        if (error) {
          results.push(`${label} -> FAILED: ${error}`);
          agent.emitEvent('result', { step, result: `FAILED: ${error}` });
          chainFailed = true;
          break;
        }
        const risk = desktopRiskOf(action, { target, fg: obs.foreground, typing: agent.settings?.get('safety.typing') });
        if (risk && !(await confirm(risk))) {
          results.push(`${label} -> user DECLINED this action; choose another way or finish`);
          chainFailed = true;
          break;
        }
        if (agent.stopped) break;

        let result;
        if (action.type === 'read_text') {
          try {
            const w = action.window != null ? windows[Number(action.window) - 1] : null;
            if (action.window != null && !w) throw new Error(`no window number ${action.window}`);
            // Background: always the whole target window (a screen point could be the user's window on top).
            const point = target && !bgMode ? { x: target.x, y: target.y } : {};
            const r = await helper.call('readtext', { hwnd: w?.hwnd ?? (bgMode ? bgs.target : obs.foreground?.hwnd), ...point, max: 40_000 }, 15_000);
            const text = String(r.text || '').trim();
            if (!text) throw new Error('no readable text there (the app draws its own text): read the screenshot instead');
            const title = String(r.window?.title || '').slice(0, 60);
            toolOutput += `${toolOutput ? '\n\n' : ''}[화면 글자: ${title}]\n${text}`;
            result = `read ${text.length} chars from "${title}" (shown under TOOL OUTPUT next turn)`;
          } catch (e) {
            result = `FAILED: ${short(e)}`;
          }
        } else if (TOOL_TYPES.has(action.type)) {
          try {
            const r = await runTool(action, { workdir: agent.workdir, page: null, userDirs: [folders.desktop, folders.documents, folders.downloads, folders.pictures, folders.videos].filter(Boolean) });
            result = r.summary;
            if (r.output) toolOutput += (toolOutput ? '\n\n' : '') + r.output;
          } catch (e) {
            result = `FAILED: ${short(e)}`;
          }
        } else if (action.type === 'delegate') {
          status(t('플랫폼 스킬·플러그인으로 작업 중…'));
          try {
            const text = await agent.assistant(provider, String(action.task || ''));
            agent.emitEvent('assistant', { text });
            result = `delegate result: ${text.slice(0, 1500)}`;
          } catch (e) {
            result = `FAILED: ${short(e)}`;
          }
        } else {
          if (planned.length > 1) session.status(`${label} (${i + 1}/${planned.length})`);
          // Keystrokes go to whatever window has focus. If it is no longer the window the model
          // looked at (the user clicked elsewhere, a messenger popped up, an app stole focus),
          // typing could land in the wrong app — e.g. send a KakaoTalk message. Refuse and look again.
          const needsSameWindow = !bgMode && ((action.type === 'type' && !target) || action.type === 'key');
          if (needsSameWindow && obs.foreground?.hwnd) {
            const fg = (await helper.call('foreground').catch(() => null))?.window;
            if (fg && fg.hwnd !== obs.foreground.hwnd) {
              const msg = `FAILED: did NOT ${action.type} — the window in front changed to ${fg.process} "${String(fg.title).slice(0, 40)}" since your screenshot. Look again and bring the right window to the front first.`;
              results.push(`${label} -> ${msg}`);
              agent.emitEvent('result', { step, result: msg });
              chainFailed = true;
              break;
            }
          }
          try {
            result = bgMode
              ? await executeBackground({ helper, session }, action, target, obs, windows, bgs)
              : await executeDesktop({ helper, session }, action, target, obs, windows);
          } catch (e) {
            result = `FAILED: ${short(e)}`;
          }
          await sleep(SETTLE_MS[action.type] ?? 400); // let the UI react
        }
        results.push(`${label} -> ${result}`);
        agent.emitEvent('result', { step, result });
        if (result.startsWith('FAILED')) {
          chainFailed = true;
          break;
        }
        if (bgMode && bgs.target) {
          // A dialog opened by the target app (Save As, 열기, a popup) becomes the target.
          const known = new Set(wl.windows.map((w) => w.hwnd));
          const tproc = obs.noTarget ? null : obs.foreground?.process;
          const fresh = tproc && (await helper.call('windows').catch(() => ({ windows: [] }))).windows.find((w) => !known.has(w.hwnd) && w.process === tproc && w.hwnd !== bgs.target && !bgs.own().has(w.hwnd));
          if (fresh) {
            bgs.parents.push(bgs.target);
            bgs.target = fresh.hwnd;
            results.push(`(a new window "${String(fresh.title).slice(0, 40)}" opened from the target app: it is now your target — look again)`);
            break;
          }
          if (action.type === 'launch' || action.type === 'focus_window') break; // new target: look at it first
          continue;
        }
        if (i < planned.length - 1) {
          // A new window or dialog (Save As, popup) invalidates the remaining ids: look again.
          const fg = (await helper.call('foreground').catch(() => null))?.window;
          if (fg && fg.hwnd !== obs.foreground?.hwnd) {
            results.push(`(chain stopped: "${String(fg.title).slice(0, 40)}" is now in front — look again)`);
            break;
          }
        }
      }
      failures = chainFailed ? failures + 1 : 0;
      if (failures >= 3) history.push({ step, summary: 'Several turns failed in a row: re-read the screenshot, try another approach or ask_user.' });
      history.push({ step, summary: results.join(' ; ') || 'no action executed' });
    }

    if (agent.stopped) return null;
    return t('최대 단계({max})에 도달해 멈췄습니다. 마지막 메모: {notes}', { max: maxSteps, notes: notes || t('(없음)') });
  } finally {
    session.end();
    agent.server.request('/v1/llm/session/close', { method: 'POST', body: { sessionId } }).catch(() => {});
  }
}

/** File for a file dialog: absolute path, or a name in the work folder. Must exist. */
function pickPath(p, workdir) {
  const raw = String(p || '').trim();
  if (!raw) throw new Error('pick_file needs "path"');
  const full = path.isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw) ? raw : resolveIn(workdir, raw);
  if (!fs.existsSync(full)) throw new Error(`file not found: ${full}`);
  return full;
}

module.exports = { runDesktop, desktopLoop, executeDesktop, pickPath };
