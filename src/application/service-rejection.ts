import type { CommandResult } from '../shared/command-result.js';
import type { CommandErrorCategory } from '../shared/command-error-categories.js';

export type ServiceRejection = { code: string; category: CommandErrorCategory };
// Existing Edge pre-admission failures and transactional database rejection codes.
// Unknown RPC failures, 5xx and arbitrary envelopes do not prove absence of effects.
const rejectedCodes: Record<string, CommandErrorCategory> = {
  AUTH_REQUIRED: 'authentication',
  FORBIDDEN: 'authentication',
  '42501': 'authentication',
  INVALID_PAYLOAD: 'input',
  MODEL_ID_NOT_ALLOWED: 'input',
  MODEL_VERSION_NOT_ALLOWED: 'input',
  MODEL_ID_REQUIRED_FOR_MODEL_VERSION: 'input',
  VERSION_CONFLICT: 'conflict',
  '23505': 'conflict',
  '40001': 'conflict',
  DATA_UNDER_REVIEW: 'conflict',
  CONTENT_CONFLICT: 'conflict',
  REVIEW_STATE_CONFLICT: 'conflict',
  REVIEW_DRAFT_REQUIRED: 'precondition',
  DATASET_NOT_FOUND: 'not_found_or_not_visible',
  REVIEW_NOT_FOUND: 'not_found_or_not_visible',
  MODEL_NOT_FOUND: 'not_found_or_not_visible',
  PGRST116: 'not_found_or_not_visible',
};
export function serviceRejection(payload: unknown, status = 200): ServiceRejection | null {
  if (
    !((status >= 200 && status < 300) || [400, 401, 403, 404, 409, 422].includes(status)) ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  )
    return null;
  const value = payload as Record<string, unknown>;
  if (
    'data' in value ||
    'results' in value ||
    ('status' in value && ![400, 401, 403, 404, 409, 422].includes(value.status as number)) ||
    value.ok !== false ||
    typeof value.code !== 'string' ||
    !Object.hasOwn(rejectedCodes, value.code)
  )
    return null;
  return { code: value.code, category: rejectedCodes[value.code]! };
}
export class ServiceRejectedError extends Error {
  constructor(readonly receipt: ServiceRejection) {
    super('Service rejected the operation without applying the requested mutation.');
  }
}
export function applyServiceRejection(
  value: CommandResult,
  receipt: ServiceRejection,
): CommandResult {
  value.status = 'failed';
  value.outcome = 'service_rejected';
  value.summary =
    'Service rejected the operation; the original rejection is retained without replay.';
  value.error = { ...receipt, message: value.summary };
  value.data.receipt = { ok: false, code: receipt.code };
  return value;
}
