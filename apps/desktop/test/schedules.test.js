const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Schedules, normalize, nextRun, describe, runGoal } = require('../src/schedules');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('nextRun: daily, weekdays, weekly, once', () => {
  const tue10 = at(2026, 10, 27, 10, 0); // Tuesday
  assert.strictEqual(nextRun({ repeat: 'daily', time: '09:00' }, tue10), at(2026, 10, 28, 9));
  assert.strictEqual(nextRun({ repeat: 'daily', time: '11:30' }, tue10), at(2026, 10, 27, 11, 30));
  const fri10 = at(2026, 10, 30, 10);
  assert.strictEqual(nextRun({ repeat: 'weekdays', time: '09:00' }, fri10), at(2026, 11, 2, 9)); // Monday
  assert.strictEqual(nextRun({ repeat: 'weekly', day: 1, time: '09:00' }, tue10), at(2026, 11, 2, 9));
  assert.strictEqual(nextRun({ repeat: 'weekly', day: 2, time: '09:00' }, tue10), at(2026, 11, 3, 9)); // same day, already past
  assert.strictEqual(nextRun({ repeat: 'once', date: '2026-10-28', time: '08:00' }, tue10), at(2026, 10, 28, 8));
  assert.strictEqual(nextRun({ repeat: 'once', date: '2026-10-27', time: '08:00' }, tue10), null);
});

test('normalize validates input', () => {
  assert.throws(() => normalize({ goal: ' ', time: '09:00' }), /비어/);
  assert.throws(() => normalize({ goal: 'x', time: '25:00' }), /시간/);
  assert.throws(() => normalize({ goal: 'x', time: '09:00', repeat: 'once' }), /날짜/);
  const s = normalize({ goal: 'x', time: '9:05', mode: 'evil', provider: 'other' });
  assert.deepStrictEqual([s.time, s.mode, s.provider, s.repeat, s.enabled], ['09:05', 'browser', 'gemini', 'daily', true]);
  assert.strictEqual(describe({ repeat: 'weekly', day: 1, time: '09:00' }), '매주 월요일 09:00');
});

test('scheduler runs due tasks, waits while busy, and persists', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anb-sch-')), 's.json');
  let now = at(2026, 10, 27, 8, 0);
  let busy = false;
  const runs = [];
  const sch = new Schedules({ file, isBusy: () => busy, run: (s) => runs.push(s.goal), now: () => now });
  sch.save({ goal: '날씨 확인', time: '09:00', repeat: 'daily' });
  sch.save({ goal: '한 번만', time: '09:00', repeat: 'once', date: '2026-10-27' });
  now = at(2026, 10, 27, 8, 59);
  sch.tick();
  assert.deepStrictEqual(runs, []);
  now = at(2026, 10, 27, 9, 0, 30);
  busy = true;
  sch.tick();
  assert.deepStrictEqual(runs, []);
  busy = false;
  sch.tick();
  sch.tick();
  assert.deepStrictEqual(runs, ['날씨 확인', '한 번만']);
  const once = sch.list().find((s) => s.repeat === 'once');
  assert.strictEqual(once.enabled, false);
  assert.strictEqual(sch.list()[0].next, at(2026, 10, 28, 9));
  // Reloaded from disk after the app was closed for two days: the missed runs are skipped.
  now = at(2026, 10, 29, 12, 0);
  const again = new Schedules({ file, isBusy: () => false, run: (s) => runs.push(s.goal), now: () => now });
  again.tick();
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(again.list()[0].next, at(2026, 10, 30, 9));
});

test('a run late by more than an hour is skipped', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anb-sch-')), 's.json');
  let now = at(2026, 10, 27, 8, 0);
  const runs = [];
  const sch = new Schedules({ file, isBusy: () => true, run: (s) => runs.push(s), now: () => now });
  sch.save({ goal: 'x', time: '09:00' });
  now = at(2026, 10, 27, 10, 1);
  sch.tick();
  assert.strictEqual(runs.length, 0);
  assert.strictEqual(sch.list()[0].lastResult, 'skipped');
  assert.strictEqual(sch.list()[0].next, at(2026, 10, 28, 9));
});

test('upcoming: the enabled schedule that runs first', () => {
  let t = at(2026, 10, 27, 10);
  const file = path.join(os.tmpdir(), `anb-sched-up-${process.pid}.json`);
  const s = new Schedules({ file, isBusy: () => false, run() {}, now: () => t });
  assert.strictEqual(s.upcoming(), null);
  s.save({ goal: 'a', time: '18:00', repeat: 'daily' });
  s.save({ goal: 'b', time: '12:00', repeat: 'daily' });
  s.save({ goal: 'c', time: '11:00', repeat: 'daily', enabled: false });
  assert.strictEqual(s.upcoming().goal, 'b');
  assert.strictEqual(s.upcoming().label, '매일 12:00');
  fs.rmSync(file, { force: true });
});

test('previous run: kept after success, passed into the next goal, dropped when the goal changes', () => {
  let t = at(2026, 10, 27, 8, 59);
  const file = path.join(os.tmpdir(), `anb-sched-prev-${process.pid}.json`);
  const runs = [];
  const s = new Schedules({ file, isBusy: () => false, run: (x) => runs.push(runGoal(x)), now: () => t });
  const saved = s.save({ goal: '나라장터 신규 공고', time: '09:00', repeat: 'daily', mode: 'autopilot' });
  t = at(2026, 10, 27, 9, 0, 10);
  s.tick();
  assert.strictEqual(runs[0], '나라장터 신규 공고'); // first run: nothing to compare with
  s.finished(saved.id, 'done', { answer: '공고 3건', files: ['D:\\w\\p1\\공고.xlsx'] });
  t = at(2026, 10, 28, 9, 0, 10);
  s.tick();
  assert.match(runs[1], /^나라장터 신규 공고\n\n\[예약 작업 — 이전 실행 참고\]/);
  assert.match(runs[1], /공고 3건/);
  assert.match(runs[1], /- D:\\w\\p1\\공고\.xlsx/);
  s.finished(saved.id, 'error');
  // survives a reload; an error keeps the last successful result
  const again = new Schedules({ file, isBusy: () => false, run() {}, now: () => t });
  assert.strictEqual(again.items[0].previous.answer, '공고 3건');
  again.save({ ...again.items[0], goal: '다른 작업' });
  assert.strictEqual(again.items[0].previous, undefined);
  fs.rmSync(file, { force: true });
});

test('interval schedules keep their rhythm from the fixed first day', () => {
  const now = at(2026, 10, 27, 8, 0);
  const s = normalize({ goal: 'x', repeat: 'interval', every: 6, unit: 'hour', time: '09:00' }, now);
  assert.strictEqual(s.since, '2026-10-27');
  assert.strictEqual(describe(s), '6시간마다 (09:00 기준)');
  assert.strictEqual(nextRun(s, now), at(2026, 10, 27, 9));
  assert.strictEqual(nextRun(s, at(2026, 10, 27, 9)), at(2026, 10, 27, 15));
  assert.strictEqual(nextRun(s, at(2026, 10, 29, 16)), at(2026, 10, 29, 21));
  assert.throws(() => normalize({ goal: 'x', repeat: 'interval', every: 5, unit: 'min', time: '09:00' }, now), /10분/);
  assert.throws(() => normalize({ goal: 'x', repeat: 'interval', every: 1.5, unit: 'hour', time: '09:00' }, now));
});

test('monthly schedules fall back to the last day of a short month', () => {
  const s = normalize({ goal: 'x', repeat: 'monthly', monthDay: 31, time: '09:00' }, at(2026, 11, 1, 8));
  assert.strictEqual(describe(s), '매월 31일 09:00');
  assert.strictEqual(nextRun(s, at(2026, 11, 1, 8)), at(2026, 11, 30, 9));
  assert.strictEqual(nextRun(s, at(2026, 11, 30, 9)), at(2026, 12, 31, 9));
});

test('a repeating schedule turns itself off after five errors in a row', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anb-sch-')), 's.json');
  const sch = new Schedules({ file, isBusy: () => false, run: () => {}, now: () => at(2026, 10, 27, 8) });
  const off = [];
  sch.on('disabled', (s) => off.push(s.id));
  const { id } = sch.save({ goal: 'x', time: '09:00' });
  for (let i = 0; i < 4; i++) sch.finished(id, 'error');
  sch.finished(id, 'done');
  for (let i = 0; i < 4; i++) sch.finished(id, 'error');
  assert.strictEqual(sch.list()[0].enabled, true, 'a success resets the count');
  sch.finished(id, 'error');
  assert.deepStrictEqual(off, [id]);
  assert.strictEqual(sch.list()[0].enabled, false);
});

test('a run the app died in is reported once and not repeated', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anb-sch-')), 's.json');
  const now = at(2026, 10, 27, 9, 5);
  fs.writeFileSync(file, JSON.stringify([{ id: 'a', goal: '업로드', time: '09:00', lastResult: 'running', lastRun: now, next: at(2026, 10, 28, 9), fails: 2 }]));
  const runs = [];
  const opts = { file, isBusy: () => false, run: (s) => runs.push(s), now: () => now };
  const sch = new Schedules(opts);
  const seen = [];
  sch.on('interrupted', (s) => seen.push(s.id));
  sch.start();
  sch.stop();
  sch.tick();
  assert.deepStrictEqual(seen, ['a']);
  assert.strictEqual(runs.length, 0);
  const s = sch.list()[0];
  assert.strictEqual(s.lastResult, 'interrupted');
  assert.strictEqual(s.fails, 2); // not an error of the task itself
  assert.strictEqual(s.next, at(2026, 10, 28, 9));
  const again = new Schedules(opts);
  assert.strictEqual(again.interrupted.length, 0);
});

test('hold keeps runs back until the time is over', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anb-sch-')), 's.json');
  let now = at(2026, 10, 27, 8, 59);
  const runs = [];
  const sch = new Schedules({ file, isBusy: () => false, run: (s) => runs.push(s), now: () => now });
  sch.save({ goal: 'x', time: '09:00' });
  now = at(2026, 10, 27, 9, 10);
  sch.hold(60_000);
  sch.tick();
  assert.strictEqual(runs.length, 0);
  now += 60_000;
  sch.tick();
  assert.strictEqual(runs.length, 1);
});

test('the schedule file is encrypted, and an unreadable one is kept', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'anb-sch-')), 's.json');
  const crypt = { encrypt: (t) => Buffer.from(t).toString('base64'), decrypt: (d) => Buffer.from(d, 'base64').toString() };
  const opts = { file, isBusy: () => false, run: () => {}, now: () => at(2026, 10, 27, 8) };
  fs.writeFileSync(file, JSON.stringify([{ goal: '비밀 업무', time: '09:00' }]));
  const sch = new Schedules({ ...opts, crypt });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('비밀 업무'), 'an old plain file is encrypted on load');
  assert.strictEqual(new Schedules({ ...opts, crypt }).list()[0].goal, '비밀 업무');
  const other = new Schedules({ ...opts, crypt: { encrypt: crypt.encrypt, decrypt: () => { throw new Error('no key'); } } });
  assert.strictEqual(other.list().length, 0);
  assert.ok(fs.existsSync(`${file}.unreadable`));
  assert.ok(fs.statSync(file).size > 0);
});
