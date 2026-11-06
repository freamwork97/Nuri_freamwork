import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PolicyEngine } from '../../packages/anb-core/dist/policy.js';
import { redactText, redactObject } from '../../packages/anb-core/dist/redaction.js';

describe('PolicyEngine L0~L4 Enforcement', () => {
  const policy = new PolicyEngine();

  it('allows L0 passive read operations without approval', () => {
    const res = policy.evaluate({
      taskId: 'task_1',
      tool: 'browser.snapshot',
      origin: 'https://example.com'
    });
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.level, 'L0');
    assert.strictEqual(res.requiresUserApproval, false);
  });

  it('allows L1 navigation operations within task scope', () => {
    const res = policy.evaluate({
      taskId: 'task_1',
      tool: 'browser.navigate',
      origin: 'https://example.com',
      args: { url: 'https://example.com/search' }
    });
    assert.strictEqual(res.allowed, true);
    assert.strictEqual(res.level, 'L1');
    assert.strictEqual(res.requiresUserApproval, false);
  });

  it('blocks L3 sensitive actions without an approval token and creates approval request', () => {
    const res = policy.evaluate({
      taskId: 'task_1',
      tool: 'browser.click',
      origin: 'https://shop.example.com',
      args: { elementText: '주문하기 (Checkout)' }
    });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.level, 'L3');
    assert.strictEqual(res.requiresUserApproval, true);
    assert.ok(res.approvalRequest);
    assert.ok(res.approvalRequest.approvalId);
  });

  it('permits L3 action with human approval token and enforces single-use', () => {
    // 1. Trigger L3 request
    const check1 = policy.evaluate({
      taskId: 'task_1',
      tool: 'browser.submit',
      origin: 'https://shop.example.com'
    });
    assert.strictEqual(check1.allowed, false);
    const approvalId = check1.approvalRequest.approvalId;

    // 2. User approves
    const decision = policy.resolveApproval(approvalId, true);
    assert.strictEqual(decision.approved, true);
    assert.ok(decision.token);

    // 3. First execution with token -> Success
    const check2 = policy.evaluate({
      taskId: 'task_1',
      tool: 'browser.submit',
      origin: 'https://shop.example.com',
      approvalToken: decision.token
    });
    assert.strictEqual(check2.allowed, true);

    // 4. Re-execution with the same token -> Rejected (Single-use guard)
    const check3 = policy.evaluate({
      taskId: 'task_1',
      tool: 'browser.submit',
      origin: 'https://shop.example.com',
      approvalToken: decision.token
    });
    assert.strictEqual(check3.allowed, false);
    assert.strictEqual(check3.requiresUserApproval, true);
    assert.match(check3.reason, /already been consumed/);
  });

  it('strictly blocks L4 privilege escalation operations permanently', () => {
    const res = policy.evaluate({
      taskId: 'task_1',
      tool: 'export_auth_credential',
      origin: 'https://example.com'
    });
    assert.strictEqual(res.allowed, false);
    assert.strictEqual(res.level, 'L4');
    assert.strictEqual(res.requiresUserApproval, false);
  });
});

describe('Redaction Engine', () => {
  it('redacts Authorization Bearer tokens and passwords in text', () => {
    const input = 'Request Authorization: Bearer abc12345xyz and password = "super_secret_pw"';
    const output = redactText(input);
    assert.ok(!output.includes('abc12345xyz'));
    assert.ok(!output.includes('super_secret_pw'));
    assert.ok(output.includes('[REDACTED'));
  });

  it('redacts sensitive fields in nested JSON objects', () => {
    const input = {
      user: 'alice',
      password: 'mypassword',
      api_key: 'sk-abcdef1234567890abcdef',
      meta: {
        token: 'secret-token'
      }
    };
    const output = redactObject(input);
    assert.strictEqual(output.user, 'alice');
    assert.strictEqual(output.password, '[REDACTED_SENSITIVE_FIELD]');
    assert.strictEqual(output.api_key, '[REDACTED_SENSITIVE_FIELD]');
    assert.strictEqual(output.meta.token, '[REDACTED_SENSITIVE_FIELD]');
  });
});
