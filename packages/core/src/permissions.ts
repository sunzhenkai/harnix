import { allowAllPermissions, denyAllPermissions } from './helpers.js';
import type { PermissionDecision, PermissionHandler, PermissionRequest } from './types.js';

export type HarnessPermissionMode = 'allow_all' | 'readonly' | 'deny_all';

export interface ToolPermissionPolicy {
  readonly allowRead: boolean;
  readonly allowSearch: boolean;
  readonly allowFetch: boolean;
  readonly allowWrite: boolean;
  readonly allowExecute: boolean;
  readonly readonlyOnly?: boolean;
}

export const DEFAULT_READONLY_PERMISSION_POLICY: ToolPermissionPolicy = {
  allowRead: true,
  allowSearch: true,
  allowFetch: true,
  allowWrite: false,
  allowExecute: false,
  readonlyOnly: true,
};

const READ_PATTERNS = ['read', 'list', 'get', 'cat', 'view'];
const SEARCH_PATTERNS = ['search', 'find', 'grep', 'query', 'structure', 'audit', 'gaps', 'similar', 'references'];
const FETCH_PATTERNS = ['fetch', 'http', 'web'];
const WRITE_PATTERNS = ['write', 'edit', 'delete', 'remove', 'move', 'create', 'update', 'patch', 'save', 'apply'];
const EXECUTE_PATTERNS = ['exec', 'run', 'shell', 'bash', 'terminal', 'cmd'];

/**
 * Infers canonical permission kind from explicit toolKind or tool name keywords.
 */
export function inferToolKind(toolName: string, explicitKind?: string): string {
  const kind = explicitKind?.trim().toLowerCase();
  if (kind) return kind;

  const name = toolName.trim().toLowerCase();
  if (WRITE_PATTERNS.some((p) => name.includes(p))) return 'edit';
  if (EXECUTE_PATTERNS.some((p) => name.includes(p))) return 'execute';
  if (FETCH_PATTERNS.some((p) => name.includes(p))) return 'fetch';
  if (SEARCH_PATTERNS.some((p) => name.includes(p))) return 'search';
  if (READ_PATTERNS.some((p) => name.includes(p))) return 'read';
  return 'other';
}

function matchOptionId(request: PermissionRequest, allowed: boolean): string | undefined {
  const options = request.options ?? [];
  const preferred = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of preferred) {
    const matched = options.find((opt) => opt.kind === kind);
    if (matched) return matched.optionId;
  }
  return undefined;
}

/**
 * Creates a policy-driven PermissionHandler compatible with both Native/Pi tool loops and ACP requests.
 */
export function createPolicyPermissionHandler(policy: ToolPermissionPolicy): PermissionHandler {
  const readonlyOnly = policy.readonlyOnly ?? true;

  return (request: PermissionRequest): PermissionDecision => {
    const kind = inferToolKind(request.toolName, request.toolKind);
    let allowed = false;

    switch (kind) {
      case 'think':
        allowed = true;
        break;
      case 'read':
        allowed = policy.allowRead;
        break;
      case 'search':
        allowed = policy.allowSearch;
        break;
      case 'fetch':
        allowed = policy.allowFetch;
        break;
      case 'edit':
      case 'delete':
      case 'move':
      case 'write':
        allowed = policy.allowWrite && !readonlyOnly;
        break;
      case 'execute':
        allowed = policy.allowExecute && !readonlyOnly;
        break;
      default:
        allowed = false;
    }

    const optionId = matchOptionId(request, allowed);
    return {
      outcome: allowed ? 'allow' : 'deny',
      ...(optionId !== undefined ? { optionId } : {}),
      reason: allowed ? 'policy_allowed' : `policy_denied:${kind}`,
    };
  };
}

/**
 * Returns a PermissionHandler for a standard HarnessPermissionMode.
 */
export function createPermissionHandlerForMode(mode: HarnessPermissionMode): PermissionHandler {
  switch (mode) {
    case 'allow_all':
      return allowAllPermissions;
    case 'deny_all':
      return denyAllPermissions;
    case 'readonly':
    default:
      return createPolicyPermissionHandler(DEFAULT_READONLY_PERMISSION_POLICY);
  }
}
