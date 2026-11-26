import {
  HarnixError,
  type HarnessMessage,
  type HarnessTool,
  type HarnessToolCall,
  type HarnessToolChoice,
  type HarnessUsage,
} from '@harnix/core';
import { parseSseStream } from './sse.js';

export type NativeProviderKind = 'openai-compatible' | 'anthropic';

export interface NativeProviderConfig {
  readonly kind: NativeProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Whether to send `stream_options: { include_usage: true }` for OpenAI-compatible endpoints (default: true). */
  readonly includeUsage?: boolean;
  readonly headers?: Record<string, string>;
  readonly fetchFn?: typeof fetch;
}

export interface NativeModelTurnInput {
  readonly config: NativeProviderConfig;
  readonly systemPrompt?: string;
  readonly messages: readonly HarnessMessage[];
  readonly tools: readonly HarnessTool[];
  readonly signal: AbortSignal;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly toolChoice?: HarnessToolChoice;
  readonly onTextDelta: (text: string) => Promise<void> | void;
  readonly onThoughtDelta: (text: string) => Promise<void> | void;
}

export interface NativeModelTurnResult {
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly HarnessToolCall[];
  readonly usage: HarnessUsage;
  readonly truncated: boolean;
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function normalizeOpenAiEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

function normalizeAnthropicEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/u, '');
  if (trimmed.endsWith('/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function toOpenAiMessages(
  systemPrompt: string | undefined,
  messages: readonly HarnessMessage[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'user') {
      out.push({ role: msg.role, content: msg.content });
    } else if (msg.role === 'assistant') {
      const toolCalls = msg.toolCalls?.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }));
      out.push({
        role: 'assistant',
        content: msg.content || null,
        ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }
  return out;
}

function toAnthropicMessages(messages: readonly HarnessMessage[]): {
  systemParts: string[];
  messages: Record<string, unknown>[];
} {
  const systemParts: string[] = [];
  const out: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks: Record<string, unknown>[] = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    if (msg.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        ...(msg.isError ? { is_error: true } : {}),
      };
      const prev = out[out.length - 1];
      if (prev && prev['role'] === 'user' && Array.isArray(prev['content'])) {
        (prev['content'] as Record<string, unknown>[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }

  return { systemParts, messages: out };
}

async function assertOkResponse(response: Response, provider: NativeProviderKind): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new HarnixError(
    'PROVIDER_ERROR',
    `${provider} request failed with HTTP ${response.status}: ${text || response.statusText}`,
    {
      retryable: response.status === 429 || response.status >= 500,
      details: { status: response.status, provider },
    },
  );
}

export async function invokeOpenAiCompatibleTurn(input: NativeModelTurnInput): Promise<NativeModelTurnResult> {
  const fetchFn = input.config.fetchFn ?? fetch;
  const url = normalizeOpenAiEndpoint(input.config.baseUrl);
  const temperature = input.temperature ?? input.config.temperature;
  const maxTokens = input.maxTokens ?? input.config.maxTokens;
  const apiKey = input.config.apiKey.trim();

  const buildBody = (includeToolChoice: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: input.config.model,
      messages: toOpenAiMessages(input.systemPrompt, input.messages),
      stream: true,
      ...(input.config.includeUsage !== false ? { stream_options: { include_usage: true } } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    };

    if (input.tools.length > 0) {
      body['tools'] = input.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      if (includeToolChoice && input.toolChoice) {
        body['tool_choice'] = input.toolChoice;
      }
    }
    return body;
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...input.config.headers,
  };

  let response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(true)),
    signal: input.signal,
  });

  if (response.status === 400 && input.tools.length > 0 && input.toolChoice) {
    response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(false)),
      signal: input.signal,
    });
  }

  await assertOkResponse(response, 'openai-compatible');
  if (!response.body) {
    throw new HarnixError('PROVIDER_ERROR', 'OpenAI-compatible response body is empty');
  }

  let text = '';
  let thinking = '';
  let truncated = false;
  let usage: HarnessUsage = {};
  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

  for await (const frame of parseSseStream(response.body, input.signal)) {
    if (frame.data === '[DONE]') break;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const rawUsage = parsed['usage'] as Record<string, unknown> | undefined;
    if (rawUsage && typeof rawUsage === 'object') {
      usage = {
        inputTokens: typeof rawUsage['prompt_tokens'] === 'number' ? rawUsage['prompt_tokens'] : undefined,
        outputTokens: typeof rawUsage['completion_tokens'] === 'number' ? rawUsage['completion_tokens'] : undefined,
        totalTokens: typeof rawUsage['total_tokens'] === 'number' ? rawUsage['total_tokens'] : undefined,
      };
    }

    const choices = parsed['choices'] as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;

    if (choice['finish_reason'] === 'length') truncated = true;

    const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
    if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'].length > 0) {
      thinking += delta['reasoning_content'];
      await input.onThoughtDelta(delta['reasoning_content']);
    }
    if (typeof delta['content'] === 'string' && delta['content'].length > 0) {
      text += delta['content'];
      await input.onTextDelta(delta['content']);
    }

    const rawToolCalls = delta['tool_calls'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        const index = typeof tc['index'] === 'number' ? tc['index'] : 0;
        const entry = toolBuffers.get(index) ?? { id: '', name: '', args: '' };
        if (typeof tc['id'] === 'string' && tc['id']) entry.id = tc['id'];
        const fn = tc['function'] as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn['name'] === 'string' && fn['name']) entry.name += fn['name'];
          if (typeof fn['arguments'] === 'string') entry.args += fn['arguments'];
        }
        toolBuffers.set(index, entry);
      }
    }
  }

  const toolCalls: HarnessToolCall[] = [...toolBuffers.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, tc]) => ({
      id: tc.id || `call_${index + 1}`,
      name: tc.name,
      arguments: safeParseJsonObject(tc.args),
    }));

  return { text, thinking, toolCalls, usage, truncated };
}

export async function invokeAnthropicTurn(input: NativeModelTurnInput): Promise<NativeModelTurnResult> {
  const fetchFn = input.config.fetchFn ?? fetch;
  const url = normalizeAnthropicEndpoint(input.config.baseUrl);
  const converted = toAnthropicMessages(input.messages);
  const system = [input.systemPrompt, ...converted.systemParts].filter(Boolean).join('\n\n');
  const temperature = input.temperature ?? input.config.temperature;
  const maxTokens = input.maxTokens ?? input.config.maxTokens ?? 4096;
  const apiKey = input.config.apiKey.trim();

  const buildBody = (includeToolChoice: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: input.config.model,
      max_tokens: maxTokens,
      messages: converted.messages,
      stream: true,
      ...(system ? { system } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };

    if (input.tools.length > 0) {
      body['tools'] = input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
      if (includeToolChoice && input.toolChoice) {
        body['tool_choice'] = {
          type: input.toolChoice === 'required' ? 'any' : input.toolChoice,
        };
      }
    }
    return body;
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
    'anthropic-version': '2023-06-01',
    ...input.config.headers,
  };

  let response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildBody(true)),
    signal: input.signal,
  });

  if (response.status === 400 && input.tools.length > 0 && input.toolChoice) {
    response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(false)),
      signal: input.signal,
    });
  }

  await assertOkResponse(response, 'anthropic');
  if (!response.body) {
    throw new HarnixError('PROVIDER_ERROR', 'Anthropic response body is empty');
  }

  let text = '';
  let thinking = '';
  let truncated = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

  for await (const frame of parseSseStream(response.body, input.signal)) {
    if (!frame.data || frame.data === '[DONE]') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = parsed['type'];
    if (type === 'message_start') {
      const msg = parsed['message'] as Record<string, unknown> | undefined;
      const rawUsage = msg?.['usage'] as Record<string, unknown> | undefined;
      if (typeof rawUsage?.['input_tokens'] === 'number') inputTokens = rawUsage['input_tokens'];
    } else if (type === 'content_block_start') {
      const index = typeof parsed['index'] === 'number' ? parsed['index'] : 0;
      const block = parsed['content_block'] as Record<string, unknown> | undefined;
      if (block?.['type'] === 'tool_use') {
        toolBuffers.set(index, {
          id: typeof block['id'] === 'string' ? block['id'] : `toolu_${index}`,
          name: typeof block['name'] === 'string' ? block['name'] : '',
          args: '',
        });
      }
    } else if (type === 'content_block_delta') {
      const index = typeof parsed['index'] === 'number' ? parsed['index'] : 0;
      const delta = parsed['delta'] as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        text += delta['text'];
        await input.onTextDelta(delta['text']);
      } else if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
        thinking += delta['thinking'];
        await input.onThoughtDelta(delta['thinking']);
      } else if (delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        const entry = toolBuffers.get(index);
        if (entry) entry.args += delta['partial_json'];
      }
    } else if (type === 'message_delta') {
      const delta = parsed['delta'] as Record<string, unknown> | undefined;
      if (delta?.['stop_reason'] === 'max_tokens') truncated = true;
      const rawUsage = parsed['usage'] as Record<string, unknown> | undefined;
      if (typeof rawUsage?.['output_tokens'] === 'number') outputTokens = rawUsage['output_tokens'];
    }
  }

  const toolCalls: HarnessToolCall[] = [...toolBuffers.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      name: tc.name,
      arguments: safeParseJsonObject(tc.args),
    }));

  return {
    text,
    thinking,
    toolCalls,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    truncated,
  };
}
