import type { HarnessEvent } from './events.js';

export type HarnessCapability =
  | 'streaming'
  | 'thinking'
  | 'tools'
  | 'sessions'
  | 'cancellation'
  | 'permissions'
  | 'plan';

export interface HarnessCapabilities {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly supported: readonly HarnessCapability[];
}

export interface HarnessToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type HarnessMessage =
  | {
      readonly role: 'system' | 'user';
      readonly content: string;
    }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly thinking?: string;
      readonly toolCalls?: readonly HarnessToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface HarnessToolResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface HarnessToolContext {
  readonly runId: string;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}

export interface HarnessTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: HarnessToolContext): Promise<HarnessToolResult> | HarnessToolResult;
}

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'other';
}

export interface PermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolKind?: string;
  readonly title?: string;
  readonly input?: unknown;
  readonly options?: readonly PermissionOption[];
}

export interface PermissionDecision {
  readonly outcome: 'allow' | 'deny' | 'cancel';
  readonly optionId?: string;
  readonly reason?: string;
}

export type PermissionHandler = (
  request: PermissionRequest,
  signal: AbortSignal,
) => Promise<PermissionDecision> | PermissionDecision;

export interface HarnessPlanEntry {
  readonly content: string;
  readonly priority?: string;
  readonly status: string;
}

export interface HarnessUsage {
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface HarnessRunLimits {
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export interface HarnessRunRequest {
  readonly runId?: string;
  readonly sessionId?: string;
  readonly input: string;
  readonly systemPrompt?: string;
  readonly history?: readonly HarnessMessage[];
  readonly tools?: readonly HarnessTool[];
  readonly limits?: HarnessRunLimits;
  readonly metadata?: Record<string, unknown>;
}

export type HarnessEventListener = (event: HarnessEvent) => void | Promise<void>;

export interface HarnessRunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: HarnessEventListener;
  readonly onPermission?: PermissionHandler;
}

export type HarnessStopReason =
  | 'completed'
  | 'tool_calls'
  | 'max_turns'
  | 'max_tokens'
  | 'cancelled'
  | 'paused'
  | 'error';

export interface HarnessRunResult {
  readonly runId: string;
  readonly sessionId?: string;
  readonly text: string;
  readonly thinking?: string;
  readonly stopReason: HarnessStopReason;
  readonly messages: readonly HarnessMessage[];
  readonly usage: HarnessUsage;
}

export interface HarnessSessionOptions {
  readonly sessionId?: string;
  readonly systemPrompt?: string;
  readonly cwd?: string;
  readonly tools?: readonly HarnessTool[];
  readonly metadata?: Record<string, unknown>;
}

export interface HarnessSession {
  readonly id: string;
  send(input: string, options?: HarnessRunOptions): Promise<HarnessRunResult>;
  stream(input: string, options?: HarnessRunOptions): AsyncIterable<HarnessEvent>;
  history(): readonly HarnessMessage[];
  close(): Promise<void>;
}

/**
 * Unified Agent Harness interface implemented by Native, Pi, and ACP adapters.
 */
export interface Harness {
  readonly capabilities: HarnessCapabilities;
  run(request: HarnessRunRequest, options?: HarnessRunOptions): Promise<HarnessRunResult>;
  stream(request: HarnessRunRequest, options?: HarnessRunOptions): AsyncIterable<HarnessEvent>;
  createSession?(options?: HarnessSessionOptions): Promise<HarnessSession>;
  close?(): Promise<void>;
}
