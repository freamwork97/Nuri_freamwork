/**
 * Fast, tool-less completions for browser-agent step decisions.
 * Speed flags were chosen from measurements on a ~5KB step prompt (2026-10-21):
 *   claude  10.4s -> 7.7s cold, ~1.3s warm (session)   gemini 22.2s -> 8.4s   codex ~9s
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_ISOLATED,
  CODEX_SUBSCRIPTION_FLAG,
  runCli,
  writeTempImages,
  type ImageInput,
  type LlmProvider,
} from './process.js';
import { askClaudeSession } from './claudeSession.js';
import { askCodexSession } from './codexSession.js';
import { askGeminiSession } from './geminiSession.js';

export type Quality = 'fast' | 'accurate';

export interface CompleteRequest {
  provider: LlmProvider;
  prompt: string;
  system?: string;
  images?: ImageInput[];
  sessionId?: string; // reuse a warm process (Claude) across steps of one agent run
  quality?: Quality;
  model?: string;
  signal?: AbortSignal;
}

const MAX_PROMPT_CHARS = 120_000; // stay well below the per-argument limit (128KB on Linux)

export async function complete(req: CompleteRequest): Promise<string> {
  const quality = req.quality ?? 'fast';
  const system = req.system?.trim() || 'Follow the user instructions exactly.';
  const prompt = req.prompt.slice(0, MAX_PROMPT_CHARS);
  const images = (req.images || []).slice(0, 3);

  switch (req.provider) {
    case 'claude': {
      const effort = quality === 'fast' ? 'low' : 'medium';
      if (req.sessionId) {
        return (await askClaudeSession({ sessionId: req.sessionId, system, prompt, images, effort, model: req.model })).trim();
      }
      const { files, cleanup } = writeTempImages(images);
      try {
        const imageNote = files.length ? `\n\n(Screenshot files: ${files.join(', ')})` : '';
        const args = [
          '-p', prompt + imageNote, '--output-format', 'json',
          '--tools', files.length ? 'Read' : '',
          ...CLAUDE_ISOLATED, // includes the subscription-only settings
          '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
          '--system-prompt', system, '--effort', effort,
        ];
        if (files.length) args.push('--allowedTools', 'Read');
        if (req.model) args.push('--model', req.model);
        const parsed = JSON.parse(await runCli('claude', args, { signal: req.signal }));
        if (parsed.is_error) throw new Error(`claude error: ${parsed.result}`);
        return String(parsed.result ?? '').trim();
      } finally {
        cleanup();
      }
    }

    case 'gemini': {
      const model = req.model || (quality === 'fast' ? 'gemini-3.8-flash-low' : 'gemini-3.8-flash-medium');
      if (req.sessionId) {
        try {
          const text = await askGeminiSession({ sessionId: req.sessionId, system, prompt, images, model, signal: req.signal });
          if (text.trim()) return text.trim();
        } catch (e: any) {
          if (req.signal?.aborted) throw e;
          console.error('[Nuri] gemini session failed, falling back to print mode:', e?.message);
        }
      }
      const { files, cleanup } = writeTempImages(images);
      try {
        const imageNote = files.length ? `\n\nA screenshot of the current page is saved at: ${files.join(', ')} — open it to see the page.` : '';
        const out = await runCli('agy', ['-p', `${system}\n\n${prompt}${imageNote}`, '--model', model, '--disable-slash-commands'], {
          signal: req.signal,
        });
        return out.trim();
      } finally {
        cleanup();
      }
    }

    case 'gpt': {
      if (req.sessionId) {
        try {
          const text = await askCodexSession({
            sessionId: req.sessionId, system, prompt, images, model: req.model, signal: req.signal,
            effort: quality === 'fast' ? 'low' : 'medium',
          });
          if (text.trim()) return text.trim();
        } catch (e: any) {
          if (req.signal?.aborted) throw e;
          console.error('[Nuri] codex session failed, falling back to exec:', e?.message);
        }
      }
      const outFile = path.join(os.tmpdir(), `anb-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      const { files, cleanup } = writeTempImages(images);
      const args = ['exec', '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '-c', CODEX_SUBSCRIPTION_FLAG, '-o', outFile];
      if (req.model) args.push('-m', req.model);
      for (const f of files) args.push(`--image=${f}`);
      // "--" ends option parsing: --image takes multiple values and would swallow the prompt.
      args.push('--', `${system}\n\n${prompt}`);
      try {
        await runCli('codex', args, { signal: req.signal });
        return fs.readFileSync(outFile, 'utf8').trim();
      } finally {
        cleanup();
        fs.rmSync(outFile, { force: true });
      }
    }
  }
}
