import {
  BUILT_IN_HARNESS_DESCRIPTORS,
  HarnixError,
  validateHarnixSettings,
  type AcpAgentEntry,
  type HarnixSettings,
  type Harness,
  type HarnessDescriptor,
  type HarnessHealthCheckDetail,
  type HarnessHealthCheckResult,
  type HarnessKind,
  type HarnessTool,
} from '@harnix/core';
import { NativeHarness, type NativeProviderKind } from '@harnix/native';
import { PiHarness } from '@harnix/pi';
import { AcpHarness, probeAcpAgent, type AcpAgentSpawnConfig } from '@harnix/acp';

export * from '@harnix/core';
export * from '@harnix/native';
export * from '@harnix/pi';
export * from '@harnix/acp';

export interface HarnessProviderCredentials {
  readonly kind: NativeProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly headers?: Record<string, string>;
}

export interface CreateHarnessOptions {
  readonly kind?: HarnessKind;
  readonly settings: HarnixSettings;
  readonly provider?: HarnessProviderCredentials;
  readonly acpAgentId?: string;
  readonly cwd?: string;
  readonly defaultTools?: readonly HarnessTool[];
  readonly mcpServers?: readonly unknown[];
  readonly clientInfo?: AcpAgentSpawnConfig['clientInfo'];
}

export interface ProbeHarnessOptions {
  readonly kind: HarnessKind;
  readonly settings: HarnixSettings;
  readonly provider?: HarnessProviderCredentials;
  readonly acpAgentId?: string;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly checkProvider?: (provider: HarnessProviderCredentials, signal?: AbortSignal) => Promise<void>;
}

/**
 * Returns metadata descriptors for all built-in Harness implementations.
 */
export function listHarnessDescriptors(): readonly HarnessDescriptor[] {
  return BUILT_IN_HARNESS_DESCRIPTORS;
}

function resolveAcpEntry(settings: HarnixSettings, acpAgentId?: string): AcpAgentEntry {
  const id = (acpAgentId ?? settings.acp.defaultAgentId).trim();
  if (!id) {
    throw new HarnixError('INVALID_REQUEST', 'ACP agent id is required');
  }
  const entry = settings.acp.agents[id];
  if (!entry) {
    throw new HarnixError('INVALID_REQUEST', `Unknown ACP agent '${id}'`, { details: { acpAgentId: id } });
  }
  if (!entry.enabled) {
    throw new HarnixError('INVALID_REQUEST', `ACP agent '${id}' is disabled`, { details: { acpAgentId: id } });
  }
  return entry;
}

/**
 * Creates a configured Harness instance from normalized HarnixSettings and host credentials.
 */
export function createHarness(options: CreateHarnessOptions): Harness {
  validateHarnixSettings(options.settings);
  const kind = options.kind ?? options.settings.defaultKind;

  if (kind === 'native') {
    if (!options.provider) {
      throw new HarnixError('INVALID_REQUEST', 'Provider credentials are required for native harness');
    }
    const cfg = options.settings.native;
    return new NativeHarness({
      provider: {
        kind: options.provider.kind,
        baseUrl: options.provider.baseUrl,
        apiKey: options.provider.apiKey,
        model: options.provider.model,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        includeUsage: cfg.includeUsage,
        headers: options.provider.headers,
      },
      defaultTools: options.defaultTools,
      maxTurns: cfg.maxTurns,
      maxToolCalls: cfg.maxToolCalls,
      maxToolCallsPerTurn: cfg.maxToolCallsPerTurn,
    });
  }

  if (kind === 'pi') {
    if (!options.provider) {
      throw new HarnixError('INVALID_REQUEST', 'Provider credentials are required for pi harness');
    }
    const cfg = options.settings.pi;
    return new PiHarness({
      route: {
        adapterKind: options.provider.kind,
        baseUrl: options.provider.baseUrl,
        apiKey: options.provider.apiKey,
        modelId: options.provider.model,
        reasoning: cfg.reasoning,
        contextWindow: cfg.contextWindow,
        maxTokens: cfg.maxTokens,
      },
      defaultTools: options.defaultTools,
      maxTurns: cfg.maxTurns,
      maxToolCalls: cfg.maxToolCalls,
      maxToolCallsPerTurn: cfg.maxToolCallsPerTurn,
    });
  }

  const entry = resolveAcpEntry(options.settings, options.acpAgentId);
  return new AcpHarness({
    maxConcurrentSessions: options.settings.acp.maxConcurrentSessions,
    agent: {
      command: entry.command,
      args: entry.args,
      envPassthrough: entry.envPassthrough,
      cwd: options.cwd,
      mcpServers: options.mcpServers,
      initTimeoutMs: entry.initTimeoutMs,
      promptTimeoutMs: entry.promptTimeoutMs,
      idleTimeoutMs: entry.idleTimeoutMs,
      clientInfo: options.clientInfo,
    },
  });
}

/**
 * Probes a Harness implementation and returns structured connectivity/configuration status.
 */
export async function probeHarness(options: ProbeHarnessOptions): Promise<HarnessHealthCheckResult> {
  try {
    validateHarnixSettings(options.settings);
  } catch (error) {
    return {
      kind: options.kind,
      ok: false,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (options.kind === 'native' || options.kind === 'pi') {
    if (!options.provider || !options.provider.baseUrl.trim() || !options.provider.model.trim()) {
      return {
        kind: options.kind,
        ok: false,
        status: 'error',
        message: 'Provider baseUrl and model are required',
      };
    }
    if (options.checkProvider) {
      try {
        await options.checkProvider(options.provider, options.signal);
      } catch (error) {
        return {
          kind: options.kind,
          ok: false,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      kind: options.kind,
      ok: true,
      status: 'ok',
      message: `${options.kind} harness configuration is valid (${options.provider.model})`,
    };
  }

  const targetIds = options.acpAgentId?.trim()
    ? [options.acpAgentId.trim()]
    : Object.keys(options.settings.acp.agents).sort();

  if (targetIds.length === 0) {
    return {
      kind: 'acp',
      ok: false,
      status: 'disabled',
      message: 'No ACP agents configured',
      details: [],
    };
  }

  const details: HarnessHealthCheckDetail[] = [];
  for (const id of targetIds) {
    const entry = options.settings.acp.agents[id];
    if (!entry) {
      details.push({
        id,
        name: id,
        status: 'error',
        code: 'unknown_agent',
        message: `Unknown ACP agent '${id}'`,
      });
      continue;
    }
    if (!entry.enabled) {
      details.push({
        id: entry.id,
        name: entry.name,
        status: 'disabled',
        code: 'disabled',
        message: 'Agent is disabled',
      });
      continue;
    }
    const probe = await probeAcpAgent(
      {
        command: entry.command,
        args: entry.args,
        envPassthrough: entry.envPassthrough,
        cwd: options.cwd,
        initTimeoutMs: entry.initTimeoutMs,
        idleTimeoutMs: entry.idleTimeoutMs,
      },
      options.signal,
    );
    details.push({
      id: entry.id,
      name: entry.name,
      status: probe.ok ? 'ok' : 'error',
      code: probe.code,
      message: probe.message,
      agentName: probe.agentName,
      agentVersion: probe.agentVersion,
      protocolVersion: probe.protocolVersion,
    });
  }

  const hasOk = details.some((d) => d.status === 'ok');
  const hasError = details.some((d) => d.status === 'error');
  const status = hasError ? 'error' : hasOk ? 'ok' : 'disabled';
  return {
    kind: 'acp',
    ok: !hasError && hasOk,
    status,
    message:
      status === 'ok'
        ? `ACP agents ready (${details.filter((d) => d.status === 'ok').length}/${details.length})`
        : details.find((d) => d.status === 'error')?.message ?? 'No enabled ACP agents',
    details,
  };
}
