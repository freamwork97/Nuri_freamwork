/**
 * Legacy task API used by the Edge extension fallback and tests:
 * providers, skills, server-side tabs, tasks (+SSE events), approvals, extension side panel files.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskOrchestrator } from '../orchestrator.js';
import { readJsonBody } from '../http/util.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export async function handleLegacyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  orchestrator: TaskOrchestrator,
): Promise<boolean> {
      // 1b. Side panel: GET /sidepanel
      if (pathname === '/sidepanel' && req.method === 'GET') {
        const rootDir = REPO_ROOT;
        const sidepanelPath = path.resolve(rootDir, 'extension', 'sidepanel.html');
        if (fs.existsSync(sidepanelPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(sidepanelPath, 'utf8'));
          return true;
        }
      }

      if (pathname === '/sidepanel.js' && req.method === 'GET') {
        const rootDir = REPO_ROOT;
        const jsPath = path.resolve(rootDir, 'extension', 'sidepanel.js');
        if (fs.existsSync(jsPath)) {
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(fs.readFileSync(jsPath, 'utf8'));
          return true;
        }
      }

      // 3. Provider List: GET /v1/providers
      if (pathname === '/v1/providers' && req.method === 'GET') {
        const agy = orchestrator.getProvider('google-agy');
        const agyHealth = agy ? await agy.detect() : null;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          {
            id: 'google-agy',
            name: 'Google Antigravity CLI',
            health: agyHealth,
            isDefault: true,
            models: agyHealth?.availableModels || ['gemini-3.8-flash-medium']
          },
          {
            id: 'openai-codex',
            name: 'OpenAI Codex CLI (P1)',
            health: { status: 'unsupported', reason: 'P1 roadmap item; pending verification' },
            isDefault: false
          },
          {
            id: 'anthropic-claude',
            name: 'Claude Code (P1)',
            health: { status: 'unsupported', reason: 'P1 roadmap item; pending verification' },
            isDefault: false
          }
        ]));
        return true;
      }

      // 4. Skills: GET /v1/skills
      if (pathname === '/v1/skills' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(orchestrator.skillManager.listSkills()));
        return true;
      }

      // 5. Tabs: GET /v1/tabs
      if (pathname === '/v1/tabs' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(orchestrator.tabManager.listTabs()));
        return true;
      }

      // 6. Active Tab ARIA Snapshot: GET /v1/tabs/active/aria
      if (pathname === '/v1/tabs/active/aria' && req.method === 'GET') {
        const activeTab = orchestrator.tabManager.getActiveTab();
        if (!activeTab) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No active tab' }));
          return true;
        }
        const aria = orchestrator.tabManager.getAriaSnapshot(activeTab.tabId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(aria));
        return true;
      }

      // 7. Open Tab: POST /v1/tabs
      if (pathname === '/v1/tabs' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const tab = orchestrator.tabManager.createTab(body.url || 'about:blank', body.title);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tab));
        return true;
      }

      // 8. Navigate Tab: POST /v1/tabs/navigate
      if (pathname === '/v1/tabs/navigate' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const activeTab = orchestrator.tabManager.getActiveTab();
        if (!activeTab) throw new Error('No active tab');
        const nav = await orchestrator.tabManager.navigate(activeTab.tabId, body.url, body.mockContent, body.mockTitle);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nav));
        return true;
      }

      // 9. Tasks: POST /v1/tasks
      if (pathname === '/v1/tasks' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const task = await orchestrator.createTask({
          providerId: body.providerId || 'google-agy',
          model: body.model || 'gemini-3.8-flash-medium',
          prompt: body.prompt,
          skillId: body.skillId,
          allowedOrigins: body.allowedOrigins
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
        return true;
      }

      // 9b. Task Status: GET /v1/tasks/:id
      const taskGetMatch = /^\/v1\/tasks\/([^/]+)$/.exec(pathname);
      if (taskGetMatch && req.method === 'GET') {
        const taskId = taskGetMatch[1];
        const task = orchestrator.getTask(taskId);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Task not found' }));
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
        return true;
      }

      // 10. Task Events SSE: GET /v1/tasks/:id/events
      const eventsMatch = /^\/v1\/tasks\/([^/]+)\/events$/.exec(pathname);
      if (eventsMatch && req.method === 'GET') {
        const taskId = eventsMatch[1];
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        res.write('retry: 1000\n\n');

        const send = (event: any) => res.write(`data: ${JSON.stringify(event)}\n\n`);

        // Replay events emitted before this client subscribed.
        for (const past of orchestrator.storage.getEvents(taskId)) send(past);

        const onEvent = (payload: { taskId: string; event: any }) => {
          if (payload.taskId === taskId) send(payload.event);
        };
        const onFailed = (payload: { taskId: string; error: string }) => {
          if (payload.taskId === taskId) send({ type: 'error', error: payload.error, timestamp: new Date().toISOString() });
        };
        const onState = (payload: { taskId: string; state: string }) => {
          if (payload.taskId === taskId) send({ type: 'state', state: payload.state, timestamp: new Date().toISOString() });
        };

        orchestrator.on('task:event', onEvent);
        orchestrator.on('task:failed', onFailed);
        orchestrator.on('task:state_change', onState);

        // Task already finished before subscribing: report its final state.
        const existing = orchestrator.getTask(taskId);
        if (existing?.state === 'FAILED') send({ type: 'error', error: existing.errorCode || 'Task failed' });
        else if (existing && ['COMPLETED', 'CANCELLED'].includes(existing.state)) send({ type: 'state', state: existing.state });

        req.on('close', () => {
          orchestrator.off('task:event', onEvent);
          orchestrator.off('task:failed', onFailed);
          orchestrator.off('task:state_change', onState);
        });
        return true;
      }

      // 11. Cancel Task: POST /v1/tasks/:id/cancel
      const cancelMatch = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(pathname);
      if (cancelMatch && req.method === 'POST') {
        const taskId = cancelMatch[1];
        const success = await orchestrator.cancelTask(taskId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
        return true;
      }

      // 12. Approvals: POST /v1/approvals/:id
      const approvalMatch = /^\/v1\/approvals\/([^/]+)$/.exec(pathname);
      if (approvalMatch && req.method === 'POST') {
        const approvalId = approvalMatch[1];
        const body = await readJsonBody(req);
        const decision = orchestrator.resolveApproval(approvalId, body.approved, body.reason);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(decision));
        return true;
      }

      return false;
}
