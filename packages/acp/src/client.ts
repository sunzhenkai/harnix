import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  allowAllPermissions,
  HarnixError,
  type PermissionDecision,
  type PermissionHandler,
  type PermissionRequest,
} from '@harnix/core';
import { decodePermissionRequest, decodeSessionUpdate, type AcpDecodedEvent } from './events.js';
import { JsonRpcConn, type JsonRpcStreamEndpoint } from './jsonrpc.js';

export interface AcpAgentSpawnConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly idleTimeoutMs?: number;
  readonly clientInfo?: {
    readonly name: string;
    readonly title?: string;
    readonly version: string;
  };
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities?: Record<string, unknown>;
  readonly agentInfo?: { readonly name: string; readonly version: string };
}

export interface AcpPromptHandlers {
  readonly onEvent?: (event: AcpDecodedEvent) => void;
  readonly onPermission?: PermissionHandler;
}

export interface AcpEndpoint extends JsonRpcStreamEndpoint {
  close(): Promise<void>;
  stderrTail(): string;
}

export function spawnAcpProcess(config: AcpAgentSpawnConfig): AcpEndpoint {
  const child: ChildProcess = spawn(config.command, [...(config.args ?? [])], {
    cwd: config.cwd ?? process.cwd(),
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (!child.stdin || !child.stdout) {
    throw new HarnixError('ACP_PROCESS_ERROR', `Failed to open stdio pipes for ACP command '${config.command}'`);
  }

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4096);
  });

  const waitDone = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderrTail: () => stderrBuf.trim(),
    close: async () => {
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      const res = await Promise.race([
        waitDone.then(() => 'done' as const),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1500)),
      ]);
      if (res === 'timeout' && child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          waitDone,
          new Promise<void>((r) => setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
            r();
          }, 1000)),
        ]);
      }
    },
  };
}

interface ActivePrompt {
  readonly handlers: AcpPromptHandlers;
  cancelled: boolean;
  waiters: Array<() => void>;
  onActivity: () => void;
  nextActivity: () => Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

/**
 * ACP JSON-RPC 2.0 client managing initialization, sessions, prompt streaming, permissions, and cancellation.
 */
export class AcpClient {
  private readonly conn: JsonRpcConn;
  private readonly active = new Map<string, ActivePrompt>();
  private readonly idleTimeoutMs: number;
  private readonly clientInfo: { name: string; title: string; version: string };

  constructor(
    private readonly endpoint: AcpEndpoint,
    options: Pick<AcpAgentSpawnConfig, 'idleTimeoutMs' | 'clientInfo'> = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clientInfo = {
      name: options.clientInfo?.name ?? 'harnix',
      title: options.clientInfo?.title ?? 'Harnix ACP Client',
      version: options.clientInfo?.version ?? '0.1.0',
    };

    this.conn = new JsonRpcConn(endpoint);
    this.conn.setNotificationHandler((method, params) => this.handleNotification(method, params));
    this.conn.setRequestHandler((method, params) => this.handleRequest(method, params));
  }

  async initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
    const result = (await this.conn.call(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: this.clientInfo,
      },
      signal,
    )) as AcpInitializeResult;

    if (result.protocolVersion !== 1) {
      throw new HarnixError(
        'ACP_PROTOCOL_ERROR',
        `Unsupported ACP protocolVersion: ${String(result.protocolVersion)}`,
      );
    }
    return result;
  }

  async newSession(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = (await this.conn.call(
      'session/new',
      { cwd: path.resolve(cwd), mcpServers: [] },
      signal,
    )) as { sessionId?: string };

    if (!result.sessionId) {
      throw new HarnixError('ACP_PROTOCOL_ERROR', 'ACP session/new returned empty sessionId');
    }
    return result.sessionId;
  }

  async prompt(
    sessionId: string,
    text: string,
    handlers: AcpPromptHandlers = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const active: ActivePrompt = {
      handlers,
      cancelled: false,
      waiters: [],
      onActivity: () => {
        const list = active.waiters.splice(0);
        for (const w of list) w();
      },
      nextActivity: () =>
        new Promise<void>((resolve) => {
          active.waiters.push(resolve);
        }),
    };
    this.active.set(sessionId, active);

    try {
      const outcomePromise = this.conn
        .call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
        .then(
          (res) => ({
            ok: true as const,
            stopReason: String((res as { stopReason?: string })?.stopReason ?? 'end_turn'),
          }),
          (error) => ({ ok: false as const, error }),
        );

      while (true) {
        const racers: Array<
          Promise<
            | { kind: 'outcome'; outcome: Awaited<typeof outcomePromise> }
            | { kind: 'activity' }
            | { kind: 'idle' }
            | { kind: 'abort' }
          >
        > = [
          outcomePromise.then((outcome) => ({ kind: 'outcome' as const, outcome })),
          active.nextActivity().then(() => ({ kind: 'activity' as const })),
          new Promise<{ kind: 'idle' }>((resolve) =>
            setTimeout(() => resolve({ kind: 'idle' }), this.idleTimeoutMs),
          ),
        ];

        if (signal) {
          if (signal.aborted) {
            racers.push(Promise.resolve({ kind: 'abort' as const }));
          } else {
            racers.push(
              new Promise<{ kind: 'abort' }>((resolve) => {
                signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true });
              }),
            );
          }
        }

        const race = await Promise.race(racers);
        if (race.kind === 'activity') continue;

        if (race.kind === 'outcome') {
          if (!race.outcome.ok) {
            const tail = this.endpoint.stderrTail();
            const baseMsg =
              race.outcome.error instanceof Error
                ? race.outcome.error.message
                : String(race.outcome.error);
            throw new HarnixError(
              'ACP_PROCESS_ERROR',
              tail ? `${baseMsg}: ${tail}` : baseMsg,
              { cause: race.outcome.error },
            );
          }
          return race.outcome.stopReason;
        }

        active.cancelled = true;
        await this.cancel(sessionId).catch(() => {});
        if (race.kind === 'abort') {
          throw new HarnixError('CANCELLED', 'ACP prompt cancelled by caller');
        }
        throw new HarnixError('TIMEOUT', `ACP prompt idle timeout after ${this.idleTimeoutMs}ms`, {
          retryable: true,
        });
      }
    } finally {
      if (this.active.get(sessionId) === active) {
        this.active.delete(sessionId);
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.conn.notify('session/cancel', { sessionId });
  }

  async close(): Promise<void> {
    await this.endpoint.close();
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const obj = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : '';
    const active = this.active.get(sessionId);
    if (!active) return;

    active.onActivity();
    const decoded = decodeSessionUpdate(params);
    if (decoded.kind !== 'ignored') {
      active.handlers.onEvent?.(decoded);
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      throw new HarnixError('ACP_PROTOCOL_ERROR', `Unsupported ACP server request: ${method}`);
    }

    const { sessionId, request } = decodePermissionRequest(params);
    const active = this.active.get(sessionId);

    if (!active || active.cancelled) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const handler = active.handlers.onPermission ?? allowAllPermissions;
    const decision = await handler(request, new AbortController().signal);
    return toAcpPermissionResponse(decision, request);
  }
}

function toAcpPermissionResponse(
  decision: PermissionDecision,
  request: PermissionRequest,
): Record<string, unknown> {
  if (decision.outcome === 'cancel') {
    return { outcome: { outcome: 'cancelled' } };
  }

  if (decision.optionId) {
    return { outcome: { outcome: 'selected', optionId: decision.optionId } };
  }

  const options = request.options ?? [];
  const matched =
    decision.outcome === 'allow'
      ? options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
      : options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');

  if (matched) {
    return { outcome: { outcome: 'selected', optionId: matched.optionId } };
  }

  if (decision.outcome === 'allow') {
    return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
  }
  return { outcome: { outcome: 'cancelled' } };
}
