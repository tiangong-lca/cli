import { parseArgs } from 'node:util';
import { CliError } from '../lib/errors.js';
import { stringifyJson } from '../lib/io.js';
import {
  runDatasetClassificationApply,
  runDatasetClassificationAudit,
} from '../lib/dataset-classification.js';

import type { CliDeps, CliResult } from '../cli-deps.js';
function renderDatasetClassificationHelp(): string {
  return `Usage:
  tiangong-lca dataset classification children --type <type> [options]
  tiangong-lca dataset classification path --type <type> --code <code> [options]
  tiangong-lca dataset classification audit --type location --input <file> [options]
  tiangong-lca dataset classification apply --input <file> --decisions <file> --out <file> [options]

Classification types:
  process, flow-product, flow-elementary, source, contact, unitgroup, flowproperty, lciamethod, location

Actions:
  children   List the next selectable children for a parent code. Omit --parent for top level.
  path       Resolve one schema code into the full root-to-leaf classification path.
  audit      Scan local rows for schema-derived location fields that are not valid TIDAS location codes.
  apply      Apply AI/human classification decisions to local TIDAS rows deterministically.

Options for children:
  --type <type>     Classification schema type
  --parent <code>   Parent code to inspect
  --query <text>    Filter direct children by code or label
  --limit <n>       Page size 1..100, default 20
  --cursor <token>  Continue the same content-bound selection
  --output <file>   Complete selected report
  --json            Print compact JSON

Options for path:
  --type <type>     Classification schema type
  --code <code>     Leaf or intermediate classification code
  --output <file>   Complete selected report
  --json            Print compact JSON

Options for audit:
  --type location   Audit schema-derived location values against tidas_locations_category.json
  --input <file>    Local rows as JSON or JSONL
  --out-dir <dir>   Optional artifact directory
  --json            Print compact JSON

Options for apply:
  --input <file>     Local rows as JSON or JSONL
  --decisions <file> JSON/JSONL decisions with row_index or dataset_id plus code/classes
  --out <file>       Output JSONL path for classified rows
  --type <type>      Default classification type when decisions omit category_type
  --out-dir <dir>    Artifact directory; defaults to the output file directory
  --json             Print compact JSON
  -h, --help

Decision contract:
  Decisions may target row_index or dataset_id. They may provide code, leaf_code, class_id, cat_id,
  or a classes/common:class/common:category path. The CLI normalizes the path against the bundled
  TIDAS schema copied from tidas-tools before writing it back. Location decisions use location
  target fields derived from the bundled TIDAS schemas, plus TIDAS LCIA geography fields; use
  --type location and target_path when a row contains more than one location field.

Outputs:
  - complete children/path report at --output; terminal context remains bounded
  - outputs/location-audit-findings.jsonl for audit
  - outputs/location-audit-report.json for audit
  - classified rows at --out for apply
  - outputs/classification-apply-evidence.jsonl
  - outputs/classification-apply-report.json
`.trim();
}

function parseDatasetClassificationAuditFlags(args: string[]): {
  help: boolean;
  json: boolean;
  inputPath: string;
  type: string;
  outDir: string | null;
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
        input: { type: 'string' },
        type: { type: 'string' },
        'out-dir': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    inputPath: typeof values.input === 'string' ? values.input : '',
    type: typeof values.type === 'string' ? values.type : 'location',
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : null,
  };
}

function parseDatasetClassificationApplyFlags(args: string[]): {
  help: boolean;
  json: boolean;
  inputPath: string;
  decisionsPath: string;
  outPath: string;
  type: string | null;
  outDir: string | null;
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
        input: { type: 'string' },
        decisions: { type: 'string' },
        out: { type: 'string' },
        type: { type: 'string' },
        'out-dir': { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CliError(String(error), {
      code: 'INVALID_ARGS',
      exitCode: 2,
    });
  }

  return {
    help: Boolean(values.help),
    json: Boolean(values.json),
    inputPath: typeof values.input === 'string' ? values.input : '',
    decisionsPath: typeof values.decisions === 'string' ? values.decisions : '',
    outPath: typeof values.out === 'string' ? values.out : '',
    type: typeof values.type === 'string' ? values.type : null,
    outDir: typeof values['out-dir'] === 'string' ? values['out-dir'] : null,
  };
}

export async function executeClassificationMaintenance(
  commandArgs: string[],
  deps: CliDeps,
): Promise<CliResult> {
  const datasetClassificationAuditImpl =
    deps.runDatasetClassificationAuditImpl ?? runDatasetClassificationAudit;
  const datasetClassificationApplyImpl =
    deps.runDatasetClassificationApplyImpl ?? runDatasetClassificationApply;

  const action = commandArgs[0];
  if (action === 'audit') {
    const datasetFlags = parseDatasetClassificationAuditFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return { exitCode: 0, stdout: `${renderDatasetClassificationHelp()}\n`, stderr: '' };
    }
    const report = await datasetClassificationAuditImpl({
      inputPath: datasetFlags.inputPath,
      type: datasetFlags.type,
      outDir: datasetFlags.outDir,
    });
    return {
      exitCode: report.status === 'blocked' ? 1 : 0,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  } else {
    const datasetFlags = parseDatasetClassificationApplyFlags(commandArgs.slice(1));
    if (datasetFlags.help) {
      return { exitCode: 0, stdout: `${renderDatasetClassificationHelp()}\n`, stderr: '' };
    }
    const report = await datasetClassificationApplyImpl({
      inputPath: datasetFlags.inputPath,
      decisionsPath: datasetFlags.decisionsPath,
      outPath: datasetFlags.outPath,
      type: datasetFlags.type,
      outDir: datasetFlags.outDir,
    });
    return {
      exitCode: report.status === 'blocked' ? 1 : 0,
      stdout: stringifyJson(report, datasetFlags.json),
      stderr: '',
    };
  }
}
