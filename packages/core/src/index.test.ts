import { describe, expect, it } from 'vitest';
import {
  assertCapabilities,
  AsyncEventQueue,
  createPermissionHandlerForMode,
  createPolicyPermissionHandler,
  defaultHarnixSettings,
  HarnixError,
  InMemoryHarnessSession,
  isHarnixError,
  normalizeHarnixSettings,
  redactAcpAgents,
  runToolLoop,
  streamFromRun,
  toHarnixError,
  type Harness,
  type HarnessCapabilities,
  type HarnessDebugEvent,
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

  it('normalizes and validates HarnixSettings with ACP security invariants', () => {
    const defaults = defaultHarnixSettings();
    expect(defaults.defaultKind).toBe('native');
    expect(normalizeHarnixSettings()).toEqual(defaults);

    expect(() =>
      normalizeHarnixSettings({
        acp: {
          agents: {
            bad: { id: 'bad', name: 'Bad', command: 'claude', env: { SECRET: '1' } },
          },
        },
      }),
    ).toThrowError(HarnixError);

    expect(() =>
      normalizeHarnixSettings({
        acp: {
          agents: {
            bad: { id: 'bad', name: 'Bad', command: 'claude', args: ['--api-key', 'sk-123'] },
          },
        },
      }),
    ).toThrowError(HarnixError);

    expect(() =>
      normalizeHarnixSettings({
        acp: {
          defaults: { readonlyOnly: true },
          agents: {
            bad: { id: 'bad', name: 'Bad', command: 'claude', permission: { allowWrite: true } },
          },
        },
      }),
    ).toThrowError(HarnixError);

    const valid = normalizeHarnixSettings({
      defaultKind: 'pi',
      pi: { reasoning: true, contextWindow: 65536 },
      acp: {
        defaultAgentId: 'claude',
        agents: {
          claude: {
            id: 'claude',
            name: 'Claude Code',
            enabled: true,
            command: 'claude',
            envPassthrough: ['PATH', 'CUSTOM_VAR_1'],
          },
        },
      },
    });
    expect(valid.pi.reasoning).toBe(true);
    const redacted = redactAcpAgents(valid.acp, { PATH: '/usr/bin' });
    expect(redacted[0]?.envPassthrough).toEqual([
      { name: 'PATH', present: true },
      { name: 'CUSTOM_VAR_1', present: false },
    ]);
  });

  it('enforces policy permissions and runToolLoop per-turn limits & onDebug', async () => {
    const readonlyHandler = createPermissionHandlerForMode('readonly');
    const signal = new AbortController().signal;
    expect((await readonlyHandler({ requestId: '1', toolName: 'search_docs' }, signal)).outcome).toBe('allow');
    expect((await readonlyHandler({ requestId: '2', toolName: 'write_file' }, signal)).outcome).toBe('deny');

    const customHandler = createPolicyPermissionHandler({
      allowRead: true,
      allowSearch: false,
      allowFetch: false,
      allowWrite: true,
      allowExecute: false,
      readonlyOnly: false,
    });
    expect((await customHandler({ requestId: '3', toolName: 'edit_page' }, signal)).outcome).toBe('allow');

    const debugEvents: HarnessDebugEvent[] = [];
    const executed: string[] = [];
    let turn = 0;
    const result = await runToolLoop({
      harnessId: 'test',
      defaultMaxToolCallsPerTurn: 1,
      request: {
        input: 'run tools',
        temperature: 0.2,
        maxTokens: 512,
        toolChoice: 'required',
        tools: [
          { name: 't1', description: 't1', parameters: {}, execute: () => (executed.push('t1'), { content: 'r1' }) },
          { name: 't2', description: 't2', parameters: {}, execute: () => (executed.push('t2'), { content: 'r2' }) },
        ],
      },
      options: {
        onDebug: (ev) => debugEvents.push(ev),
      },
      invokeTurn: async (ctx) => {
        turn += 1;
        expect(ctx.temperature).toBe(0.2);
        expect(ctx.maxTokens).toBe(512);
        expect(ctx.toolChoice).toBe('required');
        if (turn === 1) {
          return {
            text: '',
            thinking: '',
            toolCalls: [
              { id: 'c1', name: 't1', arguments: {} },
              { id: 'c2', name: 't2', arguments: {} },
            ],
            usage: {},
            truncated: false,
          };
        }
        return { text: 'done', thinking: '', toolCalls: [], usage: {}, truncated: false };
      },
    });

    expect(result.text).toBe('done');
    expect(executed).toEqual(['t1']);
    expect(debugEvents.some((e) => e.phase === 'tool_calls_truncated')).toBe(true);
    expect(debugEvents.some((e) => e.phase === 'tool_result')).toBe(true);
  });
});
