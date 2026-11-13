import { resolveModelRuntime, modelRuntimeEnvironment } from './model-runtime.js';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareModel, type CalculationReference } from '../application/model-calculation.js';
import { object, text, type JsonObject } from '../application/dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';
import { datasetReader } from './dataset-read.js';
import { resolveRequestFile } from './model-input.js';
import type { FetchLike } from '../lib/transport/http.js';

export async function prepareModelInput(
  request: JsonObject,
  inputPath: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
) {
  const read = async (
    ref: CalculationReference | { type: 'model'; id: string; version: string },
  ) => {
    if (ref.version === 'latest')
      throw new CommandInputError(
        'EXACT_VERSION_REQUIRED',
        'Model preparation requires exact remote versions.',
      );
    const page = await datasetReader(env, fetchImpl)(ref.type, {
      id: ref.id,
      version: ref.version,
      limit: 1,
      offset: 0,
    });
    if (page.records.length !== 1)
      throw new CommandInputError(
        'CALCULATION_DEPENDENCY_MISSING',
        `Exact ${ref.type} ${ref.id}@${ref.version} not found or not visible.`,
        'not_found_or_not_visible',
      );
    return page.records[0]!.content;
  };
  return prepareModel(request, {
    read,
    async load(selection) {
      if (Object.keys(selection).length !== 1)
        throw new CommandInputError(
          'CALCULATION_SELECTION_INVALID',
          'Select exactly one content, file or explicit remote Model.',
        );
      if (selection.content !== undefined) return object(selection.content, 'content');
      if (selection.file !== undefined)
        return object(
          JSON.parse(readFileSync(resolveRequestFile(selection.file, inputPath), 'utf8')),
          'file content',
        );
      const remote = object(selection.remote, 'remote Model');
      return read({
        type: 'model',
        id: text(remote.id, 'remote.id'),
        version: text(remote.version, 'remote.version'),
      });
    },
  });
}

// Preserve only bounded, known input identities; never forward arbitrary engine stderr.
function calculationDiagnostic(stderr: string): { detail: string; inputError: boolean } {
  const code = /(?:^|\n)Error: ([a-z][a-z0-9_]{0,95})(?:\s|$)/u.exec(stderr)?.[1];
  const token = '[A-Za-z0-9_.-]{1,128}';
  const number = '-?[0-9](?:\\.[0-9]{1,17})?e[+-]?[0-9]{1,3}';
  const patterns = [
    `study_connection_direction_mismatch flow=${token} version=${token} supplier_instance=${token} supplier_exchange=${token} supplier_direction=(?:Input|Output) supplier_amount=${number} supplier_coefficient=${number} consumer_instance=${token} consumer_exchange=${token} consumer_direction=(?:Input|Output) consumer_amount=${number} consumer_coefficient=${number}`,
    `local_background_reference_missing instance=${token} reference=${token} matches=[0-9]{1,6}`,
    `local_background_reference_mismatch instance=${token} reference=${token} expected_flow=${token} expected_version=${token} expected_direction=(?:Input|Output) actual_flow=${token} actual_version=${token} actual_direction=(?:Input|Output)`,
    `study_ambiguous_or_missing_exchange_port instance=${token} flow=${token} version=${token} direction=(?:Input|Output) matches=[0-9]{1,6}`,
  ];
  const context = new RegExp(`(?:^|\\n)Error: (${patterns.join('|')})(?=\\r?\\n|$)`, 'u').exec(
    stderr,
  )?.[1];
  return { detail: context ?? code ?? '', inputError: context !== undefined };
}

export function calculateLocalModel(
  request: JsonObject,
  env: NodeJS.ProcessEnv,
  execute: typeof spawnSync = spawnSync,
): JsonObject {
  const input = object(request.content, 'calculation input');
  if (input.schemaVersion !== 'lca.model-input.v1')
    throw new CommandInputError(
      'CALCULATION_INPUT_INVALID',
      'Use dataset model prepare to assemble a complete local input.',
    );
  const { engine, staticCache: cache } = resolveModelRuntime(request, env);
  const output = path.resolve(text(request.outputDir, '--output-dir'));
  if (existsSync(output))
    throw new CommandInputError(
      'CALCULATION_OUTPUT_EXISTS',
      'Choose a new output directory for each calculation. Existing results are never replaced.',
      'conflict',
    );
  const limits = input.limits === undefined ? {} : object(input.limits, 'limits');
  const timeout = request.timeoutMs ?? 120000;
  const maxBytes = limits.maxInputBytes ?? 4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeout) ||
    Number(timeout) < 1 ||
    Number(timeout) > 2147483647 ||
    !Number.isSafeInteger(maxBytes) ||
    Number(maxBytes) < 1
  )
    throw new CommandInputError(
      'CALCULATION_RESOURCE_INVALID',
      'timeout-ms must be 1..2147483647; maxInputBytes must be a positive safe integer.',
    );
  const bytes = JSON.stringify(input);
  if (Buffer.byteLength(bytes) > Number(maxBytes))
    throw new CommandInputError(
      'CALCULATION_INPUT_LIMIT',
      'Input exceeds maxInputBytes. Increase the explicit resource budget if appropriate.',
    );
  const staging = mkdtempSync(path.join(os.tmpdir(), 'tiangong-model-'));
  try {
    const file = path.join(staging, 'input.json');
    writeFileSync(file, bytes, { mode: 0o600 });
    const execution = execute(
      engine,
      [
        '--input',
        file,
        '--static-cache',
        cache,
        '--output-dir',
        output,
        '--max-input-bytes',
        String(maxBytes),
      ],
      {
        encoding: 'utf8',
        shell: false,
        timeout: Number(timeout),
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        env: modelRuntimeEnvironment(env),
      },
    );
    if (execution.error || execution.status !== 0) {
      const diagnostic = calculationDiagnostic(execution.stderr);
      throw new CommandInputError(
        'CALCULATION_EXECUTION_FAILED',
        `Local calculation did not complete${diagnostic.detail ? ` (${diagnostic.detail})` : ''}. ${diagnostic.inputError ? 'Inspect the named Process reference and connection ports: Flow/version, direction, signed amounts and units. Nonzero connected coefficients must be opposite (Input=-amount, Output=amount). Preserve original signs and the published background quantity; correct the input and use a new Run.' : 'Inspect the engine installation, input and resource limits.'} Retain any files in ${output}; no retry was attempted.`,
        'precondition',
      );
    }
    const summary = object(
      JSON.parse(readFileSync(path.join(output, 'summary.json'), 'utf8')),
      'calculation summary',
    );
    if (
      summary.status !== 'completed' ||
      summary.profile !== 'lca.model-local.v1' ||
      !['input.json', 'prepared.json', 'result.json'].every((name) =>
        existsSync(path.join(output, name)),
      )
    )
      throw new CommandInputError(
        'CALCULATION_OUTPUT_INCOMPLETE',
        `Engine did not deliver a complete run in ${output}. Inspect existing files before starting a new calculation.`,
        'precondition',
      );
    return {
      ...summary,
      execution: 'local',
      outputDirectory: output,
      timeoutMs: timeout,
      artifacts: ['input', 'prepared', 'result', 'summary'].map((name) => ({
        purpose: name,
        path: path.join(output, `${name}.json`),
        bytes: statSync(path.join(output, `${name}.json`)).size,
      })),
      files: Object.fromEntries(
        ['input', 'prepared', 'result', 'summary'].map((name) => [
          name,
          path.join(output, `${name}.json`),
        ]),
      ),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
