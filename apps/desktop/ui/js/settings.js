// 설정 page: options the user controls (stored by the main process, see src/settings.js).
// Every change is saved immediately; the main process validates it and broadcasts the result.
(() => {
  const { $, el, svg, api, state, store, t } = ANB;
  const page = $('settingsPage');
  let values = {};
  let options = {};
  let info = {};
  let current = 'general';
  let savedTimer = 0;

  const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // Privacy Policy and Terms of Use (repository documents), in the interface language.
  const DOCS = ANB.lang === 'en'
    ? { privacy: 'https://github.com/lsszz2100/Nuri/blob/main/PRIVACY.md', terms: 'https://github.com/lsszz2100/Nuri/blob/main/TERMS.md' }
    : { privacy: 'https://github.com/lsszz2100/Nuri/blob/main/PRIVACY.md#개인정보처리방침', terms: 'https://github.com/lsszz2100/Nuri/blob/main/TERMS.md#이용약관' };

  const APPROVAL = { ask: '매번 묻기', auto: '자동 승인', block: '항상 차단' };
  const APPROVAL_KEYS = ['safety.payments', 'safety.publish', 'safety.delete', 'safety.terminal', 'safety.launch', 'safety.skills', 'safety.other'];

  // Line icons for the menu (static markup).
  const ICON = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    general: ICON('<path d="M4 6h16M4 12h16M4 18h10"/>'),
    safety: ICON('<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>'),
    automation: ICON('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
    appearance: ICON('<path d="M4 7V5h16v2M9 19h6M12 5v14"/>'),
    notifications: ICON('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    connections: ICON('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
    data: ICON('<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  };

  // Menu and rows. kind: select | switch | text | folder | custom. Texts are Korean keys,
  // translated when drawn (ui/locales/en.js).
  const SECTIONS = [
    {
      id: 'general', title: '일반',
      desc: '앱을 켤 때의 기본값과 브라우저 동작입니다.',
      groups: [
        { title: '기본 실행 설정', rows: [
          { key: 'general.defaultProvider', kind: 'select', label: '기본 AI 모델', help: '앱을 시작할 때 선택되어 있는 모델', labels: { gemini: 'Gemini', claude: 'Claude', gpt: 'GPT (Codex)' } },
          { key: 'general.defaultMode', kind: 'select', label: '기본 모드', help: '앱을 시작할 때 선택되어 있는 작업 모드', labels: { browser: '브라우저 자동화', desktop: '컴퓨터 제어', autopilot: '오토파일럿', assistant: '어시스턴트' } },
          { key: 'general.defaultQuality', kind: 'select', label: '기본 속도', help: '정확 모드는 더 신중하게 판단하지만 느립니다', labels: { fast: '빠름', accurate: '정확' } },
        ] },
        { title: '시작 · 종료', rows: [
          { key: 'general.startWithWindows', kind: 'switch', label: 'Windows 시작 시 자동 실행', help: 'PC를 켜고 로그인하면 앱이 자동으로 시작됩니다. 예약 작업이 앱을 직접 열지 않아도 실행됩니다' },
          { key: 'general.startInTray', kind: 'switch', label: '자동 실행 때 트레이에서 시작', help: '창을 띄우지 않고 작업 표시줄 트레이 아이콘으로만 시작합니다. 아이콘을 누르면 창이 열립니다' },
          { key: 'general.closeAction', kind: 'select', label: '창 닫기(X) 버튼', help: '트레이로 숨기면 앱이 계속 실행되어 예약 작업이 정해진 시간에 실행됩니다', labels: { ask: '매번 묻기', tray: '트레이로 숨기기', quit: '종료 (작업 중이면 묻기)' } },
        ] },
        { title: '브라우저', rows: [
          { key: 'general.browserEngine', kind: 'select', label: '브라우저 방식', help: '단일 창: 브라우저와 AI 에이전트가 한 창에 있습니다. Google 로그인은 작은 로그인 창에서 한 뒤 자동으로 가져옵니다. 사이드 패널: 진짜 Chromium 브라우저에 AI 에이전트가 사이드 패널로 들어 있습니다. 바꾸면 앱을 다시 시작해야 적용됩니다', labels: { builtin: '단일 창 (권장)', chromium: 'Chromium + 사이드 패널' } },
          { key: 'general.confirmTabClose', kind: 'switch', label: '탭 닫기 전에 확인', help: '탭의 X 버튼을 누르면 닫을지 먼저 묻습니다' },
          { key: 'general.homeUrl', kind: 'text', label: '시작 페이지', help: '새 탭과 홈 버튼이 여는 주소 (https:// 로 시작)', placeholder: 'https://www.google.com' },
          { key: 'general.searchEngine', kind: 'select', label: '검색 엔진', help: '주소창에 주소가 아닌 말을 입력했을 때', labels: { google: 'Google', naver: '네이버', bing: 'Bing' } },
          { key: 'general.historyLimit', kind: 'select', label: '작업 기록 보관 개수', help: '왼쪽 "최근 작업"에 남기는 개수 (고정한 작업은 항상 유지)', labels: { 20: '20개', 50: '50개', 100: '100개', 200: '200개' } },
        ] },
      ],
    },
    {
      id: 'safety', title: '권한 · 안전',
      desc: 'AI가 되돌리기 어려운 동작을 하기 전의 처리 방식입니다. "매번 묻기"는 승인 카드를 띄우고, "자동 승인"은 묻지 않고 진행하며(대화창에 기록), "항상 차단"은 묻지 않고 거부합니다. 로그인·비밀번호·공동인증서는 항상 직접 입력하도록 AI가 멈춥니다.',
      groups: [
        { rows: [
          { kind: 'custom', label: '한 번에 바꾸기', help: '아래 승인 항목을 한꺼번에 설정합니다', render: approvalPresets },
        ] },
        { title: '승인 방식', rows: [
          { key: 'safety.payments', kind: 'select', label: '결제 · 구매 · 송금', help: '결제하기, 주문하기, 바로구매, 이체 같은 버튼. 자동 승인하면 실제로 돈이 나갈 수 있습니다', labels: APPROVAL },
          { key: 'safety.publish', kind: 'select', label: '게시 · 전송 · 업로드', help: '글 발행, 메시지 보내기, 파일 업로드, 공유 버튼, 메신저 전송', labels: APPROVAL },
          { key: 'safety.delete', kind: 'select', label: '삭제 · 탈퇴', help: '삭제 버튼, 파일 삭제(Delete, Shift+Delete), 회원 탈퇴', labels: APPROVAL },
          { key: 'safety.terminal', kind: 'select', label: '터미널 명령 실행', help: '명령 프롬프트·PowerShell 등에서 명령을 실행(Enter)할 때', labels: APPROVAL },
          { key: 'safety.launch', kind: 'select', label: '프로그램 실행', help: '메모장·계산기 같은 기본 앱이 아닌 프로그램이나 파일을 열 때', labels: APPROVAL },
          { key: 'safety.skills', kind: 'select', label: '플랫폼 스킬 · 플러그인', help: 'AI가 작업 일부를 설치된 스킬·플러그인에 맡길 때', labels: APPROVAL },
          { key: 'safety.other', kind: 'select', label: '그 밖의 확인', help: '위에 속하지 않는 승인 요청', labels: APPROVAL },
        ] },
        { title: '입력 확인', rows: [
          { key: 'safety.typing', kind: 'select', label: '글자 입력', help: '검색어·양식·문서·터미널 등에 글자를 입력할 때. 자동이면 묻지 않고 바로 입력합니다 (전송·실행은 위 설정을 따름)', labels: { auto: '자동 (묻지 않음)', ask: '매번 묻기' } },
        ] },
      ],
    },
    {
      id: 'automation', title: '자동화',
      desc: '자동화가 한 번에 진행하는 범위와 결과 파일 위치입니다.',
      groups: [
        { title: '실행 범위', rows: [
          { key: 'automation.browserMaxSteps', kind: 'select', label: '브라우저 자동화 최대 단계', help: '이 단계 수에 도달하면 멈추고 진행 상황을 보고합니다', labels: { 20: '20단계', 40: '40단계', 60: '60단계', 100: '100단계' } },
          { key: 'automation.subagents', kind: 'select', label: '하위 에이전트 (동시 작업)', help: '여러 사이트를 조사·비교하는 일처럼 서로 독립된 일을 AI가 하위 에이전트에게 나눠 각자 탭에서 동시에 진행합니다. 하위 에이전트는 조사·수집만 하고 결제·게시·전송은 하지 않습니다. 하나하나가 따로 AI를 쓰므로 구독 사용 한도가 그만큼 빨리 줄어듭니다', labels: { 0: '사용 안 함', 2: '최대 2개', 3: '최대 3개', 4: '최대 4개' } },
          { key: 'automation.desktopMaxSteps', kind: 'select', label: '컴퓨터 제어 최대 단계', labels: { 30: '30단계', 50: '50단계', 80: '80단계', 120: '120단계' } },
          { key: 'automation.autopilotOnFail', kind: 'select', label: '오토파일럿 단계 실패 시', help: '자동 처리: 한 번 더 시도하고, 또 실패하면 그 단계를 건너뛰고 계속합니다', labels: { ask: '물어보기', 'retry-skip': '자동 재시도 후 건너뛰기' } },
        ] },
        { title: '파일 · 화면', rows: [
          { key: 'automation.downloadDir', kind: 'folder', label: '다운로드 저장 폴더', help: 'AI가 내려받은 파일 (오토파일럿은 프로젝트 폴더에 저장)' },
          { key: 'automation.desktopTarget', kind: 'select', label: '컴퓨터 제어 위치', help: 'AI 작업 PC: AI가 별도의 가상 Windows(Windows 샌드박스)에서 작업하므로 내 PC를 쓰는 동안에도 전혀 부딪히지 않습니다. 그 PC에는 엑셀·한글·카카오톡과 내 로그인이 없고, 결과 파일은 내 PC 폴더에 저장됩니다. 내 PC: 내 프로그램(엑셀·카카오톡 등)을 직접 다룹니다', labels: { local: '내 PC', sandbox: 'AI 작업 PC (가상)' } },
          { key: 'automation.desktopMode', kind: 'select', label: '컴퓨터 제어 방식', help: '백그라운드: 진짜 마우스·키보드를 쓰지 않고 AI가 연 창을 내 창 뒤에서 조작합니다 (작업 중에도 방해 없음). 화면 직접 제어: 사람처럼 화면을 조작합니다 (게임·카카오톡처럼 백그라운드로 안 되는 앱용)', labels: { background: '백그라운드 (방해 없음)', foreground: '화면 직접 제어' } },
          { key: 'automation.minimizeDuringDesktop', kind: 'switch', label: '화면 직접 제어 중 이 창 최소화', help: '화면 직접 제어 방식에서만 적용됩니다. 끄면 이 창이 화면에 남습니다' },
          { kind: 'custom', label: '작업 결과 폴더', help: '오토파일럿 프로젝트, 저장한 파일', render: () => button('열기', () => api.openWorkspace()) },
        ] },
      ],
    },
    {
      id: 'appearance', title: '화면',
      desc: '언어, 글꼴, 글자 크기입니다. 글꼴은 앱에 들어 있는 것만 고를 수 있고, 모두 SIL Open Font License 1.1이라 개인·상업용 모두 무료입니다.',
      groups: [
        { rows: [
          { key: 'appearance.language', kind: 'select', label: '언어 (Language)', help: '화면과 AI 답변에 쓰는 언어입니다. 자동은 Windows 표시 언어를 따릅니다', labels: { auto: '자동 (Windows 언어)', ko: '한국어', en: 'English' } },
          { key: 'appearance.koreanFont', kind: 'select', label: '글꼴 (한글)', help: '화면 전체에 쓰는 기본 글꼴', labels: { pretendard: 'Pretendard', 'noto-sans-kr': 'Noto Sans KR (본고딕)', 'nanum-gothic': '나눔고딕', 'ibm-plex-sans-kr': 'IBM Plex Sans KR', system: '맑은 고딕 (Windows 기본)' } },
          { key: 'appearance.latinFont', kind: 'select', label: '글꼴 (영문·숫자)', help: '영문과 숫자만 다른 글꼴로 보여 줍니다', labels: { same: '한글 글꼴과 같게', inter: 'Inter', roboto: 'Roboto', 'source-sans-3': 'Source Sans 3' } },
          { key: 'appearance.textSize', kind: 'select', label: '글자 크기', labels: { small: '작게', normal: '보통', large: '크게', xlarge: '아주 크게' } },
          { kind: 'custom', label: '미리 보기', render: () => el('div', 'font-preview', '다람쥐 헌 쳇바퀴에 타고파 · The quick brown fox 0123456789') },
        ] },
      ],
    },
    {
      id: 'notifications', title: '알림',
      desc: '이 창을 보고 있지 않을 때 Windows 알림으로 알려 줍니다.',
      groups: [
        { rows: [
          { key: 'notifications.taskDone', kind: 'switch', label: '작업 완료 · 오류 알림' },
          { key: 'notifications.needsAttention', kind: 'switch', label: '확인 · 승인 필요 알림', help: 'AI가 질문하거나 승인을 기다릴 때' },
          { key: 'notifications.sound', kind: 'switch', label: '알림음', help: '작업이 끝나면 짧은 소리로 알려 줍니다' },
        ] },
      ],
    },
    {
      id: 'connections', title: '연결 · 스킬',
      desc: 'AI 계정(구독 로그인)과 각 플랫폼의 스킬·플러그인·MCP는 오른쪽 패널의 "연결 · 스킬" 탭에서 관리합니다.',
      groups: [
        { rows: [{ kind: 'custom', label: 'AI 계정 · 스킬 · MCP', help: '구독 로그인 상태 확인, 로그인, 설치된 스킬 보기', render: () => button('열기', () => { close(); ANB.accounts.showView('accounts'); }) }] },
      ],
    },
    {
      id: 'data', title: '데이터 · 진단',
      desc: '문제가 생겼을 때 확인할 정보와 정리 도구입니다.',
      groups: [
        { title: '상태', rows: [{ kind: 'custom', full: true, render: infoGrid }] },
        { title: '폴더 · 엔진', rows: [
          { kind: 'custom', label: 'AI 엔진 다시 연결', help: '엔진이 응답하지 않을 때', render: () => button('다시 연결', () => api.retryServer()) },
          { kind: 'custom', label: '로그 폴더', help: '오류 보고에 필요한 기록', render: () => button('열기', () => api.openLogs()) },
          { kind: 'custom', label: '다운로드 폴더', render: () => button('열기', () => api.openDownloads()) },
        ] },
        { title: '정리', rows: [
          { kind: 'custom', label: '작업 기록 지우기', help: '왼쪽 "최근 작업" 목록을 지웁니다 (고정한 작업은 남김)', render: () => button('지우기', clearHistory, 'btn-danger') },
          { kind: 'custom', label: '설정 초기화', help: '모든 설정을 처음 값으로 되돌립니다', render: () => button('초기화', resetAll, 'btn-danger') },
        ] },
        { title: '개인정보 · 약관', rows: [
          { kind: 'custom', label: '개인정보처리방침', help: 'Nuri는 아무것도 수집하지 않습니다. 내 PC에 저장되는 것과 AI 회사로 보내는 것을 설명합니다', render: () => button(t('열기'), () => api.openExternal(DOCS.privacy)) },
          { kind: 'custom', label: '이용약관', help: 'Nuri가 나를 대신해 한 행동에 대한 책임과 보증의 범위', render: () => button(t('열기'), () => api.openExternal(DOCS.terms)) },
        ] },
      ],
    },
  ];


  function approvalPresets() {
    const box = el('div', 'set-control preset-buttons');
    const apply = async (pick, text) => {
      try {
        const r = await api.setSettings(Object.fromEntries(APPROVAL_KEYS.map((k) => [k, pick(k)])));
        values = r.values;
        flash(text);
      } catch (e) {
        flash(t('저장 실패: {error}', { error: cleanError(e) }), true);
      }
      render();
    };
    box.append(
      button(t('모두 묻기'), () => apply(() => 'ask', t('모든 승인을 매번 묻습니다'))),
      button(t('결제만 묻기'), () => apply((k) => (k === 'safety.payments' ? 'ask' : 'auto'), t('결제·구매만 묻고 나머지는 자동 승인합니다'))),
      button(t('모두 자동'), () => {
        if (confirm(t('결제·구매·송금까지 묻지 않고 진행합니다. 실제로 돈이 나가거나 글이 게시될 수 있습니다. 계속할까요?'))) apply(() => 'auto', t('모든 승인을 자동으로 처리합니다'));
      }),
    );
    return box;
  }

  function button(text, onclick, cls = 'btn-ghost') {
    const b = el('button', cls, text);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  }

  function flash(text, isError) {
    const s = $('settingsSaved');
    s.textContent = text;
    s.className = 'settings-saved show' + (isError ? ' err' : '');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (s.className = 'settings-saved'), 1800);
  }

  async function save(key, value) {
    try {
      const r = await api.setSettings({ [key]: value });
      values = r.values;
      if (r.rejected.length) flash(t('저장하지 못했습니다: 값을 확인해 주세요'), true);
      else flash(key === 'general.browserEngine' ? t('저장됨 · 앱을 다시 시작하면 적용됩니다') : t('저장됨'));
      applyToUi();
      if (key === 'appearance.language' && !r.rejected.length) return switchLanguage(value);
    } catch (e) {
      flash(t('저장 실패: {error}', { error: cleanError(e) }), true);
    }
    render();
  }

  function control(row) {
    const v = values[row.key];
    switch (row.kind) {
      case 'select': {
        const sel = el('select');
        for (const o of options[row.key] || []) {
          const opt = el('option', null, row.labels?.[o] != null ? t(row.labels[o]) : String(o));
          opt.value = String(o);
          if (String(o) === String(v)) opt.selected = true;
          sel.append(opt);
        }
        sel.onchange = () => save(row.key, sel.value);
        return sel;
      }
      case 'switch': {
        const sw = el('button', 'switch');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(!!v));
        sw.setAttribute('aria-label', t(row.label));
        sw.onclick = () => save(row.key, !v);
        return sw;
      }
      case 'text': {
        const input = el('input');
        input.type = 'text';
        input.value = v || '';
        input.placeholder = row.placeholder || '';
        input.spellcheck = false;
        const commit = () => input.value.trim() !== (v || '') && save(row.key, input.value.trim());
        input.onchange = commit;
        input.onkeydown = (e) => e.key === 'Enter' && input.blur();
        return input;
      }
      case 'folder': {
        const box = el('div', 'set-control');
        box.append(el('span', 'path', v || t('기본 ({path})', { path: info.downloads || t('다운로드') })));
        box.lastChild.title = v || info.downloads || '';
        box.append(button(t('변경'), async () => {
          const dir = await api.pickFolder();
          if (dir) save(row.key, dir);
        }));
        if (v) box.append(button(t('기본값'), () => save(row.key, '')));
        return box;
      }
      case 'custom':
        return row.render();
      default:
        return el('span');
    }
  }

  function infoGrid() {
    const dl = el('dl', 'info-grid');
    const add = (k, vnode) => {
      dl.append(el('dt', null, t(k)));
      const dd = el('dd');
      if (typeof vnode === 'string') dd.textContent = vnode;
      else dd.append(vnode);
      dl.append(dd);
    };
    const engine = el('span');
    engine.append(el('span', 'status-dot ' + (state.serverReady ? 'ok' : 'bad')), document.createTextNode(state.serverReady ? t('연결됨') : t('연결 안 됨')));
    add('AI 엔진', engine);
    add('앱 버전', `${info.version || '-'} (Electron ${info.electron || '-'}, Chromium ${info.chrome || '-'})`);
    add('브라우저 방식', info.engine ? (info.engine.type === 'chromium' ? t('Nuri (Chromium + 사이드 패널)') : t('내장 브라우저 (예전 방식)')) : '-');
    add('프로필', info.profile || '-');
    add('작업 결과 폴더', info.workspace || '-');
    add('설정 · 데이터 위치', info.userData || '-');
    add('작업 기록', t('{n}개', { n: store.load().length }));
    return dl;
  }

  function render() {
    const nav = $('settingsNav');
    nav.replaceChildren(
      ...SECTIONS.map((sec) => {
        const b = el('button', sec.id === current ? 'active' : '');
        b.type = 'button';
        b.append(svg(ICONS[sec.id]), el('span', null, t(sec.title)));
        b.onclick = () => {
          current = sec.id;
          render();
        };
        return b;
      }),
    );
    const sec = SECTIONS.find((s) => s.id === current) || SECTIONS[0];
    const box = $('settingsContent');
    const parts = [el('h3', null, t(sec.title)), el('p', 'sec-desc', t(sec.desc))];
    for (const g of sec.groups) {
      const group = el('div', 'set-group');
      if (g.title) group.append(el('div', 'set-group-title', t(g.title)));
      for (const row of g.rows) {
        const r = el('div', row.full ? 'set-row full' : 'set-row');
        if (row.full) r.append(row.render());
        else {
          const text = el('div', 'set-text');
          text.append(el('div', 'set-label', t(row.label)));
          if (row.help) text.append(el('div', 'set-help', t(row.help)));
          const c = el('div', 'set-control');
          c.append(control(row));
          r.append(text, c);
        }
        group.append(r);
      }
      parts.push(group);
    }
    box.replaceChildren(...parts);
  }

  function clearHistory() {
    if (state.running) return flash(t('작업이 실행 중일 때는 지울 수 없습니다'), true);
    const n = store.load().filter((h) => !h.pinned).length;
    if (!n) return flash(t('지울 기록이 없습니다'));
    if (!window.confirm(t('최근 작업 {n}개를 지울까요? (고정한 작업은 남습니다)', { n }))) return;
    store.clearUnpinned();
    ANB.chat.showEmpty();
    flash(t('{n}개를 지웠습니다', { n }));
    render();
  }

  async function resetAll() {
    if (!window.confirm(t('모든 설정을 처음 값으로 되돌릴까요?'))) return;
    const r = await api.resetSettings();
    values = r.values;
    applyToUi();
    flash(t('초기화했습니다'));
    render();
  }

  /**
   * 설정 > 화면 > 언어: the main process already uses the new language; the UI reloads to redraw
   * everything in it. While a task runs, the reload waits so the conversation on screen is kept.
   */
  function switchLanguage(value) {
    const lang = value === 'auto' ? (/^ko\b/i.test(navigator.language) ? 'ko' : 'en') : value;
    try {
      localStorage.setItem('nuri.lang', lang);
    } catch {
      /* optional: the desktop window gets the language from the main process */
    }
    if (state.running) {
      state.reloadWhenIdle = reloadUi; // ui/js/chat.js runs it when the task ends
      return flash(t('작업이 끝난 뒤 화면 언어가 바뀝니다'));
    }
    reloadUi();
  }

  function reloadUi() {
    // The page view stays hidden until the new UI has loaded (main.js shows it again), so nothing
    // of the old screen shows through while it reloads.
    if (api.reloadUi && !document.documentElement.classList.contains('panel')) api.reloadUi();
    else location.reload();
  }

  /** Settings the renderer applies itself (history size, alert sound). */
  const KOREAN_FONTS = { pretendard: "'Pretendard Variable'", 'noto-sans-kr': "'Noto Sans KR Variable'", 'nanum-gothic': "'Nanum Gothic'", 'ibm-plex-sans-kr': "'IBM Plex Sans KR'", system: "'Malgun Gothic'" };
  const LATIN_FONTS = { inter: "'Inter Variable'", roboto: "'Roboto Variable'", 'source-sans-3': "'Source Sans 3 Variable'" };
  const TEXT_SCALE = { small: 0.93, normal: 1, large: 1.08, xlarge: 1.16 };

  /** 설정 > 화면: the font comes first for Latin letters, the Korean one covers the rest. */
  function applyAppearance() {
    const stack = [LATIN_FONTS[values['appearance.latinFont']], KOREAN_FONTS[values['appearance.koreanFont']] || KOREAN_FONTS.pretendard];
    const root = document.documentElement.style;
    root.setProperty('--font-ui', [...stack.filter(Boolean), "'Segoe UI'", "'Malgun Gothic'", 'system-ui', 'sans-serif'].join(', '));
    root.setProperty('--font-scale', String(TEXT_SCALE[values['appearance.textSize']] || 1));
  }

  function applyToUi() {
    state.settings = values;
    applyAppearance();
  }

  async function load() {
    const r = await api.getSettings();
    values = r.values;
    options = r.options;
    info = r.info;
    applyToUi();
    return values;
  }

  async function open(section) {
    document.documentElement.classList.add('settings-open');
    if (section) current = section;
    try {
      await load();
    } catch (e) {
      flash(t('불러오기 실패: {error}', { error: cleanError(e) }), true);
    }
    page.hidden = false;
    $('settingsBtn').classList.add('active');
    api.setBrowserCovered(true);
    render();
  }

  function close() {
    document.documentElement.classList.remove('settings-open');
    if (page.hidden) return;
    page.hidden = true;
    $('settingsBtn').classList.remove('active');
    api.setBrowserCovered(false);
  }

  $('settingsBtn').onclick = () => (page.hidden ? open() : close());
  $('panelSettingsBtn').onclick = () => (page.hidden ? open() : close());
  $('settingsClose').onclick = close;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !page.hidden) close();
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      page.hidden ? open() : close();
    }
  });
  api.onSettings((v) => {
    values = v;
    applyToUi();
    if (!page.hidden) render();
  });

  ANB.settings = { open, close, load, get: (k) => values[k] };
})();
