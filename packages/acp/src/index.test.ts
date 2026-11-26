import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@harnix/core';
import { AcpHarness } from './index.js';

const MOCK_ACP_SCRIPT = `
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let turnCount = 0;

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
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'remote_sess_1' } });
  } else if (msg.method === 'session/prompt') {
    turnCount += 1;
    const sessionId = msg.params.sessionId;
    const text = msg.params.prompt?.[0]?.text ?? '';

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
              content: { type: 'text', text: 'ACP turn ' + turnCount + ' (' + (allowed ? 'allowed' : 'denied') + '): ' + text }
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

  it('connects to an ACP agent over stdio, maps updates, handles permissions, and keeps sessions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnix-acp-test-'));
    tempDirs.push(dir);
    const agentFile = path.join(dir, 'mock-agent.mjs');
    await fs.writeFile(agentFile, MOCK_ACP_SCRIPT, 'utf8');

    const harness = new AcpHarness({
      agent: {
        command: process.execPath,
        args: [agentFile],
      },
    });

    const session = await harness.createSession();
    const events: HarnessEvent[] = [];

    const first = await session.send('hello', {
      onEvent: (e) => void events.push(e),
      onPermission: () => ({ outcome: 'allow', optionId: 'allow_once' }),
    });

    expect(first.text).toBe('ACP turn 1 (allowed): hello');
    expect(first.thinking).toBe('analyzing...');
    expect(events.some((e) => e.type === 'plan.updated')).toBe(true);
    expect(events.some((e) => e.type === 'tool.completed' && e.content === 'ok')).toBe(true);

    const second = await session.send('again', {
      onPermission: () => ({ outcome: 'deny', optionId: 'reject_once' }),
    });
    expect(second.text).toBe('ACP turn 2 (denied): again');
    expect(session.history()).toHaveLength(4);

    await session.close();
    await harness.close();
  });
});
