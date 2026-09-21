// Bounded exact-decimal normalisation for scientific-notation quantities.
//
// The frozen v1 alias grammar accepts plain decimals only, so the current source-proven
// cohort (151 of 654 quantities written as `2.0E-4`, `1.18E-7`, ...) is refused before any
// value is scaled. This module adds one bounded, exact entry point for the versioned v2
// plan without touching the v1 grammar or its behaviour:
//
//   - the mantissa must be a plain decimal of at most 64 digits, optionally signed;
//   - the exponent is an optional sign plus one or two digits, bounded by
//     BOUNDED_EXPONENT_LIMIT, so overflow/underflow spellings fail closed;
//   - everything is normalised to `{ negative, coefficient: bigint, scale }` and multiplied
//     with the same integer arithmetic the reviewed v1 math uses. No Number(), no
//     parseFloat, no Math.*, no rounding: the decimal value is preserved exactly and the
//     rendered text is the exact plain-decimal spelling of the same quantity.

export const BOUNDED_EXPONENT_LIMIT = 30;

const MAX_MANTISSA_DIGITS = 64;
const PLAIN_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const EXPONENT_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?)(\d{1,2})$/u;

type DecimalParts = { negative: boolean; coefficient: bigint; scale: number };

function plainParts(value: string): DecimalParts | null {
  if (!PLAIN_DECIMAL.test(value)) {
    return null;
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  if (integer.length + fraction.length > MAX_MANTISSA_DIGITS) {
    return null;
  }
  return {
    negative,
    coefficient: BigInt(`${integer}${fraction}`),
    scale: fraction.length,
  };
}

/**
 * Parses one bounded decimal quantity. Returns null for every spelling outside the reviewed
 * grammar, including overflow/underflow exponents, so an unknown quantity can never be
 * silently normalised.
 */
export function parseBoundedExponentDecimal(value: string): DecimalParts | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
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
  if (integer.length + fraction.length > MAX_MANTISSA_DIGITS) {
    return null;
  }
  let coefficient = BigInt(`${integer}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { negative: sign === '-', coefficient, scale };
}

function renderDecimal(parts: DecimalParts): string {
  let digits = parts.coefficient.toString().padStart(parts.scale + 1, '0');
  if (parts.scale > 0) {
    const split = digits.length - parts.scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
  }
  return `${parts.negative && parts.coefficient !== 0n ? '-' : ''}${digits}`;
}

/** True when the value is a legal v2 quantity (plain decimal or bounded exponent form). */
export function isBoundedDecimalValue(value: string): boolean {
  return parseBoundedExponentDecimal(value) !== null;
}

/**
 * Exact plain-decimal spelling of one bounded quantity. Trailing zeros that belong to the
 * input scale are preserved while the value stays fractional (`2.0E-4` renders as
 * `0.00020`), and are absorbed when a positive exponent moves the point past the integer
 * part (`1.0E+3` renders as `1000`). Both spellings are exactly the same quantity.
 */
export function normalizeBoundedDecimalText(value: string): string | null {
  const parts = parseBoundedExponentDecimal(value);
  return parts === null ? null : renderDecimal(parts);
}

/**
 * Exact decimal multiplication of one bounded v2 quantity by a plain-decimal factor. Both
 * operands are normalised first, so exponent notation and plain decimals multiply identically.
 */
export function multiplyBoundedExactDecimal(value: string, factor: string): string | null {
  const left = parseBoundedExponentDecimal(value);
  const right = plainParts(factor);
  if (!left || !right) {
    return null;
  }
  return renderDecimal({
    negative: left.negative !== right.negative,
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}
