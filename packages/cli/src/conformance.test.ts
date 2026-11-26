import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpHarness } from '@harnix/acp';
import { hasCapability, type Harness, type HarnessEvent } from '@harnix/core';
import { NativeHarness } from '@harnix/native';
import { PiHarness } from '@harnix/pi';

interface HarnessFixture {
  readonly harness: Harness;
  readonly cleanup: () => Promise<void>;
}

function startEchoOpenAiServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages: Array<{ role: string; content: string }>;
        };
        const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: 'cmpl-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'echo',
            choices: [{ index: 0, delta: { role: 'assistant', content: `echo:${lastUser}` }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'cmpl-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'echo',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function createAcpEchoFixture(): Promise<HarnessFixture> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnix-conformance-'));
  const agentFile = path.join(dir, 'echo-acp.mjs');
  await fs.writeFile(
    agentFile,
    `
    import readline from 'node:readline';
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
      } else if (msg.method === 'session/prompt') {
        const text = msg.params.prompt?.[0]?.text ?? '';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:' + text } }
          }
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    });
    `,
    'utf8',
  );
  const harness = new AcpHarness({
    agent: { command: process.execPath, args: [agentFile] },
  });
  return {
    harness,
    cleanup: async () => {
      await harness.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const implementations: Array<{ name: string; create: () => Promise<HarnessFixture> }> = [
  {
    name: 'NativeHarness',
    create: async () => {
      const srv = await startEchoOpenAiServer();
      const harness = new NativeHarness({
        provider: { kind: 'openai-compatible', baseUrl: srv.url, apiKey: 'test', model: 'echo' },
      });
      return { harness, cleanup: srv.close };
    },
  },
  {
    name: 'PiHarness',
    create: async () => {
      const srv = await startEchoOpenAiServer();
      const harness = new PiHarness({
        route: { adapterKind: 'openai-compatible', baseUrl: srv.url, apiKey: 'test', modelId: 'echo' },
      });
      return { harness, cleanup: srv.close };
    },
  },
  {
    name: 'AcpHarness',
    create: createAcpEchoFixture,
  },
];

describe('Cross-Harness Conformance Suite', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  for (const impl of implementations) {
    describe(impl.name, () => {
      it('emits monotonic ordered stream events and preserves multi-turn session history', async () => {
        const fixture = await impl.create();
        cleanups.push(fixture.cleanup);
        const { harness } = fixture;

        expect(hasCapability(harness.capabilities, 'streaming')).toBe(true);
        expect(hasCapability(harness.capabilities, 'sessions')).toBe(true);
        expect(hasCapability(harness.capabilities, 'permissions')).toBe(true);

        const events: HarnessEvent[] = [];
        for await (const ev of harness.stream({ input: 'hello' })) {
          events.push(ev);
        }

        expect(events[0]?.type).toBe('run.started');
        expect(events[events.length - 1]?.type).toBe('run.completed');
        expect(events.some((e) => e.type === 'text.delta' && e.text.includes('echo:hello'))).toBe(true);
        for (let i = 1; i < events.length; i += 1) {
          expect(events[i]!.sequence).toBeGreaterThan(events[i - 1]!.sequence);
        }

        const session = await harness.createSession!();
        const r1 = await session.send('turn-1');
        const r2 = await session.send('turn-2');
        expect(r1.text).toContain('echo:turn-1');
        expect(r2.text).toContain('echo:turn-2');
        expect(session.history()).toHaveLength(4);
        await session.close();
      });
    });
  }
});
