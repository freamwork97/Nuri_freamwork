import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskOrchestrator } from '../../packages/anb-orchestrator/dist/orchestrator.js';

describe('TaskOrchestrator Integration & Task Lifecycle', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anb-test-'));

  it('initializes orchestrator with registered AntigravityProvider', () => {
    const orch = new TaskOrchestrator(tmpDir);
    const providers = orch.listProviders();
    assert.ok(providers.includes('google-agy'));
    assert.ok(orch.tabManager);
    assert.ok(orch.policyEngine);
  });

  it('enforces single-task concurrency constraint', async () => {
    const orch = new TaskOrchestrator(tmpDir);
    const task1 = await orch.createTask({
      providerId: 'google-agy',
      prompt: 'Summarize the documentation of Gemini 3.8 Flash'
    });

    assert.ok(task1.taskId);
    assert.strictEqual(task1.providerId, 'google-agy');

    // Attempt to start a second task while task 1 is running
    await assert.rejects(
      async () => {
        await orch.createTask({
          providerId: 'google-agy',
          prompt: 'Second task that should be rejected'
        });
      },
      /Another task .* is currently active/
    );

    // Cancel task1 to clean up
    await orch.cancelTask(task1.taskId);
  });

  it('cancels active task cleanly and updates task state', async () => {
    const orch = new TaskOrchestrator(tmpDir);
    const task = await orch.createTask({
      providerId: 'google-agy',
      prompt: 'Cancelable test task'
    });

    const cancelled = await orch.cancelTask(task.taskId);
    assert.strictEqual(cancelled, true);

    const savedTask = orch.storage.getTask(task.taskId);
    assert.ok(savedTask);
    assert.strictEqual(savedTask.state, 'CANCELLED');
  });

  it('exports task result to structured Markdown and JSON with evidence provenance', () => {
    const orch = new TaskOrchestrator(tmpDir);
    const mockTask = {
      taskId: 'task_export_test',
      providerId: 'google-agy',
      model: 'gemini-3.8-flash-medium',
      prompt: 'Check pricing and summarize findings',
      state: 'COMPLETED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const exported = orch.storage.exportTaskResult(
      mockTask,
      'Product A is $10/mo, Product B is $20/mo.',
      ['https://example.com/pricing']
    );

    assert.ok(fs.existsSync(exported.mdPath));
    assert.ok(fs.existsSync(exported.jsonPath));

    const mdContent = fs.readFileSync(exported.mdPath, 'utf-8');
    assert.ok(mdContent.includes('Nuri - 작업 결과 보고서'));
    assert.ok(mdContent.includes('Product A is $10/mo'));
    assert.ok(mdContent.includes('https://example.com/pricing'));

    const jsonContent = JSON.parse(fs.readFileSync(exported.jsonPath, 'utf-8'));
    assert.strictEqual(jsonContent.taskId, 'task_export_test');
    assert.strictEqual(jsonContent.sourceUrls[0], 'https://example.com/pricing');
  });
});
