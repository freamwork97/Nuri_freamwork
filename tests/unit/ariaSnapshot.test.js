import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AriaSnapshotEngine } from '../../packages/anb-mcp-server/dist/ariaSnapshot.js';

describe('AriaSnapshotEngine', () => {
  it('parses raw HTML into structured accessibility tree with #ref IDs', () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head><title>Naver Test Page</title></head>
      <body>
        <h1>주요 뉴스 헤드라인</h1>
        <input type="search" name="query" placeholder="검색어를 입력해 주세요." value="AI 브라우저">
        <button id="search_btn">검색</button>
        <a href="https://news.naver.com">뉴스 홈으로 이동</a>
        <a href="https://shopping.naver.com">쇼핑 홈으로 이동</a>
      </body>
      </html>
    `;

    const result = AriaSnapshotEngine.generateSnapshot(html, 'https://www.naver.com', 'Naver Test Page');
    assert.strictEqual(result.title, 'Naver Test Page');
    assert.strictEqual(result.hasCaptcha, false);
    assert.ok(result.interactiveCount >= 4);
    assert.ok(result.snapshotText.includes('searchbox "검색어를 입력해 주세요."'));
    assert.ok(result.snapshotText.includes('button "검색"'));
    assert.ok(result.snapshotText.includes('link "뉴스 홈으로 이동"'));
    assert.ok(result.snapshotText.includes('heading "주요 뉴스 헤드라인"'));
  });

  it('detects CAPTCHA barriers and sets alert flags', () => {
    const html = `
      <html>
      <body>
        <div class="g-recaptcha" data-sitekey="xyz"></div>
        <input type="text" name="captcha_input">
      </body>
      </html>
    `;

    const result = AriaSnapshotEngine.generateSnapshot(html, 'https://example.com/protected');
    assert.strictEqual(result.hasCaptcha, true);
    assert.strictEqual(result.captchaType, 'reCAPTCHA');
    assert.ok(result.snapshotText.includes('CAPTCHA DETECTED'));
  });

  it('strips script, style, and svg noise to save LLM context tokens', () => {
    const html = `
      <html>
      <head>
        <style>.heavy { color: red; }</style>
        <script>console.log("noisy heavy tracking code");</script>
      </head>
      <body>
        <svg><path d="M0 0"/></svg>
        <button>Clean Button</button>
      </body>
      </html>
    `;

    const result = AriaSnapshotEngine.generateSnapshot(html);
    assert.ok(!result.snapshotText.includes('noisy heavy tracking code'));
    assert.ok(!result.snapshotText.includes('.heavy { color: red; }'));
    assert.ok(result.snapshotText.includes('button "Clean Button"'));
  });
});
