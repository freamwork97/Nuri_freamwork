/**
 * ANB MCP Tool Dispatcher
 * Dispatches browser tools with strict PolicyEngine L0~L4 interception.
 */

import { PolicyEngine, type ActionContext } from '@anb/core';
import { TabManager } from './tabManager.js';

export interface ToolCallRequest {
  requestId: string;
  taskId: string;
  tool: string;
  args?: Record<string, any>;
  expectedPageOrigin?: string;
  approvalToken?: string | null;
}

export interface ToolCallResponse {
  requestId: string;
  success: boolean;
  result?: any;
  error?: string;
  approvalRequired?: boolean;
  approvalRequest?: any;
}

export class McpDispatcher {
  constructor(
    public readonly tabManager: TabManager,
    public readonly policyEngine: PolicyEngine
  ) {}

  async dispatch(req: ToolCallRequest): Promise<ToolCallResponse> {
    const activeTab = this.tabManager.getActiveTab();
    const origin = req.expectedPageOrigin || (activeTab ? this.extractOrigin(activeTab.url) : 'https://unknown.local');

    // 1. Evaluate security policy
    const policyContext: ActionContext = {
      taskId: req.taskId,
      tool: req.tool,
      origin,
      args: req.args,
      approvalToken: req.approvalToken
    };

    const evalResult = this.policyEngine.evaluate(policyContext);

    if (!evalResult.allowed) {
      if (evalResult.requiresUserApproval) {
        return {
          requestId: req.requestId,
          success: false,
          approvalRequired: true,
          approvalRequest: evalResult.approvalRequest,
          error: evalResult.reason
        };
      }
      return {
        requestId: req.requestId,
        success: false,
        error: evalResult.reason
      };
    }

    // 2. Dispatch authorized tool
    try {
      const result = await this.executeTool(req.tool, req.args, activeTab?.tabId);
      return {
        requestId: req.requestId,
        success: true,
        result
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        requestId: req.requestId,
        success: false,
        error: msg
      };
    }
  }

  private async executeTool(tool: string, args: Record<string, any> = {}, defaultTabId?: string): Promise<any> {
    const tabId = args.tabId || defaultTabId;

    switch (tool) {
      case 'browser.tabs.list': {
        return this.tabManager.listTabs();
      }

      case 'browser.tabs.open': {
        const url = args.url || 'about:blank';
        const title = args.title || 'New Tab';
        return this.tabManager.createTab(url, title);
      }

      case 'browser.tabs.activate': {
        if (!args.tabId) throw new Error("Missing required argument 'tabId'");
        const ok = this.tabManager.activateTab(args.tabId);
        return { activated: ok, tabId: args.tabId };
      }

      case 'browser.navigate': {
        if (!tabId) throw new Error("No active tab available to navigate");
        if (!args.url) throw new Error("Missing required argument 'url'");
        return await this.tabManager.navigate(tabId, args.url, args.mockContent, args.mockTitle);
      }

      case 'browser.snapshot': {
        if (!tabId) throw new Error("No active tab to snapshot");
        return { snapshot: this.tabManager.getSnapshot(tabId) };
      }

      case 'browser.find': {
        if (!tabId) throw new Error("No active tab to find elements");
        const found = this.tabManager.findElement(tabId, {
          role: args.role,
          text: args.text,
          selector: args.selector
        });
        return { element: found };
      }

      case 'browser.click': {
        if (!tabId) throw new Error("No active tab to click");
        // Verify element exists
        const el = this.tabManager.findElement(tabId, { selector: args.elementId });
        return {
          clicked: true,
          elementId: args.elementId,
          element: el
        };
      }

      case 'browser.type': {
        if (!tabId) throw new Error("No active tab to type");
        if (!args.elementId) throw new Error("Missing required argument 'elementId'");
        const typed = this.tabManager.typeElement(tabId, args.elementId, args.text || '');
        return { typed: true, elementId: args.elementId, value: typed.value };
      }

      case 'browser.scroll': {
        return { scrolled: true, delta: args.delta || 500 };
      }

      case 'browser.extract': {
        if (!tabId) throw new Error("No active tab to extract");
        return this.tabManager.extractText(tabId);
      }

      case 'browser.screenshot': {
        return {
          format: 'png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
        };
      }

      default:
        throw new Error(`Unsupported tool: '${tool}'`);
    }
  }

  private extractOrigin(urlStr: string): string {
    try {
      const u = new URL(urlStr);
      return u.origin;
    } catch {
      return 'https://unknown.local';
    }
  }
}
