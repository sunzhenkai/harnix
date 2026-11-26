import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent, HarnessTool } from '@harnix/core';
import { buildPiModel, PiHarness, toPiMessages, toPiTools } from './index.js';

function startMockOpenAiServer(
  handler: (body: string, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => handler(Buffer.concat(chunks).toString('utf8'), res));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('@harnix/pi', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('maps routes, messages, and tools to Pi AI structures', () => {
    const model = buildPiModel({
      adapterKind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      modelId: 'claude-sonnet-4',
      apiKey: 'sk-ant',
    });
    expect(model.api).toBe('anthropic-messages');
    expect(model.baseUrl).toBe('https://api.anthropic.com');

    const piMsgs = toPiMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'ping', content: 'pong' },
    ]);
    expect(piMsgs).toHaveLength(3);

    const piTools = toPiTools([
      { name: 'ping', description: 'Ping', parameters: { type: 'object' }, execute: () => ({ content: 'pong' }) },
    ]);
    expect(piTools[0]?.name).toBe('ping');
  });

  it('executes real defaultPiTurnInvoker through @mariozechner/pi-ai against a mock OpenAI SSE server', async () => {
    let callCount = 0;
    const srv = await startMockOpenAiServer((body, res) => {
      callCount += 1;
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (callCount === 1) {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-pi-live',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_pi_1',
                      type: 'function',
                      function: { name: 'echo', arguments: '{"msg":"pi-live"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'gpt-pi-live',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      const toolMsg = parsed.messages.find((m) => m.role === 'tool');
      const reply = `Pi answered: ${String(toolMsg?.content ?? '')}`;
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-2',
          object: 'chat.completion.chunk',
          created: 2,
          model: 'gpt-pi-live',
          choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-2',
          object: 'chat.completion.chunk',
          created: 2,
          model: 'gpt-pi-live',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    cleanups.push(srv.close);

    const echoTool: HarnessTool = {
      name: 'echo',
      description: 'Echo message',
      parameters: {
        type: 'object',
        properties: { msg: { type: 'string' } },
        required: ['msg'],
      },
      execute: (args) => ({ content: String(args['msg'] ?? '') }),
    };

    // No custom invoker: exercises the real defaultPiTurnInvoker + @mariozechner/pi-ai stream()
    const harness = new PiHarness({
      route: {
        adapterKind: 'openai-compatible',
        baseUrl: `${srv.url}/v1`,
        modelId: 'gpt-pi-live',
        apiKey: 'sk-test',
      },
    });

    const events: HarnessEvent[] = [];
    for await (const event of harness.stream({ input: 'run echo', tools: [echoTool] })) {
      events.push(event);
    }

    const completed = events.find((e) => e.type === 'run.completed');
    expect(completed?.type === 'run.completed' && completed.result.text).toBe('Pi answered: pi-live');
    expect(completed?.type === 'run.completed' && completed.result.usage.turns).toBe(2);
    expect(completed?.type === 'run.completed' && completed.result.usage.toolCalls).toBe(1);
    expect(events.some((e) => e.type === 'tool.completed' && e.content === 'pi-live')).toBe(true);
    expect(events.some((e) => e.type === 'text.delta' && e.text.includes('Pi answered'))).toBe(true);
  });

  it('forwards request-level temperature and maxTokens to Pi invoker', async () => {
    let seenTemp: number | undefined;
    let seenMaxTokens: number | undefined;

    const harness = new PiHarness({
      route: {
        adapterKind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9999/v1',
        modelId: 'gpt-pi',
        apiKey: 'sk-test',
      },
      invoker: async (input) => {
        seenTemp = input.temperature;
        seenMaxTokens = input.maxTokens;
        return { text: 'ok', thinking: '', toolCalls: [], usage: {}, truncated: false };
      },
    });

    const res = await harness.run({ input: 'hello', temperature: 0.15, maxTokens: 777 });
    expect(res.text).toBe('ok');
    expect(seenTemp).toBe(0.15);
    expect(seenMaxTokens).toBe(777);
  });
});
