export type CliHarnessKind = 'native' | 'pi' | 'acp';
export type CliProviderKind = 'openai-compatible' | 'anthropic';

export interface CliOptions {
  readonly harness: CliHarnessKind;
  readonly provider: CliProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly prompt?: string;
  readonly acpCommand?: string;
  readonly acpArgs: readonly string[];
  readonly acpCwd?: string;
  readonly autoApprove: boolean;
  readonly withDemoTools: boolean;
  readonly help: boolean;
}

export const CLI_HELP_TEXT = `harnix — Unified Agent Harness CLI

Usage:
  harnix [options]

Options:
  --harness <kind>       Harness backend: native | pi | acp (default: native)
  --provider <kind>      Model provider: openai-compatible | anthropic (default: openai-compatible)
  --base-url <url>       Model API base URL (env: HARNIX_BASE_URL / OPENAI_BASE_URL)
  --api-key <key>        Model API key (env: HARNIX_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)
  --model <id>           Model ID (env: HARNIX_MODEL, default: gpt-4o-mini)
  --system <text>        Optional system prompt
  -p, --prompt <text>    Run a single prompt and exit (omit for interactive REPL)
  --acp-command <cmd>    ACP agent executable command (required when --harness acp)
  --acp-arg <arg>        Argument passed to ACP agent (repeatable)
  --acp-cwd <dir>        Working directory for ACP agent
  --auto-approve         Automatically allow tool/permission requests
  --no-demo-tools        Disable built-in demo tools (get_current_time, echo)
  -h, --help             Show this help message
`;

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  let harness: CliHarnessKind = 'native';
  let provider: CliProviderKind = 'openai-compatible';
  let baseUrl = env['HARNIX_BASE_URL'] ?? env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1';
  let apiKey =
    env['HARNIX_API_KEY'] ?? env['OPENAI_API_KEY'] ?? env['ANTHROPIC_API_KEY'] ?? '';
  let model = env['HARNIX_MODEL'] ?? 'gpt-4o-mini';
  let systemPrompt: string | undefined;
  let prompt: string | undefined;
  let acpCommand = env['HARNIX_ACP_COMMAND'];
  const acpArgs: string[] = [];
  let acpCwd: string | undefined;
  let autoApprove = false;
  let withDemoTools = true;
  let help = false;

  const takeValue = (index: number, flag: string): string => {
    const val = argv[index + 1];
    if (val === undefined) throw new Error(`Missing value for ${flag}`);
    return val;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--harness') {
      const val = takeValue(i, arg);
      if (val !== 'native' && val !== 'pi' && val !== 'acp') {
        throw new Error(`Invalid --harness '${val}', expected native | pi | acp`);
      }
      harness = val;
      i += 1;
    } else if (arg === '--provider') {
      const val = takeValue(i, arg);
      if (val !== 'openai-compatible' && val !== 'anthropic') {
        throw new Error(`Invalid --provider '${val}', expected openai-compatible | anthropic`);
      }
      provider = val;
      i += 1;
    } else if (arg === '--base-url') {
      baseUrl = takeValue(i, arg);
      i += 1;
    } else if (arg === '--api-key') {
      apiKey = takeValue(i, arg);
      i += 1;
    } else if (arg === '--model') {
      model = takeValue(i, arg);
      i += 1;
    } else if (arg === '--system') {
      systemPrompt = takeValue(i, arg);
      i += 1;
    } else if (arg === '-p' || arg === '--prompt') {
      prompt = takeValue(i, arg);
      i += 1;
    } else if (arg === '--acp-command') {
      acpCommand = takeValue(i, arg);
      i += 1;
    } else if (arg === '--acp-arg') {
      acpArgs.push(takeValue(i, arg));
      i += 1;
    } else if (arg === '--acp-cwd') {
      acpCwd = takeValue(i, arg);
      i += 1;
    } else if (arg === '--auto-approve') {
      autoApprove = true;
    } else if (arg === '--no-demo-tools') {
      withDemoTools = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    harness,
    provider,
    baseUrl,
    apiKey,
    model,
    systemPrompt,
    prompt,
    acpCommand,
    acpArgs,
    acpCwd,
    autoApprove,
    withDemoTools,
    help,
  };
}
