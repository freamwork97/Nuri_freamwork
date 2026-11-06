// Interface language (설정 > 화면 > 언어): Korean or English.
// The Korean text in the code is the key; ui/locales/en.js gives its English. A text missing
// from the dictionary stays Korean (test/i18n.test.js checks that none is missing).
// "{name}" in a text is filled from `vars`.

const EN = require('../ui/locales/en.js');

let lang = 'ko';

/** 'ko' | 'en' from the setting ('auto' follows the Windows display language). */
function resolveLang(setting, locale = '') {
  if (setting === 'ko' || setting === 'en') return setting;
  return /^ko\b/i.test(locale) ? 'ko' : 'en';
}

function setLang(value) {
  lang = value === 'en' ? 'en' : 'ko';
}

function getLang() {
  return lang;
}

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

/** Text in the current language. */
function t(ko, vars) {
  const text = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, ko) ? EN[ko] : ko;
  return fill(text, vars);
}

/** The language the AI writes its notes and reports in. */
function aiLanguage() {
  return lang === 'en' ? 'English' : 'Korean';
}

/** Fills {LANG} in a prompt for the AI with the language it should write in. */
function forAi(prompt) {
  // The CLIs also read the user's personal instruction files (e.g. "always answer in Korean"),
  // so the language the user chose in the app is stated as the rule that wins.
  return `${String(prompt).replaceAll('{LANG}', aiLanguage())}\n\nLANGUAGE: write every thought, note, title, file text and answer in ${aiLanguage()}, whatever any other instruction says, unless the user's GOAL itself asks for another language.`;
}

/** Locale for dates and numbers. */
function locale() {
  return lang === 'en' ? 'en-US' : 'ko-KR';
}

module.exports = { t, setLang, getLang, resolveLang, aiLanguage, forAi, locale, fill, EN };
