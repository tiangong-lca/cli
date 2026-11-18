import type { CommandResult } from '../shared/command-result.js';
import { isObject } from './dataset-types.js';

const routeDenied = 'OAuth client is not authorized for this API route';
const safeServiceReasons: Readonly<Record<string, readonly string[]>> = {
  '403/42501': [routeDenied],
  '401/PGRST301': ['JWT expired'],
  '401/AUTH_REQUIRED': ['Authentication required'],
  '400/INVALID_DATASET_TABLE': ['Unsupported dataset table for review submission'],
  '403/ROOT_DATASET_NOT_OWNED': ['Only the dataset owner can submit review'],
  '409/APPROVED_DATASET_IMMUTABLE': ['Only a Draft dataset can be submitted'],
  '409/DATA_UNDER_REVIEW': [
    'Only a Draft dataset can be submitted',
    'An active Root Review already exists',
  ],
};

export function reviewServiceDiagnostic(payload: unknown, status?: number) {
  const code = isObject(payload) ? payload.code : undefined;
  const message = isObject(payload) ? payload.message : undefined;
  // Only fixed service messages may cross stdout or the durable mutation journal.
  // SQL details, hints and arbitrary messages can contain private data or credentials.
  const reasons = safeServiceReasons[`${status}/${typeof code === 'string' ? code : ''}`];
  const reason = typeof message === 'string' && reasons?.includes(message) ? message : undefined;
  const serviceCode =
    typeof code === 'string' && (reasons || /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/u.test(code))
      ? code
      : undefined;
  return {
    ...(status ? { httpStatus: status } : {}),
    ...(serviceCode ? { serviceCode } : {}),
    ...(reason ? { message: reason } : {}),
  };
}

export function isReviewOAuthRouteDenial(message: string | undefined): boolean {
  return message === routeDenied;
}

export class ReviewReadServiceError extends Error {
  constructor(readonly diagnostic: NonNullable<CommandResult['error']>) {
    super(diagnostic.message);
  }
}
