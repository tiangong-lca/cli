import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isRecord, type JsonObject } from './dataset-local.js';
import { CliError } from './errors.js';
import {
  assertExitContract,
  assertSupportedPlatform,
  parseOperationReport,
  readCompatibleVersion,
  readProcessReport,
  resolveTidasBinary,
  runTidas,
} from './dataset-import-lca.js';

export function canonicalPropertyJson(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (isRecord(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    return item === undefined ? null : item;
  };
  return JSON.stringify(ordered(value));
}

export function propertyJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalPropertyJson(value)).digest('hex');
}

export type FlowPropertyConversionOptions = {
  tidasBin?: string;
  spawnImpl?: typeof spawnSync;
  env?: NodeJS.ProcessEnv;
};

/** Native Toolkit owns decimal arithmetic, property selection, intervals and factors. */
export function runFlowPropertyConversion(
  request: JsonObject,
  options: FlowPropertyConversionOptions = {},
): JsonObject {
  const env = options.env ?? process.env;
  const executable = resolveTidasBinary(options.tidasBin, env);
  const spawn = options.spawnImpl ?? spawnSync;
  assertSupportedPlatform(process.platform, process.arch);
  const versionRun = runTidas(
    spawn,
    executable,
    ['version', '--format', 'json', '--progress', 'never'],
    process.cwd(),
    env,
  );
  const versionReport = parseOperationReport(readProcessReport(versionRun, null), 'version');
  assertExitContract(versionRun, versionReport);
  readCompatibleVersion(
    versionReport,
    /^0\.3\.\d+$/u,
    'flow-property conversion requires a stable contract-compatible 0.3.x release',
  );
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
    throw new CliError('Flow-property conversion request exceeds 16 MiB.', {
      code: 'FLOW_PROPERTY_CONVERSION_INPUT_TOO_LARGE',
      exitCode: 2,
    });
  }
  const run = runTidas(
    spawn,
    executable,
    ['convert', '-', '--to', 'reference-unit', '--format', 'json', '--progress', 'never'],
    process.cwd(),
    env,
    encoded,
  );
  const operation = parseOperationReport(readProcessReport(run, null), 'convert');
  assertExitContract(run, operation);
  const report = operation.summary.flow_property_conversion;
  if (
    operation.status !== 'succeeded' ||
    operation.exit_class !== 'success' ||
    operation.completeness !== 'complete' ||
    !isRecord(report) ||
    report.schema_version !== 'tidas.flow-property-conversion.v1'
  ) {
    throw new CliError(
      'Native flow-property conversion did not produce a complete successful report.',
      { code: 'FLOW_PROPERTY_CONVERSION_BLOCKED', exitCode: 2, details: operation.diagnostics },
    );
  }
  return report;
}
