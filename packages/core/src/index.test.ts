import { describe, expect, it } from 'vitest';
import {
  assertCapabilities,
  AsyncEventQueue,
  HarnixError,
  InMemoryHarnessSession,
  isHarnixError,
  streamFromRun,
  toHarnixError,
  type Harness,
  type HarnessCapabilities,
  type HarnessEvent,
  HarnessEventEmitter,
} from './index.js';

describe('@harnix/core', () => {
  it('validates required harness capabilities', () => {
    const caps: HarnessCapabilities = {
      id: 'test',
      name: 'Test Harness',
      version: '0.1.0',
      supported: ['streaming', 'tools'],
    };

    expect(() => assertCapabilities(caps, ['streaming'])).not.toThrow();
    expect(() => assertCapabilities(caps, ['streaming', 'plan'])).toThrowError(HarnixError);

    try {
      assertCapabilities(caps, ['plan']);
    } catch (error) {
      expect(isHarnixError(error, 'CAPABILITY_MISSING')).toBe(true);
    }
  });

  it('converts callback runs into AsyncIterable event streams', async () => {
    const events: HarnessEvent[] = [];
    const iterable = streamFromRun(
      { input: 'hello' },
      undefined,
      async (req, opts) => {
        const emitter = new HarnessEventEmitter('run_1', req.sessionId, opts.onEvent);
        await emitter.emit({ type: 'run.started', harnessId: 'mock' });
        await emitter.emit({ type: 'text.delta', text: 'hi' });
        const result = {
          runId: 'run_1',
          text: 'hi',
          stopReason: 'completed' as const,
          messages: [
            { role: 'user' as const, content: req.input },
            { role: 'assistant' as const, content: 'hi' },
          ],
          usage: { turns: 1 },
        };
        await emitter.emit({ type: 'run.completed', result });
        return result;
      },
    );

    for await (const event of iterable) {
      events.push(event);
    }

    expect(events.map((e) => e.type)).toEqual(['run.started', 'text.delta', 'run.completed']);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('maintains multi-turn conversation history in InMemoryHarnessSession', async () => {
    const mockHarness: Harness = {
      capabilities: { id: 'mock', name: 'Mock', version: '0.1.0', supported: ['sessions'] },
      async run(req) {
        const priorCount = req.history?.length ?? 0;
        const text = `reply:${req.input}:prior=${priorCount}`;
        return {
          runId: 'r1',
          sessionId: req.sessionId,
          text,
          stopReason: 'completed',
          messages: [
            { role: 'user', content: req.input },
            { role: 'assistant', content: text },
          ],
          usage: { turns: 1 },
        };
      },
      stream(req, opts) {
        return streamFromRun(req, opts, (r) => this.run(r, opts));
      },
    };

    const session = new InMemoryHarnessSession(mockHarness, { sessionId: 'sess_1' });
    const first = await session.send('one');
    const second = await session.send('two');

    expect(first.text).toBe('reply:one:prior=0');
    expect(second.text).toBe('reply:two:prior=2');
    expect(session.history()).toHaveLength(4);
    await session.close();
    await expect(session.send('three')).rejects.toThrowError(HarnixError);
  });

  it('normalizes unknown errors and handles AsyncEventQueue failure', async () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(toHarnixError(aborted).code).toBe('CANCELLED');

    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    queue.fail(new Error('boom'));
    const iter = queue[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ value: 1, done: false });
    await expect(iter.next()).rejects.toThrow('boom');
  });
});
