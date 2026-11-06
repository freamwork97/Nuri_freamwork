// Parsing and safety classification of the LLM's step decision. Pure functions (unit-tested).

const { parseJsonObject } = require('../workflow/json');
const { t } = require('../i18n');

const ACTION_TYPES = new Set([
  'click', 'type', 'select', 'check', 'hover', 'press', 'scroll', 'navigate', 'back', 'new_tab', 'switch_tab', 'close_tab',
  'wait', 'look', 'click_xy', 'upload', 'list_files', 'save_file', 'copy_file', 'read_file', 'read_document', 'read_page', 'script', 'generate_image', 'ask_user', 'delegate', 'parallel', 'done',
]);

// Actions that end a turn: they need a fresh observation (or the user) before anything else.
const TERMINAL = new Set(['script', 'look', 'ask_user', 'delegate', 'parallel', 'done', 'navigate', 'back', 'new_tab', 'switch_tab', 'close_tab']);
const MAX_CHAIN = 6;

/** Extracts the first JSON object from a model reply (tolerates code fences and chatter). */
function parseDecision(raw, actionTypes = ACTION_TYPES) {
  const obj = parseJsonObject(raw);
  // Either {"action":{...}} or a short chain {"actions":[{...},{...}]} executed in order.
  let actions = Array.isArray(obj.actions) && obj.actions.length ? obj.actions : obj.action ? [obj.action] : [];
  if (!actions.length) throw new Error(t('응답에 action이 없습니다'));
  for (const a of actions) {
    if (!a || !actionTypes.has(a.type)) throw new Error(t('알 수 없는 action: {json}', { json: JSON.stringify(a) }));
  }
  actions = actions.slice(0, MAX_CHAIN);
  const stop = actions.findIndex((a) => TERMINAL.has(a.type));
  if (stop >= 0) actions = actions.slice(0, stop + 1);
  return { thought: String(obj.thought || ''), notes: String(obj.notes || ''), action: actions[0], actions };
}

// Element names that mean money moves, data is destroyed or something is published.
// The app shows an approve/deny card before these, so the model never has to ask in chat.
const RISKY_NAME = /결제|구매하기|바로\s*구매|주문하기|주문\s*완료|주문\s*확정|송금|이체|계좌|발행|게시하기|게시|등록하기|공유하기|업로드|전송|보내기|탈퇴|삭제|pay\s*now|place\s*order|checkout|purchase|buy\s*now|publish|upload|share|delete|send/i;

/** Returns a confirmation question when the action needs the user's explicit OK, else null. */
function riskOf(action, refs) {
  if (action.type === 'delegate') return `${t('플랫폼 스킬·플러그인으로 다음 작업을 실행할까요?')}\n\n${action.task || ''}`;
  if (action.type === 'script') {
    // A script can click anything, so its code is checked for the same words as a button.
    const word = String(action.code || '').match(RISKY_NAME)?.[0];
    return word ? `${t('스크립트가 "{word}" 동작을 포함합니다. 실행할까요?', { word })}\n\n${String(action.code).slice(0, 600)}` : null;
  }
  if (action.type === 'click' || (action.type === 'type' && action.submit)) {
    const target = refs?.get(String(action.ref));
    if (!target || !RISKY_NAME.test(target.name)) return null;
    return t('"{name}" {role}을(를) 누르려고 합니다. 진행할까요?', { name: target.name, role: target.role });
  }
  return null;
}

function describeAction(a, refs) {
  const el = a.ref != null ? refs?.get(String(a.ref)) : null;
  const target = el ? `${el.role} "${(el.name || '').slice(0, 40)}"` : a.ref != null ? `#${a.ref}` : '';
  switch (a.type) {
    case 'click': return t('클릭: {target}', { target });
    case 'type': return t('입력: {target} ← "{text}"', { target, text: String(a.text ?? '').slice(0, 60) }) + (a.submit ? ' + Enter' : '');
    case 'select': return t('선택: {target} ← "{value}"', { target, value: a.value });
    case 'check': return `${a.checked === false ? t('체크 해제') : t('체크')}: ${target}`;
    case 'hover': return t('마우스 올리기: {target}', { target });
    case 'press': return t('키 입력: {key}', { key: a.key });
    case 'scroll': return a.direction === 'up' ? t('스크롤 위로') : t('스크롤 아래로');
    case 'navigate': return t('이동: {url}', { url: a.url });
    case 'back': return t('뒤로 가기');
    case 'generate_image': return t('이미지 생성: {name}', { name: a.name || 'image.png' });
    case 'new_tab': return t('새 탭 열기') + (a.url ? `: ${a.url}` : '');
    case 'switch_tab': return t('탭 전환: {tab}', { tab: a.tab });
    case 'close_tab': return t('탭 닫기: {tab}', { tab: a.tab });
    case 'wait': return t('대기 {n}초', { n: a.seconds || 2 });
    case 'look': return t('화면 인식 (스크린샷)');
    case 'click_xy': return t('좌표 클릭: {x}, {y}', { x: a.x, y: a.y });
    case 'upload': return t('파일 업로드: {files}', { files: [].concat(a.files || a.file || a.path || []).map((f) => String(f).split(/[\\/]/).pop()).join(', ') });
    case 'save_file': return t('파일 저장: {name}', { name: String(a.name || a.path || '').split(/[\\/]/).pop() }) + (a.append ? ` (${t('이어쓰기')})` : '') + (a.open ? ` + ${t('열기')}` : '');
    case 'copy_file': return t('파일 복사: {from} → {to}', { from: String(a.from || '').split(/[\\/]/).pop(), to: a.to });
    case 'read_file': return t('파일 읽기: {name}', { name: a.name || a.path });
    case 'read_document': return t('문서 읽기: {name}', { name: String(a.path || a.name || '').split(/[\\/]/).pop() });
    case 'read_page': return t('페이지 전체 읽기') + (a.part > 1 ? ` (${a.part})` : '');
    case 'script': return t('스크립트 실행: {title}', { title: String(a.title || '').slice(0, 60) || t('자동화 코드') });
    case 'list_files': return t('파일 찾기: {dir}', { dir: a.dir || t('바탕화면·다운로드·동영상·사진·문서') });
    case 'ask_user': return t('사용자에게 질문');
    case 'delegate': return t('스킬/플러그인 위임: {task}', { task: String(a.task || '').slice(0, 60) });
    case 'parallel': return t('하위 에이전트 {n}개 동시 실행: {list}', { n: [].concat(a.tasks || []).length, list: [].concat(a.tasks || []).map((x) => String(x?.title || '').slice(0, 20)).join(', ') });
    case 'done': return t('완료');
    default: return a.type;
  }
}

module.exports = { parseDecision, riskOf, describeAction, ACTION_TYPES, RISKY_NAME };
