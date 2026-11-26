import {
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
  readonly maxToolCallsPerTurn?: number;
  readonly invoker?: NativeTurnInvoker;
}

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
    const tools = request.tools ?? this.options.defaultTools ?? [];
    const conversation: HarnessMessage[] = [
      ...(request.history ?? []),
      { role: 'user', content: request.input },
    ];

    return runToolLoop({
      harnessId: this.capabilities.id,
      runIdPrefix: 'native',
      defaultTools: this.options.defaultTools,
      defaultMaxTurns: this.options.maxTurns,
      defaultMaxToolCalls: this.options.maxToolCalls,
      defaultMaxToolCallsPerTurn: this.options.maxToolCallsPerTurn,
      request,
      options: runOptions,
      invokeTurn: ({ signal, temperature, maxTokens, toolChoice, onTextDelta, onThoughtDelta }) =>
        this.invoker({
          config: this.options.provider,
          systemPrompt: request.systemPrompt,
          messages: conversation,
          tools,
          signal,
          temperature,
          maxTokens,
          toolChoice,
          onTextDelta,
          onThoughtDelta,
        }),
      onAssistantMessage: (msg) => conversation.push(msg),
      onToolMessage: (msg) => conversation.push(msg),
    });
  }

  stream(request: HarnessRunRequest, options?: HarnessRunOptions): AsyncIterable<HarnessEvent> {
    return streamFromRun(request, options, (req, opts) => this.run(req, opts));
  }

  async createSession(options?: HarnessSessionOptions): Promise<HarnessSession> {
    return new InMemoryHarnessSession(this, options);
  }
}
