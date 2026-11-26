import {
  allowAllPermissions,
  combineSignals,
  createRunId,
  createSessionId,
  HarnixError,
  HarnessEventEmitter,
  streamFromRun,
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
  type HarnessUsage,
} from '@harnix/core';
import {
  AcpClient,
  spawnAcpProcess,
  type AcpAgentSpawnConfig,
  type AcpEndpoint,
} from './client.js';
import type { AcpDecodedEvent } from './events.js';

export interface AcpHarnessOptions {
  readonly agent: AcpAgentSpawnConfig;
  readonly endpointFactory?: (config: AcpAgentSpawnConfig) => AcpEndpoint;
}

interface AcpConnectionState {
  readonly client: AcpClient;
  readonly remoteSessionId: string;
  historyReplayed: boolean;
}

function formatHistoryPrompt(
  systemPrompt: string | undefined,
  history: readonly HarnessMessage[] | undefined,
  input: string,
): string {
  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`[System Instructions]\n${systemPrompt}`);
  }
  if (history && history.length > 0) {
    const lines = history.map((m) => `${m.role.toUpperCase()}: ${m.content}`);
    parts.push(`[Conversation History]\n${lines.join('\n')}`);
  }
  if (parts.length === 0) return input;
  parts.push(`[Current User Message]\n${input}`);
  return parts.join('\n\n');
}

function mapAcpStopReason(raw: string): HarnessStopReason {
  if (raw === 'max_tokens') return 'max_tokens';
  if (raw === 'max_turn_requests') return 'max_turns';
  if (raw === 'cancelled') return 'cancelled';
  return 'completed';
}

/**
 * Harness adapter that connects any ACP (Agent Client Protocol) compatible Agent over stdio JSON-RPC 2.0.
 */
export class AcpHarness implements Harness {
  readonly capabilities: HarnessCapabilities = {
    id: 'acp',
    name: 'Harnix ACP Adapter',
    version: '0.1.0',
    supported: ['streaming', 'thinking', 'tools', 'sessions', 'cancellation', 'permissions', 'plan'],
  };

  private readonly endpointFactory: (config: AcpAgentSpawnConfig) => AcpEndpoint;
  private readonly connections = new Map<string, AcpConnectionState>();

  constructor(private readonly options: AcpHarnessOptions) {
    this.endpointFactory = options.endpointFactory ?? spawnAcpProcess;
  }

  async run(request: HarnessRunRequest, runOptions: HarnessRunOptions = {}): Promise<HarnessRunResult> {
    if (!request.input.trim()) {
      throw new HarnixError('INVALID_REQUEST', 'HarnessRunRequest.input must not be empty');
    }

    const runId = request.runId ?? createRunId('acp');
    const emitter = new HarnessEventEmitter(runId, request.sessionId, runOptions.onEvent);
    const { signal, cleanup } = combineSignals(runOptions.signal, request.limits?.timeoutMs);

    const ephemeral = request.sessionId === undefined;
    let conn: AcpConnectionState | undefined;

    try {
      await emitter.emit({ type: 'run.started', harnessId: this.capabilities.id });

      const targetCwd = request.cwd ?? this.options.agent.cwd;
      conn = request.sessionId
        ? await this.getOrCreateConnection(request.sessionId, targetCwd, signal)
        : await this.openConnection(targetCwd, signal);

      const promptText = conn.historyReplayed
        ? request.input
        : formatHistoryPrompt(request.systemPrompt, request.history, request.input);
      conn.historyReplayed = true;

      let text = '';
      let thinking = '';
      let usage: HarnessUsage = { turns: 1, toolCalls: 0 };
      const pendingEvents: Promise<unknown>[] = [];

      const enqueueEmit = (p: Promise<unknown>) => {
        pendingEvents.push(p);
      };

      const onAcpEvent = (event: AcpDecodedEvent) => {
        if (event.kind === 'message' && event.text) {
          text += event.text;
          enqueueEmit(emitter.emit({ type: 'text.delta', text: event.text }));
        } else if (event.kind === 'thought' && event.text) {
          thinking += event.text;
          enqueueEmit(emitter.emit({ type: 'thought.delta', text: event.text }));
        } else if (event.kind === 'tool_call') {
          usage = { ...usage, toolCalls: (usage.toolCalls ?? 0) + 1 };
          enqueueEmit(
            emitter.emit({
              type: 'tool.started',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              title: event.toolTitle || undefined,
              input: event.toolRawInput,
            }),
          );
        } else if (event.kind === 'tool_call_update') {
          if (event.toolStatus === 'completed' || event.toolStatus === 'failed') {
            const output =
              typeof event.toolRawOutput === 'string'
                ? event.toolRawOutput
                : event.toolRawOutput !== undefined
                  ? JSON.stringify(event.toolRawOutput)
                  : event.toolStatus;
            enqueueEmit(
              emitter.emit({
                type: 'tool.completed',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                content: output,
                isError: event.toolStatus === 'failed',
              }),
            );
          } else {
            enqueueEmit(
              emitter.emit({
                type: 'tool.updated',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: event.toolStatus || undefined,
                title: event.toolTitle || undefined,
                output: event.toolRawOutput,
              }),
            );
          }
        } else if (event.kind === 'plan') {
          enqueueEmit(emitter.emit({ type: 'plan.updated', entries: event.plan }));
        } else if (event.kind === 'usage' && event.usage) {
          usage = { ...usage, ...event.usage };
          enqueueEmit(emitter.emit({ type: 'usage.updated', usage }));
        }
      };

      const onPermission = async (
        permReq: Parameters<NonNullable<HarnessRunOptions['onPermission']>>[0],
        permSignal: AbortSignal,
      ) => {
        await emitter.emit({ type: 'permission.requested', request: permReq });
        const handler = runOptions.onPermission ?? allowAllPermissions;
        const decision = await handler(permReq, permSignal);
        await emitter.emit({
          type: 'permission.resolved',
          requestId: permReq.requestId,
          decision,
        });
        return decision;
      };

      const rawStopReason = await conn.client.prompt(
        conn.remoteSessionId,
        promptText,
        { onEvent: onAcpEvent, onPermission },
        signal,
      );
      await Promise.all(pendingEvents);

      const result: HarnessRunResult = {
        runId,
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
        text,
        ...(thinking ? { thinking } : {}),
        stopReason: mapAcpStopReason(rawStopReason),
        messages: [
          { role: 'user', content: request.input },
          {
            role: 'assistant',
            content: text,
            ...(thinking ? { thinking } : {}),
          },
        ],
        usage,
      };
      await emitter.emit({ type: 'run.completed', result });
      return result;
    } catch (error) {
      const harnixError = toHarnixError(error, 'ACP_PROCESS_ERROR');
      await emitter.emit({ type: 'run.failed', error: harnixError });
      if (request.sessionId) {
        await this.closeSession(request.sessionId).catch(() => {});
      }
      throw harnixError;
    } finally {
      cleanup();
      if (ephemeral && conn) {
        await conn.client.close().catch(() => {});
      }
    }
  }

  stream(request: HarnessRunRequest, options?: HarnessRunOptions): AsyncIterable<HarnessEvent> {
    return streamFromRun(request, options, (req, opts) => this.run(req, opts));
  }

  async createSession(options: HarnessSessionOptions = {}): Promise<HarnessSession> {
    const sessionId = options.sessionId ?? createSessionId('acp');
    const history: HarnessMessage[] = [];
    let closed = false;

    const ensureOpen = () => {
      if (closed) {
        throw new HarnixError('INVALID_REQUEST', `ACP session '${sessionId}' is already closed`);
      }
    };

    return {
      id: sessionId,
      send: async (input, runOptions) => {
        ensureOpen();
        const result = await this.run(
          {
            sessionId,
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            input,
            systemPrompt: options.systemPrompt,
            tools: options.tools,
            metadata: options.metadata,
          },
          runOptions,
        );
        history.push(...result.messages);
        return result;
      },
      stream: async function* (
        this: AcpHarness,
        input: string,
        runOptions?: HarnessRunOptions,
      ): AsyncIterable<HarnessEvent> {
        ensureOpen();
        let completed: HarnessRunResult | undefined;
        for await (const ev of this.stream(
          {
            sessionId,
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            input,
            systemPrompt: options.systemPrompt,
            tools: options.tools,
            metadata: options.metadata,
          },
          runOptions,
        )) {
          if (ev.type === 'run.completed') completed = ev.result;
          yield ev;
        }
        if (completed) history.push(...completed.messages);
      }.bind(this),
      history: () => [...history],
      close: async () => {
        closed = true;
        await this.closeSession(sessionId);
      },
    };
  }

  async close(): Promise<void> {
    const entries = [...this.connections.entries()];
    this.connections.clear();
    await Promise.all(entries.map(([, conn]) => conn.client.close().catch(() => {})));
  }

  private async closeSession(sessionId: string): Promise<void> {
    const conn = this.connections.get(sessionId);
    if (!conn) return;
    this.connections.delete(sessionId);
    await conn.client.close();
  }

  private async getOrCreateConnection(
    sessionId: string,
    cwd: string | undefined,
    signal: AbortSignal,
  ): Promise<AcpConnectionState> {
    const existing = this.connections.get(sessionId);
    if (existing) {
      if (existing.client.isAlive()) return existing;
      this.connections.delete(sessionId);
      await existing.client.close().catch(() => {});
    }
    const created = await this.openConnection(cwd, signal);
    this.connections.set(sessionId, created);
    return created;
  }

  private async openConnection(
    cwd: string | undefined,
    signal: AbortSignal,
  ): Promise<AcpConnectionState> {
    const spawnCfg: AcpAgentSpawnConfig = {
      ...this.options.agent,
      ...(cwd !== undefined ? { cwd } : {}),
    };
    const endpoint = this.endpointFactory(spawnCfg);
    const client = new AcpClient(endpoint, {
      idleTimeoutMs: this.options.agent.idleTimeoutMs,
      clientInfo: this.options.agent.clientInfo,
    });
    try {
      await client.initialize(signal);
      const remoteSessionId = await client.newSession(
        cwd ?? process.cwd(),
        this.options.agent.mcpServers ?? [],
        signal,
      );
      return { client, remoteSessionId, historyReplayed: false };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
}
