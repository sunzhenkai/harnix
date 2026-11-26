import path from 'node:path';
import { HarnixError } from './errors.js';
import type { HarnessPermissionMode } from './permissions.js';
import type { HarnessCapability } from './types.js';

export const HARNESS_KINDS = ['native', 'pi', 'acp'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

export interface HarnessConfigFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface HarnessConfigFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly type: 'boolean' | 'number' | 'string' | 'select' | 'acp_agents';
  readonly defaultValue?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly HarnessConfigFieldOption[];
}

export interface HarnessDescriptor {
  readonly id: HarnessKind;
  readonly name: string;
  readonly summary: string;
  readonly requiresProvider: boolean;
  readonly capabilities: readonly HarnessCapability[];
  readonly fields: readonly HarnessConfigFieldSpec[];
}

export interface NativeHarnessSettings {
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxToolCallsPerTurn: number;
  readonly timeoutMs: number;
  readonly includeUsage: boolean;
  readonly permissionMode: HarnessPermissionMode;
}

export interface PiHarnessSettings {
  readonly providerInstanceId?: string;
  readonly model?: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxToolCallsPerTurn: number;
  readonly timeoutMs: number;
  readonly permissionMode: HarnessPermissionMode;
}

export interface AcpAgentPermissionSettings {
  readonly mode: 'auto';
  readonly allowRead: boolean;
  readonly allowSearch: boolean;
  readonly allowFetch: boolean;
  readonly allowWrite: boolean;
  readonly allowExecute: boolean;
}

export interface AcpAgentEntry {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly envPassthrough: readonly string[];
  readonly cwdPolicy: 'workspace' | 'session';
  readonly initTimeoutMs: number;
  readonly promptTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly permission: AcpAgentPermissionSettings;
}

export interface AcpHarnessSettings {
  readonly defaultAgentId: string;
  readonly maxConcurrentSessions: number;
  readonly defaults: {
    readonly readonlyOnly: boolean;
    readonly onUnavailable: 'error';
  };
  readonly agents: Readonly<Record<string, AcpAgentEntry>>;
}

export interface HarnixSettings {
  readonly version: 1;
  readonly defaultKind: HarnessKind;
  readonly native: NativeHarnessSettings;
  readonly pi: PiHarnessSettings;
  readonly acp: AcpHarnessSettings;
}

export interface RedactedEnvVar {
  readonly name: string;
  readonly present: boolean;
}

export interface RedactedAcpAgentEntry extends Omit<AcpAgentEntry, 'envPassthrough'> {
  readonly envPassthrough: readonly RedactedEnvVar[];
}

export interface HarnessHealthCheckDetail {
  readonly id: string;
  readonly name: string;
  readonly status: 'ok' | 'error' | 'disabled';
  readonly code?: string;
  readonly message: string;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly protocolVersion?: number;
}

export interface HarnessHealthCheckResult {
  readonly kind: HarnessKind;
  readonly ok: boolean;
  readonly status: 'ok' | 'error' | 'disabled';
  readonly message: string;
  readonly details?: readonly HarnessHealthCheckDetail[];
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_FLAGS = new Set([
  '--token',
  '--api-key',
  '--api_key',
  '--password',
  '--secret',
  '--authorization',
  '--header',
]);
const CREDENTIAL_PREFIXES = ['sk-', 'ghp_', 'github_pat_', 'xoxb-', 'xoxp-', 'AKIA'];

export function defaultHarnixSettings(): HarnixSettings {
  return {
    version: 1,
    defaultKind: 'native',
    native: {
      maxTurns: 8,
      maxToolCalls: 32,
      maxToolCallsPerTurn: 4,
      timeoutMs: 180_000,
      includeUsage: true,
      permissionMode: 'readonly',
    },
    pi: {
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4_096,
      maxTurns: 8,
      maxToolCalls: 32,
      maxToolCallsPerTurn: 4,
      timeoutMs: 180_000,
      permissionMode: 'readonly',
    },
    acp: {
      defaultAgentId: '',
      maxConcurrentSessions: 4,
      defaults: {
        readonlyOnly: true,
        onUnavailable: 'error',
      },
      agents: {},
    },
  };
}

function invalidConfig(fieldPath: string, message: string): HarnixError {
  return new HarnixError('INVALID_REQUEST', fieldPath ? `${fieldPath}: ${message}` : message, {
    details: { path: fieldPath },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizePermissionMode(value: unknown, fallback: HarnessPermissionMode): HarnessPermissionMode {
  if (value === 'allow_all' || value === 'readonly' || value === 'deny_all') {
    return value;
  }
  return fallback;
}

function normalizeHarnessKind(value: unknown, fallback: HarnessKind): HarnessKind {
  if (typeof value === 'string' && (HARNESS_KINDS as readonly string[]).includes(value)) {
    return value as HarnessKind;
  }
  return fallback;
}

/**
 * Parses and normalizes raw HarnixSettings JSON/object with defaults and strict validation.
 */
export function normalizeHarnixSettings(input?: unknown): HarnixSettings {
  const defaults = defaultHarnixSettings();
  if (input === undefined || input === null || input === '') {
    return defaults;
  }

  let rawObj: Record<string, unknown> | undefined;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return defaults;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw invalidConfig('', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    rawObj = asRecord(parsed);
    if (!rawObj) throw invalidConfig('', 'expected a JSON object');
  } else {
    rawObj = asRecord(input);
    if (!rawObj) throw invalidConfig('', 'expected an object');
  }

  if (rawObj['defaultKind'] !== undefined && typeof rawObj['defaultKind'] !== 'string') {
    throw invalidConfig('defaultKind', 'must be a string');
  }
  if (
    typeof rawObj['defaultKind'] === 'string' &&
    !(HARNESS_KINDS as readonly string[]).includes(rawObj['defaultKind'])
  ) {
    throw invalidConfig('defaultKind', `must be one of ${HARNESS_KINDS.join(', ')}`);
  }

  const rawNative = asRecord(rawObj['native']) ?? {};
  const rawPi = asRecord(rawObj['pi']) ?? {};
  const rawAcp = asRecord(rawObj['acp']) ?? {};
  const rawAcpDefaults = asRecord(rawAcp['defaults']) ?? {};
  const rawAgents = rawAcp['agents'];

  if (rawAgents !== undefined && rawAgents !== null && !asRecord(rawAgents)) {
    throw invalidConfig('acp.agents', 'must be an object keyed by agent id');
  }

  const agents: Record<string, AcpAgentEntry> = {};
  for (const [id, agentValue] of Object.entries(asRecord(rawAgents) ?? {})) {
    if (!id.trim()) throw invalidConfig('acp.agents', 'empty agent key');
    const agentObj = asRecord(agentValue);
    if (!agentObj) throw invalidConfig(`acp.agents.${id}`, 'invalid object');
    if (Object.prototype.hasOwnProperty.call(agentObj, 'env')) {
      throw invalidConfig(
        `acp.agents.${id}.env`,
        'environment values are not allowed; use envPassthrough variable names only',
      );
    }

    const permObj = asRecord(agentObj['permission']) ?? {};
    const cwdRaw = asString(agentObj['cwdPolicy'], 'workspace');
    if (cwdRaw !== 'workspace' && cwdRaw !== 'session') {
      throw invalidConfig(`acp.agents.${id}.cwdPolicy`, 'must be workspace or session');
    }

    const permModeRaw = asString(permObj['mode'], 'auto');
    if (permModeRaw !== 'auto') {
      throw invalidConfig(`acp.agents.${id}.permission.mode`, 'must be auto');
    }

    agents[id] = {
      id: asString(agentObj['id'], id),
      name: asString(agentObj['name']),
      enabled: asBoolean(agentObj['enabled'], false),
      command: asString(agentObj['command']),
      args: asStringArray(agentObj['args'], []),
      envPassthrough: asStringArray(agentObj['envPassthrough'], ['PATH', 'HOME', 'LANG']),
      cwdPolicy: cwdRaw,
      initTimeoutMs: asNumber(agentObj['initTimeoutMs'], 30_000) || 30_000,
      promptTimeoutMs: asNumber(agentObj['promptTimeoutMs'], 600_000) || 600_000,
      idleTimeoutMs: asNumber(agentObj['idleTimeoutMs'], 120_000) || 120_000,
      permission: {
        mode: 'auto',
        allowRead: asBoolean(permObj['allowRead'], false),
        allowSearch: asBoolean(permObj['allowSearch'], false),
        allowFetch: asBoolean(permObj['allowFetch'], false),
        allowWrite: asBoolean(permObj['allowWrite'], false),
        allowExecute: asBoolean(permObj['allowExecute'], false),
      },
    };
  }

  const normalized: HarnixSettings = {
    version: 1,
    defaultKind: normalizeHarnessKind(rawObj['defaultKind'], defaults.defaultKind),
    native: {
      ...(asOptionalNonEmptyString(rawNative['providerInstanceId']) !== undefined
        ? { providerInstanceId: asOptionalNonEmptyString(rawNative['providerInstanceId']) }
        : {}),
      ...(asOptionalNonEmptyString(rawNative['model']) !== undefined
        ? { model: asOptionalNonEmptyString(rawNative['model']) }
        : {}),
      ...(asOptionalNumber(rawNative['temperature']) !== undefined
        ? { temperature: asOptionalNumber(rawNative['temperature']) }
        : {}),
      ...(asOptionalNumber(rawNative['maxTokens']) !== undefined
        ? { maxTokens: asOptionalNumber(rawNative['maxTokens']) }
        : {}),
      maxTurns: asNumber(rawNative['maxTurns'], defaults.native.maxTurns),
      maxToolCalls: asNumber(rawNative['maxToolCalls'], defaults.native.maxToolCalls),
      maxToolCallsPerTurn: asNumber(
        rawNative['maxToolCallsPerTurn'],
        defaults.native.maxToolCallsPerTurn,
      ),
      timeoutMs: asNumber(rawNative['timeoutMs'], defaults.native.timeoutMs),
      includeUsage: asBoolean(rawNative['includeUsage'], defaults.native.includeUsage),
      permissionMode: normalizePermissionMode(
        rawNative['permissionMode'],
        defaults.native.permissionMode,
      ),
    },
    pi: {
      ...(asOptionalNonEmptyString(rawPi['providerInstanceId']) !== undefined
        ? { providerInstanceId: asOptionalNonEmptyString(rawPi['providerInstanceId']) }
        : {}),
      ...(asOptionalNonEmptyString(rawPi['model']) !== undefined
        ? { model: asOptionalNonEmptyString(rawPi['model']) }
        : {}),
      reasoning: asBoolean(rawPi['reasoning'], defaults.pi.reasoning),
      contextWindow: asNumber(rawPi['contextWindow'], defaults.pi.contextWindow),
      maxTokens: asNumber(rawPi['maxTokens'], defaults.pi.maxTokens),
      maxTurns: asNumber(rawPi['maxTurns'], defaults.pi.maxTurns),
      maxToolCalls: asNumber(rawPi['maxToolCalls'], defaults.pi.maxToolCalls),
      maxToolCallsPerTurn: asNumber(
        rawPi['maxToolCallsPerTurn'],
        defaults.pi.maxToolCallsPerTurn,
      ),
      timeoutMs: asNumber(rawPi['timeoutMs'], defaults.pi.timeoutMs),
      permissionMode: normalizePermissionMode(rawPi['permissionMode'], defaults.pi.permissionMode),
    },
    acp: {
      defaultAgentId: asString(rawAcp['defaultAgentId'], defaults.acp.defaultAgentId),
      maxConcurrentSessions: asNumber(
        rawAcp['maxConcurrentSessions'],
        defaults.acp.maxConcurrentSessions,
      ),
      defaults: {
        readonlyOnly: asBoolean(
          rawAcpDefaults['readonlyOnly'],
          defaults.acp.defaults.readonlyOnly,
        ),
        onUnavailable: 'error',
      },
      agents,
    },
  };

  validateHarnixSettings(normalized);
  return normalized;
}

function checkRange(value: number, min: number, max: number, fieldPath: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw invalidConfig(fieldPath, `must be between ${min} and ${max}`);
  }
}

function hasCredentialShape(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.startsWith('bearer ') || lower.startsWith('authorization:')) return true;
  if (CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;
  return value.startsWith('eyJ') && (value.match(/\./g)?.length ?? 0) >= 2;
}

function validateAcpArgsNoCredentials(agentId: string, args: readonly string[]): void {
  let expectValueFlagIndex = -1;
  args.forEach((arg, index) => {
    const fieldPath = `acp.agents.${agentId}.args[${index}]`;
    const lower = arg.toLowerCase();
    if (expectValueFlagIndex >= 0) {
      throw invalidConfig(
        fieldPath,
        'command args must not contain credentials; use envPassthrough variable names instead',
      );
    }
    for (const flag of CREDENTIAL_FLAGS) {
      if (lower === flag) {
        expectValueFlagIndex = index;
        break;
      }
      if (lower.startsWith(`${flag}=`)) {
        throw invalidConfig(
          fieldPath,
          'command args must not contain credentials; use envPassthrough variable names instead',
        );
      }
    }
    if (hasCredentialShape(arg)) {
      throw invalidConfig(
        fieldPath,
        'command args must not contain credentials; use envPassthrough variable names instead',
      );
    }
  });
  if (expectValueFlagIndex >= 0) {
    throw invalidConfig(
      `acp.agents.${agentId}.args[${expectValueFlagIndex}]`,
      'command args must not contain credentials; use envPassthrough variable names instead',
    );
  }
}

/**
 * Validates HarnixSettings boundaries and ACP security invariants.
 */
export function validateHarnixSettings(settings: HarnixSettings): void {
  if (!(HARNESS_KINDS as readonly string[]).includes(settings.defaultKind)) {
    throw invalidConfig('defaultKind', `must be one of ${HARNESS_KINDS.join(', ')}`);
  }

  if (settings.native.temperature !== undefined) {
    checkRange(settings.native.temperature, 0, 2, 'native.temperature');
  }
  if (settings.native.maxTokens !== undefined) {
    checkRange(settings.native.maxTokens, 1, 200_000, 'native.maxTokens');
  }
  checkRange(settings.native.maxTurns, 1, 64, 'native.maxTurns');
  checkRange(settings.native.maxToolCalls, 1, 256, 'native.maxToolCalls');
  checkRange(settings.native.maxToolCallsPerTurn, 1, 32, 'native.maxToolCallsPerTurn');
  checkRange(settings.native.timeoutMs, 5_000, 3_600_000, 'native.timeoutMs');

  checkRange(settings.pi.contextWindow, 1_024, 2_000_000, 'pi.contextWindow');
  checkRange(settings.pi.maxTokens, 1, 200_000, 'pi.maxTokens');
  checkRange(settings.pi.maxTurns, 1, 64, 'pi.maxTurns');
  checkRange(settings.pi.maxToolCalls, 1, 256, 'pi.maxToolCalls');
  checkRange(settings.pi.maxToolCallsPerTurn, 1, 32, 'pi.maxToolCallsPerTurn');
  checkRange(settings.pi.timeoutMs, 5_000, 3_600_000, 'pi.timeoutMs');

  checkRange(settings.acp.maxConcurrentSessions, 1, 16, 'acp.maxConcurrentSessions');
  if (settings.acp.defaultAgentId.trim() && !settings.acp.agents[settings.acp.defaultAgentId]) {
    throw invalidConfig('acp.defaultAgentId', `references unknown agent '${settings.acp.defaultAgentId}'`);
  }

  for (const [id, agent] of Object.entries(settings.acp.agents)) {
    const prefix = `acp.agents.${id}`;
    if (agent.id !== id) {
      throw invalidConfig(`${prefix}.id`, `must match map key '${id}'`);
    }
    if (!agent.name.trim()) {
      throw invalidConfig(`${prefix}.name`, 'is required');
    }
    const cmd = agent.command.trim();
    if (!cmd) {
      throw invalidConfig(`${prefix}.command`, 'is required');
    }
    if (/[;|&`$<>()\n\r]/.test(cmd)) {
      throw invalidConfig(`${prefix}.command`, 'must not contain shell metacharacters');
    }
    if (/[/\\]/.test(cmd) && !path.isAbsolute(cmd)) {
      throw invalidConfig(`${prefix}.command`, 'must be an executable name or an absolute path');
    }

    validateAcpArgsNoCredentials(id, agent.args);

    const seenEnv = new Set<string>();
    agent.envPassthrough.forEach((envName, index) => {
      const envPath = `${prefix}.envPassthrough[${index}]`;
      if (!envName || !ENV_NAME_PATTERN.test(envName)) {
        throw invalidConfig(envPath, 'must match ^[A-Za-z_][A-Za-z0-9_]*$');
      }
      if (seenEnv.has(envName)) {
        throw invalidConfig(envPath, `duplicate environment variable '${envName}'`);
      }
      seenEnv.add(envName);
    });

    checkRange(agent.initTimeoutMs, 1_000, 120_000, `${prefix}.initTimeoutMs`);
    checkRange(agent.promptTimeoutMs, 5_000, 3_600_000, `${prefix}.promptTimeoutMs`);
    checkRange(agent.idleTimeoutMs, 5_000, 600_000, `${prefix}.idleTimeoutMs`);

    if (settings.acp.defaults.readonlyOnly && (agent.permission.allowWrite || agent.permission.allowExecute)) {
      throw invalidConfig(
        `${prefix}.permission`,
        'allowWrite/allowExecute requires acp.defaults.readonlyOnly=false',
      );
    }
  }
}

/**
 * Redacts ACP agent entries for safe API/UI exposure (only shows env variable presence, never values).
 */
export function redactAcpAgents(
  acp: AcpHarnessSettings,
  env: NodeJS.ProcessEnv = process.env,
): readonly RedactedAcpAgentEntry[] {
  return Object.values(acp.agents)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((agent) => ({
      ...agent,
      args: [...agent.args],
      envPassthrough: agent.envPassthrough.map((name) => ({
        name,
        present: env[name] !== undefined,
      })),
    }));
}

const PERMISSION_MODE_OPTIONS: readonly HarnessConfigFieldOption[] = [
  { value: 'readonly', label: '只读策略（默认）' },
  { value: 'allow_all', label: '全部允许' },
  { value: 'deny_all', label: '全部拒绝' },
];

export const BUILT_IN_HARNESS_DESCRIPTORS: readonly HarnessDescriptor[] = [
  {
    id: 'native',
    name: 'Native Harness',
    summary: '原生 fetch + SSE 流式与多轮工具循环，轻量可控，直接复用模型 Provider 实例。',
    requiresProvider: true,
    capabilities: ['streaming', 'thinking', 'tools', 'sessions', 'cancellation', 'permissions'],
    fields: [
      {
        key: 'permissionMode',
        label: '工具权限策略',
        description: '控制 Native 运行时调用工具前的权限判定方式。',
        type: 'select',
        defaultValue: 'readonly',
        options: PERMISSION_MODE_OPTIONS,
      },
      {
        key: 'maxTurns',
        label: '最大轮次',
        description: '单次对话最多执行的工具循环轮数（1–64）。',
        type: 'number',
        defaultValue: 8,
        min: 1,
        max: 64,
      },
      {
        key: 'maxToolCalls',
        label: '总工具调用上限',
        description: '单次运行累计允许调用工具的次数上限（1–256）。',
        type: 'number',
        defaultValue: 32,
        min: 1,
        max: 256,
      },
      {
        key: 'maxToolCallsPerTurn',
        label: '单轮工具调用上限',
        description: '单轮最多并发/顺序执行的工具数量（1–32）。',
        type: 'number',
        defaultValue: 4,
        min: 1,
        max: 32,
      },
      {
        key: 'timeoutMs',
        label: '超时时间 (ms)',
        description: '单次运行超时阈值（5000–3600000 ms）。',
        type: 'number',
        defaultValue: 180_000,
        min: 5_000,
        max: 3_600_000,
      },
      {
        key: 'includeUsage',
        label: '请求 Token 用量',
        description: 'OpenAI-compatible 请求携带 stream_options.include_usage。',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'temperature',
        label: '默认 Temperature（可选）',
        description: '覆盖模型默认采样温度（0–2）。',
        type: 'number',
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        key: 'maxTokens',
        label: '默认 Max Tokens（可选）',
        description: '覆盖模型默认最大输出 token（1–200000）。',
        type: 'number',
        min: 1,
        max: 200_000,
      },
    ],
  },
  {
    id: 'pi',
    name: 'Pi AI Harness',
    summary: '基于 @mariozechner/pi-ai 的统一运行时，支持扩展推理（reasoning）与上下文窗口配置。',
    requiresProvider: true,
    capabilities: ['streaming', 'thinking', 'tools', 'sessions', 'cancellation', 'permissions'],
    fields: [
      {
        key: 'permissionMode',
        label: '工具权限策略',
        description: '控制 Pi 运行时调用工具前的权限判定方式。',
        type: 'select',
        defaultValue: 'readonly',
        options: PERMISSION_MODE_OPTIONS,
      },
      {
        key: 'reasoning',
        label: '启用 Reasoning',
        description: '向 Pi 模型路由开启思维链/推理输出。',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'contextWindow',
        label: '上下文窗口',
        description: '传给 Pi 模型路由的上下文窗口大小（1024–2000000）。',
        type: 'number',
        defaultValue: 128_000,
        min: 1_024,
        max: 2_000_000,
      },
      {
        key: 'maxTokens',
        label: 'Max Tokens',
        description: '单次响应最大输出 token（1–200000）。',
        type: 'number',
        defaultValue: 4_096,
        min: 1,
        max: 200_000,
      },
      {
        key: 'maxTurns',
        label: '最大轮次',
        description: '单次对话最多执行的工具循环轮数（1–64）。',
        type: 'number',
        defaultValue: 8,
        min: 1,
        max: 64,
      },
      {
        key: 'maxToolCalls',
        label: '总工具调用上限',
        description: '单次运行累计允许调用工具的次数上限（1–256）。',
        type: 'number',
        defaultValue: 32,
        min: 1,
        max: 256,
      },
      {
        key: 'maxToolCallsPerTurn',
        label: '单轮工具调用上限',
        description: '单轮最多执行的工具数量（1–32）。',
        type: 'number',
        defaultValue: 4,
        min: 1,
        max: 32,
      },
      {
        key: 'timeoutMs',
        label: '超时时间 (ms)',
        description: '单次运行超时阈值（5000–3600000 ms）。',
        type: 'number',
        defaultValue: 180_000,
        min: 5_000,
        max: 3_600_000,
      },
    ],
  },
  {
    id: 'acp',
    name: 'ACP Adapter',
    summary: '通过 stdio JSON-RPC 2.0 连接外部 ACP Coding Agent，支持进程池并发、白名单环境变量与细粒度权限。',
    requiresProvider: false,
    capabilities: ['streaming', 'thinking', 'tools', 'sessions', 'cancellation', 'permissions', 'plan'],
    fields: [
      {
        key: 'defaultAgentId',
        label: '默认 ACP Agent',
        description: '新建会话选择 ACP 时默认使用的 Agent ID。',
        type: 'string',
        defaultValue: '',
      },
      {
        key: 'maxConcurrentSessions',
        label: '最大并发进程数',
        description: '同时保持活跃的 ACP 子进程会话上限（1–16）。',
        type: 'number',
        defaultValue: 4,
        min: 1,
        max: 16,
      },
      {
        key: 'defaults.readonlyOnly',
        label: '全局只读限制',
        description: '开启后禁止任何 ACP Agent 授予 write / execute 权限。',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'agents',
        label: 'ACP Agents 配置',
        description: '外部 Agent 的命令、参数、envPassthrough 白名单与权限策略。',
        type: 'acp_agents',
        defaultValue: {},
      },
    ],
  },
];
