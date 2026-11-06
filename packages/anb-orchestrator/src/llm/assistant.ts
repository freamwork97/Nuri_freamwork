/**
 * Assistant mode: runs a CLI with the user's own configuration so installed skills, plugins
 * and connected MCP servers are available. Output files land in <repo>/workspace.
 * "Skip all permissions" flags are never used (project directive).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_SUBSCRIPTION_SETTINGS,
  CODEX_SUBSCRIPTION_FLAG,
  runCli,
  tryRunCli,
  type LlmProvider,
} from './process.js';

// The app's work folder (the installed app passes its own; the repo layout is the default).
export const ASSISTANT_WORKSPACE = process.env.ANB_WORKSPACE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../workspace');

export async function runAssistant(req: { provider: LlmProvider; prompt: string; images?: string[]; model?: string; signal?: AbortSignal }): Promise<string> {
  const opts = { cwd: ASSISTANT_WORKSPACE, timeoutMs: 15 * 60_000, signal: req.signal };
  switch (req.provider) {
    case 'claude': {
      const args = ['-p', req.prompt, '--output-format', 'json', '--settings', CLAUDE_SUBSCRIPTION_SETTINGS, '--permission-mode', 'auto'];
      if (req.model) args.push('--model', req.model);
      const parsed = JSON.parse(await runCli('claude', args, opts));
      if (parsed.is_error) throw new Error(`claude error: ${parsed.result}`);
      return String(parsed.result ?? '').trim();
    }
    case 'gpt': {
      const outFile = path.join(os.tmpdir(), `anb-codex-${Date.now()}.txt`);
      const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-c', CODEX_SUBSCRIPTION_FLAG, '-o', outFile];
      if (req.model) args.push('-m', req.model);
      // Claude and Gemini open image files from the prompt's paths; Codex needs them as flags.
      for (const f of req.images || []) args.push(`--image=${f}`);
      // "--" ends option parsing: --image takes multiple values and would swallow the prompt.
      args.push('--', req.prompt);
      try {
        await runCli('codex', args, opts);
        return fs.readFileSync(outFile, 'utf8').trim();
      } finally {
        fs.rmSync(outFile, { force: true });
      }
    }
    case 'gemini': {
      // "auto" mode is not available on every plan; accept-edits lets it write files in the workspace.
      const out = await runCli('agy', ['-p', req.prompt, '--model', req.model || 'gemini-3.8-flash-medium', '--mode', 'accept-edits'], opts);
      // A tool that needs a permission prompt is denied in print mode and the run ends with no text.
      if (!out.trim()) throw new Error('Gemini가 답변 없이 끝났습니다. 권한이 필요한 작업일 수 있으니 Claude 또는 GPT로 시도해 보세요.');
      return out.trim();
    }
  }
}

/** Makes an image with Codex's built-in generator (the user's ChatGPT plan) and saves it in the work folder. */
export async function generateImage(req: { prompt: string; path: string; signal?: AbortSignal }): Promise<{ path: string; bytes: number }> {
  const started = Date.now();
  const file = path.join(ASSISTANT_WORKSPACE, req.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const task = `이미지 생성 기능으로 아래 그림을 한 장 만들어 ${req.path} 에 PNG로 저장해. 다른 일은 하지 마.\n\n그림 설명: ${req.prompt}`;
  const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-c', CODEX_SUBSCRIPTION_FLAG, '--', task];
  await runCli('codex', args, { cwd: ASSISTANT_WORKSPACE, timeoutMs: 5 * 60_000, signal: req.signal });
  if (!fs.existsSync(file)) {
    // The generator always keeps its own copy, in case Codex did not move it.
    const dir = path.join(os.homedir(), '.codex', 'generated_images');
    const made = fs.existsSync(dir)
      ? (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f)).filter((f) => f.endsWith('.png') && fs.statSync(f).mtimeMs >= started)
      : [];
    if (!made.length) throw new Error('이미지가 만들어지지 않았습니다');
    fs.copyFileSync(made.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0], file);
  }
  return { path: req.path, bytes: fs.statSync(file).size };
}

// ---------- installed skills / plugins / MCP servers ----------

export interface Capabilities {
  provider: LlmProvider;
  plugins: string[];
  mcp: { name: string; status: 'connected' | 'needs-auth' | 'off' }[];
  skills: string[];
}

const CAPS_TTL_MS = 5 * 60_000;
let capCache: { at: number; data: Capabilities[] } | null = null;

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

const stripAnsi = (s: string | null) => (s ? s.replace(/\x1b\[[0-9;]*m/g, '') : '');

/** Parses "name: ... - status" style list output; empty for "No ... configured" messages. */
function simpleNames(s: string): string[] {
  if (!s || /No (MCP|plugins)/i.test(s)) return [];
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(name|-{3,}|warning)/i.test(l))
    .map((l) => l.split(/\s{2,}|\s+-\s+|:/)[0]);
}

export function parseClaudePlugins(text: string): string[] {
  return [...text.matchAll(/❯\s+([^\s@]+)@/g)].map((m) => m[1]);
}

export function parseClaudeMcp(text: string): Capabilities['mcp'] {
  return text
    .split('\n')
    .map((l) => /^(.+?):\s.*-\s+(✔ Connected|! Needs authentication|✘ Failed.*|- Not configured)/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({
      name: m[1].replace(/^claude\.ai /, '').replace(/^plugin:/, ''),
      status: m[2].includes('Connected') ? 'connected' : m[2].includes('auth') ? 'needs-auth' : 'off',
    }));
}

export async function capabilities(force = false): Promise<Capabilities[]> {
  if (!force && capCache && Date.now() - capCache.at < CAPS_TTL_MS) return capCache.data;
  const home = os.homedir();
  const [cPlug, cMcp, xMcp, gPlug, gMcp] = (
    await Promise.all([
      tryRunCli('claude', ['plugin', 'list'], 40_000),
      tryRunCli('claude', ['mcp', 'list'], 60_000),
      tryRunCli('codex', ['mcp', 'list']),
      tryRunCli('agy', ['plugin', 'list']),
      tryRunCli('agy', ['mcp', 'list']),
    ])
  ).map(stripAnsi);

  const data: Capabilities[] = [
    {
      provider: 'gemini',
      plugins: simpleNames(gPlug),
      mcp: simpleNames(gMcp).map((name) => ({ name, status: 'connected' as const })),
      skills: listDirs(path.join(home, '.gemini', 'skills')),
    },
    {
      provider: 'claude',
      plugins: parseClaudePlugins(cPlug),
      mcp: parseClaudeMcp(cMcp),
      skills: listDirs(path.join(home, '.claude', 'skills')).filter((n) => n !== 'synced'),
    },
    {
      provider: 'gpt',
      plugins: [],
      mcp: simpleNames(xMcp).map((name) => ({ name, status: 'connected' as const })),
      skills: listDirs(path.join(home, '.codex', 'skills')),
    },
  ];
  capCache = { at: Date.now(), data };
  return data;
}
