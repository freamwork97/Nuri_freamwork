const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GoogleBrowser } = require('../src/google-browser');

const STUDIO = 'https://studio.youtube.com/channel/x';
const SIGNIN = 'https://accounts.google.com/v3/signin/identifier?continue=x';

/** A GoogleBrowser whose Chrome ends up on `url`. `release` holds the check open when given. */
const make = ({ url = STUDIO, state, release } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-google-'));
  const stateFile = path.join(dir, 'state.json');
  if (state) fs.writeFileSync(stateFile, JSON.stringify(state));
  let clock = Date.UTC(2026, 10, 2);
  const g = new GoogleBrowser({ exe: 'x', profileDir: dir, stateFile, settings: {}, loginOpen: () => false, agentBusy: () => false, now: () => clock });
  g.settleMs = 0;
  g.engines = 0;
  g.page = { url: () => url, goto: async () => release };
  g.newEngine = () => {
    g.engines++;
    return { connect: async () => ({ contexts: () => [{ pages: () => [g.page] }] }), close: async () => {} };
  };
  const expired = [];
  g.on('expired', () => expired.push(1));
  return { g, expired, stateFile, later: (ms) => (clock += ms) };
};
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const DAY = 24 * 60 * 60_000;

test('only a window sign-in brought up hides by itself', async () => {
  const { g } = make();
  const moves = [];
  g.placeWindow = async (left) => moves.push(left);
  const at = (url) => {
    g.tabs = { activeId: 1, tabs: new Map([[1, { url, title: '', page: { bringToFront: async () => {} } }]]) };
    g.live = { page: g.tabs.tabs.get(1).page };
  };
  at(SIGNIN);
  g.follow();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(g.shown, 'sign-in');
  at(STUDIO);
  g.follow();
  assert.strictEqual(g.shown, null);
  await g.show(); // "창으로 열기" or a CAPTCHA for the user
  at(`${STUDIO}/next`);
  g.follow();
  assert.strictEqual(g.shown, 'user');
  assert.deepStrictEqual(moves, [120, -32000, 120]);
});

test('a good session is noted and checked once a day', async () => {
  const { g, expired, stateFile, later } = make();
  assert.strictEqual(await g.check(), true);
  assert.strictEqual(read(stateFile).signedIn, true);
  assert.strictEqual(await g.check(), null);
  assert.strictEqual(g.engines, 1);
  later(DAY);
  assert.strictEqual(await g.check(), true);
  assert.strictEqual(expired.length, 0);
});

test('a session that worked before and now shows sign-in has expired', async () => {
  const { g, expired, stateFile } = make({ url: SIGNIN, state: { at: 1, ok: true, signedIn: true } });
  assert.strictEqual(await g.check(), false);
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(read(stateFile).signedIn, true); // keeps reminding until the user signs in
});

test('a profile that never signed in gets no expiry notice', async () => {
  const { g, expired } = make({ url: SIGNIN });
  assert.strictEqual(await g.check(), false);
  assert.strictEqual(expired.length, 0);
});

test('an account without a channel leaves the studio but is not signed out', async () => {
  const { g, expired } = make({ url: 'https://www.youtube.com/create_channel' });
  assert.strictEqual(await g.check(), true);
  assert.strictEqual(expired.length, 0);
});

test('a failed check is not counted, so the next hourly try runs it again', async () => {
  const { g, stateFile } = make();
  g.page.goto = async () => {
    throw new Error('offline');
  };
  assert.strictEqual(await g.check(), null);
  assert.strictEqual(fs.existsSync(stateFile), false);
  assert.strictEqual(g.engine, null);
});

test('a task waits for a running check instead of opening the profile twice', async () => {
  let done;
  const { g } = make({ release: new Promise((r) => (done = r)) });
  g.page.goto = () => new Promise((r) => (done = r));
  const check = g.check();
  await new Promise((r) => setImmediate(r));
  let opened = false;
  const open = g.open().catch(() => {}).finally(() => (opened = true));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(opened, false);
  assert.strictEqual(g.engines, 1);
  done();
  await check;
  await open;
  assert.strictEqual(opened, true);
  assert.strictEqual(g.engines, 2);
});
