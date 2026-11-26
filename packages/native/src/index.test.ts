import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent, HarnessTool } from '@harnix/core';
import { NativeHarness } from './index.js';

function startServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
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

describe('@harnix/native', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('streams OpenAI-compatible responses and executes multi-turn tool calls', async () => {
    let callCount = 0;
    const srv = await startServer((_req, body, res) => {
      callCount += 1;
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> };
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (callCount === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'need calc' } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call_1', function: { name: 'add', arguments: '{"a":2,' } }],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"b":3}' } }] } }],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      const toolReply = parsed.messages.find((m) => m.role === 'tool')?.content;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Answer is ${toolReply}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    cleanups.push(srv.close);

    const addTool: HarnessTool = {
      name: 'add',
      description: 'Add two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      execute: (args) => ({ content: String(Number(args['a']) + Number(args['b'])) }),
    };

    const harness = new NativeHarness({
      provider: {
        kind: 'openai-compatible',
        baseUrl: `${srv.url}/v1`,
        apiKey: 'test-key',
        model: 'gpt-test',
      },
    });

    const events: HarnessEvent[] = [];
    const result = await harness.run(
      { input: '2+3?', tools: [addTool] },
      { onEvent: (e) => void events.push(e) },
    );

    expect(result.text).toBe('Answer is 5');
    expect(result.thinking).toBe('need calc');
    expect(result.usage.turns).toBe(2);
    expect(result.usage.toolCalls).toBe(1);
    expect(result.usage.totalTokens).toBe(41);
    expect(events.some((e) => e.type === 'tool.completed' && e.content === '5')).toBe(true);
  });

  it('supports Anthropic SSE streaming and permission denial', async () => {
    let turn = 0;
    const srv = await startServer((_req, _body, res) => {
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (turn === 1) {
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'danger' } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } })}\n\n`);
        res.end();
        return;
      }
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Stopped safely.' } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n`);
      res.end();
    });
    cleanups.push(srv.close);

    let executed = false;
    const dangerTool: HarnessTool = {
      name: 'danger',
      description: 'Dangerous op',
      parameters: { type: 'object' },
      execute: () => {
        executed = true;
        return { content: 'boom' };
      },
    };

    const harness = new NativeHarness({
      provider: {
        kind: 'anthropic',
        baseUrl: srv.url,
        apiKey: 'anth-key',
        model: 'claude-test',
      },
    });

    const events: HarnessEvent[] = [];
    for await (const event of harness.stream(
      { input: 'do danger', tools: [dangerTool] },
      { onPermission: () => ({ outcome: 'deny', reason: 'blocked by policy' }) },
    )) {
      events.push(event);
    }

    expect(executed).toBe(false);
    const completed = events.find((e) => e.type === 'run.completed');
    expect(completed?.type === 'run.completed' && completed.result.text).toBe('Stopped safely.');
    expect(
      events.some((e) => e.type === 'tool.completed' && e.isError === true && e.content === 'blocked by policy'),
    ).toBe(true);
  });

  it('omits Authorization when apiKey is empty and retries without tool_choice on HTTP 400', async () => {
    const authHeaders: Array<string | undefined> = [];
    const bodies: Array<Record<string, unknown>> = [];
    let attempt = 0;

    const srv = await startServer((req, body, res) => {
      attempt += 1;
      authHeaders.push(req.headers['authorization']);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      bodies.push(parsed);

      if (attempt === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'tool_choice not supported' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ollama ok' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    cleanups.push(srv.close);

    const harness = new NativeHarness({
      provider: {
        kind: 'openai-compatible',
        baseUrl: `${srv.url}/v1`,
        apiKey: '',
        model: 'llama3',
      },
    });

    const result = await harness.run({
      input: 'hi',
      temperature: 0.3,
      maxTokens: 256,
      toolChoice: 'required',
      tools: [{ name: 'ping', description: 'ping', parameters: { type: 'object' }, execute: () => ({ content: 'ok' }) }],
    });

    expect(result.text).toBe('ollama ok');
    expect(authHeaders).toEqual([undefined, undefined]);
    expect(bodies[0]?.['tool_choice']).toBe('required');
    expect(bodies[1]?.['tool_choice']).toBeUndefined();
    expect(bodies[1]?.['temperature']).toBe(0.3);
    expect(bodies[1]?.['max_tokens']).toBe(256);
  });
});
