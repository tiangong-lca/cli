import { parseArgs } from 'node:util';
import path from 'node:path';
import type { CliResult } from '../cli.js';
import type { FetchLike } from './http.js';
import { readStudyIntent, readStudyJson } from './study-intent.js';
import {
  STUDY_COMMANDS,
  STUDY_REPORT_COMMANDS,
  studyFailure,
  studyObject,
  type StudyApiVersion,
} from './study-protocol.js';
import { runStudyRequest, type StudyCommandReport } from './study-transport.js';
import { runStudyExportFiles } from './study-export.js';

const HELP = `Usage: tiangong-lca study <action> [--input request.json] [--json]

Actions:
  capabilities | create | get | list | resources | archive | select-revision
  member set
  model source resolve | model source get | model prepare | model get
  revision create | save | get | freeze
  scenario create | save | get | freeze
  run submit | get | cancel
  task get | wait | cancel
  artifact download --input descriptor-request.json --output result.json [--force]
  request recover --intent-file /absolute/path/to/intent.json
  analysis request | get | task get | task wait | task cancel
  report create | save | get | freeze | resources
  export request | get
  export download --input artifact-request.json --output-dir report --anchors trusted-keys.json --expected selected-export.json
  export verify (--directory report | --bundle bundle.json) --anchors trusted-keys.json --expected selected-export.json

Inputs are operation fields as JSON; request/schema/key identities may be supplied.
Mutations retain the exact request in private local state before dispatch.
Recover a lost reply with its original intent; recovery never creates a new key.
--state-dir chooses retained request state; no cache cleanup deletes it or outputs.
Task selectors require studyId and typed resource; raw job IDs are not accepted.
task wait: --wait-ms (default 30000, max 60000), --poll-ms (default 1000).
A wait budget can return waiting:true; HTTP success is not computation completion.
--timeout-ms defaults to 30000 (max 60000). No automatic mutation retry.
Use auth login/status/doctor-auth for the existing configured OAuth session.
Installing this CLI grants no Study rights or runtime activation.
Analysis/report actions explicitly use v3; core lifecycle stays v2.
--api-version 3 selects v3 for capabilities/resources/task/artifact commands.
No automatic downgrade; current rights/capabilities still govern every operation.
Official HTML export additionally requires qualified receipt/renderer verification.
`;

function integer(value: string | boolean | undefined, fallback: number, minimum: number): number {
  const result =
    value === undefined
      ? fallback
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(result) || result < minimum || result > 60_000)
    studyFailure('INVALID_ARGS');
  return result;
}

export async function runStudyCommand(
  subcommand: string | null | undefined,
  args: string[],
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...(subcommand ? [subcommand] : []), ...args],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        input: { type: 'string' },
        'intent-file': { type: 'string' },
        'state-dir': { type: 'string' },
        output: { type: 'string' },
        force: { type: 'boolean' },
        'timeout-ms': { type: 'string' },
        'wait-ms': { type: 'string' },
        'poll-ms': { type: 'string' },
        'api-version': { type: 'string' },
        anchors: { type: 'string' },
        expected: { type: 'string' },
        directory: { type: 'string' },
        bundle: { type: 'string' },
        'output-dir': { type: 'string' },
      },
    });
  } catch {
    return studyFailure('INVALID_ARGS');
  }
  const { values, positionals } = parsed;
  const action = positionals.join(' ');
  if (values.help || !action) return { exitCode: 0, stdout: HELP, stderr: '' };
  const versionFlag = values['api-version'];
  if (versionFlag !== undefined && versionFlag !== '2' && versionFlag !== '3')
    studyFailure('INVALID_ARGS');
  if (action === 'export verify' || action === 'export download') {
    if (versionFlag === '2') studyFailure('UNSUPPORTED_SCHEMA');
    if (
      !values.anchors ||
      !values.expected ||
      values.output ||
      values.force ||
      values['intent-file'] ||
      values['wait-ms'] !== undefined ||
      values['poll-ms'] !== undefined
    )
      studyFailure('INVALID_ARGS');
    if (
      action === 'export verify'
        ? Boolean(values.directory) === Boolean(values.bundle) ||
          Boolean(values.input) ||
          Boolean(values['output-dir'])
        : !values.input ||
          !values['output-dir'] ||
          Boolean(values.bundle) ||
          Boolean(values.directory)
    )
      studyFailure('INVALID_ARGS');
    const report = await runStudyExportFiles(
      action === 'export verify' ? 'verify' : 'download',
      {
        anchorsFile: values.anchors,
        expectedFile: values.expected,
        directory: values.directory,
        bundleFile: values.bundle,
        inputFile: values.input,
        outputDirectory: values['output-dir'],
        timeoutMs: integer(values['timeout-ms'], 30_000, 1),
      },
      fetchImpl,
      env,
    );
    return {
      exitCode: 0,
      stdout: values.json
        ? `${JSON.stringify(report)}\n`
        : `Study export verification\n${JSON.stringify(report, null, 2)}\n`,
      stderr: '',
    };
  }
  if (
    values.anchors ||
    values.expected ||
    values.directory ||
    values.bundle ||
    values['output-dir']
  )
    studyFailure('INVALID_ARGS');
  if (
    ['analysis', 'report', 'export'].includes(positionals[0]) &&
    !Object.hasOwn(STUDY_REPORT_COMMANDS, action)
  )
    studyFailure('CAPABILITY_UNAVAILABLE');
  const recovering = action === 'request recover';
  const waiting = action === 'task wait' || action === 'analysis task wait';
  const reporting = Object.hasOwn(STUDY_REPORT_COMMANDS, action);
  if (recovering && versionFlag !== undefined) studyFailure('INVALID_ARGS');
  if (reporting && versionFlag === '2') studyFailure('UNSUPPORTED_SCHEMA');
  if (
    versionFlag !== undefined &&
    !reporting &&
    ![
      'capabilities',
      'resources',
      'task get',
      'task wait',
      'task cancel',
      'artifact download',
    ].includes(action)
  )
    studyFailure('INVALID_ARGS');
  const apiVersion: StudyApiVersion | undefined = recovering
    ? undefined
    : reporting || versionFlag === '3'
      ? 'v3'
      : 'v2';
  const operation = STUDY_COMMANDS[action];
  if (!operation && !recovering) studyFailure('INVALID_ARGS');
  if (
    (recovering && (!values['intent-file'] || values.input || values.output || values.force)) ||
    (!recovering && values['intent-file']) ||
    (values.force && action !== 'artifact download') ||
    (!waiting && (values['wait-ms'] !== undefined || values['poll-ms'] !== undefined))
  )
    studyFailure('INVALID_ARGS');
  if (!recovering && operation !== 'capability.read' && !values.input)
    studyFailure('STUDY_INPUT_REQUIRED');
  const timeoutMs = integer(values['timeout-ms'], 30_000, 1);
  const input = recovering
    ? readStudyIntent(path.resolve(values['intent-file'] as string)).request
    : values.input
      ? readStudyJson(path.resolve(values.input))
      : {};
  const selectedOperation = recovering
    ? String((input as Record<string, unknown>).operation)
    : operation;
  const options = {
    env,
    fetchImpl,
    timeoutMs,
    stateDir: values['state-dir'],
    outputPath: values.output,
    force: values.force,
    recoverFile: values['intent-file'],
    apiVersion,
  };
  const deadline = performance.now() + (waiting ? integer(values['wait-ms'], 30_000, 0) : 0);
  let report: StudyCommandReport & { waiting?: boolean } = await runStudyRequest(
    selectedOperation,
    input,
    options,
  );
  if (waiting) {
    const pollMs = integer(values['poll-ms'], 1000, 1);
    while (true) {
      // The contained codec has validated the task resource/selection already.
      const execution = (report.data.value as { execution: Record<string, unknown> }).execution;
      if (
        ['completed', 'failed', 'cancelled', 'blocked', 'stale'].includes(String(execution.status))
      ) {
        report = { ...report, waiting: false };
        break;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        report = { ...report, waiting: true };
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
      if (performance.now() >= deadline) {
        report = { ...report, waiting: true };
        break;
      }
      report = await runStudyRequest(operation, input, {
        ...options,
        timeoutMs: Math.max(1, Math.floor(Math.min(timeoutMs, deadline - performance.now()))),
      });
    }
  }
  const task =
    studyObject(report.data.value) && studyObject(report.data.value.execution)
      ? report.data.value.execution
      : undefined;
  const failedTask =
    waiting && task && ['failed', 'cancelled', 'blocked', 'stale'].includes(String(task.status));
  return {
    exitCode: failedTask ? 1 : 0,
    stdout: values.json
      ? `${JSON.stringify(report)}\n`
      : `Study ${report.operation}\n${JSON.stringify(report, null, 2)}\n`,
    stderr: '',
  };
}
