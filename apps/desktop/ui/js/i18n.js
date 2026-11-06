// Interface language for the UI (설정 > 화면 > 언어). Loaded before every other UI script.
// ANB.t(koreanText, vars) returns the text in the current language; static text in
// index.html is translated once on load (text nodes and the attributes below).
(() => {
  const EN = window.NURI_EN || {};
  // The desktop window gets it from the main process (preload); helper pages in the URL (?lang=).
  const fromApp = (window.anb && window.anb.lang) || new URLSearchParams(location.search).get('lang');
  let cached = '';
  try {
    cached = localStorage.getItem('nuri.lang') || '';
  } catch {
    /* storage unavailable */
  }
  const lang = fromApp || cached || (/^ko\b/i.test(navigator.language) ? 'ko' : 'en');
  try {
    localStorage.setItem('nuri.lang', lang);
  } catch {
    /* optional */
  }

  const has = (k) => Object.prototype.hasOwnProperty.call(EN, k);

  function t(ko, vars) {
    let text = lang === 'en' && has(ko) ? EN[ko] : ko;
    if (vars) text = text.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
    return text;
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'data-prompt'];

  /** Translates static text under `root` (keeps the spaces around each text). */
  function translate(root) {
    if (lang !== 'en') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const key = n.nodeValue.trim();
      if (key && has(key)) n.nodeValue = n.nodeValue.replace(key, EN[key]);
    }
    for (const e of root.querySelectorAll('*')) {
      for (const a of ATTRS) {
        const v = e.getAttribute(a);
        if (v && has(v.trim())) e.setAttribute(a, EN[v.trim()]);
      }
    }
  }

  document.documentElement.lang = lang;
  translate(document.body);
  if (lang === 'en') document.title = document.title.replace(/.+/, (s) => t(s));

  window.NURI_I18N = { lang, t, translate, locale: lang === 'en' ? 'en-US' : 'ko-KR' };
})();
