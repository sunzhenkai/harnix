import type { HarnixError } from './errors.js';
import type {
  HarnessPlanEntry,
  HarnessRunResult,
  HarnessUsage,
  PermissionDecision,
  PermissionRequest,
} from './types.js';

export interface HarnessEventBase {
  readonly runId: string;
  readonly sessionId?: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export type HarnessEvent =
  | (HarnessEventBase & { readonly type: 'run.started'; readonly harnessId: string })
  | (HarnessEventBase & { readonly type: 'text.delta'; readonly text: string })
  | (HarnessEventBase & { readonly type: 'thought.delta'; readonly text: string })
  | (HarnessEventBase & {
      readonly type: 'tool.started';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly title?: string;
      readonly input?: unknown;
    })
  | (HarnessEventBase & {
      readonly type: 'tool.updated';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status?: string;
      readonly title?: string;
      readonly output?: unknown;
    })
  | (HarnessEventBase & {
      readonly type: 'tool.completed';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError?: boolean;
    })
  | (HarnessEventBase & { readonly type: 'plan.updated'; readonly entries: readonly HarnessPlanEntry[] })
  | (HarnessEventBase & { readonly type: 'permission.requested'; readonly request: PermissionRequest })
  | (HarnessEventBase & {
      readonly type: 'permission.resolved';
      readonly requestId: string;
      readonly decision: PermissionDecision;
    })
  | (HarnessEventBase & { readonly type: 'usage.updated'; readonly usage: HarnessUsage })
  | (HarnessEventBase & { readonly type: 'run.completed'; readonly result: HarnessRunResult })
  | (HarnessEventBase & { readonly type: 'run.failed'; readonly error: HarnixError });

export type HarnessEventPayload =
  | { readonly type: 'run.started'; readonly harnessId: string }
  | { readonly type: 'text.delta'; readonly text: string }
  | { readonly type: 'thought.delta'; readonly text: string }
  | {
      readonly type: 'tool.started';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly title?: string;
      readonly input?: unknown;
    }
  | {
      readonly type: 'tool.updated';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status?: string;
      readonly title?: string;
      readonly output?: unknown;
    }
  | {
      readonly type: 'tool.completed';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError?: boolean;
    }
  | { readonly type: 'plan.updated'; readonly entries: readonly HarnessPlanEntry[] }
  | { readonly type: 'permission.requested'; readonly request: PermissionRequest }
  | {
      readonly type: 'permission.resolved';
      readonly requestId: string;
      readonly decision: PermissionDecision;
    }
  | { readonly type: 'usage.updated'; readonly usage: HarnessUsage }
  | { readonly type: 'run.completed'; readonly result: HarnessRunResult }
  | { readonly type: 'run.failed'; readonly error: HarnixError };
