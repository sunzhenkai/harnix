import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { HarnixError } from '@harnix/core';

const MAX_LINE_BYTES = 1024 * 1024;

interface RpcMessage {
  jsonrpc?: string;
  method?: string;
  id?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export type RpcNotificationHandler = (method: string, params: unknown) => void;
export type RpcRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export interface JsonRpcStreamEndpoint {
  readonly stdin: Writable;
  readonly stdout: Readable;
}

/**
 * Bidirectional JSON-RPC 2.0 over newline-delimited stdio streams.
 */
export class JsonRpcConn {
  private writeChain: Promise<void> = Promise.resolve();
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;
  private closeError: Error | null = null;
  private notificationHandler: RpcNotificationHandler | null = null;
  private requestHandler: RpcRequestHandler | null = null;

  constructor(private readonly endpoint: JsonRpcStreamEndpoint) {
    void this.readLoop();
  }

  setNotificationHandler(handler: RpcNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: RpcRequestHandler): void {
    this.requestHandler = handler;
  }

  async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      throw this.closeError ?? new HarnixError('ACP_PROTOCOL_ERROR', 'JSON-RPC connection closed');
    }
    const id = ++this.nextId;
    const payload = {
      jsonrpc: '2.0',
      method,
      id,
      ...(params === undefined ? {} : { params }),
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      if (signal) {
        const onAbort = () => {
          this.pending.delete(id);
          reject(new HarnixError('CANCELLED', `JSON-RPC call '${method}' aborted`));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      await this.write(payload);
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    await this.write({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private async readLoop(): Promise<void> {
    const rl = createInterface({ input: this.endpoint.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          this.fail(new HarnixError('ACP_PROTOCOL_ERROR', 'ACP JSON-RPC line exceeded 1 MiB limit'));
          return;
        }
        if (!line.trim()) continue;
        let msg: RpcMessage;
        try {
          msg = JSON.parse(line) as RpcMessage;
        } catch (error) {
          this.fail(
            new HarnixError('ACP_PROTOCOL_ERROR', `Invalid ACP JSON-RPC message: ${String(error)}`),
          );
          return;
        }

        if (!msg.method && msg.id !== undefined && msg.id !== null) {
          this.dispatchResponse(msg);
        } else if (msg.method && (msg.id === undefined || msg.id === null)) {
          this.notificationHandler?.(msg.method, msg.params);
        } else if (msg.method) {
          void this.dispatchRequest(msg);
        } else {
          this.fail(new HarnixError('ACP_PROTOCOL_ERROR', 'Malformed ACP JSON-RPC message'));
          return;
        }
      }
      this.fail(new HarnixError('ACP_PROCESS_ERROR', 'ACP stream closed (EOF)'));
    } catch (error) {
      this.fail(new HarnixError('ACP_PROCESS_ERROR', `ACP stream read failed: ${String(error)}`));
    }
  }

  private dispatchResponse(msg: RpcMessage): void {
    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
    if (!Number.isFinite(id)) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    if (msg.error) {
      pending.reject(
        new HarnixError('ACP_PROTOCOL_ERROR', `RPC '${pending.method}' failed: ${msg.error.message}`, {
          details: { rpcCode: msg.error.code, data: msg.error.data },
        }),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private async dispatchRequest(msg: RpcMessage): Promise<void> {
    if (!this.requestHandler || !msg.method) {
      await this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      }).catch(() => {});
      return;
    }
    try {
      const result = await this.requestHandler(msg.method, msg.params);
      await this.write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message },
      }).catch(() => {});
    }
  }

  private write(payload: unknown): Promise<void> {
    const line = `${JSON.stringify(payload)}\n`;
    const next = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.endpoint.stdin.write(line, 'utf8', (err) => {
            if (err) reject(new HarnixError('ACP_PROCESS_ERROR', `Failed to write ACP stdin: ${err.message}`));
            else resolve();
          });
        }),
    );
    this.writeChain = next.catch(() => {});
    return next;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
