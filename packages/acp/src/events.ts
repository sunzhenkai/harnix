import type { HarnessPlanEntry, PermissionOption, PermissionRequest } from '@harnix/core';

export interface AcpDecodedEvent {
  readonly kind:
    | 'ignored'
    | 'message'
    | 'thought'
    | 'tool_call'
    | 'tool_call_update'
    | 'plan'
    | 'usage';
  readonly text: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolKind: string;
  readonly toolStatus: string;
  readonly toolTitle: string;
  readonly toolRawInput?: unknown;
  readonly toolRawOutput?: unknown;
  readonly plan: readonly HarnessPlanEntry[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
}

function firstString(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function firstValue(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined) return obj[key];
  }
  return undefined;
}

export function decodeSessionUpdate(raw: unknown): AcpDecodedEvent {
  let envelope = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const nested = envelope['update'];
  if (nested && typeof nested === 'object') {
    envelope = nested as Record<string, unknown>;
  }

  const updateKind = typeof envelope['sessionUpdate'] === 'string' ? envelope['sessionUpdate'] : '';
  const base = {
    text: '',
    toolCallId: '',
    toolName: '',
    toolKind: '',
    toolStatus: '',
    toolTitle: '',
    plan: [] as HarnessPlanEntry[],
  };

  if (
    updateKind === 'agent_message_chunk' ||
    updateKind === 'agent_thought_chunk'
  ) {
    const content = envelope['content'] as Record<string, unknown> | undefined;
    const text = content?.['type'] === 'text' && typeof content['text'] === 'string' ? content['text'] : '';
    return {
      ...base,
      kind: updateKind === 'agent_message_chunk' ? 'message' : 'thought',
      text,
    };
  }

  if (updateKind === 'tool_call' || updateKind === 'tool_call_update') {
    const toolCallId = firstString(envelope, 'toolCallId', 'tool_call_id');
    const toolTitle = firstString(envelope, 'title');
    const toolName = firstString(envelope, 'name') || toolTitle || 'tool';
    return {
      ...base,
      kind: updateKind,
      toolCallId,
      toolTitle,
      toolName,
      toolKind: firstString(envelope, 'kind'),
      toolStatus: firstString(envelope, 'status'),
      toolRawInput: firstValue(envelope, 'rawInput', 'raw_input'),
      toolRawOutput: firstValue(envelope, 'rawOutput', 'raw_output'),
    };
  }

  if (updateKind === 'plan') {
    const rawEntries = Array.isArray(envelope['entries']) ? envelope['entries'] : [];
    const plan: HarnessPlanEntry[] = rawEntries
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .map((entry) => ({
        content: firstString(entry, 'content'),
        priority: firstString(entry, 'priority') || undefined,
        status: firstString(entry, 'status') || 'pending',
      }));
    return { ...base, kind: 'plan', plan };
  }

  if (updateKind === 'usage_update') {
    const rawUsage = (envelope['usage'] ?? envelope) as Record<string, unknown>;
    return {
      ...base,
      kind: 'usage',
      usage: {
        inputTokens: typeof rawUsage['inputTokens'] === 'number' ? rawUsage['inputTokens'] : undefined,
        outputTokens: typeof rawUsage['outputTokens'] === 'number' ? rawUsage['outputTokens'] : undefined,
        totalTokens: typeof rawUsage['totalTokens'] === 'number' ? rawUsage['totalTokens'] : undefined,
      },
    };
  }

  return { ...base, kind: 'ignored' };
}

export function decodePermissionRequest(raw: unknown): {
  readonly sessionId: string;
  readonly request: PermissionRequest;
} {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sessionId = firstString(obj, 'sessionId', 'session_id');
  const toolCall = (obj['toolCall'] && typeof obj['toolCall'] === 'object' ? obj['toolCall'] : {}) as Record<
    string,
    unknown
  >;
  const toolCallId = firstString(toolCall, 'toolCallId', 'tool_call_id') || 'perm_unknown';
  const title = firstString(toolCall, 'title');
  const toolKind = firstString(toolCall, 'kind') || undefined;
  const toolName = firstString(toolCall, 'name') || title || toolKind || 'tool';
  const rawOptions = Array.isArray(obj['options']) ? obj['options'] : [];

  const options: PermissionOption[] = rawOptions
    .filter((o): o is Record<string, unknown> => Boolean(o && typeof o === 'object'))
    .map((o) => {
      const kindRaw = firstString(o, 'kind');
      const kind: PermissionOption['kind'] =
        kindRaw === 'allow_once' ||
        kindRaw === 'allow_always' ||
        kindRaw === 'reject_once' ||
        kindRaw === 'reject_always'
          ? kindRaw
          : 'other';
      return {
        optionId: firstString(o, 'optionId', 'option_id'),
        name: firstString(o, 'name') || kind,
        kind,
      };
    });

  return {
    sessionId,
    request: {
      requestId: toolCallId,
      toolName,
      toolKind,
      title: title || undefined,
      input: firstValue(toolCall, 'rawInput', 'raw_input'),
      options,
    },
  };
}
