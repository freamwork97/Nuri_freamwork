/**
 * ANB Policy & Approval Engine (L0 ~ L4)
 */

import { createHash, randomBytes } from 'node:crypto';
import type { ApprovalLevel, ApprovalRequest, ApprovalDecision } from './types.js';

export interface ActionContext {
  taskId: string;
  tool: string;
  origin: string;
  targetElement?: string;
  args?: Record<string, unknown>;
  approvalToken?: string | null;
}

export interface PolicyResult {
  allowed: boolean;
  level: ApprovalLevel;
  requiresUserApproval: boolean;
  reason?: string;
  approvalRequest?: ApprovalRequest;
}

export class PolicyEngine {
  private activeTokens: Map<string, {
    approvalId: string;
    taskId: string;
    origin: string;
    tool: string;
    expiresAt: number;
    consumed: boolean;
  }> = new Map();

  private pendingRequests: Map<string, ApprovalRequest> = new Map();

  /**
   * Classify an action into an approval level
   */
  classifyAction(tool: string, args?: Record<string, unknown>): ApprovalLevel {
    // L4 - Permanently prohibited in MVP
    if (
      tool.includes('credential') ||
      tool.includes('export_auth') ||
      tool.includes('eval_shell') ||
      tool.includes('raw_process')
    ) {
      return 'L4';
    }

    // L3 - Sensitive operations requiring explicit human approval
    if (
      tool === 'browser.approval.request' ||
      tool === 'browser.submit' ||
      tool.includes('payment') ||
      tool.includes('order') ||
      tool.includes('delete') ||
      tool.includes('send_message') ||
      tool.includes('post_data')
    ) {
      return 'L3';
    }

    // Contextual L3 check: button submit / payment elements
    if (tool === 'browser.click' && args?.elementRole === 'submit') {
      return 'L3';
    }
    if (tool === 'browser.click' && typeof args?.elementText === 'string') {
      const sensitiveKeywords = ['결제', '주문', '제출', '삭제', '송금', 'submit', 'order', 'pay', 'checkout', 'delete'];
      const textLower = args.elementText.toLowerCase();
      if (sensitiveKeywords.some(kw => textLower.includes(kw))) {
        return 'L3';
      }
    }

    // L2 - Mutation or reading authenticated/local data
    if (
      tool === 'browser.type' ||
      tool === 'browser.download' ||
      tool === 'browser.upload'
    ) {
      return 'L2';
    }

    // L1 - Exploration and navigation
    if (
      tool === 'browser.tabs.open' ||
      tool === 'browser.navigate' ||
      tool === 'browser.click' ||
      tool === 'browser.extract'
    ) {
      return 'L1';
    }

    // L0 - Passive observation
    return 'L0';
  }

  /**
   * Evaluate whether the action can execute or needs human intervention
   */
  evaluate(context: ActionContext): PolicyResult {
    const level = this.classifyAction(context.tool, context.args);

    if (level === 'L4') {
      return {
        allowed: false,
        level: 'L4',
        requiresUserApproval: false,
        reason: `L4 action '${context.tool}' is strictly prohibited by security policy.`
      };
    }

    if (level === 'L3') {
      // Validate short-lived token if present
      if (context.approvalToken) {
        const tokenMeta = this.activeTokens.get(context.approvalToken);
        if (!tokenMeta) {
          return {
            allowed: false,
            level: 'L3',
            requiresUserApproval: true,
            reason: 'Provided approval token is invalid or expired.'
          };
        }
        if (tokenMeta.consumed) {
          return {
            allowed: false,
            level: 'L3',
            requiresUserApproval: true,
            reason: 'Approval token has already been consumed (single-use constraint).'
          };
        }
        if (Date.now() > tokenMeta.expiresAt) {
          this.activeTokens.delete(context.approvalToken);
          return {
            allowed: false,
            level: 'L3',
            requiresUserApproval: true,
            reason: 'Approval token has expired.'
          };
        }
        if (tokenMeta.taskId !== context.taskId || tokenMeta.origin !== context.origin) {
          return {
            allowed: false,
            level: 'L3',
            requiresUserApproval: true,
            reason: 'Approval token task/origin binding mismatch.'
          };
        }

        // Token valid! Mark as consumed (one-time use)
        tokenMeta.consumed = true;
        return {
          allowed: true,
          level: 'L3',
          requiresUserApproval: false
        };
      }

      // No valid token: generate approval request
      const approvalId = `appr_${Date.now()}_${randomBytes(4).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 180000).toISOString(); // 3 minutes TTL
      const summary = `Action '${context.tool}' on origin '${context.origin}' requires human approval.`;

      const approvalRequest: ApprovalRequest = {
        approvalId,
        taskId: context.taskId,
        origin: context.origin,
        actionKind: context.tool,
        level: 'L3',
        summary,
        targetElement: context.targetElement,
        requestedAt: new Date().toISOString(),
        expiresAt
      };

      this.pendingRequests.set(approvalId, approvalRequest);

      return {
        allowed: false,
        level: 'L3',
        requiresUserApproval: true,
        reason: 'L3 action requires explicit user approval before execution.',
        approvalRequest
      };
    }

    // L0, L1, L2 are permitted within an active task session
    return {
      allowed: true,
      level,
      requiresUserApproval: false
    };
  }

  /**
   * Human decides on an approval request
   */
  resolveApproval(approvalId: string, approved: boolean, reason?: string): ApprovalDecision {
    const req = this.pendingRequests.get(approvalId);
    if (!req) {
      throw new Error(`Pending approval request '${approvalId}' not found.`);
    }

    this.pendingRequests.delete(approvalId);
    const now = new Date().toISOString();

    if (!approved) {
      return {
        approvalId,
        approved: false,
        decidedAt: now,
        reason: reason || 'User rejected the action.'
      };
    }

    // Generate single-use cryptographic token bound to task, origin, tool
    const token = createHash('sha256')
      .update(`${approvalId}:${req.taskId}:${req.origin}:${randomBytes(16).toString('hex')}`)
      .digest('hex');

    this.activeTokens.set(token, {
      approvalId,
      taskId: req.taskId,
      origin: req.origin,
      tool: req.actionKind,
      expiresAt: Date.now() + 120000, // 2 minutes TTL once approved
      consumed: false
    });

    return {
      approvalId,
      approved: true,
      token,
      decidedAt: now
    };
  }
}
