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
  allowAllPermissions,
  combineSignals,
  createRunId,
  HarnixError,
  HarnessEventEmitter,
  InMemoryHarnessSession,
  streamFromRun,
  throwIfAborted,
  toHarnixError,
  type Harness,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessMessage,
  type HarnessRunOptions,
  type HarnessRunRequest,
  type HarnessRunResult,
  type HarnessSession,
  type HarnessSessionOptions,
  type HarnessStopReason,
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

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_MAX_TOOL_CALLS = 64;

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
    if (!request.input.trim()) {
      throw new HarnixError('INVALID_REQUEST', 'HarnessRunRequest.input must not be empty');
    }

    const runId = request.runId ?? createRunId('pi');
    const emitter = new HarnessEventEmitter(runId, request.sessionId, runOptions.onEvent);
    const { signal, cleanup } = combineSignals(runOptions.signal, request.limits?.timeoutMs);

    const tools = request.tools ?? this.options.defaultTools ?? [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const piTools = toPiTools(tools);
    const maxTurns = request.limits?.maxTurns ?? this.options.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxToolCalls = request.limits?.maxToolCalls ?? this.options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const onPermission = runOptions.onPermission ?? allowAllPermissions;

    const generatedMessages: HarnessMessage[] = [{ role: 'user', content: request.input }];
    const piConversation: PiMessage[] = toPiMessages([...(request.history ?? []), ...generatedMessages]);

    let turns = 0;
    let totalToolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let finalText = '';
    let finalThinking = '';
    let stopReason: HarnessStopReason = 'completed';

    try {
      await emitter.emit({ type: 'run.started', harnessId: this.capabilities.id });

      while (true) {
        throwIfAborted(signal);
        if (turns >= maxTurns) {
          stopReason = 'max_turns';
          break;
        }
        turns += 1;

        const turnResult = await this.invoker({
          route: this.options.route,
          context: {
            systemPrompt: request.systemPrompt,
            messages: piConversation,
            ...(piTools.length > 0 ? { tools: piTools } : {}),
          },
          signal,
          onTextDelta: async (delta) => {
            await emitter.emit({ type: 'text.delta', text: delta });
          },
          onThoughtDelta: async (delta) => {
            await emitter.emit({ type: 'thought.delta', text: delta });
          },
        });

        inputTokens += turnResult.usage.inputTokens ?? 0;
        outputTokens += turnResult.usage.outputTokens ?? 0;
        totalTokens +=
          turnResult.usage.totalTokens ??
          (turnResult.usage.inputTokens ?? 0) + (turnResult.usage.outputTokens ?? 0);

        await emitter.emit({
          type: 'usage.updated',
          usage: { turns, toolCalls: totalToolCalls, inputTokens, outputTokens, totalTokens },
        });

        finalText = turnResult.text;
        if (turnResult.thinking) finalThinking += turnResult.thinking;

        const assistantMsg: HarnessMessage = {
          role: 'assistant',
          content: turnResult.text,
          ...(turnResult.thinking ? { thinking: turnResult.thinking } : {}),
          ...(turnResult.toolCalls.length > 0 ? { toolCalls: turnResult.toolCalls } : {}),
        };
        generatedMessages.push(assistantMsg);

        if (turnResult.assistantMessage) {
          piConversation.push(turnResult.assistantMessage);
        } else {
          piConversation.push(...toPiMessages([assistantMsg]));
        }

        if (request.limits?.maxTokens !== undefined && totalTokens >= request.limits.maxTokens) {
          stopReason = 'max_tokens';
          break;
        }

        if (turnResult.toolCalls.length === 0) {
          stopReason = turnResult.truncated ? 'max_tokens' : 'completed';
          break;
        }

        for (const call of turnResult.toolCalls) {
          throwIfAborted(signal);
          if (totalToolCalls >= maxToolCalls) {
            throw new HarnixError('BUDGET_EXHAUSTED', `Exceeded maxToolCalls limit (${maxToolCalls})`);
          }
          totalToolCalls += 1;

          const permRequest = {
            requestId: `${runId}_perm_${totalToolCalls}`,
            toolName: call.name,
            title: `Execute tool ${call.name}`,
            input: call.arguments,
          };
          await emitter.emit({ type: 'permission.requested', request: permRequest });
          const decision = await onPermission(permRequest, signal);
          await emitter.emit({ type: 'permission.resolved', requestId: permRequest.requestId, decision });

          if (decision.outcome !== 'allow') {
            const denialContent = decision.reason || `Tool '${call.name}' execution ${decision.outcome}`;
            const toolMsg: HarnessMessage = {
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: denialContent,
              isError: true,
            };
            generatedMessages.push(toolMsg);
            piConversation.push(...toPiMessages([toolMsg]));
            await emitter.emit({
              type: 'tool.completed',
              toolCallId: call.id,
              toolName: call.name,
              content: denialContent,
              isError: true,
            });
            continue;
          }

          await emitter.emit({
            type: 'tool.started',
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments,
          });

          const tool = toolMap.get(call.name);
          let content: string;
          let isError = false;
          if (!tool) {
            content = `Unknown tool: ${call.name}`;
            isError = true;
          } else {
            try {
              const executed = await tool.execute(call.arguments, {
                runId,
                sessionId: request.sessionId,
                signal,
              });
              content = executed.content;
              isError = executed.isError ?? false;
            } catch (toolErr) {
              content = toolErr instanceof Error ? toolErr.message : String(toolErr);
              isError = true;
            }
          }

          const toolMsg: HarnessMessage = {
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content,
            isError,
          };
          generatedMessages.push(toolMsg);
          piConversation.push(...toPiMessages([toolMsg]));
          await emitter.emit({
            type: 'tool.completed',
            toolCallId: call.id,
            toolName: call.name,
            content,
            isError,
          });
        }
      }

      const result: HarnessRunResult = {
        runId,
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        text: finalText,
        ...(finalThinking ? { thinking: finalThinking } : {}),
        stopReason,
        messages: generatedMessages,
        usage: { turns, toolCalls: totalToolCalls, inputTokens, outputTokens, totalTokens },
      };
      await emitter.emit({ type: 'run.completed', result });
      return result;
    } catch (error) {
      const harnixError = toHarnixError(error, 'PROVIDER_ERROR');
      await emitter.emit({ type: 'run.failed', error: harnixError });
      throw harnixError;
    } finally {
      cleanup();
    }
  }

  stream(request: HarnessRunRequest, options?: HarnessRunOptions): AsyncIterable<HarnessEvent> {
    return streamFromRun(request, options, (req, opts) => this.run(req, opts));
  }

  async createSession(options?: HarnessSessionOptions): Promise<HarnessSession> {
    return new InMemoryHarnessSession(this, options);
  }
}
