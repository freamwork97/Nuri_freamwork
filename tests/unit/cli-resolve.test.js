import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shimTarget, resolveCli } from '../../packages/anb-orchestrator/dist/llm/process.js';

describe('running the CLIs on Windows (server outside WSL)', () => {
  it('finds the script an npm .cmd shim runs', () => {
    const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
    assert.strictEqual(shimTarget(shim, 'C:\\Users\\u\\AppData\\Roaming\\npm'), 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js');
    assert.strictEqual(shimTarget('@echo off\r\nsomething.exe %*', 'C:\\x'), null);
  });

  it('leaves the command as it is outside Windows', () => {
    if (process.platform === 'win32') return;
    assert.deepStrictEqual(resolveCli('claude'), { file: 'claude', prefix: [] });
  });
});
