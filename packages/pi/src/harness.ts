import {
  stream as piStream,
  type AssistantMessage,
  type Context,
  type Message as PiMessage,
  type Model,
  type Tool as PiTool,
  type ToolCall as PiToolCall,
} from '@mariozechner/pi-ai';
import {
  HarnixError,
  InMemoryHarnessSession,
  runToolLoop,
  streamFromRun,
  type Harness,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessMessage,
  type HarnessRunOptions,
  type HarnessRunRequest,
  type HarnessRunResult,
  type HarnessSession,
  type HarnessSessionOptions,
  type HarnessTool,
  type HarnessToolCall,
  type HarnessUsage,
} from '@harnix/core';

export type PiAdapterKind = 'openai-compatible' | 'anthropic';

export interface PiModelRoute {
  readonly adapterKind: PiAdapterKind;
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly reasoning?: boolean;
  readonly maxTokens?: number;
  readonly contextWindow?: number;
}

export interface PiTurnInput {
  readonly route: PiModelRoute;
  readonly context: Context;
  readonly signal: AbortSignal;
  readonly onTextDelta: (text: string) => Promise<void> | void;
  readonly onThoughtDelta: (text: string) => Promise<void> | void;
}

export interface PiTurnOutput {
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly HarnessToolCall[];
  readonly usage: HarnessUsage;
  readonly truncated: boolean;
  readonly assistantMessage?: AssistantMessage;
}

export type PiTurnInvoker = (input: PiTurnInput) => Promise<PiTurnOutput>;

export interface PiHarnessOptions {
  readonly route: PiModelRoute;
  readonly defaultTools?: readonly HarnessTool[];
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly invoker?: PiTurnInvoker;
}

function normalizePiBaseUrl(route: PiModelRoute): string {
  const trimmed = route.baseUrl.replace(/\/+$/u, '');
  return route.adapterKind === 'anthropic' ? trimmed.replace(/\/v1$/u, '') : trimmed;
}

export function buildPiModel(route: PiModelRoute): Model<'openai-completions' | 'anthropic-messages'> {
  return {
    id: route.modelId,
    name: route.modelId,
    api: route.adapterKind === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
    provider: route.adapterKind,
    baseUrl: normalizePiBaseUrl(route),
    reasoning: route.reasoning ?? false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow ?? 128_000,
    maxTokens: route.maxTokens ?? 4_096,
  };
}

export function toPiMessages(messages: readonly HarnessMessage[]): PiMessage[] {
  const out: PiMessage[] = [];
  const now = Date.now();
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content, timestamp: now });
    } else if (msg.role === 'system') {
      out.push({ role: 'user', content: `[System]\n${msg.content}`, timestamp: now });
    } else if (msg.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      if (msg.thinking) {
        content.push({ type: 'thinking', thinking: msg.thinking });
      }
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.toolCalls ?? []) {
        content.push({
          type: 'toolCall',
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
      out.push({
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider: 'harnix',
        model: 'history',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: msg.toolCalls && msg.toolCalls.length > 0 ? 'toolUse' : 'stop',
        timestamp: now,
      });
    } else if (msg.role === 'tool') {
      out.push({
        role: 'toolResult',
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        content: [{ type: 'text', text: msg.content }],
        isError: msg.isError ?? false,
        timestamp: now,
      });
    }
  }
  return out;
}

export function toPiTools(tools: readonly HarnessTool[]): PiTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as PiTool['parameters'],
  }));
}

export const defaultPiTurnInvoker: PiTurnInvoker = async ({
  route,
  context,
  signal,
  onTextDelta,
  onThoughtDelta,
}) => {
  const model = buildPiModel(route);
  const eventStream = piStream(model, context, {
    apiKey: route.apiKey,
    maxTokens: route.maxTokens ?? 4_096,
    signal,
  });

  let streamedText = '';
  let streamedThinking = '';
  let finalMessage: AssistantMessage | undefined;

  for await (const event of eventStream) {
    if (event.type === 'text_delta') {
      streamedText += event.delta;
      await onTextDelta(event.delta);
    } else if (event.type === 'thinking_delta') {
      streamedThinking += event.delta;
      await onThoughtDelta(event.delta);
    } else if (event.type === 'done') {
      finalMessage = event.message;
    } else if (event.type === 'error') {
      if (event.reason === 'aborted') {
        throw new HarnixError('CANCELLED', 'Pi execution aborted');
      }
      throw new HarnixError('PROVIDER_ERROR', event.error.errorMessage ?? 'Pi provider call failed');
    }
  }

  const message = finalMessage ?? (await eventStream.result());
  if (message.stopReason === 'error') {
    throw new HarnixError('PROVIDER_ERROR', message.errorMessage ?? 'Pi provider call failed');
  }
  if (message.stopReason === 'aborted') {
    throw new HarnixError('CANCELLED', 'Pi execution aborted');
  }

  const text =
    streamedText ||
    message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');

  const thinking =
    streamedThinking ||
    message.content
      .filter((part): part is { type: 'thinking'; thinking: string } => part.type === 'thinking')
      .map((part) => part.thinking)
      .join('');

  const toolCalls: HarnessToolCall[] = message.content
    .filter((part): part is PiToolCall => part.type === 'toolCall')
    .map((part) => ({
      id: part.id,
      name: part.name,
      arguments: part.arguments,
    }));

  return {
    text,
    thinking,
    toolCalls,
    usage: {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      totalTokens: message.usage.totalTokens,
    },
    truncated: message.stopReason === 'length',
    assistantMessage: message,
  };
};

/**
 * Harness implementation wrapping `@mariozechner/pi-ai` under the unified @harnix/core contract.
 */
export class PiHarness implements Harness {
  readonly capabilities: HarnessCapabilities = {
    id: 'pi',
    name: 'Harnix Pi Harness',
    version: '0.1.0',
    supported: ['streaming', 'thinking', 'tools', 'sessions', 'cancellation', 'permissions'],
  };

  private readonly invoker: PiTurnInvoker;

  constructor(private readonly options: PiHarnessOptions) {
    this.invoker = options.invoker ?? defaultPiTurnInvoker;
  }

  async run(request: HarnessRunRequest, runOptions: HarnessRunOptions = {}): Promise<HarnessRunResult> {
    const tools = request.tools ?? this.options.defaultTools ?? [];
    const piTools = toPiTools(tools);
    const piConversation: PiMessage[] = toPiMessages([
      ...(request.history ?? []),
      { role: 'user', content: request.input },
    ]);
    let lastAssistantMessage: AssistantMessage | undefined;

    return runToolLoop({
      harnessId: this.capabilities.id,
      runIdPrefix: 'pi',
      defaultTools: this.options.defaultTools,
      defaultMaxTurns: this.options.maxTurns,
      defaultMaxToolCalls: this.options.maxToolCalls,
      request,
      options: runOptions,
      invokeTurn: async ({ signal, onTextDelta, onThoughtDelta }) => {
        const result = await this.invoker({
          route: this.options.route,
          context: {
            systemPrompt: request.systemPrompt,
            messages: piConversation,
            ...(piTools.length > 0 ? { tools: piTools } : {}),
          },
          signal,
          onTextDelta,
          onThoughtDelta,
        });
        lastAssistantMessage = result.assistantMessage;
        return result;
      },
      onAssistantMessage: (msg) => {
        if (lastAssistantMessage) {
          piConversation.push(lastAssistantMessage);
          lastAssistantMessage = undefined;
        } else {
          piConversation.push(...toPiMessages([msg]));
        }
      },
      onToolMessage: (msg) => {
        piConversation.push(...toPiMessages([msg]));
      },
    });
  }

  stream(request: HarnessRunRequest, options?: HarnessRunOptions): AsyncIterable<HarnessEvent> {
    return streamFromRun(request, options, (req, opts) => this.run(req, opts));
  }

  async createSession(options?: HarnessSessionOptions): Promise<HarnessSession> {
    return new InMemoryHarnessSession(this, options);
  }
}
