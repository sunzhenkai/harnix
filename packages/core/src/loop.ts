import { HarnixError, toHarnixError } from './errors.js';
import {
  allowAllPermissions,
  combineSignals,
  createRunId,
  HarnessEventEmitter,
  throwIfAborted,
} from './helpers.js';
import type {
  HarnessMessage,
  HarnessRunOptions,
  HarnessRunRequest,
  HarnessRunResult,
  HarnessStopReason,
  HarnessTool,
  HarnessToolCall,
  HarnessUsage,
} from './types.js';

export interface ToolLoopTurnContext {
  readonly turn: number;
  readonly signal: AbortSignal;
  readonly onTextDelta: (text: string) => Promise<void>;
  readonly onThoughtDelta: (text: string) => Promise<void>;
}

export interface ToolLoopTurnOutput {
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly HarnessToolCall[];
  readonly usage: HarnessUsage;
  readonly truncated: boolean;
}

export interface ToolLoopConfig {
  readonly harnessId: string;
  readonly runIdPrefix?: string;
  readonly defaultTools?: readonly HarnessTool[];
  readonly defaultMaxTurns?: number;
  readonly defaultMaxToolCalls?: number;
  readonly request: HarnessRunRequest;
  readonly options?: HarnessRunOptions;
  readonly invokeTurn: (ctx: ToolLoopTurnContext) => Promise<ToolLoopTurnOutput>;
  readonly onAssistantMessage?: (message: HarnessMessage) => void;
  readonly onToolMessage?: (message: HarnessMessage) => void;
}

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_MAX_TOOL_CALLS = 64;

/**
 * Shared multi-turn tool-use execution loop with permission checks, budget enforcement,
 * cancellation, and standardized HarnessEvent emission.
 */
export async function runToolLoop(config: ToolLoopConfig): Promise<HarnessRunResult> {
  const { request } = config;
  const runOptions = config.options ?? {};

  if (!request.input.trim()) {
    throw new HarnixError('INVALID_REQUEST', 'HarnessRunRequest.input must not be empty');
  }

  const runId = request.runId ?? createRunId(config.runIdPrefix ?? config.harnessId);
  const emitter = new HarnessEventEmitter(runId, request.sessionId, runOptions.onEvent);
  const { signal, cleanup } = combineSignals(runOptions.signal, request.limits?.timeoutMs);

  const tools = request.tools ?? config.defaultTools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const maxTurns = request.limits?.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
  const maxToolCalls = request.limits?.maxToolCalls ?? config.defaultMaxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const onPermission = runOptions.onPermission ?? allowAllPermissions;

  const generatedMessages: HarnessMessage[] = [{ role: 'user', content: request.input }];

  let turns = 0;
  let totalToolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let finalText = '';
  let finalThinking = '';
  let stopReason: HarnessStopReason = 'completed';

  try {
    await emitter.emit({ type: 'run.started', harnessId: config.harnessId });

    while (true) {
      throwIfAborted(signal);
      if (turns >= maxTurns) {
        stopReason = 'max_turns';
        break;
      }
      turns += 1;

      const turnResult = await config.invokeTurn({
        turn: turns,
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
      config.onAssistantMessage?.(assistantMsg);

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
          generatedMessages.push(toolMsg);
          config.onToolMessage?.(toolMsg);
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
        config.onToolMessage?.(toolMsg);
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
