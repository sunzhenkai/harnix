import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliPermissionHandler, parseCliArgs, runCli, StreamEventRenderer } from './index.js';

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

  it('groups contiguous thought deltas into a single [thought] block', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });

    const renderer = new StreamEventRenderer(stdout, stderr);
    const base = { runId: 'r1', timestamp: '2026-01-01T00:00:00Z' };
    renderer.render({ ...base, sequence: 1, type: 'thought.delta', text: 'step 1 ' });
    renderer.render({ ...base, sequence: 2, type: 'thought.delta', text: 'step 2' });
    renderer.render({ ...base, sequence: 3, type: 'text.delta', text: 'Hello' });

    expect(err).toBe('[thought] step 1 step 2\n');
    expect(out).toBe('Hello');
  });

  it('denies permissions by default in non-interactive mode and prompts when interactive', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();

    const nonInteractive = createCliPermissionHandler({
      autoApprove: false,
      interactive: false,
      stdin,
      stderr,
    });
    const denied = await nonInteractive(
      { requestId: 'p1', toolName: 'shell' },
      new AbortController().signal,
    );
    expect(denied.outcome).toBe('deny');

    const interactiveHandler = createCliPermissionHandler({
      autoApprove: false,
      interactive: true,
      stdin,
      stderr,
    });
    const decisionPromise = interactiveHandler(
      { requestId: 'p2', toolName: 'shell' },
      new AbortController().signal,
    );
    stdin.write('y\n');
    const allowed = await decisionPromise;
    expect(allowed.outcome).toBe('allow');
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
      { stdout, stderr, interactive: false },
    );

    expect(code).toBe(0);
    expect(outText.trim()).toBe('CLI_OK');
  });
});
