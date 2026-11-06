/** Subscription account status and web (OAuth) login for the three CLIs. */

import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { CODEX_SUBSCRIPTION_FLAG, SANDBOX_DIR, safeEnv, tryRunCli, type LlmProvider, spawnCli } from './process.js';

export interface AccountStatus {
  provider: LlmProvider;
  label: string;
  connected: boolean;
  subscription: boolean; // billed against a subscription plan, not pay-as-you-go
  detail: string;
  canLogin: boolean;
}

const STATUS_TTL_MS = 60_000;
let statusCache: { at: number; data: AccountStatus[] } | null = null;

export function invalidateAccountCache() {
  statusCache = null;
}

export async function accountStatus(force = false): Promise<AccountStatus[]> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.data;

  const [claudeOut, codexOut, agyOut] = await Promise.all([
    tryRunCli('claude', ['auth', 'status']),
    tryRunCli('codex', ['login', 'status']),
    tryRunCli('agy', ['models'], 45_000),
  ]);

  let claude: AccountStatus = { provider: 'claude', label: 'Claude', connected: false, subscription: false, detail: '로그인 필요', canLogin: true };
  try {
    const st = JSON.parse(claudeOut || '{}');
    if (st.loggedIn) {
      const sub = st.authMethod === 'claude.ai';
      const plan = String(st.subscriptionType || '').toUpperCase() || '구독';
      claude = {
        ...claude,
        connected: true,
        subscription: sub,
        detail: sub ? `Claude ${plan} · ${st.email || ''}`.trim() : 'API(종량제) 로그인 - 구독으로 재연결 필요',
      };
    }
  } catch {
    /* not logged in */
  }

  const codexText = codexOut || '';
  const viaChatGpt = /ChatGPT/i.test(codexText);
  const viaApiKey = !viaChatGpt && /API key/i.test(codexText);
  const gpt: AccountStatus = {
    provider: 'gpt',
    label: 'GPT (Codex)',
    connected: viaChatGpt || viaApiKey,
    subscription: viaChatGpt,
    detail: viaChatGpt ? 'ChatGPT 구독 계정' : viaApiKey ? 'API 키(종량제) 로그인 - 구독으로 재연결 필요' : '로그인 필요',
    canLogin: true,
  };

  const agyOk = !!agyOut && /gemini/i.test(agyOut);
  const gemini: AccountStatus = {
    provider: 'gemini',
    label: 'Gemini',
    connected: agyOk,
    subscription: agyOk,
    detail: agyOk ? 'Google 구독 (Antigravity)' : 'agy 로그인 필요 (WSL 터미널에서 agy 실행)',
    canLogin: false,
  };

  const data = [gemini, claude, gpt];
  statusCache = { at: Date.now(), data };
  return data;
}

// ---------- web login ----------

interface LoginSession {
  child: ChildProcess;
  output: string;
  done: boolean;
  ok: boolean;
}
const loginSessions = new Map<LlmProvider, LoginSession>();

/** Starts the CLI's OAuth flow and returns the URL to open in a browser. */
export function startLogin(provider: LlmProvider): Promise<{ url: string | null; message: string }> {
  if (provider === 'gemini') {
    return Promise.resolve({ url: null, message: 'Gemini는 WSL 터미널에서 agy를 실행해 로그인하세요.' });
  }
  loginSessions.get(provider)?.child.kill();
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  const [cmd, args]: [string, string[]] =
    provider === 'claude' ? ['claude', ['auth', 'login', '--claudeai']] : ['codex', ['login', '-c', CODEX_SUBSCRIPTION_FLAG]];
  // BROWSER=echo: print the URL instead of trying to open a Linux browser inside WSL.
  const child = spawnCli(cmd, args, { cwd: SANDBOX_DIR, env: safeEnv({ BROWSER: 'echo' }), stdio: ['pipe', 'pipe', 'pipe'] });
  const session: LoginSession = { child, output: '', done: false, ok: false };
  loginSessions.set(provider, session);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (url: string | null, message: string) => {
      if (!settled) {
        settled = true;
        resolve({ url, message });
      }
    };
    const onData = (d: Buffer) => {
      session.output = (session.output + d.toString()).slice(-20_000);
      const m = /(https:\/\/[^\s"'<>]+)/.exec(session.output.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) finish(m[1], '브라우저에서 로그인을 완료하세요.');
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('close', (code) => {
      session.done = true;
      session.ok = code === 0;
      invalidateAccountCache();
      finish(null, code === 0 ? '로그인 완료' : `로그인 실패: ${session.output.slice(-300)}`);
    });
    setTimeout(() => finish(null, `로그인 URL을 받지 못했습니다: ${session.output.slice(-300)}`), 20_000);
    setTimeout(() => child.kill(), 10 * 60_000).unref();
  });
}

/** Some flows show a code on the web page that must be pasted back into the CLI. */
export function submitLoginCode(provider: LlmProvider, code: string): boolean {
  const s = loginSessions.get(provider);
  if (!s || s.done || !s.child.stdin) return false;
  s.child.stdin.write(code.trim().slice(0, 500) + '\n');
  return true;
}

export function loginState(provider: LlmProvider) {
  const s = loginSessions.get(provider);
  return { active: !!s && !s.done, done: !!s?.done, ok: !!s?.ok };
}
