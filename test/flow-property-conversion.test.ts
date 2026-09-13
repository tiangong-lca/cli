import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  canonicalPropertyJson,
  propertyJsonHash,
  runFlowPropertyConversion,
} from '../src/lib/flow-property-conversion.js';

const request = JSON.parse(
  readFileSync(
    new URL('./fixtures/flow-property-conversion/request.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;
const operation = JSON.parse(
  readFileSync(
    new URL('./fixtures/flow-property-conversion/operation-report.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;
const version = {
  ...operation,
  command: 'version',
  summary: { binary_version: '0.3.0', operation_report_schema: 'tidas.operation-report.v1' },
};
function native(report = operation, nativeVersion = version, exit = 0): typeof spawnSync {
  return ((_bin: string, args: string[], options: { input?: string }) => {
    if (args[0] === 'convert') assert.deepEqual(JSON.parse(options.input!), request);
    return {
      pid: 1,
      output: [],
      stdout: JSON.stringify(args[0] === 'version' ? nativeVersion : report),
      stderr: '',
      status: args[0] === 'version' ? 0 : exit,
      signal: null,
    };
  }) as unknown as typeof spawnSync;
}

test('conversion adapter uses the existing native machine contract and returns its full report', () => {
  const report = runFlowPropertyConversion(request, {
    tidasBin: 'tidas-fixture',
    spawnImpl: native(),
    env: {},
  });
  assert.deepEqual(report, (operation.summary as Record<string, unknown>).flow_property_conversion);
  assert.equal(
    canonicalPropertyJson({ z: undefined, a: [2, { b: 1, a: 0 }] }),
    '{"a":[2,{"a":0,"b":1}],"z":null}',
  );
  assert.equal(propertyJsonHash({ b: 1, a: 2 }), propertyJsonHash({ a: 2, b: 1 }));
});

test('conversion adapter fails closed for wrong versions, unsuccessful/missing reports and oversized requests', () => {
  assert.throws(() => runFlowPropertyConversion(request, { tidasBin: process.execPath }));
  assert.throws(
    () =>
      runFlowPropertyConversion(request, {
        spawnImpl: native(operation, {
          ...version,
          summary: { ...version.summary, binary_version: '0.2.9' },
        }),
      }),
    /Incompatible tidas/u,
  );
  for (const report of [
    { ...operation, summary: {} },
    { ...operation, completeness: 'partial' },
    { ...operation, status: 'failed' },
    { ...operation, summary: { flow_property_conversion: { schema_version: 'wrong' } } },
  ])
    assert.throws(
      () => runFlowPropertyConversion(request, { spawnImpl: native(report) }),
      /complete successful report/u,
    );
  assert.throws(
    () => runFlowPropertyConversion(request, { spawnImpl: native(operation, version, 2) }),
    /disagrees/u,
  );
  assert.throws(
    () =>
      runFlowPropertyConversion({ padding: 'x'.repeat(16 * 1024 * 1024) }, { spawnImpl: native() }),
    /exceeds 16 MiB/u,
  );
});
