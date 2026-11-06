import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AntigravityProvider } from '../../packages/anb-provider-agy/dist/antigravityProvider.js';

describe('AntigravityProvider', () => {
  const provider = new AntigravityProvider();

  it('detects official agy CLI and available Gemini models', async () => {
    const health = await provider.detect();
    assert.strictEqual(health.status, 'ready');
    assert.strictEqual(health.subscriptionOnly, true);
    assert.ok(health.availableModels.includes('gemini-3.8-flash-medium'));
  });

  it('reports capabilities as expected', async () => {
    const caps = await provider.capabilities();
    assert.strictEqual(caps.structuredEvents, true);
    assert.strictEqual(caps.mcpTools, true);
    assert.strictEqual(caps.modelSelection, true);
  });

  it('lists models including gemini-3.8-flash-medium and high', async () => {
    const models = await provider.listModels();
    assert.ok(models.some(m => m.includes('gemini-3.8-flash-medium')));
    assert.ok(models.some(m => m.includes('gemini-3.8-flash-high')));
  });
});
