/**
 * Nuri - Core Types & Contracts
 */

export type ProviderId = 'google-agy' | 'openai-codex' | 'anthropic-claude';

export type HealthStatus =
  | 'ready'
  | 'not_installed'
  | 'login_required'
  | 'unsupported'
  | 'quota_limited'
  | 'policy_blocked'
  | 'error';

export type RunStatus =
  | 'created'
  | 'validating'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'CREATED'
  | 'VALIDATING'
  | 'PLANNING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type ApprovalLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export interface ProviderCapabilities {
  structuredEvents: boolean;
  mcpTools: boolean;
  sessionResume: boolean;
  modelSelection: boolean;
  usageMetadata: boolean;
}

export interface ProviderHealth {
  status: HealthStatus;
  cliVersion?: string;
  reason?: string;
  availableModels?: string[];
  subscriptionOnly: boolean;
}

export interface AgentEventUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

export interface AgentEvent {
  type: 'init' | 'step_update' | 'text_delta' | 'tool_call' | 'approval_required' | 'result' | 'error';
  conversationId?: string;
  stepIndex?: number;
  state?: 'ACTIVE' | 'DONE' | 'FAILED';
  stepType?: 'user_input' | 'agent_response' | 'tool_execution';
  textDelta?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  usage?: AgentEventUsage;
  error?: string;
  timestamp: string;
}

export interface AgentRunInput {
  taskId: string;
  prompt: string;
  model?: string;
  workspace: string;
  allowedOrigins?: string[];
  abortSignal: AbortSignal;
}

export interface AgentProvider {
  readonly id: ProviderId;
  detect(): Promise<ProviderHealth>;
  capabilities(): Promise<ProviderCapabilities>;
  listModels(): Promise<string[]>;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}

export interface ApprovalRequest {
  approvalId: string;
  taskId: string;
  origin: string;
  actionKind: string;
  level: ApprovalLevel;
  summary: string;
  targetElement?: string;
  requestedAt: string;
  expiresAt: string;
}

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  token?: string;
  decidedAt: string;
  reason?: string;
}

export interface BrowserTab {
  tabId: string;
  title: string;
  url: string;
  isActive: boolean;
}

export interface TaskRecord {
  taskId: string;
  providerId: ProviderId;
  model: string;
  prompt: string;
  state: RunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorCode?: string;
  resultPath?: string;
  summary?: string;
  extractedUrls?: string[];
}
