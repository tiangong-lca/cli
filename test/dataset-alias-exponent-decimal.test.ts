import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BOUNDED_EXPONENT_LIMIT,
  BOUNDED_INPUT_LENGTH,
  BOUNDED_OUTPUT_LENGTH,
  canonicalDecimalText,
  isBoundedDecimalValue,
  multiplyBoundedCanonicalDecimal,
  multiplyBoundedExactDecimal,
  normalizeBoundedDecimalText,
  parseBoundedExponentDecimal,
} from '../src/lib/dataset-alias-exponent-decimal.js';
import { multiplyExactDecimal } from '../src/lib/dataset-maintenance-alias-rewrite.js';

// Shapes sampled from the current source-proven alias cohort (mantissa up to three decimals,
// exponents -3..-7) plus the boundary forms that must stay exact. Values are plain decimal
// quantities and carry no dataset, account or person information.
const REVIEWED_FACTOR = '0.00011415525114155251';

const EXPONENT_FORMS: ReadonlyArray<readonly [string, string]> = [
  ['2.0E-4', '0.00020'],
  ['9.1E-5', '0.000091'],
  ['1.03E-4', '0.000103'],
  ['1.18E-7', '0.000000118'],
  ['9.423E-4', '0.0009423'],
  ['2.43E-6', '0.00000243'],
  ['8.499E-5', '0.00008499'],
  ['1.836E-5', '0.00001836'],
  ['6.17e-4', '0.000617'],
  ['3.5e-3', '0.0035'],
  ['1E-3', '0.001'],
  ['1.0E+3', '1000'],
  ['-2.5E-2', '-0.025'],
];

/** Independent exact oracle: scaled bigint arithmetic without any floats. */
function exactProduct(left: string, right: string): string {
  const parts = (value: string) => {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [integer, fraction = ''] = unsigned.split('.');
    return { negative, coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
  };
  const a = parts(left);
  const b = parts(right);
  const coefficient = a.coefficient * b.coefficient;
  const scale = a.scale + b.scale;
  let digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale > 0) {
    const split = digits.length - scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
  }
  return `${a.negative !== b.negative && coefficient !== 0n ? '-' : ''}${digits}`;
}

/** Independent implementation of the reviewed v2 canonical text rule. */
function canonicalTrim(value: string): string {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  const magnitude = trimmed ? `${integer}.${trimmed}` : integer;
  return negative && /[1-9]/u.test(magnitude) ? `-${magnitude}` : magnitude;
}

test('bounded exponent quantities expand to exact plain decimals', () => {
  for (const [input, expected] of EXPONENT_FORMS) {
    assert.equal(normalizeBoundedDecimalText(input), expected, input);
    assert.ok(isBoundedDecimalValue(input), input);
    assert.doesNotMatch(normalizeBoundedDecimalText(input) ?? '', /[eE]/u, input);
  }
});

test('v2 desired amounts are canonical ordinary decimals and never exponent notation', () => {
  for (const [input] of EXPONENT_FORMS) {
    const normalized = normalizeBoundedDecimalText(input);
    assert.ok(normalized, input);
    const expected = canonicalTrim(exactProduct(normalized, REVIEWED_FACTOR));
    assert.ok(expected.length <= BOUNDED_OUTPUT_LENGTH, input);
    const actual = multiplyBoundedCanonicalDecimal(input, REVIEWED_FACTOR);
    assert.equal(actual, expected, input);
    assert.doesNotMatch(actual ?? '', /[eE]/u, input);
  }
  // The same quantity spelled `1` and `1.0` derives the same v2 desired text, and zero keeps
  // the single canonical spelling `0`.
  assert.equal(multiplyBoundedCanonicalDecimal('1', REVIEWED_FACTOR), '0.00011415525114155251');
  assert.equal(multiplyBoundedCanonicalDecimal('1.0', REVIEWED_FACTOR), '0.00011415525114155251');
  assert.equal(canonicalDecimalText('2.0E-4'), '0.0002');
  assert.equal(canonicalDecimalText('-0.0E-4'), '0');
  assert.equal(canonicalDecimalText('1.0E+3'), '1000');
});

test('bounded exponent multiplication stays exact decimal multiplication, never floating point', () => {
  for (const [input] of EXPONENT_FORMS) {
    const normalized = normalizeBoundedDecimalText(input);
    assert.ok(normalized, input);
    // The oracle is plain-decimal only (like the frozen v1 math); it validates that the v2
    // exponent entry point produced exactly the same product as the reviewed constant applied
    // to the same quantity.
    const product = multiplyBoundedExactDecimal(input, REVIEWED_FACTOR);
    assert.equal(product, exactProduct(normalized, REVIEWED_FACTOR), input);
  }
  assert.equal(
    multiplyBoundedExactDecimal('1.18E-7', REVIEWED_FACTOR),
    '0.00000000001347031963470319618',
  );
});

test('every rendered form keeps exactly the quantity it was rendered from', () => {
  // Rendering is value-preserving: the canonical spelling of a form multiplies to the same
  // canonical product as the form itself, and the canonical spelling is freshly parseable.
  for (let exponent = 3; exponent <= 7; exponent += 1) {
    for (const mantissa of ['1', '2.0', '9.1', '1.03', '9.423', '7.5']) {
      const value = `${mantissa}E-${exponent}`;
      const canonical = canonicalDecimalText(value);
      assert.ok(canonical, value);
      assert.ok(parseBoundedExponentDecimal(canonical) !== null, canonical);
      assert.equal(
        multiplyBoundedCanonicalDecimal(canonical, REVIEWED_FACTOR),
        multiplyBoundedCanonicalDecimal(value, REVIEWED_FACTOR),
        value,
      );
      // The exact-expansion rendering keeps each input's own fractional scale, so it is
      // compared through its canonical value rather than by text.
      assert.equal(
        canonicalTrim(multiplyBoundedExactDecimal(canonical, REVIEWED_FACTOR) ?? ''),
        canonicalTrim(
          multiplyBoundedExactDecimal(normalizeBoundedDecimalText(value) ?? '', REVIEWED_FACTOR) ??
            '',
        ),
        value,
      );
    }
  }
});

test('input, exponent and output bounds fail closed before an oversized spelling grows', () => {
  const maxPlain = '1'.repeat(BOUNDED_INPUT_LENGTH);
  assert.equal(parseBoundedExponentDecimal(maxPlain) !== null, true);
  assert.equal(parseBoundedExponentDecimal('1'.repeat(BOUNDED_INPUT_LENGTH + 1)), null);
  assert.equal(parseBoundedExponentDecimal(`${maxPlain}E-1`), null);
  assert.equal(canonicalDecimalText(maxPlain), maxPlain);

  // A product whose canonical text would exceed the reviewed output bound is refused rather
  // than truncated.
  const oversizeInput = '9'.repeat(BOUNDED_INPUT_LENGTH);
  const oversizeFactor = `0.${'9'.repeat(BOUNDED_INPUT_LENGTH)}`;
  const oversize = canonicalTrim(exactProduct(oversizeInput, oversizeFactor));
  assert.ok(oversize.length > BOUNDED_OUTPUT_LENGTH, String(oversize.length));
  assert.equal(multiplyBoundedCanonicalDecimal(oversizeInput, oversizeFactor), null);
  assert.equal(multiplyBoundedExactDecimal(oversizeInput, oversizeFactor)?.length, oversize.length);
});

test('bounded exponent parsing rejects everything outside the reviewed grammar', () => {
  for (const rejected of [
    '',
    ' ',
    '1E',
    'E-4',
    '.5E-3',
    '1.E-4',
    '+1E-4',
    '--1E-4',
    '1E-4.5',
    `1E-${BOUNDED_EXPONENT_LIMIT + 1}`,
    `1E${BOUNDED_EXPONENT_LIMIT + 1}`,
    '0x10',
    '0b101',
    'Infinity',
    '-Infinity',
    'NaN',
    '1_000E-4',
    '1e1e1',
    `${'9'.repeat(65)}E-4`,
    '9'.repeat(65),
    '1e',
    '-',
    '--',
  ]) {
    assert.equal(parseBoundedExponentDecimal(rejected), null, JSON.stringify(rejected));
    assert.equal(normalizeBoundedDecimalText(rejected), null, JSON.stringify(rejected));
    assert.equal(canonicalDecimalText(rejected), null, JSON.stringify(rejected));
    assert.equal(isBoundedDecimalValue(rejected), false, JSON.stringify(rejected));
    assert.equal(
      multiplyBoundedExactDecimal(rejected, REVIEWED_FACTOR),
      null,
      JSON.stringify(rejected),
    );
    assert.equal(
      multiplyBoundedCanonicalDecimal(rejected, REVIEWED_FACTOR),
      null,
      JSON.stringify(rejected),
    );
  }
  // Plain decimals stay accepted (v2 accepts both spellings of the same quantity).
  assert.equal(normalizeBoundedDecimalText('1'), '1');
  assert.equal(normalizeBoundedDecimalText('1.0'), '1.0');
  assert.equal(normalizeBoundedDecimalText('-0.22917'), '-0.22917');
  // The multiplier must itself be a plain decimal: an exponent factor is refused, so a v2 plan
  // can never smuggle an unnormalised factor into the multiplication.
  assert.equal(multiplyBoundedExactDecimal('1', '1E-3'), null);
  assert.equal(multiplyBoundedCanonicalDecimal('1', '1E-3'), null);
  // Non-string input is refused rather than coerced.
  assert.equal(parseBoundedExponentDecimal(undefined as unknown as string), null);
  assert.equal(parseBoundedExponentDecimal(4 as unknown as string), null);
});

test('the frozen v1 exact grammar keeps rejecting exponent quantities', () => {
  // The historical profile is immutable: v1 must stay byte-identical and must not gain
  // exponent support, so the old plan can never silently accept the new cohort.
  for (const [input] of EXPONENT_FORMS) {
    assert.equal(multiplyExactDecimal(input, REVIEWED_FACTOR), null, input);
  }
  assert.equal(multiplyExactDecimal('1.0', REVIEWED_FACTOR), '0.000114155251141552510');
});

test('the exponent module contains no floating-point arithmetic', () => {
  // Comment text is stripped first so the module may *describe* the banned helpers; the
  // assertion covers executable source only and is hygiene, not a proof of exactness (the
  // oracle-based tests above are that proof).
  const source = readFileSync(
    path.join(process.cwd(), 'src/lib/dataset-alias-exponent-decimal.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '');
  for (const forbidden of [
    'Number(',
    'parseFloat',
    'parseInt',
    'toFixed',
    'toPrecision',
    'Math.',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
