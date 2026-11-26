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
  type HarnessUsage,
} from '@harnix/core';
import {
  invokeAnthropicTurn,
  invokeOpenAiCompatibleTurn,
  type NativeModelTurnInput,
  type NativeModelTurnResult,
  type NativeProviderConfig,
} from './providers.js';

export type NativeTurnInvoker = (input: NativeModelTurnInput) => Promise<NativeModelTurnResult>;

export interface NativeHarnessOptions {
  readonly provider: NativeProviderConfig;
  readonly defaultTools?: readonly HarnessTool[];
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly invoker?: NativeTurnInvoker;
}

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_MAX_TOOL_CALLS = 64;

/**
 * Hand-crafted Harness implementation using native fetch + SSE streaming + multi-turn tool loop.
 */
export class NativeHarness implements Harness {
  readonly capabilities: HarnessCapabilities = {
    id: 'native',
    name: 'Harnix Native Harness',
    version: '0.1.0',
    supported: ['streaming', 'thinking', 'tools', 'sessions', 'cancellation', 'permissions'],
  };

  private readonly invoker: NativeTurnInvoker;

  constructor(private readonly options: NativeHarnessOptions) {
    this.invoker =
      options.invoker ??
      (options.provider.kind === 'anthropic' ? invokeAnthropicTurn : invokeOpenAiCompatibleTurn);
  }

  async run(request: HarnessRunRequest, runOptions: HarnessRunOptions = {}): Promise<HarnessRunResult> {
    if (!request.input.trim()) {
      throw new HarnixError('INVALID_REQUEST', 'HarnessRunRequest.input must not be empty');
    }

    const runId = request.runId ?? createRunId('native');
    const emitter = new HarnessEventEmitter(runId, request.sessionId, runOptions.onEvent);
    const { signal, cleanup } = combineSignals(runOptions.signal, request.limits?.timeoutMs);

    const tools = request.tools ?? this.options.defaultTools ?? [];
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const maxTurns = request.limits?.maxTurns ?? this.options.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxToolCalls = request.limits?.maxToolCalls ?? this.options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const onPermission = runOptions.onPermission ?? allowAllPermissions;

    const historyMessages: HarnessMessage[] = [...(request.history ?? [])];
    const generatedMessages: HarnessMessage[] = [{ role: 'user', content: request.input }];
    const conversation: HarnessMessage[] = [...historyMessages, ...generatedMessages];

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
          config: this.options.provider,
          systemPrompt: request.systemPrompt,
          messages: conversation,
          tools,
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

        const usage: HarnessUsage = {
          turns,
          toolCalls: totalToolCalls,
          inputTokens,
          outputTokens,
          totalTokens,
        };
        await emitter.emit({ type: 'usage.updated', usage });

        finalText = turnResult.text;
        if (turnResult.thinking) finalThinking += turnResult.thinking;

        const assistantMsg: HarnessMessage = {
          role: 'assistant',
          content: turnResult.text,
          ...(turnResult.thinking ? { thinking: turnResult.thinking } : {}),
          ...(turnResult.toolCalls.length > 0 ? { toolCalls: turnResult.toolCalls } : {}),
        };
        conversation.push(assistantMsg);
        generatedMessages.push(assistantMsg);

        if (
          request.limits?.maxTokens !== undefined &&
          totalTokens >= request.limits.maxTokens
        ) {
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
          await emitter.emit({
            type: 'permission.resolved',
            requestId: permRequest.requestId,
            decision,
          });

          if (decision.outcome !== 'allow') {
            const denialContent = decision.reason || `Tool '${call.name}' execution ${decision.outcome}`;
            const toolMsg: HarnessMessage = {
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: denialContent,
              isError: true,
            };
            conversation.push(toolMsg);
            generatedMessages.push(toolMsg);
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
          conversation.push(toolMsg);
          generatedMessages.push(toolMsg);
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
        usage: {
          turns,
          toolCalls: totalToolCalls,
          inputTokens,
          outputTokens,
          totalTokens,
        },
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
