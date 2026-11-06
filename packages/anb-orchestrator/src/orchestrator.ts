/**
 * ANB Task Orchestrator
 * State machine managing task lifecycle, provider integration, and event dispatch.
 */

import { EventEmitter } from 'node:events';
import type {
  AgentProvider,
  AgentEvent,
  TaskRecord,
  ProviderId,
  RunStatus,
  ApprovalRequest,
  ApprovalDecision
} from '@anb/core';
import { PolicyEngine } from '@anb/core';
import { AntigravityProvider } from '@anb/provider-agy';
import { TabManager, McpDispatcher } from '@anb/mcp-server';
import { LocalStorage } from './storage.js';
import { SkillManager, type SkillDefinition } from './skills/skillManager.js';

export interface CreateTaskOptions {
  providerId: ProviderId;
  model?: string;
  prompt: string;
  skillId?: string;
  allowedOrigins?: string[];
  maxSteps?: number;
  timeoutSeconds?: number;
}

export class TaskOrchestrator extends EventEmitter {
  private providers: Map<ProviderId, AgentProvider> = new Map();
  public readonly tabManager: TabManager;
  public readonly policyEngine: PolicyEngine;
  public readonly mcpDispatcher: McpDispatcher;
  public readonly storage: LocalStorage;
  public readonly skillManager: SkillManager;
  private activeAbortControllers: Map<string, AbortController> = new Map();
  private pendingApprovalResolvers: Map<string, (decision: ApprovalDecision) => void> = new Map();
  private activeTaskId: string | null = null;

  constructor(workspaceDir: string) {
    super();
    this.storage = new LocalStorage(workspaceDir);
    this.tabManager = new TabManager();
    this.policyEngine = new PolicyEngine();
    this.mcpDispatcher = new McpDispatcher(this.tabManager, this.policyEngine);
    this.skillManager = new SkillManager();

    // Register P0 Provider
    const agy = new AntigravityProvider();
    this.providers.set(agy.id, agy);
  }

  getProvider(id: ProviderId): AgentProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(): ProviderId[] {
    return Array.from(this.providers.keys());
  }

  async createTask(options: CreateTaskOptions): Promise<TaskRecord> {
    // Check single-task concurrency constraint (one active automation task at a time)
    if (this.activeTaskId) {
      const activeTask = this.storage.getTask(this.activeTaskId);
      if (activeTask && !['COMPLETED', 'CANCELLED', 'FAILED', 'completed', 'cancelled', 'failed'].includes(activeTask.state)) {
        throw new Error(`Another task '${this.activeTaskId}' is currently active. MVP allows 1 concurrent task.`);
      }
    }

    const taskId = `task_${Date.now()}`;
    const taskRecord: TaskRecord = {
      taskId,
      providerId: options.providerId,
      model: options.model || 'gemini-3.8-flash-medium',
      prompt: options.prompt,
      state: 'CREATED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      extractedUrls: []
    };

    this.storage.saveTask(taskRecord);
    this.activeTaskId = taskId;
    this.emit('task:created', taskRecord);

    // Launch execution asynchronously
    this.runTaskLoop(taskRecord, options).catch((err) => {
      this.handleTaskFailure(taskId, err);
    });

    return taskRecord;
  }

  private async runTaskLoop(task: TaskRecord, options: CreateTaskOptions) {
    const taskId = task.taskId;
    const abortController = new AbortController();
    this.activeAbortControllers.set(taskId, abortController);

    try {
      // 1. State: VALIDATING
      this.updateTaskState(taskId, 'VALIDATING');
      const provider = this.providers.get(task.providerId);
      if (!provider) {
        throw new Error(`Provider '${task.providerId}' is not registered or supported.`);
      }

      const health = await provider.detect();
      if (health.status !== 'ready') {
        throw new Error(`Provider '${task.providerId}' health check failed: ${health.reason || health.status}`);
      }

      // 2. State: PLANNING & Skill Matching
      this.updateTaskState(taskId, 'PLANNING');
      
      const matchedSkill = options.skillId 
        ? this.skillManager.getSkill(options.skillId) 
        : this.skillManager.matchSkill(task.prompt);

      if (matchedSkill) {
        this.emitEvent(taskId, {
          type: 'step_update',
          stepIndex: 1,
          state: 'ACTIVE',
          stepType: 'tool_execution',
          textDelta: `🎯 [스킬 매칭] ${matchedSkill.icon} '${matchedSkill.name}'이(가) 활성화되었습니다.`,
          timestamp: new Date().toISOString()
        });
      } else {
        this.emitEvent(taskId, {
          type: 'step_update',
          stepIndex: 1,
          state: 'ACTIVE',
          stepType: 'agent_response',
          textDelta: '사용자 명령 분석 및 접근성 트리 기반 실행 계획을 수립 중입니다...',
          timestamp: new Date().toISOString()
        });
      }

      // 3. State: RUNNING
      this.updateTaskState(taskId, 'RUNNING');

      const sourceUrls: string[] = [];
      let extractedSummary = '';
      const activeTab = this.tabManager.getActiveTab();
      if (!activeTab) throw new Error('No active browser tab found');

      // Detect target URL from prompt or skill default
      let targetUrl = this.detectTargetUrl(task.prompt);
      if (!targetUrl && matchedSkill && matchedSkill.defaultUrl) {
        targetUrl = matchedSkill.defaultUrl;
      }

      let ariaSnapshotText = '';

      if (targetUrl) {
        this.emitEvent(taskId, {
          type: 'step_update',
          stepIndex: 2,
          state: 'ACTIVE',
          stepType: 'tool_execution',
          textDelta: `🌐 웹 브라우저를 '${targetUrl}'로 실제 접속 중입니다...`,
          timestamp: new Date().toISOString()
        });

        const nav = await this.tabManager.navigate(activeTab.tabId, targetUrl);
        sourceUrls.push(nav.finalUrl);

        // Notify UI to load the real page via proxy
        this.emitEvent(taskId, {
          type: 'tool_call',
          toolName: 'browser.navigate',
          toolArgs: { url: nav.finalUrl, title: nav.title },
          timestamp: new Date().toISOString()
        });

        // Generate and dispatch ARIA Accessibility Tree
        const aria = this.tabManager.getAriaSnapshot(activeTab.tabId);
        ariaSnapshotText = aria.snapshotText;

        this.emitEvent(taskId, {
          type: 'tool_call',
          toolName: 'browser.ariaSnapshot',
          toolArgs: {
            url: aria.url,
            title: aria.title,
            hasCaptcha: aria.hasCaptcha,
            captchaType: aria.captchaType,
            interactiveCount: aria.interactiveCount,
            snapshot: aria.snapshotText
          },
          timestamp: new Date().toISOString()
        });

        if (aria.hasCaptcha) {
          this.emitEvent(taskId, {
            type: 'step_update',
            stepIndex: 3,
            state: 'ACTIVE',
            stepType: 'tool_execution',
            textDelta: `⚠️ [보안 가드] 페이지에서 ${aria.captchaType || 'CAPTCHA'}가 감지되었습니다.`,
            timestamp: new Date().toISOString()
          });
        } else {
          this.emitEvent(taskId, {
            type: 'step_update',
            stepIndex: 3,
            state: 'ACTIVE',
            stepType: 'tool_execution',
            textDelta: `'${nav.title}' 페이지 로드 완료 (상호작용 가능 요소: ${aria.interactiveCount}개). Gemini 3.8 Flash 자율 분석을 진행합니다.`,
            timestamp: new Date().toISOString()
          });
        }
      }

      // Enrich prompt with skill instructions and ARIA Accessibility Tree
      const enrichedPrompt = this.skillManager.enrichPrompt(
        task.prompt,
        matchedSkill || null,
        targetUrl,
        ariaSnapshotText
      );

      // Run real agent stream from provider
      const agentStream = provider.run({
        taskId,
        prompt: enrichedPrompt,
        model: task.model,
        workspace: process.cwd(),
        allowedOrigins: options.allowedOrigins,
        abortSignal: abortController.signal
      });

      for await (const event of agentStream) {
        if (abortController.signal.aborted) {
          this.updateTaskState(taskId, 'CANCELLED');
          return;
        }

        this.emitEvent(taskId, event);

        if (event.type === 'result' && event.textDelta) {
          extractedSummary += event.textDelta;
        }
      }

      // 4. State: COMPLETED
      const currentTab = this.tabManager.getActiveTab();
      if (currentTab && currentTab.url.startsWith('http')) {
        sourceUrls.push(currentTab.url);
      }

      const exportResult = this.storage.exportTaskResult(
        task,
        extractedSummary || 'Task completed successfully with official subscription CLI.',
        sourceUrls
      );

      task.completedAt = new Date().toISOString();
      task.resultPath = exportResult.mdPath;
      task.summary = extractedSummary;
      task.extractedUrls = sourceUrls;
      this.updateTaskState(taskId, 'COMPLETED');

    } catch (err: unknown) {
      this.handleTaskFailure(taskId, err);
    } finally {
      this.activeAbortControllers.delete(taskId);
      if (this.activeTaskId === taskId) {
        this.activeTaskId = null;
      }
    }
  }

  private detectTargetUrl(prompt: string): string | null {
    const trimmed = prompt.trim();

    // 1. Check explicit URL pattern
    const urlMatch = /(https?:\/\/[^\s]+)/i.exec(trimmed);
    if (urlMatch) return urlMatch[1];

    // 2. Search pattern in Naver: e.g. "네이버에서 [키워드] 검색"
    const naverSearchMatch = /네이버(?:에서)?\s+(?:'|")?([^'"\n]+?)(?:'|")?\s*(?:검색|찾아|조회)/i.exec(trimmed);
    if (naverSearchMatch && naverSearchMatch[1]) {
      return `https://search.naver.com/search.naver?query=${encodeURIComponent(naverSearchMatch[1].trim())}`;
    }

    // 3. Search pattern in Google: e.g. "구글에서 [키워드] 검색"
    const googleSearchMatch = /구글(?:에서)?\s+(?:'|")?([^'"\n]+?)(?:'|")?\s*(?:검색|찾아|조회)/i.exec(trimmed);
    if (googleSearchMatch && googleSearchMatch[1]) {
      return `https://www.google.com/search?q=${encodeURIComponent(googleSearchMatch[1].trim())}`;
    }

    // 4. Search pattern in YouTube: e.g. "유튜브에서 [키워드] 검색/틀어줘"
    const youtubeSearchMatch = /유튜브(?:에서)?\s+(?:'|")?([^'"\n]+?)(?:'|")?\s*(?:검색|찾아|조회|틀어|보여)/i.exec(trimmed);
    if (youtubeSearchMatch && youtubeSearchMatch[1]) {
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(youtubeSearchMatch[1].trim())}`;
    }

    // 5. Search pattern in Coupang: e.g. "쿠팡에서 [키워드] 검색"
    const coupangSearchMatch = /쿠팡(?:에서)?\s+(?:'|")?([^'"\n]+?)(?:'|")?\s*(?:검색|찾아|조회|최저가)/i.exec(trimmed);
    if (coupangSearchMatch && coupangSearchMatch[1]) {
      return `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(coupangSearchMatch[1].trim())}`;
    }

    // 6. Site name patterns
    const lower = trimmed.toLowerCase();
    if (lower.includes('네이버') || lower.includes('naver')) return 'https://www.naver.com';
    if (lower.includes('다음') || lower.includes('daum')) return 'https://www.daum.net';
    if (lower.includes('구글') || lower.includes('google')) return 'https://www.google.com';
    if (lower.includes('유튜브') || lower.includes('youtube')) return 'https://www.youtube.com';
    if (lower.includes('깃허브') || lower.includes('github')) return 'https://github.com';
    if (lower.includes('나무위키') || lower.includes('namuwiki')) return 'https://namu.wiki';
    if (lower.includes('쿠팡') || lower.includes('coupang')) return 'https://www.coupang.com';
    if (lower.includes('위키') || lower.includes('wikipedia')) return 'https://ko.wikipedia.org';

    return null;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const controller = this.activeAbortControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.activeAbortControllers.delete(taskId);
    }

    const provider = this.providers.get('google-agy');
    if (provider) {
      await provider.cancel(taskId).catch(() => {});
    }

    this.updateTaskState(taskId, 'CANCELLED');
    if (this.activeTaskId === taskId) {
      this.activeTaskId = null;
    }
    return true;
  }

  getTask(taskId: string): TaskRecord | null {
    return this.storage.getTask(taskId);
  }

  resolveApproval(approvalId: string, approved: boolean, reason?: string): ApprovalDecision {
    const decision = this.policyEngine.resolveApproval(approvalId, approved, reason);
    const resolver = this.pendingApprovalResolvers.get(approvalId);
    if (resolver) {
      resolver(decision);
      this.pendingApprovalResolvers.delete(approvalId);
    }

    // If waiting approval, resume or cancel
    if (this.activeTaskId) {
      const task = this.storage.getTask(this.activeTaskId);
      if (task && task.state === 'WAITING_APPROVAL') {
        if (approved) {
          this.updateTaskState(this.activeTaskId, 'RUNNING');
        } else {
          this.updateTaskState(this.activeTaskId, 'CANCELLED');
        }
      }
    }

    return decision;
  }

  private updateTaskState(taskId: string, state: RunStatus) {
    const task = this.storage.getTask(taskId);
    if (task) {
      task.state = state;
      task.updatedAt = new Date().toISOString();
      this.storage.saveTask(task);
      this.emit('task:state_change', { taskId, state });
    }
  }

  private emitEvent(taskId: string, event: AgentEvent) {
    this.storage.appendEvent(taskId, event);
    this.emit('task:event', { taskId, event });
  }

  private handleTaskFailure(taskId: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const task = this.storage.getTask(taskId);
    if (task) {
      task.state = 'FAILED';
      task.errorCode = msg;
      task.updatedAt = new Date().toISOString();
      this.storage.saveTask(task);
    }
    this.emit('task:failed', { taskId, error: msg });
  }
}
