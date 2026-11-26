import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs, runCli } from './index.js';

describe('@harnix/cli', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('parses CLI flags and environment defaults', () => {
    const parsed = parseCliArgs(
      ['--harness', 'pi', '--provider', 'anthropic', '--model', 'claude-3-7-sonnet', '-p', 'hi'],
      { HARNIX_API_KEY: 'env-key' },
    );
    expect(parsed.harness).toBe('pi');
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.apiKey).toBe('env-key');
    expect(parsed.prompt).toBe('hi');
  });

  it('runs single-prompt mode against an ACP agent process', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnix-cli-test-'));
    tempDirs.push(dir);
    const mockAgent = path.join(dir, 'agent.mjs');
    await fs.writeFile(
      mockAgent,
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
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'CLI_OK' } } }
          });
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
      `,
      'utf8',
    );

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let outText = '';
    stdout.on('data', (chunk: Buffer) => {
      outText += chunk.toString('utf8');
    });

    const code = await runCli(
      ['--harness', 'acp', '--acp-command', process.execPath, '--acp-arg', mockAgent, '-p', 'ping'],
      { stdout, stderr },
    );

    expect(code).toBe(0);
    expect(outText.trim()).toBe('CLI_OK');
  });
});
