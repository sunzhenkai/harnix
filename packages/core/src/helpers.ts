import { randomUUID } from 'node:crypto';
import { HarnixError, toHarnixError } from './errors.js';
import type { HarnessEvent, HarnessEventPayload } from './events.js';
import type {
  Harness,
  HarnessCapabilities,
  HarnessCapability,
  HarnessEventListener,
  HarnessMessage,
  HarnessRunOptions,
  HarnessRunRequest,
  HarnessRunResult,
  HarnessSession,
  HarnessSessionOptions,
  PermissionHandler,
} from './types.js';

export function createRunId(prefix = 'run'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function createSessionId(prefix = 'sess'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function hasCapability(capabilities: HarnessCapabilities, capability: HarnessCapability): boolean {
  return capabilities.supported.includes(capability);
}

export function assertCapabilities(
  capabilities: HarnessCapabilities,
  required: readonly HarnessCapability[],
): void {
  const missing = required.filter((cap) => !hasCapability(capabilities, cap));
  if (missing.length > 0) {
    throw new HarnixError(
      'CAPABILITY_MISSING',
      `Harness '${capabilities.id}' is missing required capabilities: ${missing.join(', ')}`,
      { details: { harnessId: capabilities.id, missing } },
    );
  }
}

export function combineSignals(
  signal?: AbortSignal,
  timeoutMs?: number,
): { readonly signal: AbortSignal; cleanup: () => void } {
  if (!signal && (timeoutMs === undefined || timeoutMs <= 0)) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => {} };
  }

  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutController: AbortController | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutController = new AbortController();
    timer = setTimeout(() => {
      timeoutController?.abort(
        new HarnixError('TIMEOUT', `Harness run exceeded timeout of ${timeoutMs}ms`, { retryable: true }),
      );
    }, timeoutMs);
    signals.push(timeoutController.signal);
  }

  const combined = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  return {
    signal: combined,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof HarnixError) throw reason;
  throw new HarnixError('CANCELLED', reason instanceof Error ? reason.message : 'Run cancelled', {
    cause: reason,
  });
}

export const allowAllPermissions: PermissionHandler = () => ({ outcome: 'allow' });
export const denyAllPermissions: PermissionHandler = () => ({
  outcome: 'deny',
  reason: 'Denied by default permission policy',
});

/**
 * Sequential event emitter that tags events with runId, sessionId, sequence, and ISO timestamp.
 */
export class HarnessEventEmitter {
  private sequence = 0;

  constructor(
    private readonly runId: string,
    private readonly sessionId: string | undefined,
    private readonly listener?: HarnessEventListener,
  ) {}

  async emit(payload: HarnessEventPayload): Promise<HarnessEvent> {
    const event: HarnessEvent = {
      ...payload,
      runId: this.runId,
      ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    } as HarnessEvent;
    await this.listener?.(event);
    return event;
  }
}

/**
 * Push-to-pull async queue used to turn callback-based harness runs into AsyncIterable<HarnessEvent>.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;
  private hasFailure = false;

  push(item: T): void {
    if (this.ended || this.hasFailure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.buffer.push(item);
  }

  finish(): void {
    if (this.ended || this.hasFailure) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ value: undefined as never, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended || this.hasFailure) return;
    this.hasFailure = true;
    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.hasFailure) {
          return Promise.reject(this.failure);
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

/**
 * Wraps a `run()`-capable harness execution function into an `AsyncIterable<HarnessEvent>`.
 */
export function streamFromRun(
  request: HarnessRunRequest,
  options: HarnessRunOptions | undefined,
  executor: (req: HarnessRunRequest, opts: HarnessRunOptions) => Promise<HarnessRunResult>,
): AsyncIterable<HarnessEvent> {
  const queue = new AsyncEventQueue<HarnessEvent>();
  const runOptions: HarnessRunOptions = {
    ...options,
    onEvent: async (event) => {
      queue.push(event);
      await options?.onEvent?.(event);
    },
  };

  void executor(request, runOptions).then(
    () => queue.finish(),
    (error) => queue.fail(toHarnixError(error)),
  );

  return queue;
}

/**
 * In-memory stateful session wrapper that works with any `Harness` implementation.
 */
export class InMemoryHarnessSession implements HarnessSession {
  readonly id: string;
  private messages: HarnessMessage[] = [];
  private closed = false;

  constructor(
    private readonly harness: Harness,
    private readonly options: HarnessSessionOptions = {},
  ) {
    this.id = options.sessionId ?? createSessionId();
  }

  async send(input: string, runOptions?: HarnessRunOptions): Promise<HarnessRunResult> {
    this.ensureOpen();
    const request = this.buildRequest(input);
    const result = await this.harness.run(request, runOptions);
    this.appendTurn(input, result);
    return result;
  }

  async *stream(input: string, runOptions?: HarnessRunOptions): AsyncIterable<HarnessEvent> {
    this.ensureOpen();
    const request = this.buildRequest(input);
    let finalResult: HarnessRunResult | undefined;
    for await (const event of this.harness.stream(request, runOptions)) {
      if (event.type === 'run.completed') {
        finalResult = event.result;
      }
      yield event;
    }
    if (finalResult) {
      this.appendTurn(input, finalResult);
    }
  }

  history(): readonly HarnessMessage[] {
    return [...this.messages];
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new HarnixError('INVALID_REQUEST', `Session '${this.id}' is already closed`);
    }
  }

  private buildRequest(input: string): HarnessRunRequest {
    return {
      sessionId: this.id,
      input,
      systemPrompt: this.options.systemPrompt,
      history: this.messages,
      tools: this.options.tools,
      metadata: this.options.metadata,
    };
  }

  private appendTurn(input: string, result: HarnessRunResult): void {
    if (result.messages.length > 0) {
      this.messages = [...this.messages, ...result.messages];
      return;
    }
    this.messages.push(
      { role: 'user', content: input },
      {
        role: 'assistant',
        content: result.text,
        ...(result.thinking !== undefined ? { thinking: result.thinking } : {}),
      },
    );
  }
}
