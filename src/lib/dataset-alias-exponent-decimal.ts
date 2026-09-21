// Bounded exact-decimal normalisation for scientific-notation quantities.
//
// The frozen v1 alias grammar accepts plain decimals only, so the current source-proven
// cohort (151 of 654 quantities written as `2.0E-4`, `1.18E-7`, ...) is refused before any
// value is scaled. This module adds one bounded, exact entry point for the versioned v2 plan
// without touching the v1 grammar or its behaviour. It follows the reviewed v2 rules:
//
//   - the CLI expands an exponent quantity exactly with bigint, never with floating point;
//   - the stored before image is never normalised (its original text is what the server
//     compares under the lock), so nothing here rewrites a before value;
//   - a v2 desired amount is rendered as a finite ordinary decimal string with unnecessary
//     trailing fractional zeros trimmed, `0` for zero and never exponent notation;
//   - input length (64 chars), exponent magnitude (+/-30) and output length (128 chars) are
//     bounded so an oversized spelling fails closed before any allocation grows.
//
// Two renderings are exposed because both are needed: the exact expansion (which keeps the
// input's fractional scale and is the arithmetic truth used for evidence) and the canonical
// spelling (which is what a v2 desired payload carries). Both respect the output bound.
//
// The grammar is the one root's cross-language review fixed for the v2 cohort, and it is
// deliberately identical to the storage-side owner's: canonical mantissa integer
// `0|[1-9][0-9]*` (no leading zeros), optional fractional digits, then an optional exponent
// `[eE][+-]?[0-9]{1,2}` of magnitude at most 30. `01E0` and `1E030` are outside it on both
// sides; `01` was already outside the frozen v1 plain grammar.
//
// The multiplier carries the same priors as a parsed quantity (finite ordinary string, at most
// 64 characters, plain decimal) so a caller can never hand an unbounded factor to `BigInt`.

import { multiplyExactDecimal } from './dataset-maintenance-alias-rewrite.js';

export const BOUNDED_INPUT_LENGTH = 64;
export const BOUNDED_EXPONENT_LIMIT = 30;
export const BOUNDED_OUTPUT_LENGTH = 128;

const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const EXPONENT_DECIMAL = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?[eE]([+-]?)(\d{1,2})$/u;

type DecimalParts = { negative: boolean; coefficient: bigint; scale: number };

function plainParts(value: string): DecimalParts | null {
  if (!PLAIN_DECIMAL.test(value)) {
    return null;
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  return {
    negative,
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

/**
 * Parses one bounded decimal quantity. Returns null for every spelling outside the reviewed
 * grammar, including oversized input, overflow/underflow exponents and malformed mantissas, so
 * an unknown quantity can never be silently normalised.
 */
export function parseBoundedExponentDecimal(value: string): DecimalParts | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > BOUNDED_INPUT_LENGTH) {
    return null;
  }
  const plain = plainParts(value);
  if (plain) {
    return plain;
  }
  const match = EXPONENT_DECIMAL.exec(value);
  if (!match) {
    return null;
  }
  const sign = match[1] as string;
  const integer = match[2] as string;
  const fraction = match[3] ?? '';
  const exponentSign = match[4] as string;
  const exponentDigits = match[5] as string;
  // Two-digit exponent arithmetic only: no Number(), no Math.*, no floating point anywhere
  // on a quantity path.
  const exponentMagnitude =
    exponentDigits.length === 1
      ? exponentDigits.charCodeAt(0) - 48
      : (exponentDigits.charCodeAt(0) - 48) * 10 + (exponentDigits.charCodeAt(1) - 48);
  if (exponentMagnitude > BOUNDED_EXPONENT_LIMIT) {
    return null;
  }
  const exponent = exponentSign === '-' ? -exponentMagnitude : exponentMagnitude;
  let coefficient = BigInt(`${integer}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { negative: sign === '-', coefficient, scale };
}

/**
 * Exact expansion: the plain-decimal spelling that keeps the input's fractional scale. Returns
 * null when the reviewed output bound is exceeded, so a bounded helper never returns a text it
 * claimed not to produce.
 */
function renderExactDecimalText(parts: DecimalParts): string | null {
  let digits = parts.coefficient.toString().padStart(parts.scale + 1, '0');
  if (parts.scale > 0) {
    const split = digits.length - parts.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
  }
  const text = `${parts.negative && parts.coefficient !== 0n ? '-' : ''}${digits}`;
  return text.length <= BOUNDED_OUTPUT_LENGTH ? text : null;
}

/**
 * Canonical v2 spelling: finite ordinary decimal, unnecessary trailing fractional zeros
 * trimmed, `0` for zero, never exponent notation. Trimming only removes characters, so a
 * canonical text is never longer than the exact expansion the output bound was applied to.
 */
function renderCanonicalDecimalText(parts: DecimalParts): string | null {
  const exact = renderExactDecimalText(parts);
  if (exact === null) {
    return null;
  }
  // A zero quantity never carries a sign here: the exact renderer already suppresses the sign
  // when the coefficient is zero, so `-0` cannot occur and `0` is the only zero spelling.
  return exact.includes('.') ? exact.replace(/0+$/u, '').replace(/\.$/u, '') : exact;
}

/** The multiplier priors: a finite ordinary string of at most 64 characters, plain decimal. */
function boundedFactorParts(factor: unknown): DecimalParts | null {
  if (typeof factor !== 'string' || factor.length === 0 || factor.length > BOUNDED_INPUT_LENGTH) {
    return null;
  }
  return plainParts(factor);
}

/**
 * The exact product, computed by the capability's existing exact-decimal engine: this module
 * normalises the bounded exponent spelling to a plain decimal and applies the multiplier priors,
 * then hands the plain operands to the reviewed `multiplyExactDecimal` — there is no second
 * bigint multiplication engine here.
 */
function boundedProduct(value: string, factor: string): string | null {
  const normalized = normalizeBoundedDecimalText(value);
  if (normalized === null || boundedFactorParts(factor) === null) {
    return null;
  }
  const product = multiplyExactDecimal(normalized, factor);
  return product !== null && product.length <= BOUNDED_OUTPUT_LENGTH ? product : null;
}

/** True when the value is a legal v2 quantity (plain decimal or bounded exponent form). */
export function isBoundedDecimalValue(value: string): boolean {
  return parseBoundedExponentDecimal(value) !== null;
}

/** True when the factor satisfies the same priors a v2 multiplier must satisfy. */
export function isBoundedFactorValue(factor: string): boolean {
  return boundedFactorParts(factor) !== null;
}

/** Exact expansion of one bounded quantity, or null when the spelling is out of bounds. */
export function normalizeBoundedDecimalText(value: string): string | null {
  const parts = parseBoundedExponentDecimal(value);
  return parts === null ? null : renderExactDecimalText(parts);
}

/** Canonical v2 spelling of one bounded quantity, or null when it is out of bounds. */
export function canonicalDecimalText(value: string): string | null {
  const parts = parseBoundedExponentDecimal(value);
  return parts === null ? null : renderCanonicalDecimalText(parts);
}

/**
 * Exact decimal multiplication of one bounded v2 quantity by a plain-decimal factor, rendered
 * as the exact expansion.
 */
export function multiplyBoundedExactDecimal(value: string, factor: string): string | null {
  return boundedProduct(value, factor);
}

/**
 * Exact decimal multiplication of one bounded v2 quantity by a plain-decimal factor, rendered
 * as the canonical v2 desired text (this is the function a v2 plan uses for its after values).
 */
export function multiplyBoundedCanonicalDecimal(value: string, factor: string): string | null {
  const product = boundedProduct(value, factor);
  return product === null ? null : canonicalText(product);
}

/** Canonical v2 spelling of an already-rendered exact decimal: trailing zeros trimmed, no exponent. */
function canonicalText(exact: string): string {
  return exact.includes('.') ? exact.replace(/0+$/u, '').replace(/\.$/u, '') : exact;
}
