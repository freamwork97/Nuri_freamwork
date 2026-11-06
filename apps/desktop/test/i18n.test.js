const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../src/i18n');
const { riskKind } = require('../src/settings');
const { riskOf } = require('../src/agent/decision');
const { desktopRiskOf } = require('../src/desktop/decision');

const ROOT = path.join(__dirname, '..');

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'locales', 'fonts', 'release', 'build', 'native', 'extension'].includes(e.name)) walk(p);
      } else if (/\.(js|html)$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ['src', 'ui']) walk(path.join(ROOT, d));
  out.push(path.join(ROOT, 'main.js'));
  return out;
}

// t('…') / t("…") with a literal Korean text.
const CALL = /\bt\(\s*(['"])((?:\\.|(?!\1).)*?[가-힣](?:\\.|(?!\1).)*?)\1/g;
const unescape = (s, q) => s.replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === q || c === '\\' ? c : m));

test('every translated Korean text has its English, with the same placeholders', () => {
  const missing = [];
  const badVars = [];
  for (const file of sources()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(CALL)) {
      const ko = unescape(m[2], m[1]);
      const en = i18n.EN[ko];
      if (en === undefined) missing.push(`${path.relative(ROOT, file)}: ${ko}`);
      else {
        const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');
        if (vars(ko) !== vars(en)) badVars.push(`${ko} -> ${en}`);
      }
    }
  }
  assert.deepStrictEqual(missing, []);
  assert.deepStrictEqual(badVars, []);
});

// Static text in the HTML pages (translated on load by ui/js/i18n.js) and the 설정 menu data
// (translated when drawn) need their English too.
function staticTexts() {
  const out = [];
  const html = ['index.html', 'overlay.html', 'mirror.html'].map((f) => fs.readFileSync(path.join(ROOT, 'ui', f), 'utf8')).join('\n').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  for (const m of html.matchAll(/>([^<>]*[가-힣][^<>]*)</g)) out.push(m[1].trim().replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  for (const m of html.matchAll(/\s(?:title|placeholder|aria-label|data-prompt)="([^"]*[가-힣][^"]*)"/g)) out.push(m[1].trim());
  const settings = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'settings.js'), 'utf8');
  const data = settings.slice(settings.indexOf('const SECTIONS'), settings.indexOf('function approvalPresets'));
  for (const m of data.matchAll(/\b(?:label|help|title|desc|placeholder): '((?:\\.|[^'])*[가-힣](?:\\.|[^'])*)'/g)) out.push(m[1]);
  for (const m of data.matchAll(/labels: \{([^}]*)\}/g)) for (const v of m[1].matchAll(/'((?:[^'])*[가-힣][^']*)'/g)) out.push(v[1]);
  const approval = settings.match(/const APPROVAL = \{([^}]*)\}/)[1];
  for (const v of approval.matchAll(/'([^']*[가-힣][^']*)'/g)) out.push(v[1]);
  return out;
}

test('static HTML text and the settings menu have their English', () => {
  const missing = [...new Set(staticTexts())].filter((k) => i18n.EN[k] === undefined);
  assert.deepStrictEqual(missing, []);
});

test('t fills placeholders and falls back to Korean', () => {
  i18n.setLang('en');
  assert.strictEqual(i18n.t('결과 파일 {n}개', { n: 3 }), '3 result file(s)');
  assert.strictEqual(i18n.t('사전에 없는 문구'), '사전에 없는 문구');
  i18n.setLang('ko');
  assert.strictEqual(i18n.t('결과 파일 {n}개', { n: 3 }), '결과 파일 3개');
});

test('language setting: auto follows the Windows display language', () => {
  assert.strictEqual(i18n.resolveLang('auto', 'ko-KR'), 'ko');
  assert.strictEqual(i18n.resolveLang('auto', 'en-US'), 'en');
  assert.strictEqual(i18n.resolveLang('auto', 'ja'), 'en');
  assert.strictEqual(i18n.resolveLang('ko', 'en-US'), 'ko');
  assert.strictEqual(i18n.resolveLang('en', 'ko-KR'), 'en');
});

// The approval policy must classify a question the same way in both languages.
test('approval questions are classified the same in Korean and English', () => {
  const refs = new Map([['e1', { role: 'button', name: '결제하기' }], ['e2', { role: 'button', name: 'Delete' }], ['e3', { role: 'button', name: '발행' }]]);
  const cases = [
    () => riskOf({ type: 'click', ref: 'e1' }, refs),
    () => riskOf({ type: 'click', ref: 'e2' }, refs),
    () => riskOf({ type: 'click', ref: 'e3' }, refs),
    () => riskOf({ type: 'delegate', task: 'x' }),
    () => riskOf({ type: 'script', code: 'await page.click("text=결제")' }),
    () => desktopRiskOf({ type: 'launch', target: 'C:\\x\\setup.exe' }),
    () => desktopRiskOf({ type: 'type', text: 'dir\n' }, { fg: { process: 'powershell', className: 'ConsoleWindowClass' } }),
    () => desktopRiskOf({ type: 'key', keys: 'enter' }, { fg: { process: 'cmd', className: 'ConsoleWindowClass' } }),
    () => desktopRiskOf({ type: 'type', text: '안녕\n' }, { fg: { process: 'KakaoTalk' } }),
    () => desktopRiskOf({ type: 'type', text: 'hello' }, { fg: { process: 'notepad' }, typing: 'ask' }),
    () => desktopRiskOf({ type: 'key', keys: 'shift+delete' }, { fg: { process: 'explorer' } }),
  ];
  for (const make of cases) {
    i18n.setLang('ko');
    const ko = make();
    i18n.setLang('en');
    const en = make();
    i18n.setLang('ko');
    assert.ok(ko && en, `question expected: ${ko}`);
    assert.strictEqual(riskKind(en), riskKind(ko), `${ko}\n${en}`);
  }
});

test('schedule labels in English', () => {
  const { describe } = require('../src/schedules');
  i18n.setLang('en');
  try {
    assert.strictEqual(describe({ repeat: 'weekly', day: 1, time: '09:00' }), 'Every Monday 09:00');
    assert.strictEqual(describe({ repeat: 'interval', every: 6, unit: 'hour', time: '09:00' }), 'Every 6 h (from 09:00)');
    assert.strictEqual(describe({ repeat: 'once', date: '2026-11-09', time: '09:00' }), '11/9 09:00');
  } finally {
    i18n.setLang('ko');
  }
});

// A local `t` (parameter or variable) hides the translation function: calling t('…') inside
// it throws "t is not a function" (it once crashed the main process on start).
test('no scope that names something `t` calls t()', () => {
  const found = [];
  for (const file of sources()) {
    const s = fs.readFileSync(file, 'utf8');
    const binders = /(?:function\s*\w*\s*\(([^)]*)\)\s*\{|\b\w+\s*\(([^)]*)\)\s*\{|\(([^()]*)\)\s*=>\s*\{|\b(?:const|let|var)\s+t\s*=)/g;
    for (const m of s.matchAll(binders)) {
      const params = m.slice(1).filter(Boolean).join(' ');
      const declares = /^(const|let|var)/.test(m[0]);
      if (!declares && !/(^|[\s,{(])t($|[\s,})=])/.test(params)) continue;
      let i = declares ? m.index : s.indexOf('{', m.index + m[0].length - 1);
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}' && --depth <= 0) break;
      }
      if (/(?<![\w.])t\(/.test(s.slice(m.index + m[0].length, j))) found.push(`${path.relative(ROOT, file)}:${s.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepStrictEqual(found, []);
});
