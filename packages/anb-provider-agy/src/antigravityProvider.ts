/**
 * Antigravity CLI Provider Adapter (P0)
 * Integrates official Google Antigravity CLI subscription into ANB.
 * Strictly uses official CLI headless mode without raw API billing keys.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import type {
  AgentProvider,
  AgentRunInput,
  AgentEvent,
  ProviderCapabilities,
  ProviderHealth,
  ProviderId
} from '@anb/core';
import { redactText } from '@anb/core';

export class AntigravityProvider implements AgentProvider {
  public readonly id: ProviderId = 'google-agy';
  private activeProcesses: Map<string, ChildProcess> = new Map();

  async detect(): Promise<ProviderHealth> {
    try {
      // 1. Check if unauthorized paid API keys are injected in ambient env
      const forbiddenKeys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
      const detectedForbidden = forbiddenKeys.filter(k => !!process.env[k]);
      if (detectedForbidden.length > 0) {
        return {
          status: 'policy_blocked',
          reason: `Ambient environment contains raw API keys [${detectedForbidden.join(', ')}]. Under ANB subscription_cli_only policy, paid API fallback is forbidden.`,
          subscriptionOnly: true
        };
      }

      // 2. Test agy CLI executable
      const cliHelp = await this.executeCommand('agy', ['--help']);
      if (!cliHelp.includes('Usage of agy:')) {
        return {
          status: 'not_installed',
          reason: "Antigravity CLI ('agy') executable was not found on PATH or output was unexpected.",
          subscriptionOnly: true
        };
      }

      // 3. Fetch available models from agy
      const modelsOutput = await this.executeCommand('agy', ['models']);
      const availableModels: string[] = [];
      const lines = modelsOutput.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('gemini-') || trimmed.startsWith('claude-') || trimmed.startsWith('gpt-')) {
          const modelId = trimmed.split(/\s+/)[0];
          if (modelId) availableModels.push(modelId);
        }
      }

      // 4. Verify primary model gemini-3.8-flash-medium availability
      const hasFlashMedium = availableModels.some(m => m.includes('gemini-3.8-flash-medium'));
      if (!hasFlashMedium) {
        return {
          status: 'unsupported',
          reason: "Model 'gemini-3.8-flash-medium' not found in available agy models.",
          availableModels,
          subscriptionOnly: true
        };
      }

      return {
        status: 'ready',
        cliVersion: 'Antigravity CLI 2026.x',
        availableModels,
        subscriptionOnly: true
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'error',
        reason: `Failed to detect Antigravity CLI: ${msg}`,
        subscriptionOnly: true
      };
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      structuredEvents: true,
      mcpTools: true,
      sessionResume: true,
      modelSelection: true,
      usageMetadata: true
    };
  }

  async listModels(): Promise<string[]> {
    const health = await this.detect();
    return health.availableModels || ['gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low'];
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const model = input.model || 'gemini-3.8-flash-medium';
    const taskId = input.taskId;

    // Build agy command args for headless stream-json
    // Never use --dangerously-skip-permissions!
    const args = [
      '-p', input.prompt,
      '--model', model,
      '--output-format', 'stream-json'
    ];

    const child = spawn('agy', args, {
      cwd: input.workspace,
      env: {
        ...process.env,
        // Ensure no external API billing keys leak into the subshell
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.activeProcesses.set(taskId, child);

    // Yield initial task event
    yield {
      type: 'init',
      stepIndex: 0,
      state: 'ACTIVE',
      stepType: 'user_input',
      textDelta: `Started task ${taskId} with model ${model}`,
      timestamp: new Date().toISOString()
    };

    const eventQueue: AgentEvent[] = [];
    const lifecycle: { isDone: boolean; streamError: Error | null } = {
      isDone: false,
      streamError: null
    };
    let resolveNext: (() => void) | null = null;

    const notify = () => {
      if (resolveNext) {
        const fn = resolveNext;
        resolveNext = null;
        fn();
      }
    };

    const rl = readline.createInterface({
      input: child.stdout!,
      crlfDelay: Infinity
    });

    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;

      try {
        const rawEvent = JSON.parse(trimmed);
        const mapped = this.mapRawEventToAgentEvent(rawEvent);
        if (mapped) {
          eventQueue.push(mapped);
          notify();
        }
      } catch {
        // Non-JSON line or partial chunk, ignored
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on('error', (err: Error) => {
      lifecycle.streamError = err;
      lifecycle.isDone = true;
      notify();
    });

    child.on('close', (code: number | null) => {
      this.activeProcesses.delete(taskId);
      if (code !== 0 && !lifecycle.streamError) {
        lifecycle.streamError = new Error(`agy CLI exited with code ${code}: ${redactText(stderrBuffer)}`);
      }
      lifecycle.isDone = true;
      notify();
    });

    // Abort signal listener
    if (input.abortSignal) {
      input.abortSignal.addEventListener('abort', () => {
        lifecycle.isDone = true;
        notify();
        this.cancel(taskId).catch(() => {});
      });
    }

    try {
      while (true) {
        while (eventQueue.length > 0) {
          const ev = eventQueue.shift()!;
          yield ev;
        }

        if (lifecycle.isDone) {
          if (lifecycle.streamError) {
            yield {
              type: 'error',
              error: lifecycle.streamError.message,
              timestamp: new Date().toISOString()
            };
          }
          break;
        }

        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      this.activeProcesses.delete(taskId);
      if (!child.killed) {
        try { child.kill('SIGTERM'); } catch {}
      }
    }
  }

  async cancel(taskId: string): Promise<void> {
    const proc = this.activeProcesses.get(taskId);
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGINT');
        const timer = setTimeout(() => {
          if (!proc.killed) {
            try { proc.kill('SIGKILL'); } catch {}
          }
        }, 1000);
        if (timer && typeof timer.unref === 'function') {
          timer.unref();
        }
      } catch {}
      this.activeProcesses.delete(taskId);
    }
  }

  private mapRawEventToAgentEvent(raw: any): AgentEvent | null {
    const timestamp = new Date().toISOString();

    if (raw.event === 'init') {
      return {
        type: 'init',
        conversationId: raw.conversation_id,
        textDelta: `Initialized session with model ${raw.init?.model}`,
        timestamp
      };
    }

    if (raw.event === 'step_update' && raw.step_update) {
      const su = raw.step_update;
      return {
        type: su.text_delta ? 'text_delta' : 'step_update',
        conversationId: su.conversation_id,
        stepIndex: su.step_index,
        state: su.state,
        stepType: su.step_type,
        textDelta: su.text_delta ? redactText(su.text_delta) : undefined,
        usage: su.usage ? {
          inputTokens: su.usage.input_tokens,
          outputTokens: su.usage.output_tokens,
          thinkingTokens: su.usage.thinking_tokens,
          cacheReadTokens: su.usage.cache_read_tokens,
          totalTokens: su.usage.total_tokens
        } : undefined,
        timestamp
      };
    }

    if (raw.event === 'result' && raw.result) {
      return {
        type: 'result',
        conversationId: raw.result.conversation_id,
        state: raw.result.status === 'SUCCESS' ? 'DONE' : 'FAILED',
        textDelta: raw.result.response ? redactText(raw.result.response) : undefined,
        usage: raw.result.usage ? {
          inputTokens: raw.result.usage.input_tokens,
          outputTokens: raw.result.usage.output_tokens,
          thinkingTokens: raw.result.usage.thinking_tokens,
          cacheReadTokens: raw.result.usage.cache_read_tokens,
          totalTokens: raw.result.usage.total_tokens
        } : undefined,
        timestamp
      };
    }

    return null;
  }

  private executeCommand(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      p.stdout?.on('data', d => { output += d.toString(); });
      p.stderr?.on('data', d => { output += d.toString(); });
      p.on('close', code => {
        if (code === 0) resolve(output);
        else reject(new Error(`Command ${cmd} exited with code ${code}: ${output}`));
      });
      p.on('error', err => reject(err));
    });
  }
}
