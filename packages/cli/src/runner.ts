import { createInterface } from 'node:readline/promises';
import { AcpHarness } from '@harnix/acp';
import {
  allowAllPermissions,
  type Harness,
  type HarnessEvent,
  type HarnessTool,
  type PermissionHandler,
} from '@harnix/core';
import { NativeHarness } from '@harnix/native';
import { PiHarness } from '@harnix/pi';
import { CLI_HELP_TEXT, parseCliArgs, type CliOptions } from './args.js';

export function createDemoTools(): readonly HarnessTool[] {
  return [
    {
      name: 'get_current_time',
      description: 'Return the current ISO-8601 UTC timestamp.',
      parameters: { type: 'object', properties: {} },
      execute: () => ({ content: new Date().toISOString() }),
    },
    {
      name: 'echo',
      description: 'Echo back a message.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo back' } },
        required: ['text'],
      },
      execute: (args) => ({ content: String(args['text'] ?? '') }),
    },
  ];
}

export function createHarnessFromOptions(options: CliOptions): Harness {
  const defaultTools = options.withDemoTools ? createDemoTools() : [];
  if (options.harness === 'native') {
    if (!options.apiKey) {
      throw new Error('Missing API key for native harness (pass --api-key or set HARNIX_API_KEY)');
    }
    return new NativeHarness({
      provider: {
        kind: options.provider,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
      },
      defaultTools,
    });
  }

  if (options.harness === 'pi') {
    if (!options.apiKey) {
      throw new Error('Missing API key for pi harness (pass --api-key or set HARNIX_API_KEY)');
    }
    return new PiHarness({
      route: {
        adapterKind: options.provider,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        modelId: options.model,
      },
      defaultTools,
    });
  }

  if (!options.acpCommand) {
    throw new Error('Missing --acp-command for acp harness');
  }
  return new AcpHarness({
    agent: {
      command: options.acpCommand,
      args: options.acpArgs,
      cwd: options.acpCwd,
    },
  });
}

export function renderEventToStreams(
  event: HarnessEvent,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  if (event.type === 'text.delta') {
    stdout.write(event.text);
  } else if (event.type === 'thought.delta') {
    stderr.write(`[thought] ${event.text}`);
  } else if (event.type === 'tool.started') {
    stderr.write(`\n[tool:start] ${event.toolName}\n`);
  } else if (event.type === 'tool.completed') {
    stderr.write(`[tool:done] ${event.toolName} (${event.isError ? 'error' : 'ok'}): ${event.content}\n`);
  } else if (event.type === 'plan.updated') {
    const summary = event.entries.map((e) => `${e.status}: ${e.content}`).join(' | ');
    stderr.write(`[plan] ${summary}\n`);
  } else if (event.type === 'run.completed') {
    stdout.write('\n');
  }
}

export async function runCli(
  argv: readonly string[],
  io: {
    readonly stdin?: NodeJS.ReadableStream;
    readonly stdout?: NodeJS.WritableStream;
    readonly stderr?: NodeJS.WritableStream;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;

  const options = parseCliArgs(argv, io.env ?? process.env);
  if (options.help) {
    stdout.write(CLI_HELP_TEXT);
    return 0;
  }

  const harness = createHarnessFromOptions(options);
  const onPermission: PermissionHandler = options.autoApprove
    ? allowAllPermissions
    : async (req) => ({
        outcome: 'allow',
        optionId: req.options?.find((o) => o.kind === 'allow_once')?.optionId,
      });

  try {
    if (options.prompt !== undefined) {
      for await (const event of harness.stream(
        { input: options.prompt, systemPrompt: options.systemPrompt },
        { onPermission },
      )) {
        renderEventToStreams(event, stdout, stderr);
      }
      return 0;
    }

    const session = harness.createSession
      ? await harness.createSession({ systemPrompt: options.systemPrompt })
      : undefined;

    const rl = createInterface({ input: stdin, output: stdout });
    stdout.write(`harnix (${harness.capabilities.name}) — type /exit to quit, /history to inspect\n`);

    try {
      while (true) {
        const line = await rl.question('> ');
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === '/exit' || trimmed === '/quit') break;
        if (trimmed === '/history') {
          const hist = session?.history() ?? [];
          stdout.write(`${JSON.stringify(hist, null, 2)}\n`);
          continue;
        }

        const stream = session
          ? session.stream(trimmed, { onPermission })
          : harness.stream({ input: trimmed, systemPrompt: options.systemPrompt }, { onPermission });

        for await (const event of stream) {
          renderEventToStreams(event, stdout, stderr);
        }
      }
    } finally {
      rl.close();
      await session?.close();
    }
    return 0;
  } finally {
    await harness.close?.();
  }
}
