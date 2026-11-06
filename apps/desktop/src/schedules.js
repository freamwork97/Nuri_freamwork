// 예약 작업: runs saved tasks at set times (once / daily / weekdays / weekly / monthly / every N
// minutes, hours or days) while the app is running, including when it is hidden in the tray.
// Stored per Windows user in userData/anb-schedules.json, encrypted when `crypt` is given.
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { t, locale } = require('./i18n');

const REPEATS = new Set(['once', 'daily', 'weekdays', 'weekly', 'monthly', 'interval']);
const UNITS = { min: { minutes: 1, label: '{n}분마다' }, hour: { minutes: 60, label: '{n}시간마다' }, day: { minutes: 1440, label: '{n}일마다' } };
const MIN_INTERVAL = 10; // minutes
const MAX_INTERVAL = 90 * 1440;
const MAX_FAILS = 5; // repeating runs stop after this many errors in a row
const MODES = new Set(['browser', 'desktop', 'autopilot', 'assistant']);
const PROVIDERS = new Set(['gemini', 'claude', 'gpt']);
const TICK_MS = 30_000;
const GRACE_MS = 10 * 60_000; // a run missed by less than this (app just started, PC woke up) still runs
const MAX_WAIT_MS = 60 * 60_000; // waiting for a busy agent: give up after an hour
const MAX_SCHEDULES = 50;

const pad = (n) => String(n).padStart(2, '0');

/** Validates and normalizes one schedule from the UI; throws a Korean message on bad input. */
function normalize(input = {}, now = Date.now()) {
  const goal = String(input.goal ?? '').trim().slice(0, 20_000);
  if (!goal) throw new Error(t('예약할 작업 내용이 비어 있습니다'));
  const repeat = REPEATS.has(input.repeat) ? input.repeat : 'daily';
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(input.time ?? ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(t('시간 형식이 올바르지 않습니다 (예: 09:00)'));
  const s = {
    id: typeof input.id === 'string' && /^[\w-]{1,40}$/.test(input.id) ? input.id : `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    goal,
    mode: MODES.has(input.mode) ? input.mode : 'browser',
    provider: PROVIDERS.has(input.provider) ? input.provider : 'gemini',
    quality: input.quality === 'accurate' ? 'accurate' : 'fast',
    repeat,
    time: `${pad(m[1])}:${m[2]}`,
    enabled: input.enabled !== false,
  };
  if (repeat === 'weekly') s.day = Number.isInteger(input.day) && input.day >= 0 && input.day <= 6 ? input.day : new Date(now).getDay();
  if (repeat === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date ?? ''))) throw new Error(t('날짜를 선택하세요'));
    s.date = input.date;
  }
  if (repeat === 'monthly') s.monthDay = Number.isInteger(input.monthDay) && input.monthDay >= 1 && input.monthDay <= 31 ? input.monthDay : new Date(now).getDate();
  if (repeat === 'interval') {
    const every = Number(input.every);
    s.unit = UNITS[input.unit] ? input.unit : 'hour';
    s.every = every;
    s.everyMin = every * UNITS[s.unit].minutes;
    if (!Number.isInteger(every) || s.everyMin < MIN_INTERVAL || s.everyMin > MAX_INTERVAL) throw new Error(t('주기는 {min}분에서 {max}일 사이로 정하세요', { min: MIN_INTERVAL, max: MAX_INTERVAL / 1440 }));
    const d = new Date(now);
    // The first day stays fixed, so runs keep their rhythm when the app restarts.
    s.since = /^\d{4}-\d{2}-\d{2}$/.test(String(input.since ?? '')) ? input.since : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return s;
}

/** Next run time (ms) strictly after `after`, or null (a past one-time schedule). Local time. */
function nextRun(s, after) {
  const [h, min] = s.time.split(':').map(Number);
  if (s.repeat === 'once') {
    const [y, mo, d] = s.date.split('-').map(Number);
    const t = new Date(y, mo - 1, d, h, min).getTime();
    return t > after ? t : null;
  }
  if (s.repeat === 'interval') {
    const [y, mo, d] = s.since.split('-').map(Number);
    const start = new Date(y, mo - 1, d, h, min).getTime();
    const step = s.everyMin * 60_000;
    return after < start ? start : start + (Math.floor((after - start) / step) + 1) * step;
  }
  if (s.repeat === 'monthly') {
    const base = new Date(after);
    for (let i = 0; i <= 12; i++) {
      const last = new Date(base.getFullYear(), base.getMonth() + i + 1, 0).getDate();
      const c = new Date(base.getFullYear(), base.getMonth() + i, Math.min(s.monthDay, last), h, min).getTime();
      if (c > after) return c;
    }
    return null;
  }
  const base = new Date(after);
  for (let i = 0; i <= 7; i++) {
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, min);
    if (c.getTime() <= after) continue;
    const day = c.getDay();
    if (s.repeat === 'weekdays' && (day === 0 || day === 6)) continue;
    if (s.repeat === 'weekly' && day !== s.day) continue;
    return c.getTime();
  }
  return null;
}

const DAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

/** "매일 09:00", "평일 18:30", "매주 월 09:00", "10월 28일 09:00". */
function describe(s) {
  if (s.repeat === 'daily') return t('매일 {time}', { time: s.time });
  if (s.repeat === 'weekdays') return t('평일 {time}', { time: s.time });
  if (s.repeat === 'weekly') return t('매주 {day} {time}', { day: t(DAYS[s.day]), time: s.time });
  if (s.repeat === 'monthly') return t('매월 {n}일 {time}', { n: s.monthDay, time: s.time });
  if (s.repeat === 'interval') return t('{every} ({time} 기준)', { every: t(UNITS[s.unit].label, { n: s.every }), time: s.time });
  const [, mo, d] = s.date.split('-').map(Number);
  return t('{mo}월 {d}일 {time}', { mo, d, time: s.time });
}

/**
 * The goal the agent gets for a run: the saved goal plus what the previous successful run
 * produced, so a repeated task ("매일 신규 공고") can tell new results from ones already found.
 */
function runGoal(s) {
  const p = s.previous;
  if (!p) return s.goal;
  const when = new Date(p.at).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  const files = (p.files || []).map((f) => `- ${f}`).join('\n');
  return `${s.goal}

${t('[예약 작업 — 이전 실행 참고]')}
${t('이 작업은 정해진 시간마다 반복 실행됩니다. 지난번 성공한 실행({when})의 결과입니다.', { when })}
${p.answer ? `${t('지난 결과 요약:')}\n${p.answer}\n` : ''}${files ? `${t('지난 결과 파일:')}\n${files}\n` : ''}${t('새로 생긴 것·달라진 것만 골라야 하면 위 결과와 비교하고, 결과에 "신규" 여부를 표시하세요.')}`;
}

class Schedules extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.file JSON file path
   * @param {() => boolean} o.isBusy true while a task runs
   * @param {(s: object) => void} o.run starts the task
   * @param {{encrypt: (text: string) => string, decrypt: (data: string) => string}} [o.crypt] protects the file
   */
  constructor({ file, isBusy, run, log = () => {}, now = () => Date.now(), crypt = null }) {
    super();
    Object.assign(this, { file, isBusy, run, log, now, crypt });
    this.items = this.load();
    // Recompute on start: runs missed while the app was closed are skipped unless just missed.
    const t = this.now();
    for (const s of this.items) if (!s.next || s.next < t - GRACE_MS) s.next = s.enabled ? nextRun(s, t) : null;
    // A run still marked running: the app died during it. It is not repeated: it may have half
    // published something. The user is told, and a repeating schedule goes on at its next time.
    this.interrupted = this.items.filter((s) => s.lastResult === 'running');
    for (const s of this.interrupted) s.lastResult = 'interrupted';
    this.persist();
  }

  load() {
    try {
      let raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.encrypted) {
        try {
          raw = JSON.parse(this.crypt.decrypt(raw.encrypted));
        } catch (e) {
          // Another user's file, or the Windows profile was reset. Kept: the next save would replace it.
          this.log('schedules unreadable', e.message);
          fs.copyFileSync(this.file, `${this.file}.unreadable`);
          return [];
        }
      }
      return (Array.isArray(raw) ? raw : []).flatMap((x) => {
        try {
          return [{ ...normalize(x), next: Number(x.next) || null, lastRun: x.lastRun || null, lastResult: x.lastResult || null, fails: x.fails || 0, ...(x.previous && typeof x.previous === 'object' ? { previous: x.previous } : {}) }];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  persist() {
    try {
      const text = JSON.stringify(this.items, null, 2);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, this.crypt ? JSON.stringify({ encrypted: this.crypt.encrypt(text) }) : text, { mode: 0o600 });
      fs.renameSync(tmp, this.file); // a crash mid-write must not lose the schedules
    } catch (e) {
      this.log('schedules save failed', e.message);
    }
  }

  list() {
    return this.items.map((s) => ({ ...s, label: describe(s) }));
  }

  /** The enabled schedule that runs next (for the tray tooltip), or null. */
  upcoming() {
    const s = this.items.filter((x) => x.enabled && x.next).sort((a, b) => a.next - b.next)[0];
    return s ? { ...s, label: describe(s) } : null;
  }

  changed() {
    this.persist();
    this.emit('change', this.list());
  }

  save(input) {
    const s = normalize(input, this.now());
    const i = this.items.findIndex((x) => x.id === s.id);
    if (i < 0 && this.items.length >= MAX_SCHEDULES) throw new Error(t('예약은 최대 {n}개까지 만들 수 있습니다', { n: MAX_SCHEDULES }));
    const prev = i >= 0 ? this.items[i] : {};
    // Editing the goal starts over: the previous result belongs to the old task.
    const previous = prev.goal === s.goal ? prev.previous : undefined;
    const item = { ...s, lastRun: prev.lastRun || null, lastResult: prev.lastResult || null, ...(previous ? { previous } : {}), next: s.enabled ? nextRun(s, this.now()) : null };
    if (s.enabled && item.next == null) throw new Error(t('이미 지난 시간입니다'));
    if (i >= 0) this.items[i] = item;
    else this.items.push(item);
    this.changed();
    return { ...item, label: describe(item) };
  }

  remove(id) {
    this.items = this.items.filter((s) => s.id !== id);
    this.changed();
  }

  /**
   * Records how a scheduled run ended (shown in the list). A successful run's answer and files
   * are kept for the next run (runGoal).
   */
  finished(id, result, { answer, files } = {}) {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    s.lastResult = result;
    s.fails = result === 'error' ? (s.fails || 0) + 1 : 0;
    if (s.fails >= MAX_FAILS && s.enabled) {
      s.enabled = false;
      s.next = null;
      this.log('schedule turned off after errors', s.id);
      this.emit('disabled', s);
    }
    if (result === 'done') {
      s.previous = {
        at: s.lastRun || this.now(),
        answer: String(answer || '').slice(0, 3000),
        files: (Array.isArray(files) ? files : []).map(String).filter(Boolean).slice(0, 12),
      };
    }
    this.changed();
  }

  start() {
    for (const s of this.interrupted.splice(0)) this.emit('interrupted', s);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    setTimeout(() => this.tick(), 5000).unref?.();
  }

  /** No new runs for a while: right after the PC wakes up the network is not back yet. */
  hold(ms) {
    this.heldUntil = this.now() + ms;
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const t = this.now();
    if (t < (this.heldUntil || 0)) return;
    const due = this.items.filter((s) => s.enabled && s.next && s.next <= t).sort((a, b) => a.next - b.next);
    if (!due.length) return;
    const s = due[0];
    if (t - s.next > MAX_WAIT_MS) {
      this.log('schedule skipped (too late)', s.id, describe(s));
      s.lastResult = 'skipped';
      this.emit('skipped', s);
      this.advance(s, t);
      return this.changed();
    }
    if (this.isBusy()) return; // another task is running: try again on the next tick
    this.log('schedule run', s.id, describe(s));
    s.lastRun = t;
    s.lastResult = 'running';
    this.advance(s, t);
    this.changed();
    try {
      this.run(s);
    } catch (e) {
      this.log('schedule run failed', e.message);
      this.finished(s.id, 'error');
    }
  }

  advance(s, t) {
    s.next = nextRun(s, t);
    if (s.repeat === 'once') {
      s.enabled = false;
      s.next = null;
    }
  }
}

module.exports = { Schedules, normalize, nextRun, describe, runGoal };
