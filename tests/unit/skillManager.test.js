import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SkillManager } from '../../packages/anb-orchestrator/dist/skills/skillManager.js';

describe('SkillManager', () => {
  const manager = new SkillManager();

  it('registers all built-in skills correctly', () => {
    const skills = manager.listSkills();
    assert.ok(skills.length >= 5);
    const ids = skills.map(s => s.id);
    assert.ok(ids.includes('naver-search'));
    assert.ok(ids.includes('aria-browse'));
    assert.ok(ids.includes('kakaotalk'));
    assert.ok(ids.includes('captcha-solver'));
    assert.ok(ids.includes('youtube-summary'));
  });

  it('matches appropriate skill from user natural language prompt', () => {
    const naverMatch = manager.matchSkill('네이버에서 오늘 주요 뉴스 찾아줘');
    assert.ok(naverMatch);
    assert.strictEqual(naverMatch.id, 'naver-search');

    const kakaoMatch = manager.matchSkill('카카오톡 최근 메시지 확인해줘');
    assert.ok(kakaoMatch);
    assert.strictEqual(kakaoMatch.id, 'kakaotalk');

    const captchaMatch = manager.matchSkill('화면에 캡차가 나타났는데 어떻게 해?');
    assert.ok(captchaMatch);
    assert.strictEqual(captchaMatch.id, 'captcha-solver');

    const youtubeMatch = manager.matchSkill('유튜브 영상 요약해줘');
    assert.ok(youtubeMatch);
    assert.strictEqual(youtubeMatch.id, 'youtube-summary');
  });

  it('enriches prompt with skill instructions and ARIA snapshot', () => {
    const skill = manager.getSkill('naver-search');
    assert.ok(skill);
    const enriched = manager.enrichPrompt(
      '네이버 뉴스 요약해줘',
      skill,
      'https://www.naver.com',
      '- searchbox "검색어 입력"\n- button "검색"'
    );
    assert.ok(enriched.includes('[활성화된 스킬]: 네이버 통합 검색'));
    assert.ok(enriched.includes('[스킬 지침: 네이버 통합 검색 & 브리핑]'));
    assert.ok(enriched.includes('[현재 웹페이지 실시간 ARIA 접근성 스냅샷]'));
  });
});
