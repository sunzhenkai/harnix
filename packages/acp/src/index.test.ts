import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isHarnixError, type HarnessEvent } from '@harnix/core';
import { AcpHarness } from './index.js';

const MOCK_ACP_SCRIPT = `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let turnCount = 0;
let lastSessionParams = null;
let cancelReceived = false;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'mock-acp-agent', version: '0.1.0' }
      }
    });
  } else if (msg.method === 'session/new') {
    lastSessionParams = msg.params;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'remote_sess_1' } });
  } else if (msg.method === 'session/cancel') {
    cancelReceived = true;
  } else if (msg.method === 'session/prompt') {
    turnCount += 1;
    const sessionId = msg.params.sessionId;
    const text = msg.params.prompt?.[0]?.text ?? '';

    if (text === '__HANG__') {
      return;
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'analyzing...' } }
      }
    });

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Check workspace', priority: 'high', status: 'in_progress' }]
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 900 + turnCount,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'tc_perm_1', title: 'Read file', kind: 'read' },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
        ]
      }
    });

    const onPermReply = (replyLine) => {
      const reply = JSON.parse(replyLine);
      if (reply.id === 900 + turnCount) {
        rl.off('line', onPermReply);
        const allowed = reply.result?.outcome?.outcome === 'selected' && reply.result?.outcome?.optionId === 'allow_once';
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc_1',
              title: 'Read file',
              name: 'read_file',
              kind: 'read',
              status: 'running'
            }
          }
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc_1',
              name: 'read_file',
              status: 'completed',
              rawOutput: allowed ? 'ok' : 'denied'
            }
          }
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'ACP turn ' + turnCount + ' (' + (allowed ? 'allowed' : 'denied') + ') cwd=' + (lastSessionParams?.cwd ?? '') + ' mcp=' + (lastSessionParams?.mcpServers?.length ?? 0) + ': ' + text
              }
            }
          }
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      }
    };
    rl.on('line', onPermReply);
  }
});
`;

describe('@harnix/acp', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  async function writeMockAgent(): Promise<{ dir: string; agentFile: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnix-acp-test-'));
    tempDirs.push(dir);
    const agentFile = path.join(dir, 'mock-agent.mjs');
    await fs.writeFile(agentFile, MOCK_ACP_SCRIPT, 'utf8');
    return { dir, agentFile };
  }

  it('connects to an ACP agent, forwards session cwd and mcpServers, maps updates, and handles permissions', async () => {
    const { dir, agentFile } = await writeMockAgent();
    const sessionCwd = path.join(dir, 'workspace');
    await fs.mkdir(sessionCwd, { recursive: true });

    const harness = new AcpHarness({
      agent: {
        command: process.execPath,
        args: [agentFile],
        mcpServers: [{ name: 'wiki', url: 'http://localhost:9000/mcp' }],
      },
    });

    const session = await harness.createSession({ cwd: sessionCwd });
    const events: HarnessEvent[] = [];

    const first = await session.send('hello', {
      onEvent: (e) => void events.push(e),
      onPermission: () => ({ outcome: 'allow', optionId: 'allow_once' }),
    });

    expect(first.text).toBe(`ACP turn 1 (allowed) cwd=${sessionCwd} mcp=1: hello`);
    expect(first.thinking).toBe('analyzing...');
    expect(events.some((e) => e.type === 'plan.updated')).toBe(true);
    expect(events.some((e) => e.type === 'tool.completed' && e.content === 'ok')).toBe(true);

    const second = await session.send('again', {
      onPermission: () => ({ outcome: 'deny', optionId: 'reject_once' }),
    });
    expect(second.text).toBe(`ACP turn 2 (denied) cwd=${sessionCwd} mcp=1: again`);
    expect(session.history()).toHaveLength(4);

    await session.close();
    await harness.close();
  });

  it('cancels an in-flight ACP prompt when AbortSignal fires', async () => {
    const { agentFile } = await writeMockAgent();
    const harness = new AcpHarness({
      agent: { command: process.execPath, args: [agentFile] },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    try {
      await harness.run({ input: '__HANG__' }, { signal: controller.signal });
      expect.unreachable('should have thrown CANCELLED');
    } catch (error) {
      expect(isHarnixError(error, 'CANCELLED')).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('times out an idle ACP prompt cleanly', async () => {
    const { agentFile } = await writeMockAgent();
    const harness = new AcpHarness({
      agent: { command: process.execPath, args: [agentFile], idleTimeoutMs: 80 },
    });

    try {
      await harness.run({ input: '__HANG__' });
      expect.unreachable('should have thrown TIMEOUT');
    } catch (error) {
      expect(isHarnixError(error, 'TIMEOUT')).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
