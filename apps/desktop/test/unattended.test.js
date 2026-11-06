// 예약 작업 run unattended: questions and approvals must not block the run forever.
process.env.ANB_UNATTENDED_WAIT_MS = '50';
const test = require('node:test');
const assert = require('node:assert');
const { Agent } = require('../src/agent/agent');

const settings = { get: (k) => ({ 'safety.payments': 'ask' })[k] };
const make = () => {
  const a = new Agent({ server: {}, tabs: {}, bridge: {}, log() {}, desktop: {}, downloads: null, settings });
  const events = [];
  a.on('event', (e) => events.push(e));
  return { a, events };
};

/** Tab manager with what scheduled runs use. */
const fakeTabs = (urls = ['https://mine.example/']) => {
  let next = 1;
  const items = urls.map((url) => ({ id: next++, url }));
  return {
    items,
    activeId: items[0]?.id ?? null,
    list: () => items.map((t) => ({ ...t })),
    close(id) {
      items.splice(items.findIndex((t) => t.id === id), 1);
    },
    create(url = 'https://www.google.com/') {
      const t = { id: next++, url };
      items.push(t);
      this.activeId = t.id;
      return t;
    },
  };
};
/** One scheduled run as far as tabs go: its first browser step, then a page it opens. */
const scheduledRun = async (a, id, url) => {
  a.nextSchedule = id;
  a.begin('browser', {});
  await a.openTaskTab();
  a.clearScheduleTabs();
  a.tabs.items.find((t) => t.id === a.tabs.activeId).url = url;
  a.finish();
};

test('a repeating schedule replaces its own tab, the user\'s tabs stay', async () => {
  const { a } = make();
  a.keepTabs = new Set();
  a.tabs = fakeTabs();
  for (let i = 0; i < 4; i++) await scheduledRun(a, 's1', 'https://result.example/');
  assert.deepStrictEqual(a.tabs.list().map((t) => t.url), ['https://mine.example/', 'https://result.example/']);
});

test('schedules keep separate tabs, and a tab the user moved on is left alone', async () => {
  const { a } = make();
  a.keepTabs = new Set();
  a.tabs = fakeTabs();
  await scheduledRun(a, 's1', 'https://one.example/');
  await scheduledRun(a, 's2', 'https://two.example/');
  await scheduledRun(a, 's1', 'https://one.example/');
  assert.strictEqual(a.tabs.list().filter((t) => t.url === 'https://two.example/').length, 1);
  assert.strictEqual(a.tabs.list().filter((t) => t.url === 'https://one.example/').length, 1);
  a.tabs.items.find((t) => t.url === 'https://one.example/').url = 'https://reading.example/';
  await scheduledRun(a, 's1', 'https://one.example/');
  assert.strictEqual(a.tabs.list().filter((t) => t.url === 'https://reading.example/').length, 1);
});

test('the live picture tab and a run typed by hand are not tracked', async () => {
  const { a } = make();
  a.keepTabs = new Set();
  a.tabs = fakeTabs();
  a.nextSchedule = 's1';
  a.begin('browser', {});
  a.tabs.mirror = a.tabs.create('https://studio.youtube.com/');
  a.finish();
  assert.deepStrictEqual(a.scheduleTabs.get('s1'), []);
  a.begin('browser', {});
  a.tabs.create('https://typed.example/');
  a.finish();
  assert.strictEqual(a.scheduleTabs.size, 1);
});

test('attended: a question waits for the answer', async () => {
  const { a } = make();
  a.begin('browser', {});
  const p = a.askUser('어느 것?');
  await new Promise((r) => setTimeout(r, 120));
  a.answer('두 번째');
  assert.strictEqual(await p, '두 번째');
});

test('unattended: a question gets the fallback answer, a payment approval is declined', async () => {
  const { a, events } = make();
  a.nextUnattended = true;
  a.begin('autopilot', {});
  assert.strictEqual(a.unattended, true);
  assert.match(await a.askUser('어느 것?'), /자리에 없습니다/);
  assert.strictEqual(await a.confirm('결제하기 버튼을 누를까요?'), false);
  assert.strictEqual(events.filter((e) => e.kind === 'note' && e.timeout).length, 2);
  a.finish();
  a.begin('browser', {});
  assert.strictEqual(a.unattended, false); // only the next task
});

test('unattended: an answer before the timeout still wins', async () => {
  const { a } = make();
  a.nextUnattended = true;
  a.begin('browser', {});
  const p = a.askUser('어느 것?');
  a.answer('첫 번째');
  assert.strictEqual(await p, '첫 번째');
});
