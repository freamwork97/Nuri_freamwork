// Builds the agent's view of the current page: compact aria snapshot + page metadata.
const { compactSnapshot } = require('./snapshot');

const CAPTCHA_TEXT = /보안문자|자동입력 방지|로봇이 아닙니다|I'm not a robot|verify you are human/i;

// A security service's full-page "checking you are human" screen (Cloudflare and the like).
const HUMAN_CHECK_TEXT = /사람인지 확인|verifying you are human|checking your browser/i;

async function pageMeta(page) {
  return page.evaluate(({ captchaSource, checkSource }) => {
    const re = new RegExp(captchaSource, 'i');
    const body = (document.body && document.body.innerText) || '';
    // Only a visible challenge counts: invisible reCAPTCHA v3 badges are on many normal pages.
    const captchaFrame = [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"]')].some((f) => {
      if (/size=invisible/.test(f.src)) return false;
      const r = f.getBoundingClientRect();
      const style = getComputedStyle(f);
      return r.width > 60 && r.height > 50 && r.bottom > 0 && r.top < innerHeight && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    return {
      url: location.href,
      title: document.title,
      width: innerWidth,
      height: innerHeight,
      scrollY: Math.round(scrollY),
      scrollMax: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)),
      captcha: captchaFrame || re.test(body.slice(0, 5000)),
      humanCheck: new RegExp(checkSource, 'i').test(body.slice(0, 2000)) && !!document.querySelector('script[src*="challenge-platform"], #challenge-form, [name="cf-turnstile-response"]'),
    };
  }, { captchaSource: CAPTCHA_TEXT.source, checkSource: HUMAN_CHECK_TEXT.source });
}

async function observe(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  const meta = await pageMeta(page);
  const raw = await page.ariaSnapshot({ mode: 'ai', boxes: true, timeout: 10_000 });
  const snap = compactSnapshot(raw, { width: meta.width, height: meta.height });
  return { ...meta, snapshot: snap.text, refs: snap.refs, visibleRefs: snap.visibleRefs, truncated: snap.truncated, offscreen: snap.offscreen };
}

module.exports = { observe, pageMeta };
