export const BRIDGE_SCHEMA_VERSION = 1;

export const EVENT_TYPES = {
  STARTED: 'started',
  PROGRESS: 'progress',
  QUESTION: 'question',
  PERMISSION_REQUIRED: 'permission_required',
  BLOCKED: 'blocked',
  FAILED: 'failed',
};

export const REPORT_OUTCOMES = {
  SUBMITTED: 'submitted',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export const ERROR_CODES = {
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  STALE_ATTEMPT: 'stale_attempt',
  CONTEXT_STALE: 'context_stale',
  PERMISSION_REQUIRED: 'permission_required',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  NETWORK_ERROR: 'network_error',
  EXECUTOR_UNAVAILABLE: 'executor_unavailable',
  UNSUPPORTED_SCHEMA: 'unsupported_schema',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  PROCESS_ERROR: 'process_error',
  PARSE_ERROR: 'parse_error',
  UNKNOWN: 'unknown',
};

export const CANCEL_REASONS = {
  TIMEOUT: 'timeout',
  SIGNAL_ABORTED: 'signal_aborted',
  CLIENT_CANCELLED: 'client_cancelled',
  LEASE_REVOKED: 'lease_revoked',
  EXTERNAL_ABORT: 'external_abort',
};

export const EXECUTION_MODES = {
  CHAT: 'chat',
  WORK: 'work',
};
