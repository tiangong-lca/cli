import { createHash } from 'node:crypto';
import { CliError } from '../shared/errors.js';

function normalizeCredentialValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function fingerprintSecret(value: string): string {
  const normalized = normalizeCredentialValue(value);
  if (!normalized) {
    throw new CliError('Cannot fingerprint an empty secret value.', {
      code: 'SECRET_FINGERPRINT_VALUE_REQUIRED',
      exitCode: 2,
    });
  }

  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

export function redactEmail(email: string): string {
  const normalized = normalizeCredentialValue(email);
  const [localPart, domainPart] = normalized.split('@');
  if (!localPart || !domainPart) {
    return '****';
  }

  if (localPart.length <= 2) {
    return `****@${domainPart}`;
  }

  return `${localPart.slice(0, 2)}****@${domainPart}`;
}

export const __testInternals = { normalizeCredentialValue };
