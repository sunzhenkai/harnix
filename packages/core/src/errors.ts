export type HarnixErrorCode =
  | 'INVALID_REQUEST'
  | 'CAPABILITY_MISSING'
  | 'PROVIDER_ERROR'
  | 'TOOL_ERROR'
  | 'ACP_PROCESS_ERROR'
  | 'ACP_PROTOCOL_ERROR'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'BUDGET_EXHAUSTED'
  | 'INTERNAL_ERROR';

export interface HarnixErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Standardized error raised by all Harnix harnesses and helpers.
 */
export class HarnixError extends Error {
  readonly code: HarnixErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: HarnixErrorCode, message: string, options: HarnixErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HarnixError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function isHarnixError(error: unknown, code?: HarnixErrorCode): error is HarnixError {
  return error instanceof HarnixError && (code === undefined || error.code === code);
}

export function toHarnixError(error: unknown, fallbackCode: HarnixErrorCode = 'INTERNAL_ERROR'): HarnixError {
  if (error instanceof HarnixError) return error;
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new HarnixError('CANCELLED', error.message || 'Operation aborted', { cause: error });
    }
    return new HarnixError(fallbackCode, error.message || fallbackCode, { cause: error });
  }
  return new HarnixError(fallbackCode, String(error));
}
