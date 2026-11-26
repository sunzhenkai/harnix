import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';
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

/**
 * Stateful stream renderer that groups contiguous thought chunks into a single `[thought]` block.
 */
export class StreamEventRenderer {
  private inThought = false;
  private hasText = false;

  constructor(
    private readonly stdout: NodeJS.WritableStream,
    private readonly stderr: NodeJS.WritableStream,
  ) {}

  render(event: HarnessEvent): void {
    if (event.type === 'thought.delta') {
      if (!this.inThought) {
        this.stderr.write('[thought] ');
        this.inThought = true;
      }
      this.stderr.write(event.text);
      return;
    }

    this.flushThought();

    if (event.type === 'text.delta') {
      this.hasText = true;
      this.stdout.write(event.text);
    } else if (event.type === 'tool.started') {
      this.stderr.write(`${this.hasText ? '\n' : ''}[tool:start] ${event.toolName}\n`);
    } else if (event.type === 'tool.completed') {
      this.stderr.write(
        `[tool:done] ${event.toolName} (${event.isError ? 'error' : 'ok'}): ${event.content}\n`,
      );
    } else if (event.type === 'plan.updated') {
      const summary = event.entries.map((e) => `${e.status}: ${e.content}`).join(' | ');
      this.stderr.write(`[plan] ${summary}\n`);
    } else if (event.type === 'run.completed') {
      this.stdout.write('\n');
      this.hasText = false;
    }
  }

  private flushThought(): void {
    if (!this.inThought) return;
    this.stderr.write('\n');
    this.inThought = false;
  }
}

export function renderEventToStreams(
  event: HarnessEvent,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): void {
  const renderer = new StreamEventRenderer(stdout, stderr);
  renderer.render(event);
}

export function createCliPermissionHandler(params: {
  readonly autoApprove: boolean;
  readonly interactive: boolean;
  readonly stdin: NodeJS.ReadableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly getReadline?: () => ReadlineInterface | undefined;
}): PermissionHandler {
  if (params.autoApprove) {
    return allowAllPermissions;
  }

  return async (req) => {
    const rejectOption = req.options?.find((o) => o.kind === 'reject_once')?.optionId;
    if (!params.interactive) {
      params.stderr.write(
        `[permission:denied] Tool '${req.toolName}' denied in non-interactive mode (pass --auto-approve to allow)\n`,
      );
      return {
        outcome: 'deny',
        optionId: rejectOption,
        reason: 'Denied in non-interactive mode (pass --auto-approve to allow)',
      };
    }

    const existingRl = params.getReadline?.();
    const rl = existingRl ?? createInterface({ input: params.stdin, output: params.stderr });
    try {
      const label = req.title || req.toolName;
      const answer = await rl.question(`\n[permission] Allow "${label}"? [y/N] `);
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        return {
          outcome: 'allow',
          optionId: req.options?.find((o) => o.kind === 'allow_once')?.optionId,
        };
      }
      return {
        outcome: 'deny',
        optionId: rejectOption,
        reason: 'Denied by user',
      };
    } finally {
      if (!existingRl) rl.close();
    }
  };
}

export async function runCli(
  argv: readonly string[],
  io: {
    readonly stdin?: NodeJS.ReadableStream;
    readonly stdout?: NodeJS.WritableStream;
    readonly stderr?: NodeJS.WritableStream;
    readonly env?: NodeJS.ProcessEnv;
    readonly interactive?: boolean;
  } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const interactive =
    io.interactive ?? Boolean((stdin as NodeJS.ReadStream).isTTY && (stdout as NodeJS.WriteStream).isTTY);

  const options = parseCliArgs(argv, io.env ?? process.env);
  if (options.help) {
    stdout.write(CLI_HELP_TEXT);
    return 0;
  }

  const harness = createHarnessFromOptions(options);
  const renderer = new StreamEventRenderer(stdout, stderr);
  let activeRl: ReadlineInterface | undefined;
  const onPermission = createCliPermissionHandler({
    autoApprove: options.autoApprove,
    interactive,
    stdin,
    stderr,
    getReadline: () => activeRl,
  });

  try {
    if (options.prompt !== undefined) {
      for await (const event of harness.stream(
        { input: options.prompt, systemPrompt: options.systemPrompt },
        { onPermission },
      )) {
        renderer.render(event);
      }
      return 0;
    }

    const session = harness.createSession
      ? await harness.createSession({ systemPrompt: options.systemPrompt })
      : undefined;

    activeRl = createInterface({ input: stdin, output: stdout });
    stdout.write(`harnix (${harness.capabilities.name}) — type /exit to quit, /history to inspect\n`);

    try {
      while (true) {
        const line = await activeRl.question('> ');
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
          renderer.render(event);
        }
      }
    } finally {
      activeRl.close();
      activeRl = undefined;
      await session?.close();
    }
    return 0;
  } finally {
    await harness.close?.();
  }
}
