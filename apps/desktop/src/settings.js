// User settings ("설정" page), stored as JSON in the app's userData folder (per profile).
// Every value is validated against SCHEMA on load and on write, so a bad file or a bad
// request can never put an unexpected value into the agent.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const PROVIDERS = ['gemini', 'claude', 'gpt'];
const MODES = ['browser', 'desktop', 'autopilot', 'assistant'];

// key -> { type, default, ... }. Keys are "section.name".
const SCHEMA = {
  'general.defaultProvider': { type: 'enum', values: PROVIDERS, default: 'gemini' },
  'general.defaultMode': { type: 'enum', values: MODES, default: 'browser' },
  'general.defaultQuality': { type: 'enum', values: ['fast', 'accurate'], default: 'fast' },
  // chromium: Nuri (bundled Chromium + agent side panel); builtin: classic window.
  'general.browserEngine': { type: 'enum', values: ['chromium', 'builtin'], default: 'builtin' },
  'general.homeUrl': { type: 'url', default: 'https://www.google.com' },
  'general.searchEngine': { type: 'enum', values: ['google', 'naver', 'bing'], default: 'google' },
  'general.historyLimit': { type: 'enum', values: [20, 50, 100, 200], default: 50 },
  // Start-up and the X button (src/autostart.js). Started with Windows, the app can stay in the
  // tray so 예약 작업 run without the window ever opening.
  'general.startWithWindows': { type: 'bool', default: false },
  'general.startInTray': { type: 'bool', default: true },
  'general.confirmTabClose': { type: 'bool', default: true },
  'general.closeAction': { type: 'enum', values: ['ask', 'tray', 'quit'], default: 'ask' },

  // Approvals (설정 > 권한·안전), per kind of risky action: ask = approve/deny card,
  // auto = approved without asking (noted in the chat), block = declined without asking.
  // Default (user's choice 2026-10-26): only payments ask; everything else runs on its own.
  'safety.payments': { type: 'enum', values: ['ask', 'auto', 'block'], default: 'ask' },
  'safety.publish': { type: 'enum', values: ['ask', 'auto', 'block'], default: 'auto' },
  'safety.terminal': { type: 'enum', values: ['ask', 'auto', 'block'], default: 'auto' },
  'safety.delete': { type: 'enum', values: ['ask', 'auto', 'block'], default: 'auto' },
  'safety.launch': { type: 'enum', values: ['ask', 'auto', 'block'], default: 'auto' },
  'safety.skills': { type: 'enum', values: ['ask', 'auto', 'block'], default: 'auto' },
  'safety.other': { type: 'enum', values: ['ask', 'auto', 'block'], default: 'auto' },
  'safety.typing': { type: 'enum', values: ['auto', 'ask'], default: 'auto' },

  'automation.browserMaxSteps': { type: 'enum', values: [20, 40, 60, 100], default: 40 },
  // 하위 에이전트: how many browser sub-agents one "parallel" action may run at once (0 = off).
  // Each one is its own AI session, so it uses the subscription's limit that much faster.
  'automation.subagents': { type: 'enum', values: [0, 2, 3, 4], default: 3 },
  'automation.desktopMaxSteps': { type: 'enum', values: [30, 50, 80, 120], default: 50 },
  'automation.autopilotOnFail': { type: 'enum', values: ['ask', 'retry-skip'], default: 'ask' },
  'automation.downloadDir': { type: 'path', default: '' }, // '' = Windows Downloads folder
  // Where computer use runs: the user's PC, or the AI 작업 PC (Windows Sandbox, src/sandbox).
  'automation.desktopTarget': { type: 'enum', values: ['local', 'sandbox'], default: 'local' },
  'automation.desktopMode': { type: 'enum', values: ['background', 'foreground'], default: 'background' },
  'automation.minimizeDuringDesktop': { type: 'bool', default: true },

  // 설정 > 화면: fonts bundled in ui/fonts (all SIL Open Font License 1.1) and the text size.
  'appearance.language': { type: 'enum', values: ['auto', 'ko', 'en'], default: 'auto' },
  'appearance.koreanFont': { type: 'enum', values: ['pretendard', 'noto-sans-kr', 'nanum-gothic', 'ibm-plex-sans-kr', 'system'], default: 'pretendard' },
  'appearance.latinFont': { type: 'enum', values: ['same', 'inter', 'roboto', 'source-sans-3'], default: 'same' },
  'appearance.textSize': { type: 'enum', values: ['small', 'normal', 'large', 'xlarge'], default: 'normal' },

  'notifications.taskDone': { type: 'bool', default: true },
  'notifications.needsAttention': { type: 'bool', default: true },
  'notifications.sound': { type: 'bool', default: true },
};

const SEARCH_URLS = {
  google: 'https://www.google.com/search?q=',
  naver: 'https://search.naver.com/search.naver?query=',
  bing: 'https://www.bing.com/search?q=',
};

/** Returns the valid value for `key`, or undefined when `value` is not acceptable. */
function validate(key, value) {
  const spec = SCHEMA[key];
  if (!spec) return undefined;
  switch (spec.type) {
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum': {
      const v = spec.values.find((x) => String(x) === String(value));
      return v === undefined ? undefined : v;
    }
    case 'url': {
      const s = String(value ?? '').trim();
      return /^https:\/\/[^\s]+$/i.test(s) && s.length <= 500 ? s : undefined;
    }
    case 'path': {
      const s = String(value ?? '').trim();
      if (s === '') return '';
      return s.length <= 400 && (/^[a-z]:[\\/]/i.test(s) || s.startsWith('\\\\')) && !/[<>"|?*]/.test(s.slice(2)) ? s : undefined;
    }
    default:
      return undefined;
  }
}

function defaults() {
  return Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.default]));
}

class Settings extends EventEmitter {
  /** @param {string} file JSON file (created on first save) */
  constructor(file) {
    super();
    this.file = file;
    this.values = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      // Files from before the per-kind approvals (no safety.other) stored the old default
      // "ask" for publishing: let the new default (auto) apply; an explicit "block" stays.
      if (!('safety.other' in saved) && saved['safety.publish'] === 'ask') delete saved['safety.publish'];
      if (saved['general.homeUrl'] === 'https://www.naver.com') delete saved['general.homeUrl']; // the old default, not a choice
      for (const [k, v] of Object.entries(saved)) {
        const ok = validate(k, v);
        if (ok !== undefined) this.values[k] = ok;
      }
    } catch {
      /* first run or unreadable file: defaults */
    }
  }

  get(key) {
    return this.values[key] ?? SCHEMA[key]?.default;
  }

  all() {
    return { ...this.values };
  }

  /** Applies the valid entries of `patch`; returns { values, rejected: [keys] }. */
  update(patch = {}) {
    const rejected = [];
    const changed = {};
    for (const [k, v] of Object.entries(patch)) {
      const ok = validate(k, v);
      if (ok === undefined) rejected.push(k);
      else if (ok !== this.values[k]) changed[k] = this.values[k] = ok;
    }
    if (Object.keys(changed).length) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8');
      this.emit('change', changed, this.all());
    }
    return { values: this.all(), rejected };
  }

  reset() {
    return this.update(defaults());
  }

  searchUrl(query) {
    return (SEARCH_URLS[this.get('general.searchEngine')] || SEARCH_URLS.google) + encodeURIComponent(query);
  }
}

// Words in an approval question that mark the kind of risky action (for the approval policies).
const PAY_WORDS = /결제|구매|주문|송금|이체|계좌|pay\s*now|place\s*order|checkout|purchase|buy\s*now/i;
const PUBLISH_WORDS = /발행|게시|등록하기|공유하기|업로드|전송|보내기|publish|upload|share|send|메시지/i;
const DELETE_WORDS = /삭제|탈퇴|delete/i;

const RISK_LABELS = {
  payments: '결제·구매·송금',
  publish: '게시·전송·업로드',
  terminal: '터미널 명령 실행',
  delete: '삭제·탈퇴',
  launch: '프로그램 실행',
  skills: '플랫폼 스킬',
  other: '기타 확인',
};

/**
 * Which approval policy (safety.<kind>) governs an approval question. 'typing' is the
 * "글자 입력: 매번 묻기" question: it always asks, because the user chose that explicitly.
 */
function riskKind(question) {
  const q = String(question || '');
  // The questions come in the interface language (src/i18n.js): match both.
  if (/^(플랫폼 스킬|Run this task with a platform skill)/.test(q)) return 'skills';
  if (/입력하려고 합니다|^About to type this into/.test(q)) return 'typing';
  if (/^(터미널|Terminal \()/.test(q)) return 'terminal';
  if (PAY_WORDS.test(q)) return 'payments';
  if (DELETE_WORDS.test(q)) return 'delete';
  if (PUBLISH_WORDS.test(q)) return 'publish';
  if (/프로그램\/파일을 실행|run this program\/file/.test(q)) return 'launch';
  return 'other';
}

module.exports = { Settings, SCHEMA, validate, defaults, riskKind, RISK_LABELS, SEARCH_URLS };
