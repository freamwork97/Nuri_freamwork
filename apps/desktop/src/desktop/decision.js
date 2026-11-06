// Desktop agent: action validation, target resolution and safety classification. Pure functions
// (unit-tested in test/desktop.test.js).

const { RISKY_NAME } = require('../agent/decision');
const { t } = require('../i18n');

const DESKTOP_ACTIONS = new Set([
  'click', 'double_click', 'type', 'key', 'scroll', 'drag', 'focus_window', 'launch', 'wait', 'ask_user', 'delegate', 'done',
  'save_file', 'copy_file', 'read_file', 'read_document', 'list_files', 'read_text', 'pick_file',
]);

// Apps that open without asking. Anything else (scripts, installers, unknown paths) needs approval.
const SAFE_LAUNCH = /^(notepad|calc|mspaint|explorer|write|wordpad|snippingtool|ms-settings:.*|ms-paint:|calculator:|https?:\/\/\S+|winword|excel|powerpnt|hwp|chrome|msedge|whale|firefox|kakaotalk|telegram)(\.exe)?$/i;
const SHELL_PROCESS = /^(cmd|powershell|pwsh|windowsterminal|wt|wsl|bash|conhost|openconsole|mintty)$/i;
// A real terminal window (not e.g. a normal window that a PowerShell script created).
const TERMINAL_CLASS = /^(ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|mintty|VirtualConsoleClass|PseudoConsoleWindow)$/i;
const isTerminal = (fg) => (fg?.class ? TERMINAL_CLASS.test(fg.class) : SHELL_PROCESS.test(String(fg?.process || '')));
const MESSENGER_PROCESS = /^(kakaotalk|telegram|slack|discord|teams|ms-teams|line|whatsapp|signal|outlook|thunderbird)$/i;

/** Maps a screenshot point (model space) to physical screen pixels. */
function toScreen(obs, x, y) {
  return { x: Math.round(obs.screen.x + Number(x) / obs.scale), y: Math.round(obs.screen.y + Number(y) / obs.scale) };
}

/**
 * Resolves where an action points: an element id from the last observation, or x,y in screenshot
 * pixels. Returns null when the action has no target. Throws on unknown ids / bad coordinates.
 */
function resolveTarget(action, obs) {
  if (action.id != null && action.id !== '') {
    const el = obs.elements.find((e) => e.id === String(action.id));
    if (!el) throw new Error(`unknown element id "${action.id}" (ids change every turn)`);
    return { x: Math.round(el.x + el.w / 2), y: Math.round(el.y + el.h / 2), element: el };
  }
  if (action.x != null && action.y != null) {
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > obs.width + 2 || y > obs.height + 2) {
      throw new Error(`point ${action.x},${action.y} is outside the ${obs.width}x${obs.height} screenshot`);
    }
    return toScreen(obs, x, y);
  }
  return null;
}

function normKeys(keys) {
  return String(keys || '').toLowerCase().replace(/\s+/g, '');
}

/**
 * Returns a confirmation question (in the interface language) when the action needs the user's OK, else null.
 * `target` is the resolved target (with .element when known), `fg` the foreground window.
 */
function desktopRiskOf(action, { target, fg, typing = 'auto' } = {}) {
  const proc = String(fg?.process || '');
  const name = target?.element?.name || '';
  switch (action.type) {
    case 'delegate':
      return `${t('플랫폼 스킬·플러그인으로 다음 작업을 실행할까요?')}\n\n${action.task || ''}`;
    case 'launch': {
      const what = String(action.target || '').trim();
      return SAFE_LAUNCH.test(what) ? null : `${t('다음 프로그램/파일을 실행하려고 합니다. 진행할까요?')}\n\n${what}`;
    }
    case 'click':
    case 'double_click':
      if (name && RISKY_NAME.test(name)) return t('"{name}" {role}을(를) 누르려고 합니다. 진행할까요?', { name, role: target.element.role });
      return null;
    case 'type': {
      const text = String(action.text ?? '');
      // Sending a message (Enter inside the text) and running a command always count as 전송/실행.
      if (MESSENGER_PROCESS.test(proc) && /\n/.test(text)) return `${t('{app}에서 다음 메시지를 전송하려고 합니다. 진행할까요?', { app: proc })}\n\n${text.slice(0, 500)}`;
      if (isTerminal(fg) && /\n/.test(text)) return `${t('터미널({app})에서 다음 명령을 실행하려고 합니다. 진행할까요?', { app: proc })}\n\n${text.slice(0, 500)}`;
      // 설정 > 권한·안전 > 글자 입력: "자동" (default) types without asking.
      if (typing === 'ask') return `${t('{app}에 다음을 입력하려고 합니다. 진행할까요?', { app: proc || t('이 창') })}\n\n${text.slice(0, 500)}`;
      return null;
    }
    case 'key': {
      const k = normKeys(action.keys);
      if (k.includes('shift+delete') || k.includes('shift+del')) return t('파일을 영구 삭제(Shift+Delete)하려고 합니다. 진행할까요?');
      if (/^(delete|del)$/.test(k) && /^explorer$/i.test(proc)) return t('탐색기에서 선택한 항목을 삭제하려고 합니다. 진행할까요?');
      if (/^(enter|return)$/.test(k) && isTerminal(fg)) return t('터미널({app})에서 명령을 실행(Enter)하려고 합니다. 진행할까요?', { app: proc });
      if (/^(enter|return|ctrl\+enter|alt\+s)$/.test(k) && MESSENGER_PROCESS.test(proc)) return t('{app}에서 메시지를 전송({keys})하려고 합니다. 진행할까요?', { app: proc, keys: action.keys });
      return null;
    }
    default:
      return null;
  }
}

function describeDesktopAction(a, target) {
  const el = target?.element;
  const where = el ? `${el.role} "${(el.name || '').slice(0, 40)}"` : a.x != null ? `(${a.x}, ${a.y})` : '';
  switch (a.type) {
    case 'click': return `${a.button === 'right' ? t('우클릭') : t('클릭')}: ${where}`;
    case 'double_click': return `${t('더블클릭')}: ${where}`;
    case 'type': return `${t('입력')}${where ? `: ${where}` : ''} ← "${String(a.text ?? '').replace(/\n/g, '⏎').replace(/\t/g, '⇥').slice(0, 60)}"${a.clear ? ` (${t('지우고')})` : ''}`;
    case 'key': return t('키 입력: {key}', { key: a.keys }) + (a.repeat > 1 ? ` ×${a.repeat}` : '');
    case 'scroll': return t({ up: '스크롤 위로', down: '스크롤 아래로', left: '스크롤 왼쪽으로', right: '스크롤 오른쪽으로' }[a.direction] || '스크롤 아래로');
    case 'drag': return `${t('드래그')}: (${a.from?.x}, ${a.from?.y}) → (${a.to?.x}, ${a.to?.y})`;
    case 'focus_window': return t('창 전환: {window}', { window: a.window });
    case 'launch': return t('실행: {target}', { target: a.target });
    case 'save_file': return t('파일 저장: {name}', { name: String(a.name || a.path || '').split(/[\\/]/).pop() }) + (a.append ? ` (${t('이어쓰기')})` : '') + (a.open ? ` + ${t('열기')}` : '');
    case 'copy_file': return t('파일 복사: {from} → {to}', { from: String(a.from || '').split(/[\\/]/).pop(), to: a.to });
    case 'read_file': return t('파일 읽기: {name}', { name: a.name || a.path });
    case 'read_document': return t('문서 읽기: {name}', { name: String(a.path || a.name || '').split(/[\\/]/).pop() });
        case 'list_files': return t('파일 찾기: {dir}', { dir: a.dir || t('바탕화면·다운로드·동영상·사진·문서') });
    case 'read_text': return t('화면 글자 읽기') + (where ? `: ${where}` : a.window ? `: ${t('창')} ${a.window}` : '');
    case 'pick_file': return t('파일 선택 창에 지정: {name}', { name: String(a.path || '').split(/[\\/]/).pop() });
    case 'wait': return t('대기 {n}초', { n: a.seconds || 2 });
    case 'ask_user': return t('사용자에게 질문');
    case 'delegate': return t('스킬/플러그인 위임: {task}', { task: String(a.task || '').slice(0, 60) });
    case 'done': return t('완료');
    default: return a.type;
  }
}

module.exports = { DESKTOP_ACTIONS, resolveTarget, toScreen, desktopRiskOf, describeDesktopAction, SAFE_LAUNCH };
