import { parseArgs } from 'node:util';
import { CliError } from '../lib/errors.js';
import { stringifyJson } from '../lib/io.js';
import {
  LCA_RELEASE_ACTIONS,
  renderLcaReleaseReport,
  runLcaRelease,
  type LcaReleaseAction,
} from '../lib/lca-release.js';

import type { CliDeps, CliResult } from '../cli-deps.js';
function renderLcaReleaseHelp(): string {
  return `Usage:
  tiangong-lca release <action> [options]

Workflow actions:
  prepare              register an immutable publish plan from --input
  upload               verify four local ZIPs, upload them, and write --output receipt
  finalize             bind a Release Manifest and uploaded artifact refs from --input
  approve              create a durable manager approval from --input
  publish              publish an approved release from --input; credential fingerprint is derived locally
  readback-verify      record independent artifact readback hashes from --input
  unpublish            unpublish the current release from --input

Read and download actions:
  status               read --release-run-id
  current              read the current public release
  calculation-bundle   verify/sign bundle manifest and chunks for --package-id; requires --output
  calculation-artifact download one exact --artifact-path from --package-id; requires --output
  artifact-download    download one release ZIP by --artifact-id; requires --output

Options:
  --input <file>           JSON command or upload request
  --output <path>         Durable JSON receipt/projection or downloaded bytes
  --release-run-id <uuid> Release run for status
  --package-id <uuid>     LCIA result package for Calculation Bundle reads
  --artifact-id <uuid>    Published release artifact to download
  --artifact-path <path>  Exact path from a Calculation Bundle manifest
  --force                 Replace an existing output file
  --dry-run               Validate and print the masked planned request without network writes
  --json                  Print the stable compact JSON report; otherwise print Summary and Next
  --base-url <url>        Override TIANGONG_LCA_API_BASE_URL
  --timeout-ms <n>        Request timeout in milliseconds (default 60000)
  -h, --help

Official Production: run "tiangong-lca auth login" with no env setup.
Custom environment (complete matching tuple required):
  TIANGONG_LCA_API_BASE_URL
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
  TIANGONG_LCA_OAUTH_CLIENT_ID and a prior "tiangong-lca auth login"

Authorization and safety:
  The OAuth session identifies the live account, and Database RPCs check that it has
  data_product_manager. The service-role key never enters this CLI. Large bundle projections,
  ZIPs, and chunks are written to files and verified against exact byte size and SHA-256.

Examples:
  tiangong-lca release prepare --input ./release-prepare.json --json
  tiangong-lca release upload --input ./release-upload.json --output ./upload-receipt.json
  tiangong-lca release calculation-bundle --package-id 11111111-1111-4111-8111-111111111111 --output ./calculation-bundle.json
  tiangong-lca release calculation-artifact --package-id 11111111-1111-4111-8111-111111111111 --artifact-path chunks/lci-00000.jsonl.gz --output ./lci-00000.jsonl.gz
`.trim();
}

function parseLcaReleaseFlags(args: string[]): {
  help: boolean;
  json: boolean;
  dryRun: boolean;
  force: boolean;
  inputPath: string | null;
  outputPath: string | null;
  releaseRunId: string | null;
  packageId: string | null;
  artifactId: string | null;
  artifactPath: string | null;
  apiBaseUrl: string | null;
  timeoutMs: number;
} {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        force: { type: 'boolean' },
        input: { type: 'string' },
        output: { type: 'string' },
        'release-run-id': { type: 'string' },
        'package-id': { type: 'string' },
        'artifact-id': { type: 'string' },
        'artifact-path': { type: 'string' },
        'base-url': { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  const timeoutText = typeof values['timeout-ms'] === 'string' ? values['timeout-ms'] : undefined;
  const timeoutMs = timeoutText ? Number.parseInt(timeoutText, 10) : 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliError('Expected --timeout-ms to be a positive integer.', {
      code: 'INVALID_TIMEOUT',
      exitCode: 2,
    });
  }

  const optionalString = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;
  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    dryRun: Boolean(values['dry-run']),
    force: Boolean(values.force),
    inputPath: optionalString(values.input),
    outputPath: optionalString(values.output),
    releaseRunId: optionalString(values['release-run-id']),
    packageId: optionalString(values['package-id']),
    artifactId: optionalString(values['artifact-id']),
    artifactPath: optionalString(values['artifact-path']),
    apiBaseUrl: optionalString(values['base-url']),
    timeoutMs,
  };
}

function requireLcaReleaseAction(value: string): LcaReleaseAction {
  if (!LCA_RELEASE_ACTIONS.includes(value as LcaReleaseAction)) {
    throw new CliError(`Unsupported release action: ${value}`, {
      code: 'LCA_RELEASE_ACTION_UNSUPPORTED',
      exitCode: 2,
      details: { actions: LCA_RELEASE_ACTIONS },
    });
  }
  return value as LcaReleaseAction;
}

export async function executeReleaseCommand(
  subcommand: string | null,
  commandArgs: string[],
  deps: CliDeps,
): Promise<CliResult> {
  const lcaReleaseImpl = deps.runLcaReleaseImpl ?? runLcaRelease;
  if (!subcommand) {
    return { exitCode: 0, stdout: `${renderLcaReleaseHelp()}\n`, stderr: '' };
  }

  {
    const releaseFlags = parseLcaReleaseFlags(commandArgs);
    if (releaseFlags.help) {
      return { exitCode: 0, stdout: `${renderLcaReleaseHelp()}\n`, stderr: '' };
    }
    const action = requireLcaReleaseAction(subcommand);
    const env = { ...deps.env };
    if (releaseFlags.apiBaseUrl !== null) {
      env.TIANGONG_LCA_API_BASE_URL = releaseFlags.apiBaseUrl;
    }
    const report = await lcaReleaseImpl({
      action,
      inputPath: releaseFlags.inputPath,
      outputPath: releaseFlags.outputPath,
      releaseRunId: releaseFlags.releaseRunId,
      packageId: releaseFlags.packageId,
      artifactId: releaseFlags.artifactId,
      artifactPath: releaseFlags.artifactPath,
      env,
      timeoutMs: releaseFlags.timeoutMs,
      dryRun: releaseFlags.dryRun,
      force: releaseFlags.force,
      fetchImpl: deps.fetchImpl,
    });
    return {
      exitCode: 0,
      stdout: releaseFlags.json ? stringifyJson(report, true) : renderLcaReleaseReport(report),
      stderr: '',
    };
  }
}
