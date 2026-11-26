import { describe, expect, it } from 'vitest';
import type { HarnessEvent, HarnessTool } from '@harnix/core';
import { buildPiModel, PiHarness, toPiMessages, toPiTools } from './index.js';

describe('@harnix/pi', () => {
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

  it('executes multi-turn tool loop and streams unified events', async () => {
    let step = 0;
    const harness = new PiHarness({
      route: {
        adapterKind: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'gpt-pi',
        apiKey: 'sk-test',
      },
      invoker: async ({ onTextDelta, onThoughtDelta }) => {
        step += 1;
        if (step === 1) {
          await onThoughtDelta('thinking...');
          return {
            text: '',
            thinking: 'thinking...',
            toolCalls: [{ id: 'tc_1', name: 'echo', arguments: { msg: 'hello' } }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            truncated: false,
          };
        }
        await onTextDelta('Final: ');
        await onTextDelta('hello');
        return {
          text: 'Final: hello',
          thinking: '',
          toolCalls: [],
          usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
          truncated: false,
        };
      },
    });

    const echoTool: HarnessTool = {
      name: 'echo',
      description: 'Echo message',
      parameters: { type: 'object' },
      execute: (args) => ({ content: String(args['msg'] ?? '') }),
    };

    const events: HarnessEvent[] = [];
    for await (const event of harness.stream({ input: 'run echo', tools: [echoTool] })) {
      events.push(event);
    }

    const completed = events.find((e) => e.type === 'run.completed');
    expect(completed?.type === 'run.completed' && completed.result.text).toBe('Final: hello');
    expect(completed?.type === 'run.completed' && completed.result.usage.totalTokens).toBe(35);
    expect(events.some((e) => e.type === 'thought.delta' && e.text === 'thinking...')).toBe(true);
    expect(events.some((e) => e.type === 'tool.completed' && e.content === 'hello')).toBe(true);
  });
});
