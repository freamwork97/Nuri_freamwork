import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TabManager } from '../../packages/anb-mcp-server/dist/tabManager.js';
import { McpDispatcher } from '../../packages/anb-mcp-server/dist/mcpDispatcher.js';
import { PolicyEngine } from '../../packages/anb-core/dist/policy.js';

describe('TabManager & McpDispatcher', () => {
  it('manages tab lifecycle (open, navigate, list, activate)', async () => {
    const tm = new TabManager();
    const tab1 = tm.getActiveTab();
    assert.ok(tab1);

    const tab2 = tm.createTab('https://news.ycombinator.com', 'Hacker News');
    assert.strictEqual(tm.listTabs().length, 2);
    assert.strictEqual(tm.getActiveTab().tabId, tab2.tabId);

    await tm.navigate(tab2.tabId, 'https://example.com', '<h1>Example Domain</h1>', 'Example Domain');
    const snapshot = tm.getSnapshot(tab2.tabId);
    assert.ok(snapshot.includes('Example Domain'));
  });

  it('dispatches L0 tools without approval', async () => {
    const tm = new TabManager();
    const policy = new PolicyEngine();
    const dispatcher = new McpDispatcher(tm, policy);

    const res = await dispatcher.dispatch({
      requestId: 'r1',
      taskId: 't1',
      tool: 'browser.tabs.list'
    });

    assert.strictEqual(res.success, true);
    assert.ok(Array.isArray(res.result));
    assert.strictEqual(res.result.length, 1);
  });

  it('dispatches browser.navigate and extracts page content', async () => {
    const tm = new TabManager();
    const policy = new PolicyEngine();
    const dispatcher = new McpDispatcher(tm, policy);

    const navRes = await dispatcher.dispatch({
      requestId: 'r2',
      taskId: 't1',
      tool: 'browser.navigate',
      args: {
        url: 'https://ai.google.dev',
        mockContent: '<main><h1>Gemini 3.8 Flash</h1><p>High speed and efficiency</p></main>',
        mockTitle: 'Gemini 3.8 Flash'
      }
    });

    assert.strictEqual(navRes.success, true);
    assert.strictEqual(navRes.result.title, 'Gemini 3.8 Flash');

    const extractRes = await dispatcher.dispatch({
      requestId: 'r3',
      taskId: 't1',
      tool: 'browser.extract'
    });

    assert.strictEqual(extractRes.success, true);
    assert.ok(extractRes.result.text.includes('High speed and efficiency'));
    assert.strictEqual(extractRes.result.url, 'https://ai.google.dev');
  });

  it('intercepts L3 click action requiring human approval', async () => {
    const tm = new TabManager();
    const policy = new PolicyEngine();
    const dispatcher = new McpDispatcher(tm, policy);

    const clickRes = await dispatcher.dispatch({
      requestId: 'r4',
      taskId: 't1',
      tool: 'browser.click',
      args: { elementId: 'btn_pay', elementText: '결제하기 (Pay Now)' },
      expectedPageOrigin: 'https://shop.example.com'
    });

    assert.strictEqual(clickRes.success, false);
    assert.strictEqual(clickRes.approvalRequired, true);
    assert.ok(clickRes.approvalRequest.approvalId);

    // Human approves request
    const approval = policy.resolveApproval(clickRes.approvalRequest.approvalId, true);
    assert.strictEqual(approval.approved, true);

    // Re-dispatch with valid one-time token -> Success!
    const reClickRes = await dispatcher.dispatch({
      requestId: 'r5',
      taskId: 't1',
      tool: 'browser.click',
      args: { elementId: 'btn_pay', elementText: '결제하기 (Pay Now)' },
      expectedPageOrigin: 'https://shop.example.com',
      approvalToken: approval.token
    });

    assert.strictEqual(reClickRes.success, true);
    assert.strictEqual(reClickRes.result.clicked, true);
  });
});
