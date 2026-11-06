/**
 * ANB Skill Engine
 * Manages domain-specific autonomous agent workflows in SKILL.md format,
 * with built-in skills under skills/builtin.
 */

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  triggers: string[];
  instructions: string;
  defaultUrl?: string;
  category: 'search' | 'communication' | 'automation' | 'security' | 'media';
}

export class SkillManager {
  private skills: Map<string, SkillDefinition> = new Map();

  constructor() {
    this.registerBuiltinSkills();
  }

  private registerBuiltinSkills() {
    // 1. Naver Search & Shopping Skill
    this.register({
      id: 'naver-search',
      name: '네이버 통합 검색 & 뉴스/쇼핑 브리핑',
      description: '네이버 검색창을 자동으로 탐색하여 실시간 뉴스 헤드라인, 블로그, 쇼핑 최저가를 브리핑합니다.',
      icon: '🔍',
      category: 'search',
      defaultUrl: 'https://www.naver.com',
      triggers: ['네이버', 'naver', '뉴스 요약', '실시간 뉴스', '최저가', '쇼핑 검색', '날씨'],
      instructions: `[스킬 지침: 네이버 통합 검색 & 브리핑]
1. 네이버 메인 페이지에서 검색창(searchbox)과 주요 뉴스 링크(link)를 확인합니다.
2. 사용자가 특정 키워드를 검색해달라고 하면, 네이버 검색 URL('https://search.naver.com/search.naver?query=' + 인코딩된키워드)로 바로 이동하여 검색 결과를 확인합니다.
3. 주요 뉴스 헤드라인이나 상품 최저가 목록을 3~5가지 항목으로 번호를 매겨 한국어로 친절하게 요약 보고합니다.`
    });

    // 2. ARIA Autonomous Browse Skill
    this.register({
      id: 'aria-browse',
      name: '접근성 트리 기반 자율 브라우징',
      description: '화면의 ARIA 접근성 트리(#ref 참조)를 분석하여 버튼 클릭, 텍스트 입력, 페이지 전환을 수행합니다.',
      icon: '🌐',
      category: 'automation',
      triggers: ['클릭', '눌러', '입력해줘', '작성해줘', '로그인해줘', '버튼', '링크', '이동해줘'],
      instructions: `[스킬 지침: ARIA 자율 브라우징]
1. 제공된 페이지의 ARIA 스냅샷(Interactive Inputs, Buttons, Navigation Links)을 참조합니다.
2. 타겟팅할 요소의 [refID] (예: #ref1, #ref2)를 정확히 명시하여 동작을 설명합니다.
3. L3 수준의 민감한 결제, 데이터 삭제, 계정 설정 변경 등은 반드시 사용자 승인을 거쳐야 합니다.`
    });

    // 3. KakaoTalk Skill
    this.register({
      id: 'kakaotalk',
      name: '카카오톡 연동 도우미 (KakaoTalk Helper)',
      description: '로컬 PC의 카카오톡 프로세스 상태를 점검하고 최근 대화 요약 및 알림 검색을 지원합니다.',
      icon: '💬',
      category: 'communication',
      triggers: ['카카오톡', '카톡', 'kakaotalk', '채팅 확인', '메시지 검색'],
      instructions: `[스킬 지침: 카카오톡 연동]
1. 카카오톡 연동은 읽기 전용(Read-Only) 원칙을 준수합니다.
2. 사용자 동의 없이 메시지를 임의로 전송하거나 대화방을 나가는 행위는 엄격히 금지됩니다.
3. 사용자가 카카오톡 대화 내용 확인이나 검색을 요청하면 대상 대화방 키워드를 정리하여 안내합니다.`
    });

    // 4. CAPTCHA Solver Skill
    this.register({
      id: 'captcha-solver',
      name: '스마트 캡차 감지 및 보안 가드',
      description: '페이지 내 reCAPTCHA, Cloudflare Turnstile 등의 캡차를 감지하면 자동화를 일시 중단하고 사용자의 L3 승인 팝업을 트리거합니다.',
      icon: '🛡️',
      category: 'security',
      triggers: ['캡차', '보안문자', 'captcha', 'turnstile', 'recaptcha', '로봇이 아닙니다'],
      instructions: `[스킬 지침: 캡차 대응]
1. 페이지 내 캡차(CAPTCHA)가 감지되었을 경우 즉시 자동 조작을 일시 멈추고 사용자에게 화면 직접 해결을 요청합니다.
2. 캡차가 해결된 후 사용자가 계속 진행을 승인하면 다음 자동화 단계를 속행합니다.`
    });

    // 5. YouTube Summary Skill
    this.register({
      id: 'youtube-summary',
      name: '유튜브 영상 분석 및 스크립트 요약',
      description: '유튜브 동영상 페이지에 접속하여 영상 제목, 채널, 자막 정보를 추출하고 핵심 내용을 요약합니다.',
      icon: '📺',
      category: 'media',
      defaultUrl: 'https://www.youtube.com',
      triggers: ['유튜브', 'youtube', '영상 요약', '동영상 분석'],
      instructions: `[스킬 지침: 유튜브 영상 요약]
1. 대상 유튜브 URL로 이동하여 영상 제목, 채널명, 설명란 텍스트를 추출합니다.
2. 영상의 주제와 핵심 3줄 요약, 주요 타임라인 포인트를 정리하여 전달합니다.`
    });
  }

  public register(skill: SkillDefinition) {
    this.skills.set(skill.id, skill);
  }

  public getSkill(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  public listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Match the best skill given user natural language instruction.
   */
  public matchSkill(prompt: string): SkillDefinition | null {
    const lower = prompt.toLowerCase();
    for (const skill of this.skills.values()) {
      for (const trigger of skill.triggers) {
        if (lower.includes(trigger.toLowerCase())) {
          return skill;
        }
      }
    }
    return null;
  }

  /**
   * Enrich agent prompt with matched skill instructions and ARIA DOM context.
   */
  public enrichPrompt(
    originalPrompt: string,
    skill: SkillDefinition | null,
    targetUrl: string | null,
    ariaSnapshotText?: string
  ): string {
    const parts: string[] = [`[사용자 명령]: "${originalPrompt}"`];

    if (skill) {
      parts.push(`\n[활성화된 스킬]: ${skill.name} (${skill.icon})`);
      parts.push(skill.instructions);
    }

    if (targetUrl) {
      parts.push(`\n[접속 대상 웹사이트]: ${targetUrl}`);
    }

    if (ariaSnapshotText) {
      parts.push(`\n[현재 웹페이지 실시간 ARIA 접근성 스냅샷]:\n${ariaSnapshotText.slice(0, 3000)}`);
    }

    parts.push('\n[지시사항]: 위 웹페이지 상태와 스킬 지침을 바탕으로 사용자에게 최신 결과를 한국어로 일목요연하고 명확하게 답변해줘.');
    return parts.join('\n');
  }
}
