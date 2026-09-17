import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCli } from '../src/cli.js';
import type { DatasetMaintenanceSnapshotCompleteness } from '../src/lib/dataset-maintenance-pagination.js';
import type { DotEnvLoadResult } from '../src/lib/dotenv.js';
import type { FetchLike } from '../src/lib/http.js';
import type { RunFlowReviewedPublishDataOptions } from '../src/lib/flow-publish-reviewed-data.js';
import type { RunFlowPublishVersionOptions } from '../src/lib/flow-publish-version.js';
import type { RunFlowFetchRowsOptions } from '../src/lib/flow-fetch-rows.js';
import type { RunFlowMaterializeDecisionsOptions } from '../src/lib/flow-materialize-decisions.js';
import type {
  RunFlowRegenProductOptions,
  RunFlowValidateProcessesOptions,
} from '../src/lib/flow-regen-product.js';
import type { RunFlowRemediateOptions } from '../src/lib/flow-remediate.js';
import type { RunFlowQaOptions } from '../src/lib/flow-qa.js';
import type { RunLifecyclemodelQaOptions } from '../src/lib/lifecyclemodel-qa.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

const dotEnvStatus: DotEnvLoadResult = {
  loaded: false,
  path: '/tmp/.env',
  count: 0,
};

const makeDeps = (overrides?: Partial<NodeJS.ProcessEnv>) => ({
  env: buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
    TIANGONG_LCA_REGION: 'us-east-1',
    ...overrides,
  }),
  dotEnvStatus,
  fetchImpl: (async (input) => {
    if (isSupabaseAuthTokenUrl(String(input))) {
      return makeSupabaseAuthResponse();
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get: () => 'application/json',
      },
      text: async () => JSON.stringify({ ok: true }),
    };
  }) as FetchLike,
});

test('executeCli prints main help when no command is given', async () => {
  const result = await executeCli([], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Unified TianGong command entrypoint/u);
  assert.match(result.stdout, /Implemented Commands:/u);
  assert.match(result.stdout, /Planned Surface \(not implemented yet\):/u);
  assert.match(
    result.stdout,
    /process\s+get \| list \| identity-preflight \| build-plan \| scope-statistics/u,
  );
  assert.match(result.stdout, /flow\s+get \| list \| identity-preflight \| build-plan/u);
  assert.match(result.stdout, /process\s+auto-build/u);
  assert.match(result.stdout, /lifecyclemodel auto-build/u);
  assert.match(result.stdout, /lifecyclemodel auto-build \| validate-build \| publish-build/u);
  assert.match(result.stdout, /publish-resulting-process/u);
  assert.match(result.stdout, /qa\s+process \| flow \| lifecyclemodel/u);
  assert.match(result.stdout, /maintenance clear-account\/plan\/apply\/verify/u);
  assert.doesNotMatch(result.stdout, /dataset maintenance plan \| apply \| verify/u);
  assert.match(result.stdout, /exit with code 2/u);
  assert.equal(result.stderr, '');
});

test('executeCli main help reports loaded dotenv metadata when available', async () => {
  const result = await executeCli([], {
    ...makeDeps(),
    dotEnvStatus: {
      loaded: true,
      path: '/tmp/.env',
      count: 2,
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /\.env loaded: yes \(/u);
});

test('executeCli prints version', async () => {
  const result = await executeCli(['--version'], makeDeps());
  assert.equal(result.exitCode, 0);
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };
  assert.equal(result.stdout, `${packageJson.version}\n`);
});

test('executeCli returns doctor text and success status', async () => {
  const result = await executeCli(['doctor'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /TianGong CLI doctor/u);
  assert.match(result.stdout, /\[OK /u);
});

test('executeCli doctor reports loaded dotenv metadata and incomplete custom configuration', async () => {
  const result = await executeCli(['doctor'], {
    env: {
      TIANGONG_LCA_OAUTH_CLIENT_ID: '123e4567-e89b-42d3-a456-426614174000',
    } as NodeJS.ProcessEnv,
    dotEnvStatus: {
      loaded: true,
      path: '/tmp/.env',
      count: 1,
    },
    fetchImpl: makeDeps().fetchImpl,
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /\.env loaded: yes \(1 keys\)/u);
  assert.match(result.stdout, /Missing required environment keys:/u);
});

test('executeCli returns doctor help without falling back to main help', async () => {
  const result = await executeCli(['doctor', '--help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tiangong-lca doctor \[--json\]/u);
  assert.doesNotMatch(result.stdout, /Unified TianGong command entrypoint/u);
});

test('executeCli returns doctor json and failure status when required env is missing', async () => {
  const result = await executeCli(
    ['doctor', '--json'],
    makeDeps({
      TIANGONG_LCA_API_BASE_URL: '',
      TIANGONG_LCA_ACCESS_TOKEN: '',
    }),
  );
  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.stdout) as { ok: boolean };
  assert.equal(payload.ok, false);
});

test('executeCli returns remote help for search flow', async () => {
  const result = await executeCli(['search', 'flow', '--help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tiangong-lca search flow/u);
});

test('executeCli returns remote help for admin embedding-run', async () => {
  const result = await executeCli(['admin', 'embedding-run', '--help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /tiangong-lca admin embedding-run/u);
});

test('executeCli returns help for publish and validation namespaces', async () => {
  const publishHelp = await executeCli(['publish', '--help'], makeDeps());
  assert.equal(publishHelp.exitCode, 0);
  assert.match(publishHelp.stdout, /tiangong-lca publish run/u);

  const validationHelp = await executeCli(['validation', '--help'], makeDeps());
  assert.equal(validationHelp.exitCode, 0);
  assert.match(validationHelp.stdout, /tiangong-lca validation run/u);

  const qaHelp = await executeCli(['qa', '--help'], makeDeps());
  assert.equal(qaHelp.exitCode, 0);
  assert.match(qaHelp.stdout, /tiangong-lca qa <subcommand>/u);

  const flowHelp = await executeCli(['flow', '--help'], makeDeps());
  assert.equal(flowHelp.exitCode, 0);
  assert.match(flowHelp.stdout, /tiangong-lca flow <subcommand>/u);
  assert.match(flowHelp.stdout, /get/u);
  assert.match(flowHelp.stdout, /list/u);
  assert.match(flowHelp.stdout, /identity-preflight/u);
  assert.match(flowHelp.stdout, /build-plan/u);
  assert.match(flowHelp.stdout, /fetch-rows/u);
  assert.match(flowHelp.stdout, /materialize-decisions/u);
  assert.match(flowHelp.stdout, /remediate/u);
  assert.match(flowHelp.stdout, /publish-version/u);
  assert.match(flowHelp.stdout, /publish-reviewed-data/u);
  assert.match(flowHelp.stdout, /build-alias-map/u);
  assert.match(flowHelp.stdout, /regen-product/u);
  assert.match(flowHelp.stdout, /validate-processes/u);
});

test('executeCli returns help for publish and validation subcommands', async () => {
  const publishHelp = await executeCli(['publish', 'run', '--help'], makeDeps());
  assert.equal(publishHelp.exitCode, 0);
  assert.match(publishHelp.stdout, /--out-dir/u);
  assert.match(
    publishHelp.stdout,
    /Relative out_dir values from the request body or --out-dir resolve from the request file directory\./u,
  );

  const validationHelp = await executeCli(['validation', 'run', '--help'], makeDeps());
  assert.equal(validationHelp.exitCode, 0);
  assert.match(validationHelp.stdout, /--report-file/u);

  const reviewHelp = await executeCli(['qa', 'process', '--help'], makeDeps());
  assert.equal(reviewHelp.exitCode, 0);
  assert.ok(
    reviewHelp.stdout.includes(
      'tiangong-lca qa process (--rows-file <file> | --run-root <dir>) --out-dir <dir>',
    ),
  );
  assert.match(reviewHelp.stdout, /full process list reports with rows\[\] are also accepted/u);
  assert.match(reviewHelp.stdout, /--enable-llm/u);

  const reviewFlowHelp = await executeCli(['qa', 'flow', '--help'], makeDeps());
  assert.equal(reviewFlowHelp.exitCode, 0);
  assert.ok(
    reviewFlowHelp.stdout.includes(
      'tiangong-lca qa flow (--rows-file <file> | --flows-dir <dir> | --run-root <dir>) --out-dir <dir>',
    ),
  );
  assert.match(reviewFlowHelp.stdout, /--similarity-threshold/u);

  const reviewLifecyclemodelHelp = await executeCli(['qa', 'lifecyclemodel', '--help'], makeDeps());
  assert.equal(reviewLifecyclemodelHelp.exitCode, 0);
  assert.match(
    reviewLifecyclemodelHelp.stdout,
    /tiangong-lca qa lifecyclemodel \(--rows-file <file> \| --run-dir <dir>\) --out-dir <dir>/u,
  );
  assert.match(
    reviewLifecyclemodelHelp.stdout,
    /aggregates validate-build findings when reports\/lifecyclemodel-validate-build-report\.json is present/u,
  );

  const flowRemediateHelp = await executeCli(['flow', 'remediate', '--help'], makeDeps());
  assert.equal(flowRemediateHelp.exitCode, 0);
  assert.match(
    flowRemediateHelp.stdout,
    /tiangong-lca flow remediate --input-file <file> --out-dir <dir>/u,
  );
  assert.match(flowRemediateHelp.stdout, /ready_for_mcp/u);

  const flowPublishHelp = await executeCli(['flow', 'publish-version', '--help'], makeDeps());
  assert.equal(flowPublishHelp.exitCode, 0);
  assert.match(
    flowPublishHelp.stdout,
    /tiangong-lca flow publish-version --input-file <file> --out-dir <dir>/u,
  );
  assert.match(flowPublishHelp.stdout, /--commit/u);
  assert.match(flowPublishHelp.stdout, /TIANGONG_LCA_API_BASE_URL/u);

  const flowPublishReviewedHelp = await executeCli(
    ['flow', 'publish-reviewed-data', '--help'],
    makeDeps(),
  );
  assert.equal(flowPublishReviewedHelp.exitCode, 0);
  assert.match(
    flowPublishReviewedHelp.stdout,
    /tiangong-lca flow publish-reviewed-data --out-dir <dir> \[--flow-rows-file <file>\] \[--process-rows-file <file>\]/u,
  );
  assert.match(flowPublishReviewedHelp.stdout, /--flow-publish-policy/u);
  assert.match(flowPublishReviewedHelp.stdout, /--process-publish-policy/u);

  const flowGetHelp = await executeCli(['flow', 'get', '--help'], makeDeps());
  assert.equal(flowGetHelp.exitCode, 0);
  assert.match(flowGetHelp.stdout, /tiangong-lca flow get --id <flow-id>/u);
  assert.match(flowGetHelp.stdout, /--user-id/u);
  assert.match(flowGetHelp.stdout, /TIANGONG_LCA_OAUTH_CLIENT_ID/u);
  assert.doesNotMatch(flowGetHelp.stdout, /Planned command/u);

  const flowListHelp = await executeCli(['flow', 'list', '--help'], makeDeps());
  assert.equal(flowListHelp.exitCode, 0);
  assert.match(flowListHelp.stdout, /tiangong-lca flow list \[options\]/u);
  assert.match(flowListHelp.stdout, /--type-of-dataset/u);
  assert.match(flowListHelp.stdout, /--page-size/u);
  assert.doesNotMatch(flowListHelp.stdout, /Planned command/u);

  const flowIdentityPreflightHelp = await executeCli(
    ['flow', 'identity-preflight', '--help'],
    makeDeps(),
  );
  assert.equal(flowIdentityPreflightHelp.exitCode, 0);
  assert.match(
    flowIdentityPreflightHelp.stdout,
    /tiangong-lca flow identity-preflight --input <file>/u,
  );
  assert.match(flowIdentityPreflightHelp.stdout, /identity-candidates\.jsonl/u);
  assert.match(flowIdentityPreflightHelp.stdout, /identity-candidate-sources\.json/u);
  assert.doesNotMatch(flowIdentityPreflightHelp.stdout, /Planned command/u);

  const flowBuildPlanHelp = await executeCli(['flow', 'build-plan', '--help'], makeDeps());
  assert.equal(flowBuildPlanHelp.exitCode, 0);
  assert.match(flowBuildPlanHelp.stdout, /tiangong-lca flow build-plan <validate\|materialize>/u);
  assert.match(flowBuildPlanHelp.stdout, /build-plan-gate-report\.json/u);
  assert.doesNotMatch(flowBuildPlanHelp.stdout, /Planned command/u);

  const flowBuildPlanActionHelp = await executeCli(
    ['flow', 'build-plan', 'validate', '--help'],
    makeDeps(),
  );
  assert.equal(flowBuildPlanActionHelp.exitCode, 0);
  assert.match(flowBuildPlanActionHelp.stdout, /--report-only/u);

  const flowFetchRowsHelp = await executeCli(['flow', 'fetch-rows', '--help'], makeDeps());
  assert.equal(flowFetchRowsHelp.exitCode, 0);
  assert.match(flowFetchRowsHelp.stdout, /tiangong-lca flow fetch-rows --refs-file <file>/u);
  assert.match(flowFetchRowsHelp.stdout, /--no-latest-fallback/u);
  assert.match(flowFetchRowsHelp.stdout, /qa-input-rows\.jsonl/u);
  assert.doesNotMatch(flowFetchRowsHelp.stdout, /Planned command/u);

  const flowMaterializeDecisionsHelp = await executeCli(
    ['flow', 'materialize-decisions', '--help'],
    makeDeps(),
  );
  assert.equal(flowMaterializeDecisionsHelp.exitCode, 0);
  assert.match(
    flowMaterializeDecisionsHelp.stdout,
    /tiangong-lca flow materialize-decisions --decision-file <file>/u,
  );
  assert.match(flowMaterializeDecisionsHelp.stdout, /manual-semantic-merge-seed\.current\.json/u);
  assert.match(flowMaterializeDecisionsHelp.stdout, /blocked-clusters\.json/u);
  assert.doesNotMatch(flowMaterializeDecisionsHelp.stdout, /Planned command/u);

  const flowRegenHelp = await executeCli(['flow', 'regen-product', '--help'], makeDeps());
  assert.equal(flowRegenHelp.exitCode, 0);
  assert.match(
    flowRegenHelp.stdout,
    /tiangong-lca flow regen-product --processes-file <file> --scope-flow-file <file> --out-dir <dir>/u,
  );
  assert.match(flowRegenHelp.stdout, /--auto-patch-policy/u);
  assert.match(flowRegenHelp.stdout, /repair-apply\/ \(only with --apply\)/u);
  assert.doesNotMatch(flowRegenHelp.stdout, /Planned contract:/u);

  const flowValidateHelp = await executeCli(['flow', 'validate-processes', '--help'], makeDeps());
  assert.equal(flowValidateHelp.exitCode, 0);
  assert.match(
    flowValidateHelp.stdout,
    /tiangong-lca flow validate-processes --original-processes-file <file> --patched-processes-file <file> --scope-flow-file <file> --out-dir <dir>/u,
  );
  assert.match(flowValidateHelp.stdout, /--tidas-mode/u);
  assert.match(flowValidateHelp.stdout, /validation-failures\.jsonl/u);
});

test('executeCli returns group help for search and admin namespaces', async () => {
  const searchHelp = await executeCli(['search', '--help'], makeDeps());
  assert.equal(searchHelp.exitCode, 0);
  assert.match(searchHelp.stdout, /tiangong-lca search <flow\|process\|lifecyclemodel>/u);

  const adminHelp = await executeCli(['admin', '--help'], makeDeps());
  assert.equal(adminHelp.exitCode, 0);
  assert.match(adminHelp.stdout, /tiangong-lca admin embedding-run/u);
});

test('executeCli returns help for the lifecyclemodel namespace and implemented subcommands', async () => {
  const lifecyclemodelHelp = await executeCli(['lifecyclemodel'], makeDeps());
  assert.equal(lifecyclemodelHelp.exitCode, 0);
  assert.match(lifecyclemodelHelp.stdout, /tiangong-lca lifecyclemodel <subcommand>/u);
  assert.match(lifecyclemodelHelp.stdout, /auto-build/u);
  assert.match(lifecyclemodelHelp.stdout, /validate-build/u);
  assert.match(lifecyclemodelHelp.stdout, /publish-build/u);
  assert.match(lifecyclemodelHelp.stdout, /build-resulting-process/u);
  assert.match(lifecyclemodelHelp.stdout, /publish-resulting-process/u);
  assert.match(lifecyclemodelHelp.stdout, /orchestrate/u);

  const autoBuildHelp = await executeCli(['lifecyclemodel', 'auto-build', '--help'], makeDeps());
  assert.equal(autoBuildHelp.exitCode, 0);
  assert.match(autoBuildHelp.stdout, /tiangong-lca lifecyclemodel auto-build --input <file>/u);
  assert.match(autoBuildHelp.stdout, /request\.out_dir is required/u);
  assert.match(autoBuildHelp.stdout, /"local_runs": \["\/abs\/path\/to\/process-build-run"\]/u);
  assert.match(
    autoBuildHelp.stdout,
    /leaves follow-up validation and publish handoff to the companion validate-build and publish-build commands/u,
  );
  assert.doesNotMatch(autoBuildHelp.stdout, /Planned command/u);

  const buildHelp = await executeCli(
    ['lifecyclemodel', 'build-resulting-process', '--help'],
    makeDeps(),
  );
  assert.equal(buildHelp.exitCode, 0);
  assert.match(
    buildHelp.stdout,
    /tiangong-lca lifecyclemodel build-resulting-process --input <file>/u,
  );
  assert.match(buildHelp.stdout, /TIANGONG_LCA_API_BASE_URL/u);
  assert.match(buildHelp.stdout, /TIANGONG_LCA_OAUTH_CLIENT_ID/u);
  assert.doesNotMatch(buildHelp.stdout, /Planned command/u);

  const publishHelp = await executeCli(
    ['lifecyclemodel', 'publish-resulting-process', '--help'],
    makeDeps(),
  );
  assert.equal(publishHelp.exitCode, 0);
  assert.match(
    publishHelp.stdout,
    /tiangong-lca lifecyclemodel publish-resulting-process --run-dir <dir>/u,
  );
  assert.match(publishHelp.stdout, /--publish-processes/u);
  assert.doesNotMatch(publishHelp.stdout, /Planned command/u);

  const validateBuildHelp = await executeCli(
    ['lifecyclemodel', 'validate-build', '--help'],
    makeDeps(),
  );
  assert.equal(validateBuildHelp.exitCode, 0);
  assert.match(
    validateBuildHelp.stdout,
    /tiangong-lca lifecyclemodel validate-build --run-dir <dir>/u,
  );
  assert.match(validateBuildHelp.stdout, /--engine <mode>/u);
  assert.doesNotMatch(validateBuildHelp.stdout, /Planned command/u);

  const lifecyclemodelPublishBuildHelp = await executeCli(
    ['lifecyclemodel', 'publish-build', '--help'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelPublishBuildHelp.exitCode, 0);
  assert.match(
    lifecyclemodelPublishBuildHelp.stdout,
    /tiangong-lca lifecyclemodel publish-build --run-dir <dir>/u,
  );
  assert.match(lifecyclemodelPublishBuildHelp.stdout, /publish-bundle\.json/u);
  assert.doesNotMatch(lifecyclemodelPublishBuildHelp.stdout, /Planned command/u);

  const lifecyclemodelOrchestrateHelp = await executeCli(
    ['lifecyclemodel', 'orchestrate', '--help'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelOrchestrateHelp.exitCode, 0);
  assert.match(
    lifecyclemodelOrchestrateHelp.stdout,
    /tiangong-lca lifecyclemodel orchestrate <plan\|execute\|publish>/u,
  );
  assert.match(lifecyclemodelOrchestrateHelp.stdout, /--allow-process-build/u);
  assert.match(lifecyclemodelOrchestrateHelp.stdout, /--publish-resulting-process-relations/u);
  assert.doesNotMatch(lifecyclemodelOrchestrateHelp.stdout, /Planned command/u);
});

test('executeCli exposes dataset and lifecyclemodel friction-fix commands', async () => {
  const datasetHelp = await executeCli(['dataset'], makeDeps());
  assert.equal(datasetHelp.exitCode, 0);
  assert.match(datasetHelp.stdout, /tiangong-lca dataset <subcommand>/u);
  assert.match(datasetHelp.stdout, /validate/u);
  assert.match(datasetHelp.stdout, /references rewrite/u);
  assert.match(datasetHelp.stdout, /maintenance clear-account/u);
  assert.match(datasetHelp.stdout, /maintenance plan\s+Build an immutable/u);
  assert.match(datasetHelp.stdout, /maintenance apply\s+Execute an explicitly approved/u);
  assert.match(datasetHelp.stdout, /maintenance verify\s+Read back affected rows/u);

  const datasetValidateHelp = await executeCli(['dataset', 'validate', '--help'], makeDeps());
  assert.equal(datasetValidateHelp.exitCode, 0);
  assert.match(datasetValidateHelp.stdout, /tiangong-lca dataset validate --input <file>/u);
  assert.doesNotMatch(datasetValidateHelp.stdout, /Planned command/u);

  const datasetReferencesHelp = await executeCli(
    ['dataset', 'references', 'rewrite', '--help'],
    makeDeps(),
  );
  assert.equal(datasetReferencesHelp.exitCode, 0);
  assert.match(datasetReferencesHelp.stdout, /tiangong-lca dataset references rewrite/u);
  assert.match(datasetReferencesHelp.stdout, /--commit/u);
  assert.doesNotMatch(datasetReferencesHelp.stdout, /Planned command/u);

  const datasetEvidenceHelp = await executeCli(
    ['dataset', 'evidence-search', 'plan', '--help'],
    makeDeps(),
  );
  assert.equal(datasetEvidenceHelp.exitCode, 0);
  assert.match(datasetEvidenceHelp.stdout, /tiangong-lca dataset evidence-search <plan\|run>/u);
  assert.match(datasetEvidenceHelp.stdout, /--provider-url/u);
  assert.doesNotMatch(datasetEvidenceHelp.stdout, /Planned command/u);

  const datasetMaintenanceHelp = await executeCli(['dataset', 'maintenance', '--help'], makeDeps());
  assert.equal(datasetMaintenanceHelp.exitCode, 0);
  assert.match(
    datasetMaintenanceHelp.stdout,
    /current-user RLS and platform dataset command paths/u,
  );
  assert.match(datasetMaintenanceHelp.stdout, /apply is commit-only/u);
  assert.match(datasetMaintenanceHelp.stdout, /maintenance-plan\.json/u);

  const datasetMaintenanceClearHelp = await executeCli(
    ['dataset', 'maintenance', 'clear-account', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenanceClearHelp.exitCode, 0);
  assert.match(
    datasetMaintenanceClearHelp.stdout,
    /tiangong-lca dataset maintenance clear-account/u,
  );
  assert.match(datasetMaintenanceClearHelp.stdout, /--confirm <email>/u);
  assert.match(datasetMaintenanceClearHelp.stdout, /1-5000.*exact counts/u);
  assert.doesNotMatch(datasetMaintenanceClearHelp.stdout, /Planned command/u);

  const datasetMaintenancePlanHelp = await executeCli(
    ['dataset', 'maintenance', 'plan', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenancePlanHelp.exitCode, 0);
  assert.match(datasetMaintenancePlanHelp.stdout, /--operation <operation>/u);
  assert.match(datasetMaintenancePlanHelp.stdout, /rebuild-derivatives/u);
  assert.match(datasetMaintenancePlanHelp.stdout, /1-5000.*exact counts/u);

  const datasetMaintenanceApplyHelp = await executeCli(
    ['dataset', 'maintenance', 'apply', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenanceApplyHelp.exitCode, 0);
  assert.match(datasetMaintenanceApplyHelp.stdout, /--approve-plan <sha256>/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /--global-inbound-proof <file>/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /--approve-global-inbound-proof <sha256>/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /Commit-only/u);
  assert.match(datasetMaintenanceApplyHelp.stdout, /guarded admission is queued/u);

  const datasetMaintenanceVerifyHelp = await executeCli(
    ['dataset', 'maintenance', 'verify', '--help'],
    makeDeps(),
  );
  assert.equal(datasetMaintenanceVerifyHelp.exitCode, 0);
  assert.match(datasetMaintenanceVerifyHelp.stdout, /readback-verify-report\.json/u);
  assert.match(datasetMaintenanceVerifyHelp.stdout, /1-5000.*exact counts/u);
  assert.match(datasetMaintenanceVerifyHelp.stdout, /pending, passed, or failed/u);

  let observedClearAccountOptions: unknown = null;
  const emptyClearCompleteness: DatasetMaintenanceSnapshotCompleteness<
    'lifecyclemodels' | 'processes' | 'flows' | 'sources' | 'contacts'
  > = {
    status: 'complete',
    complete: true,
    strategy: 'postgrest_exact_count_multi_request',
    requested_page_size: 1000,
    page_count: 5,
    row_count: 0,
    entity_counts: {
      lifecyclemodels: 0,
      processes: 0,
      flows: 0,
      sources: 0,
      contacts: 0,
    },
    tables: [],
  };
  const clearAccountDeps = makeDeps();
  const datasetMaintenanceClear = await executeCli(
    [
      'dataset',
      'maintenance',
      'clear-account',
      '--state-code',
      '0',
      '--out-dir',
      './account-clear',
      '--commit',
      '--confirm',
      'user@example.com',
      '--json',
    ],
    {
      ...clearAccountDeps,
      runDatasetMaintenanceClearAccountImpl: async (options) => {
        observedClearAccountOptions = options;
        return {
          schema_version: 1,
          generated_at_utc: '2026-06-04T00:00:00.000Z',
          status: 'cleared_account',
          mode: 'commit',
          account: {
            email: 'user@example.com',
            user_id: 'user-1',
            session_source: 'memory',
          },
          filters: {
            tables: ['lifecyclemodels', 'processes', 'flows', 'sources', 'contacts'],
            state_codes: [0],
            page_size: 1000,
          },
          snapshot_completeness: emptyClearCompleteness,
          readback_completeness: emptyClearCompleteness,
          readback_error: null,
          summary: {
            total_candidates: 0,
            total_deleted: 0,
            total_remaining: 0,
            total_failures: 0,
            by_table: {
              lifecyclemodels: {
                candidates: 0,
                deleted: 0,
                remaining: 0,
                status: 'skipped_empty',
              },
              processes: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
              flows: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
              sources: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
              contacts: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
            },
          },
          tables: [],
          artifacts: {
            rls_visible_snapshot: './account-clear/rls-visible-snapshot.json',
            dry_run_report: './account-clear/dry-run-report.json',
            approval_record: './account-clear/approval-record.json',
            commit_report: './account-clear/commit-report.json',
            readback_verify_report: './account-clear/readback-verify-report.json',
          },
        };
      },
    },
  );
  assert.equal(datasetMaintenanceClear.exitCode, 0);
  assert.deepEqual(JSON.parse(datasetMaintenanceClear.stdout), {
    schema_version: 1,
    generated_at_utc: '2026-06-04T00:00:00.000Z',
    status: 'cleared_account',
    mode: 'commit',
    account: {
      email: 'user@example.com',
      user_id: 'user-1',
      session_source: 'memory',
    },
    filters: {
      tables: ['lifecyclemodels', 'processes', 'flows', 'sources', 'contacts'],
      state_codes: [0],
      page_size: 1000,
    },
    snapshot_completeness: emptyClearCompleteness,
    readback_completeness: emptyClearCompleteness,
    readback_error: null,
    summary: {
      total_candidates: 0,
      total_deleted: 0,
      total_remaining: 0,
      total_failures: 0,
      by_table: {
        lifecyclemodels: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        processes: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        flows: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        sources: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
        contacts: { candidates: 0, deleted: 0, remaining: 0, status: 'skipped_empty' },
      },
    },
    tables: [],
    artifacts: {
      rls_visible_snapshot: './account-clear/rls-visible-snapshot.json',
      dry_run_report: './account-clear/dry-run-report.json',
      approval_record: './account-clear/approval-record.json',
      commit_report: './account-clear/commit-report.json',
      readback_verify_report: './account-clear/readback-verify-report.json',
    },
  });
  assert.deepEqual(observedClearAccountOptions, {
    outDir: './account-clear',
    stateCodes: [0],
    pageSize: undefined,
    timeoutMs: undefined,
    commit: true,
    confirm: 'user@example.com',
    env: clearAccountDeps.env,
    fetchImpl: clearAccountDeps.fetchImpl,
  });

  const lifecyclemodelSaveDraftHelp = await executeCli(
    ['lifecyclemodel', 'save-draft', '--help'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelSaveDraftHelp.exitCode, 0);
  assert.match(
    lifecyclemodelSaveDraftHelp.stdout,
    /tiangong-lca lifecyclemodel save-draft --input <file>/u,
  );
  assert.doesNotMatch(lifecyclemodelSaveDraftHelp.stdout, /Planned command/u);

  const lifecyclemodelGraphHelp = await executeCli(
    ['lifecyclemodel', 'graph', '--help'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelGraphHelp.exitCode, 0);
  assert.match(lifecyclemodelGraphHelp.stdout, /tiangong-lca lifecyclemodel graph --input <file>/u);
  assert.match(lifecyclemodelGraphHelp.stdout, /--check-connections/u);
  assert.doesNotMatch(lifecyclemodelGraphHelp.stdout, /Planned command/u);
});

test('executeCli dispatches dataset maintenance plan, apply, and verify', async () => {
  const deps = makeDeps();
  let observedPlanOptions: unknown = null;
  const planResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      './maintenance-scope.json',
      '--operation',
      'merge-support-aliases',
      '--out-dir',
      './maintenance-run',
      '--page-size',
      '250',
      '--timeout-ms',
      '12000',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenancePlanImpl: async (options) => {
        observedPlanOptions = options;
        return { status: 'ready', marker: 'plan' } as never;
      },
    },
  );
  assert.equal(planResult.exitCode, 0);
  assert.deepEqual(JSON.parse(planResult.stdout), { status: 'ready', marker: 'plan' });
  assert.deepEqual(observedPlanOptions, {
    scopePath: './maintenance-scope.json',
    operation: 'merge-support-aliases',
    outDir: './maintenance-run',
    pageSize: 250,
    timeoutMs: 12000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const derivativePlanResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'plan',
      '--scope',
      './derivative-scope.json',
      '--operation',
      'rebuild-derivatives',
      '--out-dir',
      './derivative-run',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenancePlanImpl: async (options) =>
        ({
          status: 'ready',
          operation: options.operation,
        }) as never,
    },
  );
  assert.equal(derivativePlanResult.exitCode, 0);
  assert.deepEqual(JSON.parse(derivativePlanResult.stdout), {
    status: 'ready',
    operation: 'rebuild-derivatives',
  });

  const approvePlan = 'a'.repeat(64);
  const approveGlobalInboundProof = 'b'.repeat(64);
  let observedApplyOptions: unknown = null;
  const applyResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--commit',
      '--approve-plan',
      approvePlan,
      '--confirm',
      'user@example.com',
      '--timeout-ms',
      '15000',
      '--max-parallel',
      '8',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
      '--approve-global-inbound-proof',
      approveGlobalInboundProof,
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenanceApplyImpl: async (options) => {
        observedApplyOptions = options;
        return { status: 'completed', marker: 'apply' } as never;
      },
    },
  );
  assert.equal(applyResult.exitCode, 0);
  assert.deepEqual(JSON.parse(applyResult.stdout), { status: 'completed', marker: 'apply' });
  assert.deepEqual(observedApplyOptions, {
    planPath: './maintenance-run/maintenance-plan.json',
    commit: true,
    approvePlan,
    confirm: 'user@example.com',
    timeoutMs: 15000,
    maxParallel: 8,
    globalInboundProofPath: '/tmp/global-inbound-proof.json',
    approveGlobalInboundProof,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const unknownApply = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--commit',
      '--approve-plan',
      approvePlan,
      '--confirm',
      'user@example.com',
    ],
    {
      ...deps,
      runDatasetMaintenanceApplyImpl: async () => ({ status: 'completed_with_unknowns' }) as never,
    },
  );
  assert.equal(unknownApply.exitCode, 1);

  const incompleteGlobalProof = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--commit',
      '--approve-plan',
      approvePlan,
      '--confirm',
      'user@example.com',
      '--max-parallel',
      '8',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
    ],
    deps,
  );
  assert.equal(incompleteGlobalProof.exitCode, 2);
  assert.match(incompleteGlobalProof.stderr, /must be provided together/u);

  const globalProofWithoutParallel = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
      '--approve-global-inbound-proof',
      approveGlobalInboundProof,
    ],
    deps,
  );
  assert.equal(globalProofWithoutParallel.exitCode, 2);
  assert.match(globalProofWithoutParallel.stderr, /require --max-parallel/u);

  const malformedGlobalProofApproval = await executeCli(
    [
      'dataset',
      'maintenance',
      'apply',
      '--max-parallel',
      '8',
      '--global-inbound-proof',
      '/tmp/global-inbound-proof.json',
      '--approve-global-inbound-proof',
      'BAD',
    ],
    deps,
  );
  assert.equal(malformedGlobalProofApproval.exitCode, 2);
  assert.match(malformedGlobalProofApproval.stderr, /lowercase SHA-256/u);

  let observedVerifyOptions: unknown = null;
  const verifyResult = await executeCli(
    [
      'dataset',
      'maintenance',
      'verify',
      '--plan',
      './maintenance-run/maintenance-plan.json',
      '--out-dir',
      './maintenance-run/verify',
      '--page-size',
      '100',
      '--timeout-ms',
      '9000',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenanceVerifyImpl: async (options) => {
        observedVerifyOptions = options;
        return { status: 'passed', marker: 'verify' } as never;
      },
    },
  );
  assert.equal(verifyResult.exitCode, 0);
  assert.deepEqual(JSON.parse(verifyResult.stdout), { status: 'passed', marker: 'verify' });
  assert.deepEqual(observedVerifyOptions, {
    planPath: './maintenance-run/maintenance-plan.json',
    outDir: './maintenance-run/verify',
    pageSize: 100,
    timeoutMs: 9000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  const pendingVerify = await executeCli(
    ['dataset', 'maintenance', 'verify', '--plan', './derivative-run/maintenance-plan.json'],
    {
      ...deps,
      runDatasetMaintenanceVerifyImpl: async () => ({ status: 'pending' }) as never,
    },
  );
  assert.equal(pendingVerify.exitCode, 1);
});

test('executeCli dispatches protected maintenance without a retry or dev fallback', async () => {
  const deps = makeDeps();
  const help = await executeCli(['dataset', 'maintenance', 'run-protected', '--help'], deps);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /at most one admission POST/u);
  assert.match(help.stdout, /never retries admission or falls back to dev/u);

  let observed: unknown = null;
  const result = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      './maintenance-plan.json',
      '--freeze',
      './freeze.json',
      '--approval',
      './approval.json',
      '--out-dir',
      './protected-run',
      '--status-only',
      '--wait-seconds',
      '30',
      '--poll-ms',
      '500',
      '--page-size',
      '250',
      '--timeout-ms',
      '12000',
      '--json',
    ],
    {
      ...deps,
      runDatasetMaintenanceProtectedImpl: async (options) => {
        observed = options;
        return { status: 'passed', marker: 'protected' } as never;
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'passed', marker: 'protected' });
  assert.deepEqual(observed, {
    planPath: './maintenance-plan.json',
    freezePath: './freeze.json',
    approvalPath: './approval.json',
    outDir: './protected-run',
    commit: false,
    statusOnly: true,
    approveExecution: undefined,
    confirm: undefined,
    waitSeconds: 30,
    pollMs: 500,
    pageSize: 250,
    timeoutMs: 12000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  for (const status of ['pending', 'failed', 'indeterminate'] as const) {
    const nonTerminal = await executeCli(
      [
        'dataset',
        'maintenance',
        'run-protected',
        '--plan',
        'plan.json',
        '--freeze',
        'freeze.json',
        '--approval',
        'approval.json',
        '--out-dir',
        'protected-run',
        '--status-only',
      ],
      {
        ...deps,
        runDatasetMaintenanceProtectedImpl: async () => ({ status }) as never,
      },
    );
    assert.equal(nonTerminal.exitCode, 1, status);
  }

  const conflict = await executeCli(
    [
      'dataset',
      'maintenance',
      'run-protected',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--out-dir',
      'protected-run',
      '--commit',
      '--status-only',
    ],
    deps,
  );
  assert.equal(conflict.exitCode, 2);

  const requiredCases = [
    [],
    ['--plan', 'plan.json'],
    ['--plan', 'plan.json', '--freeze', 'freeze.json'],
    ['--plan', 'plan.json', '--freeze', 'freeze.json', '--approval', 'approval.json'],
    [
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--out-dir',
      'protected-run',
    ],
  ];
  for (const args of requiredCases) {
    const missing = await executeCli(['dataset', 'maintenance', 'run-protected', ...args], deps);
    assert.equal(missing.exitCode, 2, args.join(' '));
  }

  const commitBase = [
    'dataset',
    'maintenance',
    'run-protected',
    '--plan',
    'plan.json',
    '--freeze',
    'freeze.json',
    '--approval',
    'approval.json',
    '--out-dir',
    'protected-run',
    '--commit',
  ];
  assert.equal((await executeCli(commitBase, deps)).exitCode, 2);
  assert.equal(
    (await executeCli([...commitBase, '--approve-execution', 'a'.repeat(64)], deps)).exitCode,
    2,
  );
  const committed = await executeCli(
    [...commitBase, '--approve-execution', 'a'.repeat(64), '--confirm', 'bafudata@126.com'],
    {
      ...deps,
      runDatasetMaintenanceProtectedImpl: async () => ({ status: 'passed' }) as never,
    },
  );
  assert.equal(committed.exitCode, 0);

  for (const args of [
    ['--unknown'],
    ['--wait-seconds', '-1'],
    ['--wait-seconds', 'not-a-number'],
  ]) {
    const invalid = await executeCli(
      [
        'dataset',
        'maintenance',
        'run-protected',
        '--plan',
        'plan.json',
        '--freeze',
        'freeze.json',
        '--approval',
        'approval.json',
        '--out-dir',
        'protected-run',
        '--status-only',
        ...args,
      ],
      deps,
    );
    assert.equal(invalid.exitCode, 2, args.join(' '));
  }
});

test('executeCli separates production read-only freeze from offline approval sealing', async () => {
  const deps = makeDeps();
  const freezeHelp = await executeCli(
    ['dataset', 'maintenance', 'freeze-protected', '--help'],
    deps,
  );
  assert.equal(freezeHelp.exitCode, 0);
  assert.match(freezeHelp.stdout, /only authenticated table reads/u);
  assert.match(freezeHelp.stdout, /never emits an approval artifact/u);

  const sealHelp = await executeCli(
    ['dataset', 'maintenance', 'seal-protected-approval', '--help'],
    deps,
  );
  assert.equal(sealHelp.exitCode, 0);
  assert.match(sealHelp.stdout, /byte-for-byte without trimming/u);
  assert.match(sealHelp.stdout, /zero authentication, network/u);

  let observedFreeze: unknown = null;
  const freeze = await executeCli(
    [
      'dataset',
      'maintenance',
      'freeze-protected',
      '--plan',
      './maintenance-plan.json',
      '--toolchain-evidence',
      './toolchain.json',
      '--expected-project-ref',
      'production-ref',
      '--confirm',
      'bafudata@126.com',
      '--out-dir',
      './protected-freeze',
      '--page-size',
      '250',
      '--timeout-ms',
      '12000',
      '--json',
    ],
    {
      ...deps,
      freezeDatasetMaintenanceProtectedImpl: async (options) => {
        observedFreeze = options;
        return { status: 'ready_for_human_approval', marker: 'freeze' } as never;
      },
    },
  );
  assert.equal(freeze.exitCode, 0);
  assert.deepEqual(JSON.parse(freeze.stdout), {
    status: 'ready_for_human_approval',
    marker: 'freeze',
  });
  assert.deepEqual(observedFreeze, {
    planPath: './maintenance-plan.json',
    toolchainEvidencePath: './toolchain.json',
    outDir: './protected-freeze',
    expectedProjectRef: 'production-ref',
    confirm: 'bafudata@126.com',
    cliVersion: '0.1.16',
    pageSize: 250,
    timeoutMs: 12000,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const freezeRequiredCases = [
    [],
    ['--plan', 'plan.json'],
    ['--plan', 'plan.json', '--toolchain-evidence', 'toolchain.json'],
    [
      '--plan',
      'plan.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--expected-project-ref',
      'production-ref',
    ],
    [
      '--plan',
      'plan.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--expected-project-ref',
      'production-ref',
      '--confirm',
      'bafudata@126.com',
    ],
  ];
  for (const args of freezeRequiredCases) {
    const result = await executeCli(['dataset', 'maintenance', 'freeze-protected', ...args], deps);
    assert.equal(result.exitCode, 2, args.join(' '));
  }
  for (const args of [['--unknown'], ['--page-size', '0']]) {
    const result = await executeCli(
      [
        'dataset',
        'maintenance',
        'freeze-protected',
        '--plan',
        'plan.json',
        '--toolchain-evidence',
        'toolchain.json',
        '--expected-project-ref',
        'production-ref',
        '--confirm',
        'bafudata@126.com',
        '--out-dir',
        'out',
        ...args,
      ],
      deps,
    );
    assert.equal(result.exitCode, 2, args.join(' '));
  }

  const hash = 'a'.repeat(64);
  let observedSeal: unknown = null;
  const seal = await executeCli(
    [
      'dataset',
      'maintenance',
      'seal-protected-approval',
      '--freeze',
      './freeze.json',
      '--approval-request',
      './request.json',
      '--human-approval',
      './human.txt',
      '--approve-freeze-file',
      hash,
      '--approve-request',
      hash,
      '--approve-text',
      hash,
      '--confirm',
      'bafudata@126.com',
      '--approved-at',
      '2026-07-15T12:00:00.000Z',
      '--out-dir',
      './approval',
      '--json',
    ],
    {
      ...deps,
      sealDatasetMaintenanceProtectedApprovalImpl: async (options) => {
        observedSeal = options;
        return { status: 'sealed', marker: 'seal' } as never;
      },
    },
  );
  assert.equal(seal.exitCode, 0);
  assert.deepEqual(JSON.parse(seal.stdout), { status: 'sealed', marker: 'seal' });
  assert.deepEqual(observedSeal, {
    freezePath: './freeze.json',
    approvalRequestPath: './request.json',
    humanApprovalPath: './human.txt',
    outDir: './approval',
    approveFreezeFile: hash,
    approveRequest: hash,
    approveText: hash,
    confirm: 'bafudata@126.com',
    approvedAtUtc: '2026-07-15T12:00:00.000Z',
  });

  const sealFlags = [
    '--freeze',
    'freeze.json',
    '--approval-request',
    'request.json',
    '--human-approval',
    'human.txt',
    '--approve-freeze-file',
    hash,
    '--approve-request',
    hash,
    '--approve-text',
    hash,
    '--confirm',
    'bafudata@126.com',
    '--approved-at',
    '2026-07-15T12:00:00.000Z',
    '--out-dir',
    'approval',
  ];
  for (let end = 0; end < sealFlags.length; end += 2) {
    const result = await executeCli(
      ['dataset', 'maintenance', 'seal-protected-approval', ...sealFlags.slice(0, end)],
      deps,
    );
    assert.equal(result.exitCode, 2, String(end));
  }
  const invalidSeal = await executeCli(
    ['dataset', 'maintenance', 'seal-protected-approval', ...sealFlags, '--unknown'],
    deps,
  );
  assert.equal(invalidSeal.exitCode, 2);
});

test('executeCli exposes the dedicated flow-identity capture/plan/freeze/seal/run/verify workflow', async () => {
  const deps = makeDeps();
  const help = await executeCli(['dataset', 'maintenance', 'flow-identity', '--help'], deps);
  assert.equal(help.exitCode, 0);
  assert.match(
    help.stdout,
    /capture\|plan\|freeze\|seal-approval\|run\|freeze-recovery\|seal-recovery-approval\|run-recovery\|verify/u,
  );
  assert.match(help.stdout, /never retry a process/u);
  assert.match(help.stdout, /separate plan, new freeze, and new exact human approval/u);

  let observed: unknown = null;
  const capture = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'capture',
      '--policy',
      'policy.json',
      '--review-ledger',
      'review.json',
      '--prerequisites',
      'prerequisites.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--request-id',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '--operation-id',
      'flow-identity-v2-capture',
      '--expected-project-ref',
      'prod',
      '--confirm',
      'owner@example.com',
      '--sdk-version',
      '0.1.45',
      '--out-dir',
      'capture-out',
      '--page-size',
      '1000',
      '--read-concurrency',
      '5',
      '--json',
    ],
    {
      ...deps,
      captureFlowIdentityImpl: async (options) => {
        observed = options;
        return { status: 'captured' } as never;
      },
    },
  );
  assert.equal(capture.exitCode, 0);
  assert.deepEqual(observed, {
    policyPath: 'policy.json',
    reviewLedgerPath: 'review.json',
    prerequisitesPath: 'prerequisites.json',
    toolchainEvidencePath: 'toolchain.json',
    requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    operationId: 'flow-identity-v2-capture',
    expectedProjectRef: 'prod',
    confirm: 'owner@example.com',
    cliVersion: '0.1.16',
    sdkVersion: '0.1.45',
    outDir: 'capture-out',
    pageSize: 1000,
    readConcurrency: 5,
    timeoutMs: undefined,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const plan = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'plan',
      '--policy',
      'policy.json',
      '--review-ledger',
      'review.json',
      '--live-capture',
      'capture.json',
      '--out-dir',
      'plan-out',
      '--json',
    ],
    {
      ...deps,
      runFlowIdentityPlanFromFilesImpl: (options) => {
        observed = options;
        return { status: 'ready', plan_sha256: 'a'.repeat(64) } as never;
      },
    },
  );
  assert.equal(plan.exitCode, 0);
  assert.deepEqual(observed, {
    policyPath: 'policy.json',
    reviewLedgerPath: 'review.json',
    liveCapturePath: 'capture.json',
    outDir: 'plan-out',
  });

  const freeze = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'freeze',
      '--plan',
      'plan.json',
      '--toolchain-evidence',
      'toolchain.json',
      '--approved-at',
      '2026-07-16T05:00:00Z',
      '--expected-project-ref',
      'prod',
      '--confirm',
      'owner@example.com',
      '--out-dir',
      'freeze-out',
      '--json',
    ],
    {
      ...deps,
      freezeFlowIdentityImpl: (options) => {
        observed = options;
        return { status: 'frozen' } as never;
      },
    },
  );
  assert.equal(freeze.exitCode, 0);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    toolchainEvidencePath: 'toolchain.json',
    approvedAtUtc: '2026-07-16T05:00:00Z',
    expectedProjectRef: 'prod',
    confirm: 'owner@example.com',
    cliVersion: '0.1.16',
    outDir: 'freeze-out',
  });

  const hash = 'a'.repeat(64);
  const seal = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'seal-approval',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval-request',
      'request.json',
      '--human-approval',
      'human.txt',
      '--approve-freeze-file',
      hash,
      '--approve-request',
      hash,
      '--approve-text',
      hash,
      '--confirm',
      'owner@example.com',
      '--approved-at',
      '2026-07-16T05:00:00Z',
      '--out-dir',
      'approval-out',
      '--json',
    ],
    {
      ...deps,
      sealFlowIdentityApprovalImpl: (options) => {
        observed = options;
        return { status: 'sealed' } as never;
      },
    },
  );
  assert.equal(seal.exitCode, 0);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalRequestPath: 'request.json',
    humanApprovalPath: 'human.txt',
    approveFreezeFile: hash,
    approveRequest: hash,
    approveText: hash,
    confirm: 'owner@example.com',
    approvedAtUtc: '2026-07-16T05:00:00Z',
    outDir: 'approval-out',
  });

  const run = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'run',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--out-dir',
      'run-out',
      '--status-only',
      '--wait-seconds',
      '0',
      '--json',
    ],
    {
      ...deps,
      runFlowIdentityImpl: async (options) => {
        observed = options;
        return { status: 'pending' } as never;
      },
    },
  );
  assert.equal(run.exitCode, 1);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    outDir: 'run-out',
    commit: false,
    statusOnly: true,
    approveExecution: undefined,
    confirm: undefined,
    waitSeconds: 0,
    pollMs: undefined,
    timeoutMs: undefined,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });

  const verify = await executeCli(
    [
      'dataset',
      'maintenance',
      'flow-identity',
      'verify',
      '--plan',
      'plan.json',
      '--freeze',
      'freeze.json',
      '--approval',
      'approval.json',
      '--run-dir',
      'run-out',
      '--out-dir',
      'verify-out',
      '--page-size',
      '250',
      '--json',
    ],
    {
      ...deps,
      verifyFlowIdentityImpl: async (options) => {
        observed = options;
        return { status: 'passed' } as never;
      },
    },
  );
  assert.equal(verify.exitCode, 0);
  assert.deepEqual(observed, {
    planPath: 'plan.json',
    freezePath: 'freeze.json',
    approvalPath: 'approval.json',
    runDir: 'run-out',
    outDir: 'verify-out',
    pageSize: 250,
    timeoutMs: undefined,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
});

test('executeCli dispatches dataset and lifecyclemodel friction-fix commands', async () => {
  const datasetValidate = await executeCli(
    [
      'dataset',
      'validate',
      '--json',
      '--input',
      'rows.jsonl',
      '--type',
      'process',
      '--out-dir',
      'validate-out',
    ],
    {
      ...makeDeps(),
      runDatasetValidateImpl: async (options) => {
        assert.equal(options.inputPath, 'rows.jsonl');
        assert.equal(options.type, 'process');
        assert.equal(options.outDir, 'validate-out');
        return {
          generated_at_utc: '2026-05-05T00:00:00.000Z',
          input_path: 'rows.jsonl',
          requested_type: 'auto',
          status: 'completed',
          counts: {
            total: 1,
            valid: 1,
            invalid: 0,
            by_type: {
              flow: 0,
              process: 1,
              lifecyclemodel: 0,
              source: 0,
              contact: 0,
              flowproperty: 0,
              unitgroup: 0,
            },
          },
          files: { report: null, valid_rows: null, invalid_rows: null },
          rows: [],
        };
      },
    },
  );
  assert.equal(datasetValidate.exitCode, 0);

  const datasetValidateFailure = await executeCli(
    ['dataset', 'validate', '--json', '--input', 'rows.jsonl'],
    {
      ...makeDeps(),
      runDatasetValidateImpl: async () => ({
        generated_at_utc: '2026-05-05T00:00:00.000Z',
        input_path: 'rows.jsonl',
        requested_type: 'auto',
        status: 'completed_with_failures',
        counts: {
          total: 1,
          valid: 0,
          invalid: 1,
          by_type: {
            flow: 0,
            process: 1,
            lifecyclemodel: 0,
            source: 0,
            contact: 0,
            flowproperty: 0,
            unitgroup: 0,
          },
        },
        files: { report: null, valid_rows: null, invalid_rows: null },
        rows: [],
      }),
    },
  );
  assert.equal(datasetValidateFailure.exitCode, 1);

  const datasetValidateParseError = await executeCli(['dataset', 'validate', '--wat'], makeDeps());
  assert.equal(datasetValidateParseError.exitCode, 2);
  assert.match(datasetValidateParseError.stderr, /Unknown option/u);

  const datasetRewrite = await executeCli(
    [
      'dataset',
      'references',
      'rewrite',
      '--json',
      '--input',
      'rows.jsonl',
      '--from',
      'flow:old@01.00.000',
      '--to',
      'flow:new@01.01.000',
      '--type',
      'process',
      '--types',
      'lifecyclemodel',
      '--scope',
      'current',
      '--out-dir',
      'rewrite-out',
    ],
    {
      ...makeDeps(),
      runDatasetReferencesRewriteImpl: async (options) => {
        assert.equal(options.inputPath, 'rows.jsonl');
        assert.equal(options.from, 'flow:old@01.00.000');
        assert.equal(options.to, 'flow:new@01.01.000');
        assert.deepEqual(options.types, ['process', 'lifecyclemodel']);
        assert.equal(options.scope, 'current');
        assert.equal(options.outDir, 'rewrite-out');
        assert.equal(options.commit, false);
        return {
          generated_at_utc: '2026-05-05T00:00:00.000Z',
          input_path: 'rows.jsonl',
          out_dir: 'rewrite-out',
          mode: 'dry_run',
          status: 'completed',
          from: { kind: 'flow', id: 'old', version: '01.00.000' },
          to: { kind: 'flow', id: 'new', version: '01.01.000' },
          filters: { types: ['process'], scope: null },
          counts: {
            input_rows: 1,
            patched_rows: 1,
            changes: 1,
            process_rows: 1,
            lifecyclemodel_rows: 0,
          },
          files: { patched_rows: '', rewrite_plan: '', summary: '' },
          changes: [],
          commit_reports: { processes: null, lifecyclemodels: null },
        };
      },
    },
  );
  assert.equal(datasetRewrite.exitCode, 0);

  const datasetRewriteFailure = await executeCli(
    [
      'dataset',
      'references',
      'rewrite',
      '--json',
      '--input',
      'rows.jsonl',
      '--from',
      'flow:old',
      '--to',
      'flow:new',
      '--out-dir',
      'rewrite-out',
    ],
    {
      ...makeDeps(),
      runDatasetReferencesRewriteImpl: async () => ({
        generated_at_utc: '2026-05-05T00:00:00.000Z',
        input_path: 'rows.jsonl',
        out_dir: 'rewrite-out',
        mode: 'commit',
        status: 'completed_with_failures',
        from: { kind: 'flow', id: 'old', version: null },
        to: { kind: 'flow', id: 'new', version: null },
        filters: { types: ['process', 'lifecyclemodel'], scope: null },
        counts: {
          input_rows: 1,
          patched_rows: 1,
          changes: 1,
          process_rows: 1,
          lifecyclemodel_rows: 0,
        },
        files: { patched_rows: '', rewrite_plan: '', summary: '' },
        changes: [],
        commit_reports: { processes: null, lifecyclemodels: null },
      }),
    },
  );
  assert.equal(datasetRewriteFailure.exitCode, 1);

  const datasetReferencesRootHelp = await executeCli(['dataset', 'references'], makeDeps());
  assert.equal(datasetReferencesRootHelp.exitCode, 0);
  assert.match(datasetReferencesRootHelp.stdout, /tiangong-lca dataset references rewrite/u);

  const invalidDatasetReferenceAction = await executeCli(
    ['dataset', 'references', 'scan'],
    makeDeps(),
  );
  assert.equal(invalidDatasetReferenceAction.exitCode, 2);
  assert.match(invalidDatasetReferenceAction.stderr, /must be 'rewrite'/u);

  const datasetReferencesModeError = await executeCli(
    [
      'dataset',
      'references',
      'rewrite',
      '--input',
      'rows.jsonl',
      '--from',
      'flow:old',
      '--to',
      'flow:new',
      '--out-dir',
      'rewrite-out',
      '--commit',
      '--dry-run',
    ],
    makeDeps(),
  );
  assert.equal(datasetReferencesModeError.exitCode, 2);
  assert.match(datasetReferencesModeError.stderr, /Cannot pass both/u);

  const datasetEvidencePlan = await executeCli(
    [
      'dataset',
      'evidence-search',
      'plan',
      '--json',
      '--query',
      '中国2026年电力结构数据',
      '--profile',
      'shallow',
      '--max-queries',
      '2',
      '--max-results-per-query',
      '3',
      '--out-dir',
      'evidence-out',
    ],
    {
      ...makeDeps(),
      runDatasetEvidenceSearchImpl: async (options) => {
        assert.equal(options.mode, 'plan');
        assert.equal(options.query, '中国2026年电力结构数据');
        assert.equal(options.profile, 'shallow');
        assert.equal(options.maxQueries, 2);
        assert.equal(options.maxResultsPerQuery, 3);
        assert.equal(options.outDir, 'evidence-out');
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-27T00:00:00.000Z',
          mode: 'plan',
          status: 'planned',
          question: '中国2026年电力结构数据',
          field: { dataset_type: null, field_path: null },
          profile: 'shallow',
          budget: { max_queries: 2, max_results_per_query: 3, max_provider_calls: 2 },
          plan: { query_count: 0, queries: [] },
          run: {
            provider_count: 0,
            provider_call_count: 0,
            normalized_result_count: 0,
            authoritative_result_count: 0,
            high_confidence_result_count: 0,
            stop_reason: 'plan_only',
          },
          evidence_quality: {
            sufficient: false,
            temporal_coverage_status: 'not_required',
            requested_year: null,
            required_complete_year: false,
          },
          files: { plan: null, results: null, report: null, declaration: null },
        };
      },
    },
  );
  assert.equal(datasetEvidencePlan.exitCode, 0);

  const datasetEvidenceNumericFallback = await executeCli(
    ['dataset', 'evidence-search', 'plan', '--query', 'x', '--max-queries', 'nope'],
    {
      ...makeDeps(),
      runDatasetEvidenceSearchImpl: async (options) => {
        assert.equal(Number.isNaN(options.maxQueries), true);
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-27T00:00:00.000Z',
          mode: 'plan',
          status: 'planned',
          question: 'x',
          field: { dataset_type: null, field_path: null },
          profile: 'balanced',
          budget: { max_queries: 1, max_results_per_query: 1, max_provider_calls: 1 },
          plan: { query_count: 0, queries: [] },
          run: {
            provider_count: 0,
            provider_call_count: 0,
            normalized_result_count: 0,
            authoritative_result_count: 0,
            high_confidence_result_count: 0,
            stop_reason: 'plan_only',
          },
          evidence_quality: {
            sufficient: false,
            temporal_coverage_status: 'not_required',
            requested_year: null,
            required_complete_year: false,
          },
          files: { plan: null, results: null, report: null, declaration: null },
        };
      },
    },
  );
  assert.equal(datasetEvidenceNumericFallback.exitCode, 0);

  const datasetEvidenceRun = await executeCli(
    [
      'dataset',
      'evidence-search',
      'run',
      '--json',
      '--input',
      'request.json',
      '--results',
      'results.json',
      '--provider-url',
      'https://search.example/query',
      '--provider-key',
      'secret',
      '--timeout-ms',
      '25',
    ],
    {
      ...makeDeps(),
      runDatasetEvidenceSearchImpl: async (options) => {
        assert.equal(options.mode, 'run');
        assert.equal(options.inputPath, 'request.json');
        assert.equal(options.resultsPath, 'results.json');
        assert.equal(options.providerUrl, 'https://search.example/query');
        assert.equal(options.providerKey, 'secret');
        assert.equal(options.timeoutMs, 25);
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-27T00:00:00.000Z',
          mode: 'run',
          status: 'completed_no_sufficient_evidence',
          question: 'x',
          field: { dataset_type: null, field_path: null },
          profile: 'balanced',
          budget: { max_queries: 1, max_results_per_query: 1, max_provider_calls: 1 },
          plan: { query_count: 0, queries: [] },
          run: {
            provider_count: 1,
            provider_call_count: 0,
            normalized_result_count: 0,
            authoritative_result_count: 0,
            high_confidence_result_count: 0,
            stop_reason: 'budget_exhausted_without_sufficient_evidence',
          },
          evidence_quality: {
            sufficient: false,
            temporal_coverage_status: 'not_required',
            requested_year: null,
            required_complete_year: false,
          },
          files: { plan: null, results: null, report: null, declaration: null },
        };
      },
    },
  );
  assert.equal(datasetEvidenceRun.exitCode, 1);

  const datasetEvidenceRootHelp = await executeCli(['dataset', 'evidence-search'], makeDeps());
  assert.equal(datasetEvidenceRootHelp.exitCode, 0);
  assert.match(datasetEvidenceRootHelp.stdout, /evidence-search <plan\|run>/u);

  const invalidDatasetEvidenceAction = await executeCli(
    ['dataset', 'evidence-search', 'scan'],
    makeDeps(),
  );
  assert.equal(invalidDatasetEvidenceAction.exitCode, 2);
  assert.match(invalidDatasetEvidenceAction.stderr, /must be 'plan' or 'run'/u);

  const datasetEvidenceParseError = await executeCli(
    ['dataset', 'evidence-search', 'plan', '--wat'],
    makeDeps(),
  );
  assert.equal(datasetEvidenceParseError.exitCode, 2);
  assert.match(datasetEvidenceParseError.stderr, /Unknown option/u);

  const datasetReferencesParseError = await executeCli(
    ['dataset', 'references', 'rewrite', '--wat'],
    makeDeps(),
  );
  assert.equal(datasetReferencesParseError.exitCode, 2);
  assert.match(datasetReferencesParseError.stderr, /Unknown option/u);

  const lifecyclemodelSaveDraft = await executeCli(
    ['lifecyclemodel', 'save-draft', '--json', '--input', 'models.jsonl', '--out-dir', 'save-out'],
    {
      ...makeDeps(),
      runLifecyclemodelSaveDraftImpl: async (options) => {
        assert.equal(options.inputPath, 'models.jsonl');
        assert.equal(options.outDir, 'save-out');
        assert.equal(options.commit, false);
        return {
          generated_at_utc: '2026-05-05T00:00:00.000Z',
          input_path: 'models.jsonl',
          out_dir: 'save-out',
          commit: false,
          mode: 'dry_run',
          status: 'completed',
          counts: { selected: 1, prepared: 1, executed: 0, failed: 0 },
          files: {
            normalized_input: '',
            selected_lifecyclemodels: '',
            progress_jsonl: '',
            failures_jsonl: '',
            summary_json: '',
          },
          lifecyclemodels: [],
        };
      },
    },
  );
  assert.equal(lifecyclemodelSaveDraft.exitCode, 0);

  const lifecyclemodelSaveDraftFailure = await executeCli(
    ['lifecyclemodel', 'save-draft', '--json', '--input', 'models.jsonl'],
    {
      ...makeDeps(),
      runLifecyclemodelSaveDraftImpl: async () => ({
        generated_at_utc: '2026-05-05T00:00:00.000Z',
        input_path: 'models.jsonl',
        out_dir: 'save-out',
        commit: false,
        mode: 'dry_run',
        status: 'completed_with_failures',
        counts: { selected: 1, prepared: 0, executed: 0, failed: 1 },
        files: {
          normalized_input: '',
          selected_lifecyclemodels: '',
          progress_jsonl: '',
          failures_jsonl: '',
          summary_json: '',
        },
        lifecyclemodels: [],
      }),
    },
  );
  assert.equal(lifecyclemodelSaveDraftFailure.exitCode, 1);

  const lifecyclemodelSaveDraftModeError = await executeCli(
    ['lifecyclemodel', 'save-draft', '--input', 'models.jsonl', '--commit', '--dry-run'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelSaveDraftModeError.exitCode, 2);
  assert.match(lifecyclemodelSaveDraftModeError.stderr, /Cannot pass both/u);

  const lifecyclemodelSaveDraftParseError = await executeCli(
    ['lifecyclemodel', 'save-draft', '--wat'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelSaveDraftParseError.exitCode, 2);
  assert.match(lifecyclemodelSaveDraftParseError.stderr, /Unknown option/u);

  const lifecyclemodelGraph = await executeCli(
    [
      'lifecyclemodel',
      'graph',
      '--json',
      '--input',
      'models.jsonl',
      '--out-dir',
      'graph-out',
      '--format',
      'dot',
      '--check-connections',
    ],
    {
      ...makeDeps(),
      runLifecyclemodelGraphImpl: async (options) => {
        assert.equal(options.inputPath, 'models.jsonl');
        assert.equal(options.outDir, 'graph-out');
        assert.equal(options.format, 'dot');
        assert.equal(options.checkConnections, true);
        return {
          generated_at_utc: '2026-05-05T00:00:00.000Z',
          input_path: 'models.jsonl',
          out_dir: 'graph-out',
          format: 'dot',
          check_connections: true,
          status: 'completed',
          counts: { models: 1, nodes: 1, edges: 0, findings: 0 },
          files: { report: '', findings: '' },
          models: [],
          findings: [],
        };
      },
    },
  );
  assert.equal(lifecyclemodelGraph.exitCode, 0);

  const lifecyclemodelGraphFindings = await executeCli(
    ['lifecyclemodel', 'graph', '--json', '--input', 'models.jsonl', '--out-dir', 'graph-out'],
    {
      ...makeDeps(),
      runLifecyclemodelGraphImpl: async () => ({
        generated_at_utc: '2026-05-05T00:00:00.000Z',
        input_path: 'models.jsonl',
        out_dir: 'graph-out',
        format: 'all',
        check_connections: false,
        status: 'completed_with_findings',
        counts: { models: 1, nodes: 1, edges: 1, findings: 1 },
        files: { report: '', findings: '' },
        models: [],
        findings: [],
      }),
    },
  );
  assert.equal(lifecyclemodelGraphFindings.exitCode, 1);

  const lifecyclemodelGraphParseError = await executeCli(
    ['lifecyclemodel', 'graph', '--wat'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelGraphParseError.exitCode, 2);
  assert.match(lifecyclemodelGraphParseError.stderr, /Unknown option/u);
});

test('executeCli executes lifecyclemodel auto-build with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-auto-build-cli-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"local_runs":["./run-1"]}', 'utf8');

  try {
    const result = await executeCli(
      ['lifecyclemodel', 'auto-build', '--json', '--input', inputPath, '--out-dir', './run-root'],
      {
        ...makeDeps(),
        runLifecyclemodelAutoBuildImpl: async (options) => {
          assert.equal(options.inputPath, inputPath);
          assert.equal(options.outDir, './run-root');
          assert.equal(options.cwd, process.cwd());
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            status: 'completed_local_lifecyclemodel_auto_build_run',
            request_path: inputPath,
            run_id: 'lifecyclemodel_auto_build_demo_build_20260330T000000Z_id123456',
            run_root: path.join(dir, 'run-root'),
            local_run_count: 1,
            built_model_count: 1,
            files: {
              request_snapshot: path.join(
                dir,
                'run-root',
                'request',
                'lifecyclemodel-auto-build.request.json',
              ),
              normalized_request: path.join(dir, 'run-root', 'request', 'request.normalized.json'),
              run_plan: path.join(dir, 'run-root', 'run-plan.json'),
              resolved_manifest: path.join(dir, 'run-root', 'resolved-manifest.json'),
              selection_brief: path.join(dir, 'run-root', 'selection', 'selection-brief.md'),
              reference_model_summary: path.join(
                dir,
                'run-root',
                'discovery',
                'reference-model-summary.json',
              ),
              invocation_index: path.join(dir, 'run-root', 'manifests', 'invocation-index.json'),
              run_manifest: path.join(dir, 'run-root', 'manifests', 'run-manifest.json'),
              report: path.join(
                dir,
                'run-root',
                'reports',
                'lifecyclemodel-auto-build-report.json',
              ),
            },
            local_build_reports: [
              {
                run_dir: path.join(dir, 'run-1'),
                run_name: 'run-1',
                model_file: path.join(
                  dir,
                  'run-root',
                  'models',
                  'run-1',
                  'tidas_bundle',
                  'lifecyclemodels',
                  'lm.json',
                ),
                summary_file: path.join(dir, 'run-root', 'models', 'run-1', 'summary.json'),
                connections_file: path.join(dir, 'run-root', 'models', 'run-1', 'connections.json'),
                process_catalog_file: path.join(
                  dir,
                  'run-root',
                  'models',
                  'run-1',
                  'process-catalog.json',
                ),
                summary: {
                  model_uuid: 'lm-demo',
                },
              },
            ],
            next_actions: ['inspect: run-plan'],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"completed_local_lifecyclemodel_auto_build_run"/u);
    assert.match(result.stdout, /"run_plan"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes flow fetch-rows with injected implementation', async () => {
  const result = await executeCli(
    [
      'flow',
      'fetch-rows',
      '--json',
      '--refs-file',
      './refs.json',
      '--out-dir',
      './out',
      '--no-latest-fallback',
      '--fail-on-missing',
    ],
    {
      ...makeDeps(),
      runFlowFetchRowsImpl: async (options: RunFlowFetchRowsOptions) => {
        assert.equal(options.refsFile, './refs.json');
        assert.equal(options.outDir, './out');
        assert.equal(options.allowLatestFallback, false);
        return {
          schema_version: 1,
          generated_at_utc: '2026-04-06T00:00:00.000Z',
          status: 'completed_flow_row_materialization_with_gaps',
          refs_file: '/tmp/refs.json',
          out_dir: '/tmp/out',
          allow_latest_fallback: false,
          requested_ref_count: 2,
          resolved_ref_count: 1,
          qa_input_row_count: 1,
          duplicate_qa_input_rows_collapsed: 0,
          missing_ref_count: 1,
          ambiguous_ref_count: 0,
          resolution_counts: {
            remote_supabase_exact: 1,
            remote_supabase_latest: 0,
            remote_supabase_latest_fallback: 0,
          },
          files: {
            resolved_flow_rows: '/tmp/out/resolved-flow-rows.jsonl',
            qa_input_rows: '/tmp/out/qa-input-rows.jsonl',
            fetch_summary: '/tmp/out/fetch-summary.json',
            missing_flow_refs: '/tmp/out/missing-flow-refs.jsonl',
            ambiguous_flow_refs: '/tmp/out/ambiguous-flow-refs.jsonl',
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /"status":"completed_flow_row_materialization_with_gaps"/u);
  assert.match(result.stdout, /"qa_input_row_count":1/u);
});

test('executeCli keeps exit code 0 for flow fetch-rows gaps unless --fail-on-missing is enabled', async () => {
  const result = await executeCli(
    ['flow', 'fetch-rows', '--json', '--refs-file', './refs.json', '--out-dir', './out'],
    {
      ...makeDeps(),
      runFlowFetchRowsImpl: async () => ({
        schema_version: 1,
        generated_at_utc: '2026-04-07T00:00:00.000Z',
        status: 'completed_flow_row_materialization_with_gaps',
        refs_file: '/tmp/refs.json',
        out_dir: '/tmp/out',
        allow_latest_fallback: true,
        requested_ref_count: 1,
        resolved_ref_count: 0,
        qa_input_row_count: 0,
        duplicate_qa_input_rows_collapsed: 0,
        missing_ref_count: 1,
        ambiguous_ref_count: 0,
        resolution_counts: {
          remote_supabase_exact: 0,
          remote_supabase_latest: 0,
          remote_supabase_latest_fallback: 0,
        },
        files: {
          resolved_flow_rows: '/tmp/out/resolved-flow-rows.jsonl',
          qa_input_rows: '/tmp/out/qa-input-rows.jsonl',
          fetch_summary: '/tmp/out/fetch-summary.json',
          missing_flow_refs: '/tmp/out/missing-flow-refs.jsonl',
          ambiguous_flow_refs: '/tmp/out/ambiguous-flow-refs.jsonl',
        },
      }),
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"missing_ref_count":1/u);
});

test('executeCli executes flow materialize-decisions with injected implementation', async () => {
  const result = await executeCli(
    [
      'flow',
      'materialize-decisions',
      '--json',
      '--decision-file',
      './decisions.json',
      '--flow-rows-file',
      './flow-rows.jsonl',
      '--out-dir',
      './out',
    ],
    {
      ...makeDeps(),
      runFlowMaterializeDecisionsImpl: async (options: RunFlowMaterializeDecisionsOptions) => {
        assert.equal(options.decisionFile, './decisions.json');
        assert.equal(options.flowRowsFile, './flow-rows.jsonl');
        assert.equal(options.outDir, './out');
        return {
          schema_version: 1,
          generated_at_utc: '2026-04-06T00:00:00.000Z',
          status: 'completed_local_flow_decision_materialization',
          decision_file: '/tmp/decisions.json',
          flow_rows_file: '/tmp/flow-rows.jsonl',
          out_dir: '/tmp/out',
          counts: {
            input_decisions: 1,
            materialized_clusters: 1,
            blocked_clusters: 0,
            canonical_map_entries: 2,
            rewrite_actions: 1,
            seed_alias_entries: 1,
            decision_counts: {
              merge_keep_one: 1,
              keep_distinct: 0,
              blocked_missing_db_flow: 0,
            },
            blocked_reason_counts: {},
          },
          files: {
            canonical_map: '/tmp/out/flow-dedup-canonical-map.json',
            rewrite_plan: '/tmp/out/flow-dedup-rewrite-plan.json',
            semantic_merge_seed: '/tmp/out/manual-semantic-merge-seed.current.json',
            summary: '/tmp/out/decision-summary.json',
            blocked_clusters: '/tmp/out/blocked-clusters.json',
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status":"completed_local_flow_decision_materialization"/u);
  assert.match(result.stdout, /"rewrite_actions":1/u);
});

test('executeCli returns parsing errors for invalid flow fetch-rows and materialize-decisions flags', async () => {
  const fetchRowsResult = await executeCli(['flow', 'fetch-rows', '--wat'], makeDeps());
  assert.equal(fetchRowsResult.exitCode, 2);
  assert.match(fetchRowsResult.stderr, /Unknown option '--wat'/u);

  const materializeResult = await executeCli(
    ['flow', 'materialize-decisions', '--wat'],
    makeDeps(),
  );
  assert.equal(materializeResult.exitCode, 2);
  assert.match(materializeResult.stderr, /Unknown option '--wat'/u);
});

test('executeCli executes lifecyclemodel orchestrate with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-orchestrate-cli-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(
    inputPath,
    '{"goal":{"name":"Demo"},"root":{"kind":"lifecyclemodel","lifecyclemodel":{"id":"lm-demo"}},"orchestration":{"mode":"collapsed","max_depth":1,"reuse_resulting_process_first":true,"allow_process_build":true,"allow_submodel_build":true,"pin_child_versions":true,"stop_at_elementary_flow":false},"publish":{"intent":"prepare_only"}}',
    'utf8',
  );

  try {
    const result = await executeCli(
      [
        'lifecyclemodel',
        'orchestrate',
        'plan',
        '--json',
        '--input',
        inputPath,
        '--out-dir',
        './run-root',
      ],
      {
        ...makeDeps(),
        runLifecyclemodelOrchestrateImpl: async (options) => {
          assert.equal(options.action, 'plan');
          assert.equal(options.inputPath, inputPath);
          assert.equal(options.outDir, './run-root');
          assert.equal(options.runDir, '');
          assert.equal(options.allowProcessBuild, false);
          assert.equal(options.publishLifecyclemodels, false);
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            action: 'plan',
            status: 'planned',
            request_id: 'demo-run',
            out_dir: path.join(dir, 'run-root'),
            counts: {
              nodes: 1,
              edges: 0,
              invocations: 1,
              unresolved: 0,
            },
            files: {
              request_normalized: path.join(dir, 'run-root', 'request.normalized.json'),
              assembly_plan: path.join(dir, 'run-root', 'assembly-plan.json'),
              graph_manifest: path.join(dir, 'run-root', 'graph-manifest.json'),
              lineage_manifest: path.join(dir, 'run-root', 'lineage-manifest.json'),
              boundary_report: path.join(dir, 'run-root', 'boundary-report.json'),
            },
            warnings: [],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"action":"plan"/u);
    assert.match(result.stdout, /"assembly_plan"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli maps lifecyclemodel orchestrate execute failures to exit code 1', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-orchestrate-fail-cli-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(
    inputPath,
    '{"goal":{"name":"Demo"},"root":{"kind":"lifecyclemodel","lifecyclemodel":{"id":"lm-demo"}},"orchestration":{"mode":"collapsed","max_depth":1,"reuse_resulting_process_first":true,"allow_process_build":true,"allow_submodel_build":true,"pin_child_versions":true,"stop_at_elementary_flow":false},"publish":{"intent":"prepare_only"}}',
    'utf8',
  );

  try {
    const result = await executeCli(
      [
        'lifecyclemodel',
        'orchestrate',
        'execute',
        '--json',
        '--input',
        inputPath,
        '--out-dir',
        './run-root',
      ],
      {
        ...makeDeps(),
        runLifecyclemodelOrchestrateImpl: async () => ({
          schema_version: 1,
          generated_at_utc: '2026-03-30T00:00:00.000Z',
          action: 'execute',
          status: 'failed',
          request_id: 'demo-run',
          out_dir: path.join(dir, 'run-root'),
          execution: {
            successful_invocations: 1,
            failed_invocations: 1,
            blocked_invocations: 0,
          },
          files: {
            request_normalized: path.join(dir, 'run-root', 'request.normalized.json'),
            assembly_plan: path.join(dir, 'run-root', 'assembly-plan.json'),
            graph_manifest: path.join(dir, 'run-root', 'graph-manifest.json'),
            lineage_manifest: path.join(dir, 'run-root', 'lineage-manifest.json'),
            boundary_report: path.join(dir, 'run-root', 'boundary-report.json'),
            invocations_dir: path.join(dir, 'run-root', 'invocations'),
          },
          warnings: [],
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /"status":"failed"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli accepts lifecyclemodel orchestrate request alias and explicit run-dir flags', async () => {
  const result = await executeCli(
    [
      'lifecyclemodel',
      'orchestrate',
      'publish',
      '--json',
      '--request',
      './request-alias.json',
      '--run-dir',
      './run-root',
    ],
    {
      ...makeDeps(),
      runLifecyclemodelOrchestrateImpl: async (options) => {
        assert.equal(options.action, 'publish');
        assert.equal(options.inputPath, './request-alias.json');
        assert.equal(options.runDir, './run-root');
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-31T00:00:00.000Z',
          action: 'publish',
          status: 'prepared_local_publish_bundle',
          request_id: 'demo-run',
          run_dir: './run-root',
          counts: {
            lifecyclemodels: 0,
            projected_processes: 0,
            resulting_process_relations: 0,
            process_build_runs: 0,
          },
          files: {
            assembly_plan: './run-root/assembly-plan.json',
            graph_manifest: './run-root/graph-manifest.json',
            lineage_manifest: './run-root/lineage-manifest.json',
            publish_bundle: './run-root/publish-bundle.json',
            publish_summary: './run-root/publish-summary.json',
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"action":"publish"/u);
  assert.match(result.stdout, /"publish_bundle"/u);
});

test('executeCli executes lifecyclemodel validate-build with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-validate-build-cli-'));
  const runDir = path.join(dir, 'lm-run');

  try {
    const result = await executeCli(
      ['lifecyclemodel', 'validate-build', '--json', '--run-dir', runDir, '--engine', 'sdk'],
      {
        ...makeDeps(),
        runLifecyclemodelValidateBuildImpl: async (options) => {
          assert.equal(options.runDir, runDir);
          assert.equal(options.engine, 'sdk');
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            status: 'completed_lifecyclemodel_validate_build',
            run_id: 'lm-run',
            run_root: runDir,
            ok: false,
            engine: 'sdk',
            counts: {
              models: 1,
              ok: 0,
              failed: 1,
            },
            files: {
              run_manifest: path.join(runDir, 'manifests', 'run-manifest.json'),
              invocation_index: path.join(runDir, 'manifests', 'invocation-index.json'),
              auto_build_report: path.join(
                runDir,
                'reports',
                'lifecyclemodel-auto-build-report.json',
              ),
              report: path.join(runDir, 'reports', 'lifecyclemodel-validate-build-report.json'),
              model_reports_dir: path.join(runDir, 'reports', 'model-validations'),
            },
            model_reports: [],
            next_actions: [],
          };
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /"status":"completed_lifecyclemodel_validate_build"/u);
    assert.match(result.stdout, /"ok":false/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns exit code 0 when lifecyclemodel validate-build reports ok', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-validate-build-cli-ok-'));
  const runDir = path.join(dir, 'lm-run-ok');

  try {
    const result = await executeCli(['lifecyclemodel', 'validate-build', '--run-dir', runDir], {
      ...makeDeps(),
      runLifecyclemodelValidateBuildImpl: async () => ({
        schema_version: 1,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'completed_lifecyclemodel_validate_build',
        run_id: 'lm-run-ok',
        run_root: runDir,
        ok: true,
        engine: 'auto',
        counts: {
          models: 1,
          ok: 1,
          failed: 0,
        },
        files: {
          run_manifest: path.join(runDir, 'manifests', 'run-manifest.json'),
          invocation_index: path.join(runDir, 'manifests', 'invocation-index.json'),
          auto_build_report: null,
          report: path.join(runDir, 'reports', 'lifecyclemodel-validate-build-report.json'),
          model_reports_dir: path.join(runDir, 'reports', 'model-validations'),
        },
        model_reports: [],
        next_actions: [],
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"ok": true/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes lifecyclemodel publish-build with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-publish-build-cli-'));
  const runDir = path.join(dir, 'lm-run');

  try {
    const result = await executeCli(
      ['lifecyclemodel', 'publish-build', '--json', '--run-dir', runDir],
      {
        ...makeDeps(),
        runLifecyclemodelPublishBuildImpl: async (options) => {
          assert.equal(options.runDir, runDir);
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            status: 'prepared_local_lifecyclemodel_publish_bundle',
            run_id: 'lm-run',
            run_root: runDir,
            counts: {
              lifecyclemodels: 1,
            },
            publish_defaults: {
              commit: false,
              publish_lifecyclemodels: true,
              publish_processes: false,
              publish_sources: false,
              publish_relations: false,
              publish_process_build_runs: false,
              relation_mode: 'local_manifest_only',
            },
            validation: {
              available: false,
              ok: null,
              report: null,
            },
            files: {
              run_manifest: path.join(runDir, 'manifests', 'run-manifest.json'),
              invocation_index: path.join(runDir, 'manifests', 'invocation-index.json'),
              publish_bundle: path.join(
                runDir,
                'stage_outputs',
                '10_publish',
                'publish-bundle.json',
              ),
              publish_request: path.join(
                runDir,
                'stage_outputs',
                '10_publish',
                'publish-request.json',
              ),
              publish_intent: path.join(
                runDir,
                'stage_outputs',
                '10_publish',
                'publish-intent.json',
              ),
              report: path.join(runDir, 'reports', 'lifecyclemodel-publish-build-report.json'),
            },
            next_actions: [],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"prepared_local_lifecyclemodel_publish_bundle"/u);
    assert.match(result.stdout, /"lifecyclemodels":1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns help for the process namespace and implemented subcommands', async () => {
  const processHelp = await executeCli(['process'], makeDeps());
  assert.equal(processHelp.exitCode, 0);
  assert.match(processHelp.stdout, /tiangong-lca process <subcommand>/u);
  assert.match(processHelp.stdout, /get/u);
  assert.match(processHelp.stdout, /list/u);
  assert.match(processHelp.stdout, /identity-preflight/u);
  assert.match(processHelp.stdout, /build-plan/u);
  assert.match(processHelp.stdout, /scope-statistics/u);
  assert.match(processHelp.stdout, /dedup-review/u);
  assert.match(processHelp.stdout, /auto-build/u);
  assert.match(processHelp.stdout, /resume-build/u);
  assert.match(processHelp.stdout, /publish-build/u);
  assert.match(processHelp.stdout, /save-draft/u);
  assert.match(processHelp.stdout, /batch-build/u);
  assert.match(processHelp.stdout, /refresh-references/u);
  assert.match(processHelp.stdout, /verify-rows/u);

  const getHelp = await executeCli(['process', 'get', '--help'], makeDeps());
  assert.equal(getHelp.exitCode, 0);
  assert.match(getHelp.stdout, /tiangong-lca process get --id <process-id>/u);
  assert.match(getHelp.stdout, /TIANGONG_LCA_API_BASE_URL/u);
  assert.match(getHelp.stdout, /TIANGONG_LCA_OAUTH_CLIENT_ID/u);
  assert.doesNotMatch(getHelp.stdout, /Planned command/u);

  const listHelp = await executeCli(['process', 'list', '--help'], makeDeps());
  assert.equal(listHelp.exitCode, 0);
  assert.match(listHelp.stdout, /tiangong-lca process list \[options\]/u);
  assert.match(listHelp.stdout, /--page-size/u);
  assert.match(listHelp.stdout, /TIANGONG_LCA_API_BASE_URL/u);
  assert.doesNotMatch(listHelp.stdout, /Planned command/u);

  const identityPreflightHelp = await executeCli(
    ['process', 'identity-preflight', '--help'],
    makeDeps(),
  );
  assert.equal(identityPreflightHelp.exitCode, 0);
  assert.match(
    identityPreflightHelp.stdout,
    /tiangong-lca process identity-preflight --input <file>/u,
  );
  assert.match(identityPreflightHelp.stdout, /identity-decision\.json/u);
  assert.match(identityPreflightHelp.stdout, /identity-candidate-sources\.json/u);
  assert.doesNotMatch(identityPreflightHelp.stdout, /Planned command/u);

  const processBuildPlanHelp = await executeCli(['process', 'build-plan', '--help'], makeDeps());
  assert.equal(processBuildPlanHelp.exitCode, 0);
  assert.match(
    processBuildPlanHelp.stdout,
    /tiangong-lca process build-plan <validate\|materialize>/u,
  );
  assert.match(processBuildPlanHelp.stdout, /build-plan-gate-report\.json/u);
  assert.doesNotMatch(processBuildPlanHelp.stdout, /Planned command/u);

  const processBuildPlanActionHelp = await executeCli(
    ['process', 'build-plan', 'materialize', '--help'],
    makeDeps(),
  );
  assert.equal(processBuildPlanActionHelp.exitCode, 0);
  assert.match(processBuildPlanActionHelp.stdout, /materialized-process\.json/u);

  const scopeStatisticsHelp = await executeCli(
    ['process', 'scope-statistics', '--help'],
    makeDeps(),
  );
  assert.equal(scopeStatisticsHelp.exitCode, 0);
  assert.match(
    scopeStatisticsHelp.stdout,
    /tiangong-lca process scope-statistics --out-dir <dir>/u,
  );
  assert.match(scopeStatisticsHelp.stdout, /--state-code/u);
  assert.match(scopeStatisticsHelp.stdout, /process-scope-statistics\.zh-CN\.md/u);
  assert.doesNotMatch(scopeStatisticsHelp.stdout, /Planned command/u);

  const dedupReviewHelp = await executeCli(['process', 'dedup-review', '--help'], makeDeps());
  assert.equal(dedupReviewHelp.exitCode, 0);
  assert.match(dedupReviewHelp.stdout, /tiangong-lca process dedup-review --input <file>/u);
  assert.match(dedupReviewHelp.stdout, /--skip-remote/u);
  assert.match(dedupReviewHelp.stdout, /inputs\/dedup-input\.manifest\.json/u);
  assert.doesNotMatch(dedupReviewHelp.stdout, /Planned command/u);

  const autoBuildHelp = await executeCli(['process', 'auto-build', '--help'], makeDeps());
  assert.equal(autoBuildHelp.exitCode, 0);
  assert.match(autoBuildHelp.stdout, /tiangong-lca process auto-build --input <file>/u);
  assert.match(autoBuildHelp.stdout, /request\.workspace_run_root is required/u);
  assert.match(autoBuildHelp.stdout, /--out-dir/u);
  assert.doesNotMatch(autoBuildHelp.stdout, /Planned command/u);

  const resumeBuildHelp = await executeCli(['process', 'resume-build', '--help'], makeDeps());
  assert.equal(resumeBuildHelp.exitCode, 0);
  assert.match(resumeBuildHelp.stdout, /tiangong-lca process resume-build --run-dir <dir>/u);
  assert.match(resumeBuildHelp.stdout, /--run-dir/u);
  assert.doesNotMatch(resumeBuildHelp.stdout, /Planned command/u);

  const publishBuildHelp = await executeCli(['process', 'publish-build', '--help'], makeDeps());
  assert.equal(publishBuildHelp.exitCode, 0);
  assert.match(publishBuildHelp.stdout, /tiangong-lca process publish-build --run-dir <dir>/u);
  assert.match(publishBuildHelp.stdout, /--run-dir/u);
  assert.doesNotMatch(publishBuildHelp.stdout, /Planned command/u);

  const saveDraftHelp = await executeCli(['process', 'save-draft', '--help'], makeDeps());
  assert.equal(saveDraftHelp.exitCode, 0);
  assert.match(saveDraftHelp.stdout, /tiangong-lca process save-draft --input <file>/u);
  assert.match(saveDraftHelp.stdout, /--commit/u);
  assert.match(saveDraftHelp.stdout, /--target-user-id <id>/u);
  assert.match(saveDraftHelp.stdout, /outputs\/save-draft-rpc\/summary\.json/u);
  assert.doesNotMatch(saveDraftHelp.stdout, /Planned command/u);

  const requiredFieldsHelp = await executeCli(
    ['process', 'complete-required-fields', '--help'],
    makeDeps(),
  );
  assert.equal(requiredFieldsHelp.exitCode, 0);
  assert.match(
    requiredFieldsHelp.stdout,
    /tiangong-lca process complete-required-fields --input <file> --out <file>/u,
  );
  assert.match(requiredFieldsHelp.stdout, /annualSupplyOrProductionVolume/u);
  assert.match(requiredFieldsHelp.stdout, /process-required-fields-evidence\.jsonl/u);
  assert.doesNotMatch(requiredFieldsHelp.stdout, /Planned command/u);

  const refreshReferencesHelp = await executeCli(
    ['process', 'refresh-references', '--help'],
    makeDeps(),
  );
  assert.equal(refreshReferencesHelp.exitCode, 0);
  assert.match(
    refreshReferencesHelp.stdout,
    /tiangong-lca process refresh-references --out-dir <dir>/u,
  );
  assert.match(refreshReferencesHelp.stdout, /--reuse-manifest/u);
  assert.match(refreshReferencesHelp.stdout, /never requires raw SUPABASE_EMAIL/u);
  assert.doesNotMatch(refreshReferencesHelp.stdout, /Planned command/u);

  const verifyRowsHelp = await executeCli(['process', 'verify-rows', '--help'], makeDeps());
  assert.equal(verifyRowsHelp.exitCode, 0);
  assert.match(
    verifyRowsHelp.stdout,
    /tiangong-lca process verify-rows --rows-file <file> --out-dir <dir>/u,
  );
  assert.match(verifyRowsHelp.stdout, /outputs\/verification\.jsonl/u);
  assert.doesNotMatch(verifyRowsHelp.stdout, /Planned command/u);

  const batchBuildHelp = await executeCli(['process', 'batch-build', '--help'], makeDeps());
  assert.equal(batchBuildHelp.exitCode, 0);
  assert.match(batchBuildHelp.stdout, /tiangong-lca process batch-build --input <file>/u);
  assert.match(batchBuildHelp.stdout, /request\.out_dir is required/u);
  assert.match(batchBuildHelp.stdout, /--out-dir/u);
  assert.doesNotMatch(batchBuildHelp.stdout, /Planned command/u);
});

test('executeCli executes process scope-statistics with injected implementation', async () => {
  const result = await executeCli(
    [
      'process',
      'scope-statistics',
      '--json',
      '--out-dir',
      './out',
      '--scope',
      'current-user',
      '--state-code',
      '0',
      '--state-codes',
      '100,200',
      '--page-size',
      '50',
      '--reuse-snapshot',
    ],
    {
      ...makeDeps(),
      runProcessScopeStatisticsImpl: async (options) => {
        assert.equal(options.outDir, './out');
        assert.equal(options.scope, 'current-user');
        assert.deepEqual(options.stateCodes, [0, 100, 200]);
        assert.equal(options.pageSize, 50);
        assert.equal(options.reuseSnapshot, true);
        return {
          schema_version: 1,
          generated_at_utc: '2026-04-18T00:00:00.000Z',
          status: 'completed_process_scope_statistics',
          out_dir: '/tmp/out',
          scope: 'current-user',
          state_codes: [0, 100, 200],
          total_process_rows: 12,
          domain_count_primary: 4,
          domain_count_leaf: 6,
          craft_count: 7,
          unit_process_rows: 8,
          product_count: 9,
          files: {
            snapshot_manifest: '/tmp/out/inputs/processes.snapshot.manifest.json',
            snapshot_rows: '/tmp/out/inputs/processes.snapshot.rows.jsonl',
            process_scope_summary: '/tmp/out/outputs/process-scope-summary.json',
            domain_summary: '/tmp/out/outputs/domain-summary.json',
            craft_summary: '/tmp/out/outputs/craft-summary.json',
            product_summary: '/tmp/out/outputs/product-summary.json',
            type_of_dataset_summary: '/tmp/out/outputs/type-of-dataset-summary.json',
            report: '/tmp/out/reports/process-scope-statistics.md',
            report_zh: '/tmp/out/reports/process-scope-statistics.zh-CN.md',
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status":"completed_process_scope_statistics"/u);
  assert.match(result.stdout, /"state_codes":\[0,100,200\]/u);
});

test('executeCli executes process dedup-review with injected implementation', async () => {
  const result = await executeCli(
    [
      'process',
      'dedup-review',
      '--json',
      '--input',
      './dedup.json',
      '--out-dir',
      './artifacts',
      '--skip-remote',
    ],
    {
      ...makeDeps(),
      runProcessDedupReviewImpl: async (options) => {
        assert.equal(options.inputPath, './dedup.json');
        assert.equal(options.outDir, './artifacts');
        assert.equal(options.skipRemote, true);
        return {
          schema_version: 1,
          generated_at_utc: '2026-04-18T00:00:00.000Z',
          status: 'completed_process_dedup_review',
          input_file: '/tmp/dedup.json',
          out_dir: '/tmp/artifacts',
          source_label: 'duplicate-export',
          group_count: 3,
          exact_duplicate_group_count: 2,
          remote_status: {
            enabled: false,
            loaded: 0,
            error: null,
            reference_scan: 'skipped_by_flag',
          },
          files: {
            input_manifest: '/tmp/artifacts/inputs/dedup-input.manifest.json',
            remote_metadata: null,
            duplicate_groups: '/tmp/artifacts/outputs/duplicate-groups.json',
            delete_plan: '/tmp/artifacts/outputs/delete-plan.json',
            current_user_reference_scan: null,
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status":"completed_process_dedup_review"/u);
  assert.match(result.stdout, /"reference_scan":"skipped_by_flag"/u);
});

test('executeCli executes lifecyclemodel build-resulting-process with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-cli-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"source_model":{"json_ordered_path":"./model.json"}}', 'utf8');
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  try {
    const result = await executeCli(
      [
        'lifecyclemodel',
        'build-resulting-process',
        '--json',
        '--input',
        inputPath,
        '--out-dir',
        './out',
      ],
      {
        ...deps,
        runLifecyclemodelBuildResultingProcessImpl: async (options) => {
          assert.equal(options.inputPath, inputPath);
          assert.equal(options.outDir, './out');
          assert.equal(options.env, deps.env);
          assert.equal(options.fetchImpl, deps.fetchImpl);
          return {
            generated_at_utc: '2026-03-29T00:00:00.000Z',
            request_path: inputPath,
            out_dir: path.join(dir, 'out'),
            status: 'prepared_local_bundle',
            projected_process_count: 1,
            relation_count: 1,
            source_model: {
              id: 'lm-demo',
              version: '00.00.001',
              name: 'Demo model',
              json_ordered_path: path.join(dir, 'model.json'),
              reference_to_resulting_process_id: 'proc-demo',
              reference_to_resulting_process_version: '00.00.001',
              reference_process_instance_id: '1',
            },
            files: {
              normalized_request: path.join(dir, 'out', 'request.normalized.json'),
              source_model_normalized: path.join(dir, 'out', 'source-model.normalized.json'),
              source_model_summary: path.join(dir, 'out', 'source-model.summary.json'),
              projection_report: path.join(dir, 'out', 'projection-report.json'),
              process_projection_bundle: path.join(dir, 'out', 'process-projection-bundle.json'),
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"prepared_local_bundle"/u);
    assert.match(result.stdout, /"process_projection_bundle"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process get with injected implementation', async () => {
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  const result = await executeCli(['process', 'get', '--id', 'proc-1', '--version', '00.00.001'], {
    ...deps,
    runProcessGetImpl: async (options) => {
      assert.equal(options.processId, 'proc-1');
      assert.equal(options.version, '00.00.001');
      assert.equal(options.env, deps.env);
      assert.equal(options.fetchImpl, deps.fetchImpl);
      return {
        schema_version: 1,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'resolved_remote_process',
        process_id: 'proc-1',
        requested_version: '00.00.001',
        resolved_version: '00.00.001',
        resolution: 'remote_supabase_exact',
        source_url: 'https://supabase.example/rest/v1/processes?id=eq.proc-1',
        modified_at: null,
        state_code: 100,
        process: { processDataSet: { id: 'proc-1' } },
      };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status": "resolved_remote_process"/u);
  assert.equal(result.stderr, '');
});

test('executeCli executes process list with injected implementation', async () => {
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  const result = await executeCli(
    [
      'process',
      'list',
      '--id',
      'proc-1',
      '--version',
      '00.00.001',
      '--user-id',
      'user-1',
      '--state-code',
      '100',
      '--all',
      '--page-size',
      '50',
      '--order',
      'version.desc',
    ],
    {
      ...deps,
      runProcessListImpl: async (options) => {
        assert.deepEqual(options.ids, ['proc-1']);
        assert.equal(options.version, '00.00.001');
        assert.equal(options.userId, 'user-1');
        assert.deepEqual(options.stateCodes, [100]);
        assert.equal(options.all, true);
        assert.equal(options.pageSize, 50);
        assert.equal(options.order, 'version.desc');
        assert.equal(options.env, deps.env);
        assert.equal(options.fetchImpl, deps.fetchImpl);
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-30T00:00:00.000Z',
          status: 'listed_remote_processes',
          filters: {
            ids: ['proc-1'],
            requested_version: '00.00.001',
            requested_user_id: 'user-1',
            requested_state_codes: [100],
            order: 'version.desc',
            all: true,
            limit: null,
            offset: 0,
            page_size: 50,
          },
          count: 1,
          source_urls: ['https://supabase.example/rest/v1/processes?id=eq.proc-1'],
          rows: [
            {
              id: 'proc-1',
              version: '00.00.001',
              user_id: 'user-1',
              state_code: 100,
              modified_at: null,
              process: { processDataSet: { id: 'proc-1' } },
            },
          ],
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status": "listed_remote_processes"/u);
  assert.equal(result.stderr, '');
});

test('executeCli parses non-all process list pagination flags', async () => {
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  const result = await executeCli(['process', 'list', '--limit', '5', '--offset', '3'], {
    ...deps,
    runProcessListImpl: async (options) => {
      assert.equal(options.limit, 5);
      assert.equal(options.offset, 3);
      return {
        schema_version: 1,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'listed_remote_processes',
        filters: {
          ids: [],
          requested_version: null,
          requested_user_id: null,
          requested_state_codes: [],
          order: 'id.asc,version.asc',
          all: false,
          limit: 5,
          offset: 3,
          page_size: null,
        },
        count: 0,
        source_urls: ['https://supabase.example/rest/v1/processes?limit=5&offset=3'],
        rows: [],
      };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"offset": 3/u);
});

test('executeCli executes process identity-preflight with injected implementation', async () => {
  const result = await executeCli(
    [
      'process',
      'identity-preflight',
      '--json',
      '--input',
      '/tmp/process-preflight.json',
      '--candidate-input',
      '/tmp/candidates-a.jsonl',
      '--candidate-input',
      '/tmp/candidate-dir',
      '--remote-candidates',
      '--remote-query',
      'grid electricity',
      '--remote-limit',
      '3',
      '--remote-data-source',
      'tg',
      '--timeout-ms',
      '45000',
      '--out-dir',
      '/tmp/process-preflight',
    ],
    {
      ...makeDeps(),
      runProcessIdentityPreflightImpl: async (options) => {
        assert.equal(options.inputPath, '/tmp/process-preflight.json');
        assert.equal(options.outDir, '/tmp/process-preflight');
        assert.deepEqual(options.candidateInputPaths, [
          '/tmp/candidates-a.jsonl',
          '/tmp/candidate-dir',
        ]);
        assert.equal(options.remoteCandidateSearch, true);
        assert.equal(options.remoteQuery, 'grid electricity');
        assert.equal(options.remoteLimit, 3);
        assert.equal(options.remoteDataSource, 'tg');
        assert.equal(options.timeoutMs, 45000);
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-22T00:00:00.000Z',
          kind: 'process',
          status: 'blocked',
          decision: 'block_duplicate',
          confidence: 'high',
          input_path: '/tmp/process-preflight.json',
          out_dir: '/tmp/process-preflight',
          target: {
            id: null,
            version: null,
            names: [],
            fields: {},
            identity_key: 'process-key',
            exchange_signature: ['flow-a:input:1'],
            schema_validation: {
              status: 'not_applicable',
              validator: null,
              issue_count: 0,
              issues: [],
            },
          },
          candidates: [
            {
              index: 0,
              id: 'process-existing',
              version: '01.00.000',
              state_code: 100,
              names: [],
              fields: {},
              exchange_signature: ['flow-a:input:1'],
              identity_key: 'process-key',
              match_score: 100,
              match_reasons: ['same_identity_key'],
              decision_hint: 'block_duplicate',
            },
          ],
          candidate_sources: [],
          findings: [
            {
              code: 'process_duplicate_candidate',
              severity: 'blocker',
              message: 'duplicate',
              candidate_index: 0,
            },
          ],
          blockers: [
            {
              code: 'process_duplicate_candidate',
              severity: 'blocker',
              message: 'duplicate',
              candidate_index: 0,
            },
          ],
          next_action: 'stop_duplicate',
          files: {
            identity_decision: null,
            candidates: null,
            candidate_sources: null,
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /"decision":"block_duplicate"/u);
});

test('executeCli maps process identity-preflight success and argument errors', async () => {
  const result = await executeCli(
    ['process', 'identity-preflight', '--input', '/tmp/process-preflight.json'],
    {
      ...makeDeps(),
      runProcessIdentityPreflightImpl: async (options) => {
        assert.equal(options.remoteCandidateSearch, undefined);
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-22T00:00:00.000Z',
          kind: 'process',
          status: 'passed',
          decision: 'create_new',
          confidence: 'medium',
          input_path: '/tmp/process-preflight.json',
          out_dir: null,
          target: {
            id: null,
            version: null,
            names: [],
            fields: {},
            identity_key: 'process-key',
            exchange_signature: [],
            schema_validation: {
              status: 'not_applicable',
              validator: null,
              issue_count: 0,
              issues: [],
            },
          },
          candidates: [],
          candidate_sources: [],
          findings: [],
          blockers: [],
          next_action: 'materialize_new_payload',
          files: {
            identity_decision: null,
            candidates: null,
            candidate_sources: null,
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"decision": "create_new"/u);

  const invalid = await executeCli(
    ['process', 'identity-preflight', '--input', '/tmp/process-preflight.json', '--bad'],
    makeDeps(),
  );
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /Unknown option/u);

  const invalidRemoteLimit = await executeCli(
    [
      'process',
      'identity-preflight',
      '--input',
      '/tmp/process-preflight.json',
      '--remote-limit',
      '0',
    ],
    makeDeps(),
  );
  assert.equal(invalidRemoteLimit.exitCode, 2);
  assert.match(invalidRemoteLimit.stderr, /positive integer/u);
});

test('executeCli executes process build-plan validate and materialize with injected implementations', async () => {
  const baseReport = {
    schema_version: 1 as const,
    generated_at_utc: '2026-05-22T00:00:00.000Z',
    kind: 'process' as const,
    ruleset_id: 'process-authoring/strict',
    ruleset_version: '1',
    input_path: '/tmp/process-build-plan.json',
    out_dir: '/tmp/process-build-plan',
    report_only: false,
    inputs: {
      plan_schema_version: '1',
      identity_decision: 'create_new' as const,
      unit_of_analysis_decision: 'ready_for_materialization' as const,
    },
    required_fields: {
      required: ['target'],
      satisfied: ['target'],
      missing: [],
    },
    schema_validation: {
      status: 'not_applicable' as const,
      validator: null,
      issue_count: 0,
      issues: [],
    },
    findings: [],
    blockers: [],
    files: {
      gate_report: null,
      materialized_artifact: null,
    },
  };

  const validate = await executeCli(
    [
      'process',
      'build-plan',
      'validate',
      '--json',
      '--input',
      '/tmp/process-build-plan.json',
      '--out-dir',
      '/tmp/process-build-plan',
    ],
    {
      ...makeDeps(),
      runProcessBuildPlanValidateImpl: async (options) => {
        assert.equal(options.inputPath, '/tmp/process-build-plan.json');
        assert.equal(options.outDir, '/tmp/process-build-plan');
        assert.equal(options.reportOnly, false);
        return {
          ...baseReport,
          action: 'validate',
          status: 'passed',
          next_action: 'materialize_payload',
        };
      },
    },
  );
  assert.equal(validate.exitCode, 0);
  assert.match(validate.stdout, /"next_action":"materialize_payload"/u);

  const materialize = await executeCli(
    [
      'process',
      'build-plan',
      'materialize',
      '--input',
      '/tmp/process-build-plan.json',
      '--report-only',
    ],
    {
      ...makeDeps(),
      runProcessBuildPlanMaterializeImpl: async (options) => {
        assert.equal(options.inputPath, '/tmp/process-build-plan.json');
        assert.equal(options.outDir, null);
        assert.equal(options.reportOnly, true);
        return {
          ...baseReport,
          action: 'materialize',
          status: 'blocked',
          out_dir: null,
          report_only: true,
          blockers: [
            {
              code: 'build_plan_required_field_missing',
              severity: 'blocker',
              message: 'missing',
            },
          ],
          next_action: 'fix_build_plan',
        };
      },
    },
  );
  assert.equal(materialize.exitCode, 0);
  assert.match(materialize.stdout, /"status": "blocked"/u);

  const blockedValidate = await executeCli(
    ['process', 'build-plan', 'validate', '--input', '/tmp/process-build-plan.json'],
    {
      ...makeDeps(),
      runProcessBuildPlanValidateImpl: async () => ({
        ...baseReport,
        action: 'validate',
        status: 'blocked',
        blockers: [
          {
            code: 'identity_decision_not_automatic',
            severity: 'blocker',
            message: 'review needed',
          },
        ],
        next_action: 'fix_build_plan',
      }),
    },
  );
  assert.equal(blockedValidate.exitCode, 1);

  const missingAction = await executeCli(['process', 'build-plan'], makeDeps());
  assert.equal(missingAction.exitCode, 0);
  assert.match(missingAction.stdout, /tiangong-lca process build-plan/u);

  const invalid = await executeCli(['process', 'build-plan', 'bad'], makeDeps());
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /process build-plan action must be/u);

  const invalidFlag = await executeCli(
    ['process', 'build-plan', 'validate', '--input', '/tmp/process-build-plan.json', '--bad'],
    makeDeps(),
  );
  assert.equal(invalidFlag.exitCode, 2);
  assert.match(invalidFlag.stderr, /Unknown option/u);
});

test('executeCli executes flow build-plan and maps blockers to exit code 1', async () => {
  const result = await executeCli(
    ['flow', 'build-plan', 'validate', '--input', '/tmp/flow-build-plan.json'],
    {
      ...makeDeps(),
      runFlowBuildPlanValidateImpl: async (options) => {
        assert.equal(options.inputPath, '/tmp/flow-build-plan.json');
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-22T00:00:00.000Z',
          kind: 'flow',
          action: 'validate',
          status: 'blocked',
          ruleset_id: 'flow-authoring/strict',
          ruleset_version: '1',
          input_path: '/tmp/flow-build-plan.json',
          out_dir: null,
          report_only: false,
          inputs: {
            plan_schema_version: '1',
            identity_decision: 'manual_review',
            unit_of_analysis_decision: 'manual_review',
          },
          required_fields: {
            required: ['target'],
            satisfied: [],
            missing: ['target'],
          },
          schema_validation: {
            status: 'not_applicable',
            validator: null,
            issue_count: 0,
            issues: [],
          },
          findings: [],
          blockers: [
            {
              code: 'identity_decision_not_automatic',
              severity: 'blocker',
              message: 'review needed',
            },
          ],
          next_action: 'fix_build_plan',
          files: {
            gate_report: null,
            materialized_artifact: null,
          },
        };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /"next_action": "fix_build_plan"/u);

  const materialize = await executeCli(
    ['flow', 'build-plan', 'materialize', '--input', '/tmp/flow-build-plan.json'],
    {
      ...makeDeps(),
      runFlowBuildPlanMaterializeImpl: async (options) => {
        assert.equal(options.inputPath, '/tmp/flow-build-plan.json');
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-22T00:00:00.000Z',
          kind: 'flow',
          action: 'materialize',
          status: 'passed',
          ruleset_id: 'flow-authoring/strict',
          ruleset_version: '1',
          input_path: '/tmp/flow-build-plan.json',
          out_dir: null,
          report_only: false,
          inputs: {
            plan_schema_version: '1',
            identity_decision: 'create_new',
            unit_of_analysis_decision: 'declared_unit_dataset',
          },
          required_fields: {
            required: ['target'],
            satisfied: ['target'],
            missing: [],
          },
          schema_validation: {
            status: 'not_applicable',
            validator: null,
            issue_count: 0,
            issues: [],
          },
          findings: [],
          blockers: [],
          next_action: 'use_materialized_artifact',
          files: {
            gate_report: null,
            materialized_artifact: null,
          },
        };
      },
    },
  );
  assert.equal(materialize.exitCode, 0);
  assert.match(materialize.stdout, /"action": "materialize"/u);

  const invalid = await executeCli(['flow', 'build-plan', 'bad'], makeDeps());
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.stderr, /flow build-plan action must be/u);

  const missingAction = await executeCli(['flow', 'build-plan'], makeDeps());
  assert.equal(missingAction.exitCode, 0);
  assert.match(missingAction.stdout, /tiangong-lca flow build-plan/u);
});

test('executeCli executes flow get with injected implementation', async () => {
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  const result = await executeCli(
    [
      'flow',
      'get',
      '--id',
      'flow-1',
      '--version',
      '00.00.001',
      '--user-id',
      'user-1',
      '--state-code',
      '100',
    ],
    {
      ...deps,
      runFlowGetImpl: async (options) => {
        assert.equal(options.flowId, 'flow-1');
        assert.equal(options.version, '00.00.001');
        assert.equal(options.userId, 'user-1');
        assert.equal(options.stateCode, 100);
        assert.equal(options.env, deps.env);
        assert.equal(options.fetchImpl, deps.fetchImpl);
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-30T00:00:00.000Z',
          status: 'resolved_remote_flow',
          flow_id: 'flow-1',
          requested_version: '00.00.001',
          requested_user_id: 'user-1',
          requested_state_code: 100,
          resolved_version: '00.00.001',
          resolution: 'remote_supabase_exact',
          source_url: 'https://supabase.example/rest/v1/flows?id=eq.flow-1',
          modified_at: null,
          user_id: 'user-1',
          state_code: 100,
          flow: { flowDataSet: { id: 'flow-1' } },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status": "resolved_remote_flow"/u);
  assert.equal(result.stderr, '');
});

test('executeCli executes flow list with injected implementation', async () => {
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  const result = await executeCli(
    [
      'flow',
      'list',
      '--id',
      'flow-1',
      '--id',
      'flow-2',
      '--version',
      '00.00.001',
      '--user-id',
      'user-1',
      '--state-code',
      '0',
      '--state-code',
      '100',
      '--type-of-dataset',
      'Product flow',
      '--type',
      'Waste flow',
      '--all',
      '--page-size',
      '5',
      '--order',
      'id.asc,version.asc',
    ],
    {
      ...deps,
      runFlowListImpl: async (options) => {
        assert.deepEqual(options.ids, ['flow-1', 'flow-2']);
        assert.equal(options.version, '00.00.001');
        assert.equal(options.userId, 'user-1');
        assert.deepEqual(options.stateCodes, [0, 100]);
        assert.deepEqual(options.typeOfDataset, ['Product flow', 'Waste flow']);
        assert.equal(options.all, true);
        assert.equal(options.pageSize, 5);
        assert.equal(options.order, 'id.asc,version.asc');
        assert.equal(options.env, deps.env);
        assert.equal(options.fetchImpl, deps.fetchImpl);
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-30T00:00:00.000Z',
          status: 'listed_remote_flows',
          filters: {
            ids: ['flow-1', 'flow-2'],
            requested_version: '00.00.001',
            requested_user_id: 'user-1',
            requested_state_codes: [0, 100],
            requested_type_of_dataset: ['Product flow', 'Waste flow'],
            order: 'id.asc,version.asc',
            all: true,
            limit: null,
            offset: 0,
            page_size: 5,
          },
          count: 1,
          source_urls: ['https://supabase.example/rest/v1/flows'],
          rows: [
            {
              id: 'flow-1',
              version: '00.00.001',
              user_id: 'user-1',
              state_code: 100,
              modified_at: null,
              flow: { flowDataSet: { id: 'flow-1' } },
            },
          ],
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status": "listed_remote_flows"/u);
  assert.equal(result.stderr, '');
});

test('executeCli parses non-all flow list pagination flags', async () => {
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  const result = await executeCli(
    ['flow', 'list', '--id', 'flow-1', '--limit', '3', '--offset', '1'],
    {
      ...deps,
      runFlowListImpl: async (options) => {
        assert.deepEqual(options.ids, ['flow-1']);
        assert.equal(options.limit, 3);
        assert.equal(options.offset, 1);
        assert.equal(options.all, false);
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-30T00:00:00.000Z',
          status: 'listed_remote_flows',
          filters: {
            ids: ['flow-1'],
            requested_version: null,
            requested_user_id: null,
            requested_state_codes: [],
            requested_type_of_dataset: [],
            order: 'id.asc,version.asc',
            all: false,
            limit: 3,
            offset: 1,
            page_size: null,
          },
          count: 0,
          source_urls: ['https://supabase.example/rest/v1/flows'],
          rows: [],
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).filters.offset, 1);
});

test('executeCli executes flow identity-preflight with injected implementation', async () => {
  const result = await executeCli(
    [
      'flow',
      'identity-preflight',
      '--input',
      '/tmp/flow-preflight.json',
      '--remote-candidates',
      '--remote-query',
      'electricity flow',
      '--remote-limit',
      '2',
      '--remote-data-source',
      'my',
      '--timeout-ms',
      '30000',
    ],
    {
      ...makeDeps(),
      runFlowIdentityPreflightImpl: async (options) => {
        assert.equal(options.inputPath, '/tmp/flow-preflight.json');
        assert.equal(options.outDir, null);
        assert.equal(options.remoteCandidateSearch, true);
        assert.equal(options.remoteQuery, 'electricity flow');
        assert.equal(options.remoteLimit, 2);
        assert.equal(options.remoteDataSource, 'my');
        assert.equal(options.timeoutMs, 30000);
        return {
          schema_version: 1,
          generated_at_utc: '2026-05-22T00:00:00.000Z',
          kind: 'flow',
          status: 'passed',
          decision: 'create_new',
          confidence: 'medium',
          input_path: '/tmp/flow-preflight.json',
          out_dir: null,
          target: {
            id: null,
            version: null,
            names: [],
            fields: {},
            identity_key: 'flow-key',
            exchange_signature: [],
            schema_validation: {
              status: 'not_applicable',
              validator: null,
              issue_count: 0,
              issues: [],
            },
          },
          candidates: [],
          candidate_sources: [],
          findings: [
            {
              code: 'flow_no_duplicate_candidate',
              severity: 'info',
              message: 'new flow',
            },
          ],
          blockers: [],
          next_action: 'materialize_new_payload',
          files: {
            identity_decision: null,
            candidates: null,
            candidate_sources: null,
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"decision": "create_new"/u);
});

test('executeCli maps flow identity-preflight blocker reports to exit code 1', async () => {
  const result = await executeCli(
    ['flow', 'identity-preflight', '--input', '/tmp/flow-preflight.json'],
    {
      ...makeDeps(),
      runFlowIdentityPreflightImpl: async () => ({
        schema_version: 1,
        generated_at_utc: '2026-05-22T00:00:00.000Z',
        kind: 'flow',
        status: 'blocked',
        decision: 'block_duplicate',
        confidence: 'high',
        input_path: '/tmp/flow-preflight.json',
        out_dir: null,
        target: {
          id: null,
          version: null,
          names: [],
          fields: {},
          identity_key: 'flow-key',
          exchange_signature: [],
          schema_validation: {
            status: 'not_applicable',
            validator: null,
            issue_count: 0,
            issues: [],
          },
        },
        candidates: [],
        candidate_sources: [],
        findings: [],
        blockers: [
          {
            code: 'flow_duplicate_candidate',
            severity: 'blocker',
            message: 'duplicate',
          },
        ],
        next_action: 'stop_duplicate',
        files: {
          identity_decision: null,
          candidates: null,
          candidate_sources: null,
        },
      }),
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /"decision": "block_duplicate"/u);
});

test('executeCli executes flow list with explicit limit and offset', async () => {
  const deps = makeDeps({
    TIANGONG_LCA_API_BASE_URL: 'https://supabase.example/functions/v1',
    TIANGONG_LCA_ACCESS_TOKEN: 'supabase-api-key',
  });

  const result = await executeCli(
    ['flow', 'list', '--id', 'flow-1', '--limit', '7', '--offset', '3', '--json'],
    {
      ...deps,
      runFlowListImpl: async (options) => {
        assert.deepEqual(options.ids, ['flow-1']);
        assert.equal(options.limit, 7);
        assert.equal(options.offset, 3);
        assert.equal(options.all, false);
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-30T00:00:00.000Z',
          status: 'listed_remote_flows',
          filters: {
            ids: ['flow-1'],
            requested_version: null,
            requested_user_id: null,
            requested_state_codes: [],
            requested_type_of_dataset: [],
            order: 'id.asc,version.asc',
            all: false,
            limit: 7,
            offset: 3,
            page_size: null,
          },
          count: 0,
          source_urls: ['https://supabase.example/rest/v1/flows'],
          rows: [],
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"offset":3/u);
  assert.equal(result.stderr, '');
});

test('executeCli executes lifecyclemodel publish-resulting-process with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-publish-cli-'));

  try {
    const result = await executeCli(
      [
        'lifecyclemodel',
        'publish-resulting-process',
        '--json',
        '--run-dir',
        dir,
        '--publish-processes',
      ],
      {
        ...makeDeps(),
        runLifecyclemodelPublishResultingProcessImpl: async (options) => {
          assert.equal(options.runDir, dir);
          assert.equal(options.publishProcesses, true);
          assert.equal(options.publishRelations, false);
          return {
            generated_at_utc: '2026-03-29T00:00:00.000Z',
            run_dir: dir,
            status: 'prepared_local_publish_bundle',
            publish_processes: true,
            publish_relations: false,
            counts: {
              projected_processes: 1,
              relations: 0,
            },
            source_model: {
              id: 'lm-demo',
            },
            files: {
              projection_bundle: path.join(dir, 'process-projection-bundle.json'),
              projection_report: path.join(dir, 'projection-report.json'),
              publish_bundle: path.join(dir, 'publish-bundle.json'),
              publish_intent: path.join(dir, 'publish-intent.json'),
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"prepared_local_publish_bundle"/u);
    assert.match(result.stdout, /"publish_bundle"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process auto-build with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-auto-build-cli-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"flow_file":"./flow.json"}', 'utf8');

  try {
    const result = await executeCli(
      ['process', 'auto-build', '--json', '--input', inputPath, '--out-dir', './run-root'],
      {
        ...makeDeps(),
        runProcessAutoBuildImpl: async (options) => {
          assert.equal(options.inputPath, inputPath);
          assert.equal(options.outDir, './run-root');
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-29T00:00:00.000Z',
            status: 'prepared_local_process_auto_build_run',
            request_path: inputPath,
            request_id: 'pff-demo',
            run_id: 'pfw_demo_unknown_produce_20260329T000000Z',
            run_root: path.join(dir, 'run-root'),
            operation: 'produce',
            flow: {
              source_path: path.join(dir, 'flow.json'),
              artifact_path: path.join(dir, 'run-root', 'input', 'flow.json'),
              wrapper: 'flowDataSet',
              uuid: 'flow-uuid',
              version: '00.00.001',
              base_name: 'Demo flow',
            },
            source_input_count: 0,
            stage_count: 10,
            files: {
              request_snapshot: path.join(dir, 'run-root', 'request', 'pff-request.json'),
              normalized_request: path.join(dir, 'run-root', 'request', 'request.normalized.json'),
              source_policy: path.join(dir, 'run-root', 'request', 'source-policy.json'),
              flow_summary: path.join(dir, 'run-root', 'manifests', 'flow-summary.json'),
              input_manifest: path.join(dir, 'run-root', 'input', 'input_manifest.json'),
              build_plan: path.join(dir, 'run-root', 'manifests', 'process-build-plan.json'),
              assembly_plan: path.join(dir, 'run-root', 'manifests', 'assembly-plan.json'),
              lineage_manifest: path.join(dir, 'run-root', 'manifests', 'lineage-manifest.json'),
              invocation_index: path.join(dir, 'run-root', 'manifests', 'invocation-index.json'),
              run_manifest: path.join(dir, 'run-root', 'manifests', 'run-manifest.json'),
              state: path.join(dir, 'run-root', 'cache', 'process_from_flow_state.json'),
              handoff_summary: path.join(dir, 'run-root', 'cache', 'agent_handoff_summary.json'),
              report: path.join(dir, 'run-root', 'reports', 'process-auto-build-report.json'),
            },
            next_actions: ['inspect: state'],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"prepared_local_process_auto_build_run"/u);
    assert.match(result.stdout, /"request_snapshot"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process resume-build with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-resume-build-cli-'));
  const runDir = path.join(dir, 'artifacts', 'process_from_flow', 'run-1');

  try {
    const result = await executeCli(
      ['process', 'resume-build', '--json', '--run-id', 'run-1', '--run-dir', runDir],
      {
        ...makeDeps(),
        runProcessResumeBuildImpl: async (options) => {
          assert.equal(options.runId, 'run-1');
          assert.equal(options.runDir, runDir);
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-29T00:00:00.000Z',
            status: 'prepared_local_process_resume_run',
            run_id: 'run-1',
            run_root: runDir,
            request_id: 'req-1',
            resumed_from: '04_exchange_values',
            checkpoint: 'matches',
            attempt: 2,
            state_summary: {
              build_status: 'resume_prepared',
              next_stage: '04_exchange_values',
              stop_after: null,
              process_count: 1,
              matched_exchange_count: 1,
              process_dataset_count: 1,
              source_dataset_count: 1,
            },
            files: {
              state: path.join(runDir, 'cache', 'process_from_flow_state.json'),
              handoff_summary: path.join(runDir, 'cache', 'agent_handoff_summary.json'),
              run_manifest: path.join(runDir, 'manifests', 'run-manifest.json'),
              invocation_index: path.join(runDir, 'manifests', 'invocation-index.json'),
              resume_metadata: path.join(runDir, 'manifests', 'resume-metadata.json'),
              resume_history: path.join(runDir, 'manifests', 'resume-history.jsonl'),
              report: path.join(runDir, 'reports', 'process-resume-build-report.json'),
            },
            next_actions: ['inspect: state'],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"prepared_local_process_resume_run"/u);
    assert.match(result.stdout, /"resume_metadata"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process resume-build with run-dir only', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-resume-build-cli-rundir-'));
  const runDir = path.join(dir, 'artifacts', 'process_from_flow', 'run-2');

  try {
    const result = await executeCli(['process', 'resume-build', '--run-dir', runDir], {
      ...makeDeps(),
      runProcessResumeBuildImpl: async (options) => {
        assert.equal(options.runId, undefined);
        assert.equal(options.runDir, runDir);
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-29T00:10:00.000Z',
          status: 'prepared_local_process_resume_run',
          run_id: 'run-2',
          run_root: runDir,
          request_id: null,
          resumed_from: 'resume_prepared',
          checkpoint: null,
          attempt: 1,
          state_summary: {
            build_status: 'resume_prepared',
            next_stage: null,
            stop_after: null,
            process_count: 0,
            matched_exchange_count: 0,
            process_dataset_count: 0,
            source_dataset_count: 0,
          },
          files: {
            state: path.join(runDir, 'cache', 'process_from_flow_state.json'),
            handoff_summary: path.join(runDir, 'cache', 'agent_handoff_summary.json'),
            run_manifest: path.join(runDir, 'manifests', 'run-manifest.json'),
            invocation_index: path.join(runDir, 'manifests', 'invocation-index.json'),
            resume_metadata: path.join(runDir, 'manifests', 'resume-metadata.json'),
            resume_history: path.join(runDir, 'manifests', 'resume-history.jsonl'),
            report: path.join(runDir, 'reports', 'process-resume-build-report.json'),
          },
          next_actions: ['inspect: state'],
        };
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /prepared_local_process_resume_run/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process publish-build with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-publish-build-cli-'));
  const runDir = path.join(dir, 'artifacts', 'process_from_flow', 'run-3');

  try {
    const result = await executeCli(
      ['process', 'publish-build', '--json', '--run-id', 'run-3', '--run-dir', runDir],
      {
        ...makeDeps(),
        runProcessPublishBuildImpl: async (options) => {
          assert.equal(options.runId, 'run-3');
          assert.equal(options.runDir, runDir);
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-29T00:20:00.000Z',
            status: 'prepared_local_process_publish_bundle',
            run_id: 'run-3',
            run_root: runDir,
            request_id: 'req-3',
            state_summary: {
              build_status: 'resume_prepared',
              next_stage: '10_publish',
              stop_after: null,
            },
            dataset_origins: {
              processes: 'exports',
              sources: 'state',
            },
            counts: {
              processes: 2,
              sources: 1,
              relations: 0,
            },
            publish_defaults: {
              commit: false,
              publish_lifecyclemodels: false,
              publish_processes: true,
              publish_sources: true,
              publish_relations: true,
              publish_process_build_runs: false,
              relation_mode: 'local_manifest_only',
            },
            files: {
              state: path.join(runDir, 'cache', 'process_from_flow_state.json'),
              handoff_summary: path.join(runDir, 'cache', 'agent_handoff_summary.json'),
              run_manifest: path.join(runDir, 'manifests', 'run-manifest.json'),
              invocation_index: path.join(runDir, 'manifests', 'invocation-index.json'),
              publish_bundle: path.join(
                runDir,
                'stage_outputs',
                '10_publish',
                'publish-bundle.json',
              ),
              publish_request: path.join(
                runDir,
                'stage_outputs',
                '10_publish',
                'publish-request.json',
              ),
              publish_intent: path.join(
                runDir,
                'stage_outputs',
                '10_publish',
                'publish-intent.json',
              ),
              process_schema_gate: path.join(runDir, 'reports', 'process-publish-schema-gate.json'),
              report: path.join(runDir, 'reports', 'process-publish-build-report.json'),
            },
            next_actions: ['inspect: publish request'],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"prepared_local_process_publish_bundle"/u);
    assert.match(result.stdout, /"publish_request"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process publish-build with run-dir only', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-publish-build-cli-rundir-'));
  const runDir = path.join(dir, 'artifacts', 'process_from_flow', 'run-4');

  try {
    const result = await executeCli(['process', 'publish-build', '--run-dir', runDir], {
      ...makeDeps(),
      runProcessPublishBuildImpl: async (options) => {
        assert.equal(options.runId, undefined);
        assert.equal(options.runDir, runDir);
        return {
          schema_version: 1,
          generated_at_utc: '2026-03-29T00:21:00.000Z',
          status: 'prepared_local_process_publish_bundle',
          run_id: 'run-4',
          run_root: runDir,
          request_id: null,
          state_summary: {
            build_status: 'resume_prepared',
            next_stage: null,
            stop_after: null,
          },
          dataset_origins: {
            processes: 'state',
            sources: 'state',
          },
          counts: {
            processes: 1,
            sources: 0,
            relations: 0,
          },
          publish_defaults: {
            commit: false,
            publish_lifecyclemodels: false,
            publish_processes: true,
            publish_sources: true,
            publish_relations: true,
            publish_process_build_runs: false,
            relation_mode: 'local_manifest_only',
          },
          files: {
            state: path.join(runDir, 'cache', 'process_from_flow_state.json'),
            handoff_summary: path.join(runDir, 'cache', 'agent_handoff_summary.json'),
            run_manifest: path.join(runDir, 'manifests', 'run-manifest.json'),
            invocation_index: path.join(runDir, 'manifests', 'invocation-index.json'),
            publish_bundle: path.join(runDir, 'stage_outputs', '10_publish', 'publish-bundle.json'),
            publish_request: path.join(
              runDir,
              'stage_outputs',
              '10_publish',
              'publish-request.json',
            ),
            publish_intent: path.join(runDir, 'stage_outputs', '10_publish', 'publish-intent.json'),
            process_schema_gate: path.join(runDir, 'reports', 'process-publish-schema-gate.json'),
            report: path.join(runDir, 'reports', 'process-publish-build-report.json'),
          },
          next_actions: ['inspect: publish request'],
        };
      },
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /prepared_local_process_publish_bundle/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process save-draft with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-cli-'));
  const inputPath = path.join(dir, 'patched-processes.jsonl');
  writeFileSync(inputPath, '{"id":"proc-1"}\n', 'utf8');

  try {
    const result = await executeCli(
      [
        'process',
        'save-draft',
        '--json',
        '--input',
        inputPath,
        '--out-dir',
        './save-root',
        '--commit',
        '--target-user-id',
        'user-1',
      ],
      {
        ...makeDeps(),
        runProcessSaveDraftImpl: async (options) => {
          assert.equal(options.inputPath, inputPath);
          assert.equal(options.outDir, './save-root');
          assert.equal(options.commit, true);
          assert.equal(options.targetUserId, 'user-1');
          return {
            generated_at_utc: '2026-04-14T12:00:00.000Z',
            input_path: inputPath,
            input_kind: 'rows_file',
            out_dir: path.join(dir, 'save-root'),
            commit: true,
            mode: 'commit',
            target_user_id: 'user-1',
            account_guard: {
              target_user_id_required: true,
              target_user_id: 'user-1',
              commit_account_binding: 'current_cli_auth_session',
              post_write_verify_required: true,
            },
            status: 'completed',
            counts: {
              selected: 1,
              prepared: 0,
              executed: 1,
              failed: 0,
            },
            files: {
              normalized_input: path.join(dir, 'save-root', 'inputs', 'normalized-input.json'),
              selected_processes: path.join(
                dir,
                'save-root',
                'outputs',
                'save-draft-rpc',
                'selected-processes.jsonl',
              ),
              progress_jsonl: path.join(
                dir,
                'save-root',
                'outputs',
                'save-draft-rpc',
                'progress.jsonl',
              ),
              failures_jsonl: path.join(
                dir,
                'save-root',
                'outputs',
                'save-draft-rpc',
                'failures.jsonl',
              ),
              summary_json: path.join(
                dir,
                'save-root',
                'outputs',
                'save-draft-rpc',
                'summary.json',
              ),
            },
            processes: [
              {
                id: 'proc-1',
                version: '01.01.000',
                source: 'rows_file',
                bundle_path: null,
                status: 'executed',
                execution: {
                  status: 'success',
                  operation: 'save_draft',
                  write_path: 'cmd_dataset_save_draft',
                  rpc_result: { ok: true },
                  visible_row: {
                    id: 'proc-1',
                    version: '01.01.000',
                    user_id: 'user-1',
                    state_code: 0,
                  },
                },
              },
            ],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"completed"/u);
    assert.match(result.stdout, /"write_path":"cmd_dataset_save_draft"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process complete-required-fields with injected implementation', async () => {
  const result = await executeCli(
    [
      'process',
      'complete-required-fields',
      '--json',
      '--input',
      './processes.jsonl',
      '--out',
      './completed.jsonl',
      '--out-dir',
      './required-fields',
      '--flows',
      './flows.jsonl',
      '--default-unit',
      'MJ',
    ],
    {
      ...makeDeps(),
      runProcessRequiredFieldsCompleteImpl: async (options) => {
        assert.equal(options.inputPath, './processes.jsonl');
        assert.equal(options.outPath, './completed.jsonl');
        assert.equal(options.outDir, './required-fields');
        assert.equal(options.flowInputPath, './flows.jsonl');
        assert.equal(options.defaultUnit, 'MJ');
        return {
          generated_at_utc: '2026-05-23T00:00:00.000Z',
          input_path: '/tmp/processes.jsonl',
          out_path: '/tmp/completed.jsonl',
          out_dir: '/tmp/required-fields',
          status: 'completed',
          default_unit: 'MJ',
          counts: {
            total: 1,
            processes: 1,
            completed: 1,
            existing: 0,
            blocked: 0,
            skipped: 0,
          },
          files: {
            output_rows: '/tmp/completed.jsonl',
            report: '/tmp/report.json',
            evidence: '/tmp/evidence.jsonl',
          },
          rows: [],
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status":"completed"/u);
});

test('executeCli maps process complete-required-fields blockers to exit code 1', async () => {
  const result = await executeCli(
    ['process', 'complete-required-fields', '--input', './processes.jsonl', '--out', './out.jsonl'],
    {
      ...makeDeps(),
      runProcessRequiredFieldsCompleteImpl: async () => ({
        generated_at_utc: '2026-05-23T00:00:00.000Z',
        input_path: '/tmp/processes.jsonl',
        out_path: '/tmp/out.jsonl',
        out_dir: null,
        status: 'completed_with_blockers',
        default_unit: 'unit',
        counts: {
          total: 1,
          processes: 1,
          completed: 0,
          existing: 0,
          blocked: 1,
          skipped: 0,
        },
        files: {
          output_rows: '/tmp/out.jsonl',
          report: null,
          evidence: null,
        },
        rows: [
          {
            index: 0,
            id: 'proc-1',
            version: '01.01.000',
            type: 'process',
            status: 'blocked',
            issues: [
              {
                code: 'process_placeholder_content',
                message: 'placeholder content',
                path: 'processDataSet.processInformation.dataSetInformation.common:generalComment',
              },
            ],
            completions: [],
          },
        ],
      }),
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /process_placeholder_content/u);
});

test('executeCli maps process save-draft failures to exit code 1', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-save-draft-cli-failure-'));
  const inputPath = path.join(dir, 'patched-processes.jsonl');
  writeFileSync(inputPath, '{"id":"proc-1"}\n', 'utf8');

  try {
    const result = await executeCli(['process', 'save-draft', '--input', inputPath], {
      ...makeDeps(),
      runProcessSaveDraftImpl: async () => ({
        generated_at_utc: '2026-04-14T12:05:00.000Z',
        input_path: inputPath,
        input_kind: 'rows_file',
        out_dir: path.join(dir, 'save-root'),
        commit: false,
        mode: 'dry_run',
        target_user_id: null,
        account_guard: {
          target_user_id_required: false,
          target_user_id: null,
          commit_account_binding: 'current_cli_auth_session',
          post_write_verify_required: false,
        },
        status: 'completed_with_failures',
        counts: {
          selected: 1,
          prepared: 0,
          executed: 0,
          failed: 1,
        },
        files: {
          normalized_input: path.join(dir, 'save-root', 'inputs', 'normalized-input.json'),
          selected_processes: path.join(
            dir,
            'save-root',
            'outputs',
            'save-draft-rpc',
            'selected-processes.jsonl',
          ),
          progress_jsonl: path.join(
            dir,
            'save-root',
            'outputs',
            'save-draft-rpc',
            'progress.jsonl',
          ),
          failures_jsonl: path.join(
            dir,
            'save-root',
            'outputs',
            'save-draft-rpc',
            'failures.jsonl',
          ),
          summary_json: path.join(dir, 'save-root', 'outputs', 'save-draft-rpc', 'summary.json'),
        },
        processes: [
          {
            id: 'proc-1',
            version: '01.01.000',
            source: 'rows_file',
            bundle_path: null,
            status: 'failed',
            error: { message: 'owner required' },
          },
        ],
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /owner required/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli rejects conflicting process save-draft mode flags', async () => {
  const result = await executeCli(
    ['process', 'save-draft', '--input', './rows.jsonl', '--commit', '--dry-run'],
    makeDeps(),
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /INVALID_PROCESS_SAVE_DRAFT_MODE/u);
});

test('executeCli executes process refresh-references with injected implementation', async () => {
  const result = await executeCli(
    [
      'process',
      'refresh-references',
      '--json',
      '--out-dir',
      './refresh-root',
      '--apply',
      '--reuse-manifest',
      '--limit',
      '5',
      '--page-size',
      '200',
      '--concurrency',
      '2',
    ],
    {
      ...makeDeps(),
      runProcessRefreshReferencesImpl: async (options) => {
        assert.equal(options.outDir, './refresh-root');
        assert.equal(options.apply, true);
        assert.equal(options.reuseManifest, true);
        assert.equal(options.limit, 5);
        assert.equal(options.pageSize, 200);
        assert.equal(options.concurrency, 2);
        return {
          schema_version: 1,
          generated_at_utc: '2026-04-18T10:00:00.000Z',
          status: 'completed_process_reference_refresh',
          out_dir: '/tmp/refresh-root',
          mode: 'apply',
          user_id: 'user-1',
          masked_user_email: 'us****@example.com',
          counts: {
            manifest: 8,
            selected: 5,
            already_completed: 1,
            pending: 4,
            saved: 3,
            dry_run: 0,
            skipped: 1,
            validation_blocked: 0,
            errors: 0,
          },
          files: {
            manifest: '/tmp/refresh-root/inputs/processes.manifest.json',
            progress_jsonl: '/tmp/refresh-root/outputs/progress.jsonl',
            errors_jsonl: '/tmp/refresh-root/outputs/errors.jsonl',
            validation_blockers_jsonl: '/tmp/refresh-root/outputs/validation-blockers.jsonl',
            summary_json: '/tmp/refresh-root/outputs/summary.json',
            report_md: '/tmp/refresh-root/reports/process-refresh-references.md',
          },
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"status":"completed_process_reference_refresh"/u);
  assert.match(result.stdout, /"saved":3/u);
});

test('executeCli returns exit code 1 when process refresh-references reports errors', async () => {
  const result = await executeCli(
    ['process', 'refresh-references', '--json', '--out-dir', './refresh-root'],
    {
      ...makeDeps(),
      runProcessRefreshReferencesImpl: async () => ({
        schema_version: 1,
        generated_at_utc: '2026-04-18T10:02:00.000Z',
        status: 'completed_process_reference_refresh_with_errors',
        out_dir: '/tmp/refresh-root',
        mode: 'dry_run',
        user_id: 'user-1',
        masked_user_email: 'us****@example.com',
        counts: {
          manifest: 1,
          selected: 1,
          already_completed: 0,
          pending: 1,
          saved: 0,
          dry_run: 0,
          skipped: 0,
          validation_blocked: 0,
          errors: 1,
        },
        files: {
          manifest: '/tmp/refresh-root/inputs/processes.manifest.json',
          progress_jsonl: '/tmp/refresh-root/outputs/progress.jsonl',
          errors_jsonl: '/tmp/refresh-root/outputs/errors.jsonl',
          validation_blockers_jsonl: '/tmp/refresh-root/outputs/validation-blockers.jsonl',
          summary_json: '/tmp/refresh-root/outputs/summary.json',
          report_md: '/tmp/refresh-root/reports/process-refresh-references.md',
        },
      }),
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /"errors":1/u);
});

test('executeCli executes process verify-rows with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-verify-rows-cli-'));
  const rowsFile = path.join(dir, 'rows.json');
  writeFileSync(rowsFile, '{}\n', 'utf8');

  try {
    const result = await executeCli(
      ['process', 'verify-rows', '--json', '--rows-file', rowsFile, '--out-dir', './verify-root'],
      {
        ...makeDeps(),
        runProcessVerifyRowsImpl: async (options) => {
          assert.equal(options.rowsFile, rowsFile);
          assert.equal(options.outDir, './verify-root');
          return {
            schema_version: 1,
            generated_at_utc: '2026-04-18T10:05:00.000Z',
            status: 'completed_with_invalid_process_rows',
            rows_file: rowsFile,
            out_dir: path.join(dir, 'verify-root'),
            row_count: 2,
            invalid_count: 1,
            schema_invalid_count: 1,
            missing_required_name_field_count: 1,
            invalid_rows: [
              {
                id: 'proc-1',
                version: '01.00.001',
                row_index: 0,
                missing_required_fields: ['mixAndLocationTypes'],
                schema_issue_count: 2,
              },
            ],
            files: {
              summary_json: path.join(dir, 'verify-root', 'outputs', 'summary.json'),
              verification_jsonl: path.join(dir, 'verify-root', 'outputs', 'verification.jsonl'),
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /"invalid_count":1/u);
    assert.match(result.stdout, /"status":"completed_with_invalid_process_rows"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns exit code 0 when process verify-rows finds no invalid rows', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-verify-rows-cli-ok-'));
  const rowsFile = path.join(dir, 'rows.json');
  writeFileSync(rowsFile, '{}\n', 'utf8');

  try {
    const result = await executeCli(
      ['process', 'verify-rows', '--json', '--rows-file', rowsFile, '--out-dir', './verify-root'],
      {
        ...makeDeps(),
        runProcessVerifyRowsImpl: async () => ({
          schema_version: 1,
          generated_at_utc: '2026-04-18T10:06:00.000Z',
          status: 'completed_process_row_verification',
          rows_file: rowsFile,
          out_dir: path.join(dir, 'verify-root'),
          row_count: 1,
          invalid_count: 0,
          schema_invalid_count: 0,
          missing_required_name_field_count: 0,
          invalid_rows: [],
          files: {
            summary_json: path.join(dir, 'verify-root', 'outputs', 'summary.json'),
            verification_jsonl: path.join(dir, 'verify-root', 'outputs', 'verification.jsonl'),
          },
        }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"completed_process_row_verification"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes process batch-build with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-batch-build-cli-'));
  const inputPath = path.join(dir, 'batch-request.json');
  writeFileSync(inputPath, '{"items":["./request-a.json"]}', 'utf8');

  try {
    const result = await executeCli(
      ['process', 'batch-build', '--json', '--input', inputPath, '--out-dir', './batch-root'],
      {
        ...makeDeps(),
        runProcessBatchBuildImpl: async (options) => {
          assert.equal(options.inputPath, inputPath);
          assert.equal(options.outDir, './batch-root');
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-29T00:22:00.000Z',
            status: 'completed',
            manifest_path: inputPath,
            batch_id: 'batch-1',
            batch_root: path.join(dir, 'batch-root'),
            continue_on_error: true,
            counts: {
              total: 1,
              prepared: 1,
              failed: 0,
              skipped: 0,
            },
            files: {
              request_snapshot: path.join(dir, 'batch-root', 'request', 'batch-request.json'),
              normalized_request: path.join(
                dir,
                'batch-root',
                'request',
                'request.normalized.json',
              ),
              invocation_index: path.join(dir, 'batch-root', 'manifests', 'invocation-index.json'),
              run_manifest: path.join(dir, 'batch-root', 'manifests', 'run-manifest.json'),
              report: path.join(dir, 'batch-root', 'reports', 'process-batch-build-report.json'),
            },
            items: [
              {
                item_id: 'request_a',
                index: 0,
                input_path: path.join(dir, 'request-a.json'),
                out_dir: path.join(dir, 'batch-root', 'runs', '001_request_a'),
                status: 'prepared',
                run_id: 'run-1',
                run_root: path.join(dir, 'batch-root', 'runs', '001_request_a'),
                request_id: 'req-1',
                files: {
                  request_snapshot: path.join(dir, 'item', 'request.json'),
                  report: path.join(dir, 'item', 'report.json'),
                  state: path.join(dir, 'item', 'state.json'),
                  handoff_summary: path.join(dir, 'item', 'handoff.json'),
                  run_manifest: path.join(dir, 'item', 'run-manifest.json'),
                },
                error: null,
              },
            ],
            next_actions: ['inspect: report'],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status":"completed"/u);
    assert.match(result.stdout, /"batch_id":"batch-1"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli maps process batch-build failures to exit code 1', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-batch-build-cli-failure-'));
  const inputPath = path.join(dir, 'batch-request.json');
  writeFileSync(inputPath, '{"items":["./request-a.json"]}', 'utf8');

  try {
    const result = await executeCli(['process', 'batch-build', '--input', inputPath], {
      ...makeDeps(),
      runProcessBatchBuildImpl: async () => ({
        schema_version: 1,
        generated_at_utc: '2026-03-29T00:23:00.000Z',
        status: 'completed_with_failures',
        manifest_path: inputPath,
        batch_id: 'batch-2',
        batch_root: path.join(dir, 'batch-root'),
        continue_on_error: true,
        counts: {
          total: 1,
          prepared: 0,
          failed: 1,
          skipped: 0,
        },
        files: {
          request_snapshot: path.join(dir, 'batch-root', 'request', 'batch-request.json'),
          normalized_request: path.join(dir, 'batch-root', 'request', 'request.normalized.json'),
          invocation_index: path.join(dir, 'batch-root', 'manifests', 'invocation-index.json'),
          run_manifest: path.join(dir, 'batch-root', 'manifests', 'run-manifest.json'),
          report: path.join(dir, 'batch-root', 'reports', 'process-batch-build-report.json'),
        },
        items: [],
        next_actions: ['inspect: report'],
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /completed_with_failures/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli keeps subcommand --json inside remote command parsing', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-search-json-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"query":"steel"}', 'utf8');

  try {
    const result = await executeCli(['search', 'flow', '--json', '--input', inputPath], makeDeps());
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '{"ok":true}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli respects explicit URL and region override flags', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-search-overrides-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"query":"steel"}', 'utf8');

  try {
    const result = await executeCli(
      [
        'search',
        'flow',
        '--dry-run',
        '--input',
        inputPath,
        '--base-url',
        'https://override.example/functions/v1',
        '--region',
        'eu-west-1',
      ],
      makeDeps(),
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /override\.example\/functions\/v1\/flow_hybrid_search/u);
    assert.match(result.stdout, /eu-west-1/u);
    assert.match(result.stdout, /Bearer \*\*\*\*/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli resolves remote config from canonical TIANGONG_LCA_* env keys', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-search-env-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"query":"steel"}', 'utf8');

  try {
    const result = await executeCli(
      ['search', 'process', '--dry-run', '--input', inputPath],
      makeDeps({
        TIANGONG_LCA_API_BASE_URL: 'https://env.example/functions/v1',
        TIANGONG_LCA_ACCESS_TOKEN: 'env-token',
        TIANGONG_LCA_REGION: 'cn-east-1',
      }),
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /env\.example\/functions\/v1\/process_hybrid_search/u);
    assert.match(result.stdout, /cn-east-1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes admin embedding-run dry-run with default region fallback', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-admin-dry-run-'));
  const inputPath = path.join(dir, 'jobs.json');
  writeFileSync(inputPath, '[{"jobId":1}]', 'utf8');

  try {
    const result = await executeCli(
      ['admin', 'embedding-run', '--dry-run', '--input', inputPath],
      makeDeps({
        TIANGONG_LCA_REGION: undefined,
      }),
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /embedding_ft/u);
    assert.doesNotMatch(result.stdout, /x-region/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli surfaces missing search API configuration after exhausting all fallbacks', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-search-missing-config-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"query":"steel"}', 'utf8');

  try {
    const result = await executeCli(
      ['search', 'flow', '--input', inputPath],
      makeDeps({
        TIANGONG_LCA_API_BASE_URL: undefined,
        TIANGONG_LCA_ACCESS_TOKEN: '',
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: undefined,
        TIANGONG_LCA_REGION: undefined,
      }),
    );

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /SUPABASE_REST_ENV_REQUIRED/u);
    assert.match(result.stderr, /TIANGONG_LCA_API_BASE_URL/u);
    assert.match(result.stderr, /TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli surfaces missing admin API configuration after exhausting all fallbacks', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-admin-missing-config-'));
  const inputPath = path.join(dir, 'jobs.json');
  writeFileSync(inputPath, '[{"jobId":1}]', 'utf8');

  try {
    const result = await executeCli(
      ['admin', 'embedding-run', '--input', inputPath],
      makeDeps({
        TIANGONG_LCA_API_BASE_URL: undefined,
        TIANGONG_LCA_ACCESS_TOKEN: '',
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: undefined,
        TIANGONG_LCA_REGION: undefined,
      }),
    );

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /SUPABASE_REST_ENV_REQUIRED/u);
    assert.match(result.stderr, /TIANGONG_LCA_API_BASE_URL/u);
    assert.match(result.stderr, /TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns remote error payloads for invalid remote flags', async () => {
  const result = await executeCli(['search', 'flow', '--timeout-ms', '0'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /INVALID_TIMEOUT/u);
});

test('executeCli returns parsing errors for invalid remote flags', async () => {
  const result = await executeCli(['search', 'flow', '--bad-flag'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /INVALID_ARGS/u);
  assert.match(result.stderr, /Unknown option '--bad-flag'/u);
});

test('executeCli returns parsing errors for invalid doctor flags', async () => {
  const result = await executeCli(['doctor', '--bad-flag'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /INVALID_ARGS/u);
  assert.match(result.stderr, /Unknown option '--bad-flag'/u);
});

test('executeCli returns unexpected error payloads from remote execution failures', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-search-error-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"query":"steel"}', 'utf8');

  try {
    const result = await executeCli(['search', 'flow', '--input', inputPath], {
      ...makeDeps(),
      fetchImpl: (async (input) => {
        if (isSupabaseAuthTokenUrl(String(input))) {
          return makeSupabaseAuthResponse();
        }

        throw new Error('network down');
      }) as FetchLike,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /UNEXPECTED_ERROR/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes publish run with mode overrides and compact JSON output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-cli-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"publish":{"commit":false}}', 'utf8');

  try {
    const result = await executeCli(
      ['publish', 'run', '--json', '--commit', '--input', inputPath, '--out-dir', './out'],
      {
        ...makeDeps(),
        runPublishImpl: async (options) => {
          assert.equal(options.inputPath, inputPath);
          assert.equal(options.outDir, './out');
          assert.equal(options.commit, true);
          return {
            generated_at_utc: '2026-03-28T00:00:00.000Z',
            request_path: inputPath,
            out_dir: path.join(dir, 'out'),
            commit: true,
            status: 'completed',
            counts: {
              bundle_paths: 0,
              lifecyclemodels: 0,
              processes: 0,
              sources: 0,
              relations: 0,
              process_build_runs: 0,
              executed: 0,
              deferred: 0,
              failed: 0,
            },
            files: {
              normalized_request: path.join(dir, 'out', 'normalized-request.json'),
              collected_inputs: path.join(dir, 'out', 'collected-inputs.json'),
              relation_manifest: path.join(dir, 'out', 'relation-manifest.json'),
              verification_report: path.join(dir, 'out', 'verification-report.json'),
              publish_report: path.join(dir, 'out', 'publish-report.json'),
            },
            verification: {
              schema_version: 1,
              generated_at_utc: '2026-03-28T00:00:00.000Z',
              command: 'publish run',
              status: 'passed',
              ruleset_id: 'publish-run/default',
              ruleset_version: '1',
              ruleset_source_version: '2026.05.23',
              ruleset_rule_ids: ['tidas.publish.verification.required'],
              commit: true,
              findings: [],
              blockers: [],
              next_action: 'ready_for_commit_or_publish',
              counts: {
                findings: 0,
                blockers: 0,
                failed: 0,
                deferred: 0,
                executed: 0,
              },
            },
            lifecyclemodels: [],
            processes: [],
            sources: [],
            process_build_runs: [],
            relations: {
              generated_at_utc: '2026-03-28T00:00:00.000Z',
              relation_mode: 'local_manifest_only',
              status: 'prepared_local_relation_manifest',
              relations: [],
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes('\n'), true);
    assert.match(result.stdout, /"commit":true/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli maps publish dry-run override and completed_with_failures exit code', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-publish-cli-failure-'));
  const inputPath = path.join(dir, 'request.json');
  writeFileSync(inputPath, '{"publish":{"commit":true}}', 'utf8');

  try {
    const result = await executeCli(['publish', 'run', '--dry-run', '--input', inputPath], {
      ...makeDeps(),
      runPublishImpl: async (options) => {
        assert.equal(options.commit, false);
        return {
          generated_at_utc: '2026-03-28T00:00:00.000Z',
          request_path: inputPath,
          out_dir: path.join(dir, 'out'),
          commit: false,
          status: 'completed_with_failures',
          counts: {
            bundle_paths: 0,
            lifecyclemodels: 0,
            processes: 0,
            sources: 0,
            relations: 0,
            process_build_runs: 0,
            executed: 0,
            deferred: 0,
            failed: 1,
          },
          files: {
            normalized_request: path.join(dir, 'out', 'normalized-request.json'),
            collected_inputs: path.join(dir, 'out', 'collected-inputs.json'),
            relation_manifest: path.join(dir, 'out', 'relation-manifest.json'),
            verification_report: path.join(dir, 'out', 'verification-report.json'),
            publish_report: path.join(dir, 'out', 'publish-report.json'),
          },
          verification: {
            schema_version: 1,
            generated_at_utc: '2026-03-28T00:00:00.000Z',
            command: 'publish run',
            status: 'blocked',
            ruleset_id: 'publish-run/default',
            ruleset_version: '1',
            ruleset_source_version: '2026.05.23',
            ruleset_rule_ids: ['tidas.publish.verification.required'],
            commit: false,
            findings: [],
            blockers: [],
            next_action: 'fix_blockers',
            counts: {
              findings: 0,
              blockers: 0,
              failed: 1,
              deferred: 0,
              executed: 0,
            },
          },
          lifecyclemodels: [],
          processes: [],
          sources: [],
          process_build_runs: [],
          relations: {
            generated_at_utc: '2026-03-28T00:00:00.000Z',
            relation_mode: 'local_manifest_only',
            status: 'prepared_local_relation_manifest',
            relations: [],
          },
        };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /completed_with_failures/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli rejects conflicting publish mode flags', async () => {
  const result = await executeCli(
    ['publish', 'run', '--input', './request.json', '--commit', '--dry-run'],
    makeDeps(),
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /INVALID_PUBLISH_MODE/u);
});

test('executeCli returns parsing errors for invalid publish and validation flags', async () => {
  const publishResult = await executeCli(['publish', 'run', '--bad-flag'], makeDeps());
  assert.equal(publishResult.exitCode, 2);
  assert.match(publishResult.stderr, /INVALID_ARGS/u);

  const validationResult = await executeCli(['validation', 'run', '--bad-flag'], makeDeps());
  assert.equal(validationResult.exitCode, 2);
  assert.match(validationResult.stderr, /INVALID_ARGS/u);

  const reviewFlagResult = await executeCli(['qa', 'process', '--bad-flag'], makeDeps());
  assert.equal(reviewFlagResult.exitCode, 2);
  assert.match(reviewFlagResult.stderr, /INVALID_ARGS/u);

  const reviewResult = await executeCli(
    [
      'qa',
      'process',
      '--run-root',
      '/tmp/run',
      '--run-id',
      'run',
      '--out-dir',
      '/tmp/out',
      '--llm-max-processes',
      '0',
    ],
    makeDeps(),
  );
  assert.equal(reviewResult.exitCode, 2);
  assert.match(reviewResult.stderr, /INVALID_LLM_MAX_PROCESSES/u);
});

test('executeCli returns parsing errors for invalid lifecyclemodel, process, and publish-build flags', async () => {
  const result = await executeCli(
    ['lifecyclemodel', 'build-resulting-process', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /INVALID_ARGS/u);

  const validateBuildResult = await executeCli(
    ['lifecyclemodel', 'validate-build', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(validateBuildResult.exitCode, 2);
  assert.equal(validateBuildResult.stdout, '');
  assert.match(validateBuildResult.stderr, /INVALID_ARGS/u);

  const lifecyclemodelPublishBuildResult = await executeCli(
    ['lifecyclemodel', 'publish-build', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(lifecyclemodelPublishBuildResult.exitCode, 2);
  assert.equal(lifecyclemodelPublishBuildResult.stdout, '');
  assert.match(lifecyclemodelPublishBuildResult.stderr, /INVALID_ARGS/u);

  const publishResult = await executeCli(
    ['lifecyclemodel', 'publish-resulting-process', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(publishResult.exitCode, 2);
  assert.equal(publishResult.stdout, '');
  assert.match(publishResult.stderr, /INVALID_ARGS/u);

  const orchestrateResult = await executeCli(
    ['lifecyclemodel', 'orchestrate', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(orchestrateResult.exitCode, 2);
  assert.equal(orchestrateResult.stdout, '');
  assert.match(orchestrateResult.stderr, /INVALID_ARGS/u);

  const reviewLifecyclemodelResult = await executeCli(
    ['qa', 'lifecyclemodel', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(reviewLifecyclemodelResult.exitCode, 2);
  assert.equal(reviewLifecyclemodelResult.stdout, '');
  assert.match(reviewLifecyclemodelResult.stderr, /INVALID_ARGS/u);

  const invalidOrchestrateActionResult = await executeCli(
    ['lifecyclemodel', 'orchestrate', 'bad-action'],
    makeDeps(),
  );
  assert.equal(invalidOrchestrateActionResult.exitCode, 2);
  assert.equal(invalidOrchestrateActionResult.stdout, '');
  assert.match(invalidOrchestrateActionResult.stderr, /INVALID_ARGS/u);

  const processGetResult = await executeCli(['process', 'get', '--bad-flag'], makeDeps());
  assert.equal(processGetResult.exitCode, 2);
  assert.equal(processGetResult.stdout, '');
  assert.match(processGetResult.stderr, /INVALID_ARGS/u);

  const processListResult = await executeCli(['process', 'list', '--bad-flag'], makeDeps());
  assert.equal(processListResult.exitCode, 2);
  assert.equal(processListResult.stdout, '');
  assert.match(processListResult.stderr, /INVALID_ARGS/u);

  const processListPageSizeResult = await executeCli(
    ['process', 'list', '--page-size', '10'],
    makeDeps(),
  );
  assert.equal(processListPageSizeResult.exitCode, 2);
  assert.match(processListPageSizeResult.stderr, /PROCESS_LIST_PAGE_SIZE_REQUIRES_ALL/u);

  const processListStateCodeResult = await executeCli(
    ['process', 'list', '--state-code=-1'],
    makeDeps(),
  );
  assert.equal(processListStateCodeResult.exitCode, 2);
  assert.match(processListStateCodeResult.stderr, /INVALID_PROCESS_LIST_STATE_CODE/u);

  const processListLimitResult = await executeCli(['process', 'list', '--limit=0'], makeDeps());
  assert.equal(processListLimitResult.exitCode, 2);
  assert.match(processListLimitResult.stderr, /INVALID_PROCESS_LIST_LIMIT/u);

  const processListOffsetResult = await executeCli(['process', 'list', '--offset=-1'], makeDeps());
  assert.equal(processListOffsetResult.exitCode, 2);
  assert.match(processListOffsetResult.stderr, /INVALID_PROCESS_LIST_OFFSET/u);

  const processResult = await executeCli(['process', 'auto-build', '--bad-flag'], makeDeps());
  assert.equal(processResult.exitCode, 2);
  assert.equal(processResult.stdout, '');
  assert.match(processResult.stderr, /INVALID_ARGS/u);

  const processDedupReviewResult = await executeCli(
    ['process', 'dedup-review', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processDedupReviewResult.exitCode, 2);
  assert.equal(processDedupReviewResult.stdout, '');
  assert.match(processDedupReviewResult.stderr, /INVALID_ARGS/u);

  const processResumeResult = await executeCli(
    ['process', 'resume-build', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processResumeResult.exitCode, 2);
  assert.equal(processResumeResult.stdout, '');
  assert.match(processResumeResult.stderr, /INVALID_ARGS/u);

  const processPublishResult = await executeCli(
    ['process', 'publish-build', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processPublishResult.exitCode, 2);
  assert.equal(processPublishResult.stdout, '');
  assert.match(processPublishResult.stderr, /INVALID_ARGS/u);

  const processSaveDraftResult = await executeCli(
    ['process', 'save-draft', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processSaveDraftResult.exitCode, 2);
  assert.equal(processSaveDraftResult.stdout, '');
  assert.match(processSaveDraftResult.stderr, /INVALID_ARGS/u);

  const processRequiredFieldsResult = await executeCli(
    ['process', 'complete-required-fields', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processRequiredFieldsResult.exitCode, 2);
  assert.equal(processRequiredFieldsResult.stdout, '');
  assert.match(processRequiredFieldsResult.stderr, /INVALID_ARGS/u);

  const processRefreshArgsResult = await executeCli(
    ['process', 'refresh-references', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processRefreshArgsResult.exitCode, 2);
  assert.equal(processRefreshArgsResult.stdout, '');
  assert.match(processRefreshArgsResult.stderr, /INVALID_ARGS/u);

  const processRefreshLimitResult = await executeCli(
    ['process', 'refresh-references', '--out-dir', './refresh-root', '--limit', '0'],
    makeDeps(),
  );
  assert.equal(processRefreshLimitResult.exitCode, 2);
  assert.match(processRefreshLimitResult.stderr, /INVALID_PROCESS_REFRESH_LIMIT/u);

  const processRefreshPageSizeResult = await executeCli(
    ['process', 'refresh-references', '--out-dir', './refresh-root', '--page-size', '0'],
    makeDeps(),
  );
  assert.equal(processRefreshPageSizeResult.exitCode, 2);
  assert.match(processRefreshPageSizeResult.stderr, /INVALID_PROCESS_REFRESH_PAGE_SIZE/u);

  const processRefreshConcurrencyResult = await executeCli(
    ['process', 'refresh-references', '--out-dir', './refresh-root', '--concurrency', '0'],
    makeDeps(),
  );
  assert.equal(processRefreshConcurrencyResult.exitCode, 2);
  assert.match(processRefreshConcurrencyResult.stderr, /INVALID_PROCESS_REFRESH_CONCURRENCY/u);

  const processRefreshModeConflictResult = await executeCli(
    ['process', 'refresh-references', '--out-dir', './refresh-root', '--apply', '--dry-run'],
    makeDeps(),
  );
  assert.equal(processRefreshModeConflictResult.exitCode, 2);
  assert.match(processRefreshModeConflictResult.stderr, /PROCESS_REFRESH_MODE_CONFLICT/u);

  const processScopeArgsResult = await executeCli(
    ['process', 'scope-statistics', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processScopeArgsResult.exitCode, 2);
  assert.equal(processScopeArgsResult.stdout, '');
  assert.match(processScopeArgsResult.stderr, /INVALID_ARGS/u);

  const processScopeStateCodeResult = await executeCli(
    ['process', 'scope-statistics', '--state-code=-1'],
    makeDeps(),
  );
  assert.equal(processScopeStateCodeResult.exitCode, 2);
  assert.match(processScopeStateCodeResult.stderr, /INVALID_PROCESS_SCOPE_STATE_CODE/u);

  const processScopePageSizeResult = await executeCli(
    ['process', 'scope-statistics', '--page-size', '0'],
    makeDeps(),
  );
  assert.equal(processScopePageSizeResult.exitCode, 2);
  assert.match(processScopePageSizeResult.stderr, /INVALID_PROCESS_SCOPE_PAGE_SIZE/u);

  const processScopeInvalidScopeResult = await executeCli(
    ['process', 'scope-statistics', '--scope', 'owner'],
    makeDeps(),
  );
  assert.equal(processScopeInvalidScopeResult.exitCode, 2);
  assert.match(processScopeInvalidScopeResult.stderr, /INVALID_PROCESS_SCOPE_SCOPE/u);

  const processVerifyArgsResult = await executeCli(
    ['process', 'verify-rows', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(processVerifyArgsResult.exitCode, 2);
  assert.equal(processVerifyArgsResult.stdout, '');
  assert.match(processVerifyArgsResult.stderr, /INVALID_ARGS/u);

  const processBatchResult = await executeCli(['process', 'batch-build', '--bad-flag'], makeDeps());
  assert.equal(processBatchResult.exitCode, 2);
  assert.equal(processBatchResult.stdout, '');
  assert.match(processBatchResult.stderr, /INVALID_ARGS/u);
});

test('executeCli executes validation run with injected implementation and report file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-cli-'));

  try {
    const result = await executeCli(
      [
        'validation',
        'run',
        '--json',
        '--input-dir',
        dir,
        '--engine',
        'sdk',
        '--report-file',
        './validation-report.json',
      ],
      {
        ...makeDeps(),
        runValidationImpl: async (options) => {
          assert.equal(options.inputDir, dir);
          assert.equal(options.engine, 'sdk');
          assert.equal(options.reportFile, './validation-report.json');
          return {
            input_dir: dir,
            mode: 'sdk',
            ok: false,
            summary: {
              engine_count: 1,
              ok_count: 0,
              failed_count: 1,
            },
            files: {
              report: path.join(dir, 'validation-report.json'),
            },
            reports: [],
            comparison: null,
          };
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /"mode":"sdk"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes qa process with injected implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-review-cli-'));

  try {
    const result = await executeCli(
      [
        'qa',
        'process',
        '--reference-rows-file',
        path.join(dir, 'flows.jsonl'),
        '--reference-rows-file',
        path.join(dir, 'support.json'),
        '--run-root',
        path.join(dir, 'run-root'),
        '--run-id',
        'run-001',
        '--out-dir',
        path.join(dir, 'review'),
        '--start-ts',
        '2026-03-30T00:00:00.000Z',
        '--end-ts',
        '2026-03-30T00:05:00.000Z',
        '--logic-version',
        'v2.2',
        '--enable-llm',
        '--llm-model',
        'gpt-5.4',
        '--llm-max-processes',
        '4',
      ],
      {
        ...makeDeps(),
        runProcessQaImpl: async (options) => {
          assert.equal(options.rowsFile, undefined);
          assert.deepEqual(options.referenceRowsFiles, [
            path.join(dir, 'flows.jsonl'),
            path.join(dir, 'support.json'),
          ]);
          assert.equal(options.runRoot, path.join(dir, 'run-root'));
          assert.equal(options.runId, 'run-001');
          assert.equal(options.startTs, '2026-03-30T00:00:00.000Z');
          assert.equal(options.endTs, '2026-03-30T00:05:00.000Z');
          assert.equal(options.logicVersion, 'v2.2');
          assert.equal(options.llmModel, 'gpt-5.4');
          assert.equal(options.llmMaxProcesses, 4);
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            status: 'completed_local_process_qa',
            run_id: options.runId ?? 'run-001',
            run_root: options.runRoot ?? '',
            rows_file: options.rowsFile ?? '',
            out_dir: options.outDir,
            input_mode: 'run_root',
            effective_processes_dir: path.join(dir, 'run-root', 'exports', 'processes'),
            logic_version: options.logicVersion ?? 'v2.1',
            process_count: 1,
            policy_decision_owner: 'foundry',
            qa_mode: 'deterministic_qa_report',
            totals: {
              raw_input: 1,
              product_plus_byproduct_plus_waste: 1,
              delta: 0,
              relative_deviation: 0,
              energy_excluded: 0,
            },
            files: {
              qa_input_summary: path.join(dir, 'review', 'qa-input-summary.json'),
              materialization_summary: null,
              qa_zh: path.join(dir, 'review', 'zh.md'),
              qa_en: path.join(dir, 'review', 'en.md'),
              timing: path.join(dir, 'review', 'timing.md'),
              unit_issue_log: path.join(dir, 'review', 'unit.md'),
              summary: path.join(dir, 'review', 'summary.json'),
              report: path.join(dir, 'review', 'report.json'),
            },
            llm: {
              enabled: true,
              ok: true,
              result: {
                findings: [],
              },
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"status": "completed_local_process_qa"/u);
    assert.match(result.stdout, /"run_id": "run-001"/u);
    assert.match(result.stdout, /"logic_version": "v2\.2"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli passes rows-file qa process input through to the implementation', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-review-cli-rows-'));
  const rowsFile = path.join(dir, 'process-list-report.json');

  try {
    const result = await executeCli(
      ['qa', 'process', '--rows-file', rowsFile, '--out-dir', path.join(dir, 'review')],
      {
        ...makeDeps(),
        runProcessQaImpl: async (options) => {
          assert.equal(options.rowsFile, rowsFile);
          assert.equal(options.runRoot, undefined);
          assert.equal(options.runId, undefined);
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            status: 'completed_local_process_qa',
            run_id: 'process-list-report',
            run_root: '',
            rows_file: rowsFile,
            out_dir: options.outDir,
            input_mode: 'rows_file',
            effective_processes_dir: path.join(dir, 'review', 'qa-input', 'processes'),
            logic_version: 'v2.1',
            process_count: 1,
            policy_decision_owner: 'foundry',
            qa_mode: 'deterministic_qa_report',
            totals: {
              raw_input: 1,
              product_plus_byproduct_plus_waste: 1,
              delta: 0,
              relative_deviation: 0,
              energy_excluded: 0,
            },
            files: {
              qa_input_summary: path.join(dir, 'review', 'qa-input-summary.json'),
              materialization_summary: path.join(
                dir,
                'review',
                'qa-input',
                'materialization-summary.json',
              ),
              qa_zh: path.join(dir, 'review', 'zh.md'),
              qa_en: path.join(dir, 'review', 'en.md'),
              timing: path.join(dir, 'review', 'timing.md'),
              unit_issue_log: path.join(dir, 'review', 'unit.md'),
              summary: path.join(dir, 'review', 'summary.json'),
              report: path.join(dir, 'review', 'report.json'),
            },
            llm: {
              enabled: false,
              reason: 'disabled',
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"input_mode": "rows_file"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli executes qa process with only required flags', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-review-cli-required-'));

  try {
    const result = await executeCli(
      [
        'qa',
        'process',
        '--run-root',
        path.join(dir, 'run-root'),
        '--run-id',
        'run-required',
        '--out-dir',
        path.join(dir, 'review'),
      ],
      {
        ...makeDeps(),
        runProcessQaImpl: async (options) => {
          assert.equal(options.rowsFile, undefined);
          assert.equal(options.runRoot, path.join(dir, 'run-root'));
          assert.equal(options.runId, 'run-required');
          assert.equal(options.startTs, undefined);
          assert.equal(options.endTs, undefined);
          assert.equal(options.logicVersion, undefined);
          assert.equal(options.enableLlm, false);
          assert.equal(options.llmModel, undefined);
          assert.equal(options.llmMaxProcesses, undefined);
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            status: 'completed_local_process_qa',
            run_id: options.runId ?? 'run-required',
            run_root: options.runRoot ?? '',
            rows_file: options.rowsFile ?? '',
            out_dir: options.outDir,
            input_mode: 'run_root',
            effective_processes_dir: path.join(dir, 'run-root', 'exports', 'processes'),
            logic_version: 'v2.1',
            process_count: 0,
            policy_decision_owner: 'foundry',
            qa_mode: 'deterministic_qa_report',
            totals: {
              raw_input: 0,
              product_plus_byproduct_plus_waste: 0,
              delta: 0,
              relative_deviation: null,
              energy_excluded: 0,
            },
            files: {
              qa_input_summary: path.join(dir, 'review', 'qa-input-summary.json'),
              materialization_summary: null,
              qa_zh: path.join(dir, 'review', 'zh.md'),
              qa_en: path.join(dir, 'review', 'en.md'),
              timing: path.join(dir, 'review', 'timing.md'),
              unit_issue_log: path.join(dir, 'review', 'unit.md'),
              summary: path.join(dir, 'review', 'summary.json'),
              report: path.join(dir, 'review', 'report.json'),
            },
            llm: {
              enabled: false,
              reason: 'disabled',
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"run_id": "run-required"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns success for validation reports that are ok', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-cli-ok-'));

  try {
    const result = await executeCli(['validation', 'run', '--input-dir', dir], {
      ...makeDeps(),
      runValidationImpl: async () => ({
        input_dir: dir,
        mode: 'auto',
        ok: true,
        summary: {
          engine_count: 1,
          ok_count: 1,
          failed_count: 0,
        },
        files: {
          report: null,
        },
        reports: [],
        comparison: null,
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"ok": true/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli rejects unknown root options', async () => {
  const result = await executeCli(['--json'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /UNKNOWN_ROOT_OPTION/u);
});

test('executeCli rejects removed review command group without aliasing to qa', async () => {
  const rootResult = await executeCli(['review'], makeDeps());
  assert.equal(rootResult.exitCode, 2);
  assert.equal(rootResult.stdout, '');
  assert.match(rootResult.stderr, /Command 'review' was removed/u);
  assert.match(rootResult.stderr, /tiangong-lca qa/u);

  const result = await executeCli(['review', 'process', '--help'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Command 'review process' was removed/u);
  assert.match(result.stderr, /tiangong-lca qa process/u);

  const flowResult = await executeCli(['review', 'flow', '--help'], makeDeps());
  assert.equal(flowResult.exitCode, 2);
  assert.equal(flowResult.stdout, '');
  assert.match(flowResult.stderr, /Command 'review flow' was removed/u);
  assert.match(flowResult.stderr, /tiangong-lca qa flow/u);

  const lifecyclemodelResult = await executeCli(['review', 'lifecyclemodel', '--help'], makeDeps());
  assert.equal(lifecyclemodelResult.exitCode, 2);
  assert.equal(lifecyclemodelResult.stdout, '');
  assert.match(lifecyclemodelResult.stderr, /Command 'review lifecyclemodel' was removed/u);
  assert.match(lifecyclemodelResult.stderr, /tiangong-lca qa lifecyclemodel/u);
});

test('executeCli prints main help when root help appears before the command', async () => {
  const result = await executeCli(['--help', 'search', 'flow'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Unified TianGong command entrypoint/u);
});

test('executeCli supports root argument separator before the command', async () => {
  const result = await executeCli(['--', 'doctor', '--json'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /"ok":true/u);
});

test('executeCli prints main help for the explicit help command', async () => {
  const result = await executeCli(['help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Unified TianGong command entrypoint/u);
});

test('executeCli validates missing required flow regen-product inputs once the command is implemented', async () => {
  const result = await executeCli(['flow', 'regen-product'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /FLOW_REGEN_PROCESSES_FILE_REQUIRED/u);
});

test('executeCli dispatches qa lifecyclemodel to the implemented CLI module', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-lifecyclemodel-qa-dispatch-'));

  try {
    let observedOptions: RunLifecyclemodelQaOptions | undefined;
    const result = await executeCli(
      [
        'qa',
        'lifecyclemodel',
        '--run-dir',
        path.join(dir, 'run'),
        '--out-dir',
        path.join(dir, 'review'),
        '--start-ts',
        '2026-03-30T00:00:00.000Z',
        '--end-ts',
        '2026-03-30T00:05:00.000Z',
        '--logic-version',
        'review-v1',
        '--json',
      ],
      {
        ...makeDeps(),
        runLifecyclemodelQaImpl: async (options) => {
          observedOptions = options;
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:06:00.000Z',
            status: 'completed_local_lifecyclemodel_qa',
            run_id: 'lm-run-001',
            run_root: path.join(dir, 'run'),
            rows_file: path.join(dir, 'run', 'outputs', 'lifecyclemodels.jsonl'),
            input_mode: 'run_dir',
            out_dir: path.join(dir, 'review'),
            logic_version: 'review-v1',
            model_count: 1,
            finding_count: 0,
            severity_counts: {
              error: 0,
              warning: 0,
              info: 0,
            },
            validation: {
              available: true,
              ok: true,
              report: path.join(dir, 'run', 'reports', 'lifecyclemodel-validate-build-report.json'),
            },
            files: {
              run_manifest: path.join(dir, 'run', 'manifests', 'run-manifest.json'),
              invocation_index: path.join(dir, 'run', 'manifests', 'invocation-index.json'),
              qa_input_summary: null,
              validation_report: path.join(
                dir,
                'run',
                'reports',
                'lifecyclemodel-validate-build-report.json',
              ),
              model_summaries: path.join(dir, 'review', 'model_summaries.jsonl'),
              findings: path.join(dir, 'review', 'findings.jsonl'),
              summary: path.join(dir, 'review', 'lifecyclemodel_qa_summary.json'),
              qa_zh: path.join(dir, 'review', 'lifecyclemodel_qa_zh.md'),
              qa_en: path.join(dir, 'review', 'lifecyclemodel_qa_en.md'),
              timing: path.join(dir, 'review', 'lifecyclemodel_qa_timing.md'),
              report: path.join(dir, 'review', 'lifecyclemodel_qa_report.json'),
            },
            model_summaries: [],
            next_actions: ['inspect: findings'],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.deepEqual(observedOptions, {
      runDir: path.join(dir, 'run'),
      outDir: path.join(dir, 'review'),
      startTs: '2026-03-30T00:00:00.000Z',
      endTs: '2026-03-30T00:05:00.000Z',
      logicVersion: 'review-v1',
    });

    const payload = JSON.parse(result.stdout) as { status: string; logic_version: string };
    assert.equal(payload.status, 'completed_local_lifecyclemodel_qa');
    assert.equal(payload.logic_version, 'review-v1');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli dispatches qa flow to the implemented CLI module', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-dispatch-'));
  const rowsFile = path.join(dir, 'flows.json');
  writeFileSync(rowsFile, '[]\n', 'utf8');

  try {
    let observedOptions: RunFlowQaOptions | undefined;
    const result = await executeCli(
      [
        'qa',
        'flow',
        '--rows-file',
        rowsFile,
        '--out-dir',
        path.join(dir, 'review'),
        '--run-id',
        'flow-run',
        '--enable-llm',
        '--llm-max-flows',
        '5',
        '--llm-batch-size',
        '2',
        '--similarity-threshold',
        '0.9',
        '--methodology-id',
        'custom-method',
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowQaImpl: async (options) => {
          observedOptions = options;
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T00:00:00.000Z',
            status: 'completed_local_flow_qa',
            run_id: 'flow-run',
            out_dir: path.join(dir, 'review'),
            rows_file: rowsFile,
            input_mode: 'rows_file',
            effective_flows_dir: path.join(dir, 'qa-input', 'flows'),
            logic_version: 'flow-v1.0-cli',
            flow_count: 1,
            similarity_threshold: 0.9,
            methodology_rule_source: 'custom-method',
            with_reference_context: false,
            reference_context_mode: 'disabled',
            rule_finding_count: 1,
            llm_finding_count: 0,
            finding_count: 1,
            severity_counts: { warning: 1 },
            rule_counts: { sample_rule: 1 },
            llm: {
              enabled: true,
              ok: true,
              batch_count: 1,
              reviewed_flow_count: 1,
              truncated: false,
              batch_results: [],
            },
            files: {
              qa_input_summary: path.join(dir, 'review', 'qa-input-summary.json'),
              materialization_summary: path.join(
                dir,
                'review',
                'qa-input',
                'materialization-summary.json',
              ),
              rule_findings: path.join(dir, 'review', 'rule_findings.jsonl'),
              llm_findings: path.join(dir, 'review', 'llm_findings.jsonl'),
              findings: path.join(dir, 'review', 'findings.jsonl'),
              flow_summaries: path.join(dir, 'review', 'flow_summaries.jsonl'),
              similarity_pairs: path.join(dir, 'review', 'similarity_pairs.jsonl'),
              summary: path.join(dir, 'review', 'flow_qa_summary.json'),
              qa_zh: path.join(dir, 'review', 'flow_qa_zh.md'),
              qa_en: path.join(dir, 'review', 'flow_qa_en.md'),
              timing: path.join(dir, 'review', 'flow_qa_timing.md'),
              report: path.join(dir, 'review', 'flow_qa_report.json'),
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'completed_local_flow_qa');
    assert.equal(observedOptions?.rowsFile, rowsFile);
    assert.equal(observedOptions?.runId, 'flow-run');
    assert.equal(observedOptions?.enableLlm, true);
    assert.equal(observedOptions?.llmMaxFlows, 5);
    assert.equal(observedOptions?.llmBatchSize, 2);
    assert.equal(observedOptions?.similarityThreshold, 0.9);
    assert.equal(observedOptions?.methodologyId, 'custom-method');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli dispatches flow remediate to the implemented CLI module', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-remediate-dispatch-'));
  const inputFile = path.join(dir, 'invalid-flows.jsonl');
  writeFileSync(inputFile, '[]\n', 'utf8');

  try {
    let observedOptions: RunFlowRemediateOptions | undefined;
    const result = await executeCli(
      [
        'flow',
        'remediate',
        '--input-file',
        inputFile,
        '--out-dir',
        path.join(dir, 'remediation'),
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowRemediateImpl: async (options) => {
          observedOptions = options;
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T09:00:00.000Z',
            status: 'completed_local_flow_remediation',
            input_file: inputFile,
            out_dir: path.join(dir, 'remediation'),
            counts: {
              input_rows: 1,
              state_code_0_rows: 1,
              state_code_100_rows: 0,
              remediated_rows: 1,
              ready_for_mcp_rows: 1,
              residual_manual_rows: 0,
            },
            applied_fix_counts: {
              normalize_flow_properties: 1,
            },
            residual_manual_ids: [],
            validation_backend: 'tidas_sdk',
            files: {
              all_remediated: path.join(
                dir,
                'remediation',
                'flows_tidas_sdk_plus_classification_remediated_all.jsonl',
              ),
              ready_for_mcp: path.join(
                dir,
                'remediation',
                'flows_tidas_sdk_plus_classification_remediated_ready_for_mcp.jsonl',
              ),
              residual_manual_queue: path.join(
                dir,
                'remediation',
                'flows_tidas_sdk_plus_classification_residual_manual_queue.jsonl',
              ),
              audit: path.join(
                dir,
                'remediation',
                'flows_tidas_sdk_plus_classification_remediation_audit.jsonl',
              ),
              prompt: path.join(
                dir,
                'remediation',
                'flows_tidas_sdk_plus_classification_residual_manual_queue_prompt.md',
              ),
              report: path.join(
                dir,
                'remediation',
                'flows_tidas_sdk_plus_classification_remediation_report.json',
              ),
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'completed_local_flow_remediation');
    assert.equal(observedOptions?.inputFile, inputFile);
    assert.equal(observedOptions?.outDir, path.join(dir, 'remediation'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli dispatches flow publish-version to the implemented CLI module', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-dispatch-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  writeFileSync(inputFile, '[]\n', 'utf8');

  try {
    let observedOptions: RunFlowPublishVersionOptions | undefined;
    const result = await executeCli(
      [
        'flow',
        'publish-version',
        '--input-file',
        inputFile,
        '--out-dir',
        path.join(dir, 'publish-version'),
        '--commit',
        '--max-workers',
        '8',
        '--limit',
        '12',
        '--target-user-id',
        'user-123',
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowPublishVersionImpl: async (options) => {
          observedOptions = options;
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T10:00:00.000Z',
            status: 'completed_flow_publish_version',
            mode: 'commit',
            input_file: inputFile,
            out_dir: path.join(dir, 'publish-version'),
            counts: {
              total_rows: 2,
              success_count: 2,
              failure_count: 0,
            },
            flow_gate: {
              status: 'passed',
              ruleset_id: 'flow-publish/default',
              ruleset_version: '1',
              counts: {
                total: 2,
                valid: 2,
                invalid: 0,
              },
              blocker_count: 0,
              next_action: 'query_remote_write_plan',
            },
            operation_counts: {
              insert: 1,
              update_existing: 1,
            },
            max_workers: 8,
            limit: 12,
            target_user_id_override: 'user-123',
            files: {
              success_list: path.join(
                dir,
                'publish-version',
                'flows_tidas_sdk_plus_classification_mcp_success_list.json',
              ),
              remote_failed: path.join(
                dir,
                'publish-version',
                'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
              ),
              gate_report: path.join(
                dir,
                'publish-version',
                'flow-publish-version-gate-report.json',
              ),
              report: path.join(
                dir,
                'publish-version',
                'flows_tidas_sdk_plus_classification_mcp_sync_report.json',
              ),
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'completed_flow_publish_version');
    assert.equal(observedOptions?.inputFile, inputFile);
    assert.equal(observedOptions?.outDir, path.join(dir, 'publish-version'));
    assert.equal(observedOptions?.commit, true);
    assert.equal(observedOptions?.maxWorkers, 8);
    assert.equal(observedOptions?.limit, 12);
    assert.equal(observedOptions?.targetUserId, 'user-123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli dispatches flow publish-reviewed-data to the implemented CLI module', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-dispatch-'));
  const flowRowsFile = path.join(dir, 'reviewed-flows.jsonl');
  const processRowsFile = path.join(dir, 'reviewed-processes.jsonl');
  writeFileSync(flowRowsFile, '[]\n', 'utf8');
  writeFileSync(processRowsFile, '[]\n', 'utf8');

  try {
    let observedOptions: RunFlowReviewedPublishDataOptions | undefined;
    const result = await executeCli(
      [
        'flow',
        'publish-reviewed-data',
        '--flow-rows-file',
        flowRowsFile,
        '--original-flow-rows-file',
        path.join(dir, 'original-flows.jsonl'),
        '--process-rows-file',
        processRowsFile,
        '--flow-publish-policy',
        'upsert_current_version',
        '--process-publish-policy',
        'append_only_bump',
        '--no-rewrite-process-flow-refs',
        '--out-dir',
        path.join(dir, 'publish-reviewed'),
        '--max-workers',
        '6',
        '--target-user-id',
        'user-456',
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowReviewedPublishDataImpl: async (options) => {
          observedOptions = options;
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T16:30:00.000Z',
            status: 'prepared_flow_publish_reviewed_data',
            mode: 'dry_run',
            flow_rows_file: flowRowsFile,
            process_rows_file: processRowsFile,
            original_flow_rows_file: path.join(dir, 'original-flows.jsonl'),
            out_dir: path.join(dir, 'publish-reviewed'),
            flow_publish_policy: 'upsert_current_version',
            process_publish_policy: 'append_only_bump',
            rewrite_process_flow_refs: false,
            counts: {
              input_flow_rows: 1,
              input_process_rows: 1,
              original_flow_rows: 1,
              prepared_flow_rows: 1,
              prepared_process_rows: 1,
              skipped_unchanged_flow_rows: 0,
              rewritten_process_flow_refs: 0,
              flow_publish_reports: 1,
              process_publish_reports: 1,
              success_count: 0,
              failure_count: 0,
            },
            max_workers: 6,
            target_user_id_override: 'user-456',
            files: {
              prepared_flow_rows: path.join(dir, 'publish-reviewed', 'prepared-flow-rows.json'),
              prepared_process_rows: path.join(
                dir,
                'publish-reviewed',
                'prepared-process-rows.json',
              ),
              flow_version_map: path.join(dir, 'publish-reviewed', 'flow-version-map.json'),
              skipped_unchanged_flow_rows: path.join(
                dir,
                'publish-reviewed',
                'skipped-unchanged-flow-rows.json',
              ),
              process_ref_rewrite_evidence: path.join(
                dir,
                'publish-reviewed',
                'process-flow-ref-rewrite-evidence.jsonl',
              ),
              success_list: path.join(
                dir,
                'publish-reviewed',
                'flows_tidas_sdk_plus_classification_mcp_success_list.json',
              ),
              remote_failed: path.join(
                dir,
                'publish-reviewed',
                'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
              ),
              flow_publish_version_report: path.join(
                dir,
                'publish-reviewed',
                'flows_tidas_sdk_plus_classification_mcp_sync_report.json',
              ),
              report: path.join(dir, 'publish-reviewed', 'publish-report.json'),
            },
            flow_reports: [
              {
                entity_type: 'flow',
                id: 'flow-1',
                name: 'flow-1',
                original_version: '01.00.001',
                publish_version: '01.00.001',
                publish_policy: 'upsert_current_version',
                version_strategy: 'keep_current',
                status: 'updated',
                operation: 'update_existing',
              },
            ],
            process_reports: [],
            skipped_unchanged_flow_rows: [],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'prepared_flow_publish_reviewed_data');
    assert.equal(observedOptions?.flowRowsFile, flowRowsFile);
    assert.equal(observedOptions?.originalFlowRowsFile, path.join(dir, 'original-flows.jsonl'));
    assert.equal(observedOptions?.processRowsFile, processRowsFile);
    assert.equal(observedOptions?.outDir, path.join(dir, 'publish-reviewed'));
    assert.equal(observedOptions?.flowPublishPolicy, 'upsert_current_version');
    assert.equal(observedOptions?.processPublishPolicy, 'append_only_bump');
    assert.equal(observedOptions?.rewriteProcessFlowRefs, false);
    assert.equal(observedOptions?.commit, false);
    assert.equal(observedOptions?.maxWorkers, 6);
    assert.equal(observedOptions?.targetUserId, 'user-456');
    assert.equal(
      observedOptions?.env?.TIANGONG_LCA_API_BASE_URL,
      'https://example.com/functions/v1',
    );
    assert.equal(
      observedOptions?.env?.TIANGONG_LCA_ACCESS_TOKEN,
      makeDeps().env.TIANGONG_LCA_ACCESS_TOKEN,
    );
    assert.equal(
      observedOptions?.env?.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
      makeDeps().env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY,
    );
    assert.equal(typeof observedOptions?.fetchImpl, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli maps flow publish-reviewed-data failures to exit code 1', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-reviewed-failure-'));
  const flowRowsFile = path.join(dir, 'reviewed-flows.jsonl');
  writeFileSync(flowRowsFile, '[]\n', 'utf8');

  try {
    const result = await executeCli(
      [
        'flow',
        'publish-reviewed-data',
        '--flow-rows-file',
        flowRowsFile,
        '--out-dir',
        path.join(dir, 'publish-reviewed'),
        '--commit',
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowReviewedPublishDataImpl: async () => ({
          schema_version: 1,
          generated_at_utc: '2026-03-30T16:45:00.000Z',
          status: 'completed_flow_publish_reviewed_data_with_failures',
          mode: 'commit',
          flow_rows_file: flowRowsFile,
          process_rows_file: null,
          original_flow_rows_file: null,
          out_dir: path.join(dir, 'publish-reviewed'),
          flow_publish_policy: 'append_only_bump',
          process_publish_policy: 'append_only_bump',
          rewrite_process_flow_refs: true,
          counts: {
            input_flow_rows: 1,
            input_process_rows: 0,
            original_flow_rows: 0,
            prepared_flow_rows: 1,
            prepared_process_rows: 0,
            skipped_unchanged_flow_rows: 0,
            rewritten_process_flow_refs: 0,
            flow_publish_reports: 1,
            process_publish_reports: 0,
            success_count: 0,
            failure_count: 1,
          },
          max_workers: 4,
          target_user_id_override: null,
          files: {
            prepared_flow_rows: path.join(dir, 'publish-reviewed', 'prepared-flow-rows.json'),
            prepared_process_rows: path.join(dir, 'publish-reviewed', 'prepared-process-rows.json'),
            flow_version_map: path.join(dir, 'publish-reviewed', 'flow-version-map.json'),
            skipped_unchanged_flow_rows: path.join(
              dir,
              'publish-reviewed',
              'skipped-unchanged-flow-rows.json',
            ),
            process_ref_rewrite_evidence: path.join(
              dir,
              'publish-reviewed',
              'process-flow-ref-rewrite-evidence.jsonl',
            ),
            success_list: path.join(
              dir,
              'publish-reviewed',
              'flows_tidas_sdk_plus_classification_mcp_success_list.json',
            ),
            remote_failed: path.join(
              dir,
              'publish-reviewed',
              'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
            ),
            flow_publish_version_report: path.join(
              dir,
              'publish-reviewed',
              'flows_tidas_sdk_plus_classification_mcp_sync_report.json',
            ),
            report: path.join(dir, 'publish-reviewed', 'publish-report.json'),
          },
          flow_reports: [
            {
              entity_type: 'flow',
              id: 'flow-1',
              name: 'flow-1',
              original_version: '01.00.001',
              publish_version: '01.00.002',
              publish_policy: 'append_only_bump',
              version_strategy: 'bump',
              status: 'failed',
              error: [{ code: 'REMOTE_REQUEST_FAILED', message: 'duplicate version' }],
            },
          ],
          process_reports: [],
          skipped_unchanged_flow_rows: [],
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '');
    assert.equal(
      JSON.parse(result.stdout).status,
      'completed_flow_publish_reviewed_data_with_failures',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli dispatches flow validate-processes to the implemented CLI module', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-validate-processes-dispatch-'));
  const originalProcessesFile = path.join(dir, 'before.jsonl');
  const patchedProcessesFile = path.join(dir, 'after.jsonl');
  const scopeFlowFile = path.join(dir, 'scope.jsonl');
  writeFileSync(originalProcessesFile, '[]\n', 'utf8');
  writeFileSync(patchedProcessesFile, '[]\n', 'utf8');
  writeFileSync(scopeFlowFile, '[]\n', 'utf8');

  try {
    let observedOptions: RunFlowValidateProcessesOptions | undefined;
    const result = await executeCli(
      [
        'flow',
        'validate-processes',
        '--original-processes-file',
        originalProcessesFile,
        '--patched-processes-file',
        patchedProcessesFile,
        '--scope-flow-file',
        scopeFlowFile,
        '--out-dir',
        path.join(dir, 'validate'),
        '--tidas-mode',
        'required',
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowValidateProcessesImpl: async (options) => {
          observedOptions = options;
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T19:00:00.000Z',
            status: 'completed_local_flow_validate_processes',
            original_processes_file: originalProcessesFile,
            patched_processes_file: patchedProcessesFile,
            scope_flow_files: [scopeFlowFile],
            out_dir: path.join(dir, 'validate'),
            tidas_mode: 'required',
            summary: {
              patched_process_count: 1,
              passed: 1,
              failed: 0,
              tidas_validation: true,
            },
            files: {
              out_dir: path.join(dir, 'validate'),
              report: path.join(dir, 'validate', 'validation-report.json'),
              failures: path.join(dir, 'validate', 'validation-failures.jsonl'),
            },
            results: [],
          };
        },
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'completed_local_flow_validate_processes');
    assert.equal(observedOptions?.originalProcessesFile, originalProcessesFile);
    assert.equal(observedOptions?.patchedProcessesFile, patchedProcessesFile);
    assert.deepEqual(observedOptions?.scopeFlowFiles, [scopeFlowFile]);
    assert.equal(observedOptions?.tidasMode, 'required');
    assert.equal(observedOptions?.outDir, path.join(dir, 'validate'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli maps flow validate-processes failures to exit code 1', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-validate-processes-failure-'));
  const originalProcessesFile = path.join(dir, 'before.jsonl');
  const patchedProcessesFile = path.join(dir, 'after.jsonl');
  const scopeFlowFile = path.join(dir, 'scope.jsonl');
  writeFileSync(originalProcessesFile, '[]\n', 'utf8');
  writeFileSync(patchedProcessesFile, '[]\n', 'utf8');
  writeFileSync(scopeFlowFile, '[]\n', 'utf8');

  try {
    const result = await executeCli(
      [
        'flow',
        'validate-processes',
        '--original-processes-file',
        originalProcessesFile,
        '--patched-processes-file',
        patchedProcessesFile,
        '--scope-flow-file',
        scopeFlowFile,
        '--out-dir',
        path.join(dir, 'validate'),
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowValidateProcessesImpl: async () => ({
          schema_version: 1,
          generated_at_utc: '2026-03-30T19:05:00.000Z',
          status: 'completed_local_flow_validate_processes',
          original_processes_file: originalProcessesFile,
          patched_processes_file: patchedProcessesFile,
          scope_flow_files: [scopeFlowFile],
          out_dir: path.join(dir, 'validate'),
          tidas_mode: 'auto',
          summary: {
            patched_process_count: 1,
            passed: 0,
            failed: 1,
            tidas_validation: false,
          },
          files: {
            out_dir: path.join(dir, 'validate'),
            report: path.join(dir, 'validate', 'validation-report.json'),
            failures: path.join(dir, 'validate', 'validation-failures.jsonl'),
          },
          results: [],
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).summary.failed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli dispatches flow regen-product to the implemented CLI module and maps validation failures to exit code 1', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-regen-product-dispatch-'));
  const processesFile = path.join(dir, 'processes.jsonl');
  const scopeFlowFile = path.join(dir, 'scope-flows.jsonl');
  const catalogFlowFile = path.join(dir, 'catalog-flows.jsonl');
  const aliasMapFile = path.join(dir, 'alias-map.json');
  const processPoolFile = path.join(dir, 'process-pool.jsonl');

  writeFileSync(processesFile, '[]\n', 'utf8');
  writeFileSync(scopeFlowFile, '[]\n', 'utf8');
  writeFileSync(catalogFlowFile, '[]\n', 'utf8');
  writeFileSync(aliasMapFile, '{}\n', 'utf8');
  writeFileSync(processPoolFile, '[]\n', 'utf8');

  try {
    let observedOptions: RunFlowRegenProductOptions | undefined;
    const result = await executeCli(
      [
        'flow',
        'regen-product',
        '--processes-file',
        processesFile,
        '--scope-flow-file',
        scopeFlowFile,
        '--catalog-flow-file',
        catalogFlowFile,
        '--alias-map',
        aliasMapFile,
        '--exclude-emergy',
        '--auto-patch-policy',
        'alias-or-unique-name',
        '--apply',
        '--process-pool-file',
        processPoolFile,
        '--tidas-mode',
        'required',
        '--out-dir',
        path.join(dir, 'regen-product'),
        '--json',
      ],
      {
        ...makeDeps(),
        runFlowRegenProductImpl: async (options) => {
          observedOptions = options;
          return {
            schema_version: 1,
            generated_at_utc: '2026-03-30T11:00:00.000Z',
            status: 'completed_local_flow_regen_product',
            mode: 'apply',
            processes_file: processesFile,
            scope_flow_files: [scopeFlowFile],
            catalog_flow_files: [catalogFlowFile],
            alias_map_file: aliasMapFile,
            exclude_emergy: true,
            auto_patch_policy: 'alias-or-unique-name',
            process_pool_file: processPoolFile,
            tidas_mode: 'required',
            out_dir: path.join(dir, 'regen-product'),
            counts: {
              process_count_before_emergy_exclusion: 3,
              process_count: 2,
              emergy_excluded_process_count: 1,
              exchange_count: 2,
              issue_counts: {
                alias_target_available: 1,
              },
              processes_with_issues: 1,
              repair_item_count: 2,
              decision_counts: {
                auto_patch: 1,
                manual_review: 1,
              },
              patched_process_count: 1,
              validation_passed_count: 0,
              validation_failed_count: 1,
            },
            validation: {
              enabled: true,
              tidas_validation: true,
              ok: false,
            },
            files: {
              report: path.join(dir, 'regen-product', 'flow-regen-product-report.json'),
              scan: {
                out_dir: path.join(dir, 'regen-product', 'scan'),
                emergy_excluded_processes: path.join(
                  dir,
                  'regen-product',
                  'scan',
                  'emergy-excluded-processes.json',
                ),
                summary: path.join(dir, 'regen-product', 'scan', 'scan-summary.json'),
                findings: path.join(dir, 'regen-product', 'scan', 'scan-findings.json'),
                findings_jsonl: path.join(dir, 'regen-product', 'scan', 'scan-findings.jsonl'),
              },
              repair: {
                out_dir: path.join(dir, 'regen-product', 'repair'),
                plan: path.join(dir, 'regen-product', 'repair', 'repair-plan.json'),
                plan_jsonl: path.join(dir, 'regen-product', 'repair', 'repair-plan.jsonl'),
                manual_review_queue: path.join(
                  dir,
                  'regen-product',
                  'repair',
                  'manual-review-queue.jsonl',
                ),
                summary: path.join(dir, 'regen-product', 'repair', 'repair-summary.json'),
              },
              apply: {
                out_dir: path.join(dir, 'regen-product', 'repair-apply'),
                plan: path.join(dir, 'regen-product', 'repair-apply', 'repair-plan.json'),
                plan_jsonl: path.join(dir, 'regen-product', 'repair-apply', 'repair-plan.jsonl'),
                manual_review_queue: path.join(
                  dir,
                  'regen-product',
                  'repair-apply',
                  'manual-review-queue.jsonl',
                ),
                summary: path.join(dir, 'regen-product', 'repair-apply', 'repair-summary.json'),
                patched_processes: path.join(
                  dir,
                  'regen-product',
                  'repair-apply',
                  'patched-processes.json',
                ),
                patch_root: path.join(dir, 'regen-product', 'repair-apply', 'process-patches'),
              },
              validate: {
                out_dir: path.join(dir, 'regen-product', 'validate'),
                report: path.join(dir, 'regen-product', 'validate', 'validation-report.json'),
                failures: path.join(dir, 'regen-product', 'validate', 'validation-failures.jsonl'),
              },
            },
          };
        },
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'completed_local_flow_regen_product');
    assert.deepEqual(observedOptions, {
      processesFile,
      scopeFlowFiles: [scopeFlowFile],
      catalogFlowFiles: [catalogFlowFile],
      aliasMapFile,
      excludeEmergy: true,
      autoPatchPolicy: 'alias-or-unique-name',
      apply: true,
      processPoolFile,
      tidasMode: 'required',
      outDir: path.join(dir, 'regen-product'),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns exit code 0 for successful flow regen-product reports', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-regen-product-success-'));
  const processesFile = path.join(dir, 'processes.jsonl');
  const scopeFlowFile = path.join(dir, 'scope-flows.jsonl');

  writeFileSync(processesFile, '[]\n', 'utf8');
  writeFileSync(scopeFlowFile, '[]\n', 'utf8');

  try {
    const result = await executeCli(
      [
        'flow',
        'regen-product',
        '--processes-file',
        processesFile,
        '--scope-flow-file',
        scopeFlowFile,
        '--out-dir',
        path.join(dir, 'regen-product'),
      ],
      {
        ...makeDeps(),
        runFlowRegenProductImpl: async () => ({
          schema_version: 1,
          generated_at_utc: '2026-03-30T11:05:00.000Z',
          status: 'completed_local_flow_regen_product',
          mode: 'plan',
          processes_file: processesFile,
          scope_flow_files: [scopeFlowFile],
          catalog_flow_files: [scopeFlowFile],
          alias_map_file: null,
          exclude_emergy: false,
          auto_patch_policy: 'alias-only',
          process_pool_file: null,
          tidas_mode: 'auto',
          out_dir: path.join(dir, 'regen-product'),
          counts: {
            process_count_before_emergy_exclusion: 1,
            process_count: 1,
            emergy_excluded_process_count: 0,
            exchange_count: 1,
            issue_counts: {
              exists_in_target: 1,
            },
            processes_with_issues: 0,
            repair_item_count: 1,
            decision_counts: {
              keep_as_is: 1,
            },
            patched_process_count: 0,
            validation_passed_count: null,
            validation_failed_count: null,
          },
          validation: {
            enabled: false,
            tidas_validation: false,
            ok: null,
          },
          files: {
            report: path.join(dir, 'regen-product', 'flow-regen-product-report.json'),
            scan: {
              out_dir: path.join(dir, 'regen-product', 'scan'),
              emergy_excluded_processes: path.join(
                dir,
                'regen-product',
                'scan',
                'emergy-excluded-processes.json',
              ),
              summary: path.join(dir, 'regen-product', 'scan', 'scan-summary.json'),
              findings: path.join(dir, 'regen-product', 'scan', 'scan-findings.json'),
              findings_jsonl: path.join(dir, 'regen-product', 'scan', 'scan-findings.jsonl'),
            },
            repair: {
              out_dir: path.join(dir, 'regen-product', 'repair'),
              plan: path.join(dir, 'regen-product', 'repair', 'repair-plan.json'),
              plan_jsonl: path.join(dir, 'regen-product', 'repair', 'repair-plan.jsonl'),
              manual_review_queue: path.join(
                dir,
                'regen-product',
                'repair',
                'manual-review-queue.jsonl',
              ),
              summary: path.join(dir, 'regen-product', 'repair', 'repair-summary.json'),
            },
            apply: null,
            validate: null,
          },
        }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).mode, 'plan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli maps flow publish-version failure reports to exit code 1', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-publish-version-failure-exit-'));
  const inputFile = path.join(dir, 'ready-flows.jsonl');
  writeFileSync(inputFile, '[]\n', 'utf8');

  try {
    const result = await executeCli(
      [
        'flow',
        'publish-version',
        '--input-file',
        inputFile,
        '--out-dir',
        path.join(dir, 'publish-version'),
      ],
      {
        ...makeDeps(),
        runFlowPublishVersionImpl: async () => ({
          schema_version: 1,
          generated_at_utc: '2026-03-30T10:30:00.000Z',
          status: 'completed_flow_publish_version_with_failures',
          mode: 'commit',
          input_file: inputFile,
          out_dir: path.join(dir, 'publish-version'),
          counts: {
            total_rows: 1,
            success_count: 0,
            failure_count: 1,
          },
          flow_gate: {
            status: 'blocked',
            ruleset_id: 'flow-publish/default',
            ruleset_version: '1',
            counts: {
              total: 1,
              valid: 0,
              invalid: 1,
            },
            blocker_count: 1,
            next_action: 'fix_flow_payloads',
          },
          operation_counts: {},
          max_workers: 4,
          limit: null,
          target_user_id_override: null,
          files: {
            success_list: path.join(
              dir,
              'publish-version',
              'flows_tidas_sdk_plus_classification_mcp_success_list.json',
            ),
            remote_failed: path.join(
              dir,
              'publish-version',
              'flows_tidas_sdk_plus_classification_remote_validation_failed.jsonl',
            ),
            gate_report: path.join(dir, 'publish-version', 'flow-publish-version-gate-report.json'),
            report: path.join(
              dir,
              'publish-version',
              'flows_tidas_sdk_plus_classification_mcp_sync_report.json',
            ),
          },
        }),
      },
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).status, 'completed_flow_publish_version_with_failures');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns parsing errors for invalid flow get, list, remediate, publish-version, validate-processes, and regen-product flags', async () => {
  const invalidGetArgsResult = await executeCli(['flow', 'get', '--bad-flag'], makeDeps());
  assert.equal(invalidGetArgsResult.exitCode, 2);
  assert.match(invalidGetArgsResult.stderr, /INVALID_ARGS/u);

  const invalidGetStateCodeResult = await executeCli(
    ['flow', 'get', '--state-code=-1'],
    makeDeps(),
  );
  assert.equal(invalidGetStateCodeResult.exitCode, 2);
  assert.match(invalidGetStateCodeResult.stderr, /INVALID_FLOW_GET_STATE_CODE/u);

  const invalidListArgsResult = await executeCli(['flow', 'list', '--bad-flag'], makeDeps());
  assert.equal(invalidListArgsResult.exitCode, 2);
  assert.match(invalidListArgsResult.stderr, /INVALID_ARGS/u);

  const invalidListPageSizeResult = await executeCli(
    ['flow', 'list', '--page-size', '10'],
    makeDeps(),
  );
  assert.equal(invalidListPageSizeResult.exitCode, 2);
  assert.match(invalidListPageSizeResult.stderr, /FLOW_LIST_PAGE_SIZE_REQUIRES_ALL/u);

  const invalidListStateCodeResult = await executeCli(
    ['flow', 'list', '--state-code=-1'],
    makeDeps(),
  );
  assert.equal(invalidListStateCodeResult.exitCode, 2);
  assert.match(invalidListStateCodeResult.stderr, /INVALID_FLOW_LIST_STATE_CODE/u);

  const invalidListLimitResult = await executeCli(['flow', 'list', '--limit=0'], makeDeps());
  assert.equal(invalidListLimitResult.exitCode, 2);
  assert.match(invalidListLimitResult.stderr, /INVALID_FLOW_LIST_LIMIT/u);

  const invalidListOffsetResult = await executeCli(['flow', 'list', '--offset=-1'], makeDeps());
  assert.equal(invalidListOffsetResult.exitCode, 2);
  assert.match(invalidListOffsetResult.stderr, /INVALID_FLOW_LIST_OFFSET/u);

  const result = await executeCli(['flow', 'remediate', '--bad-flag'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /INVALID_ARGS/u);

  const invalidPublishArgsResult = await executeCli(
    ['flow', 'publish-version', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(invalidPublishArgsResult.exitCode, 2);
  assert.match(invalidPublishArgsResult.stderr, /INVALID_ARGS/u);

  const invalidModeResult = await executeCli(
    ['flow', 'publish-version', '--commit', '--dry-run'],
    makeDeps(),
  );
  assert.equal(invalidModeResult.exitCode, 2);
  assert.match(invalidModeResult.stderr, /FLOW_PUBLISH_VERSION_MODE_CONFLICT/u);

  const invalidWorkersResult = await executeCli(
    ['flow', 'publish-version', '--max-workers', '0'],
    makeDeps(),
  );
  assert.equal(invalidWorkersResult.exitCode, 2);
  assert.match(invalidWorkersResult.stderr, /INVALID_FLOW_PUBLISH_VERSION_MAX_WORKERS/u);

  const invalidLimitResult = await executeCli(
    ['flow', 'publish-version', '--limit=-1'],
    makeDeps(),
  );
  assert.equal(invalidLimitResult.exitCode, 2);
  assert.match(invalidLimitResult.stderr, /INVALID_FLOW_PUBLISH_VERSION_LIMIT/u);

  const invalidReviewedArgsResult = await executeCli(
    ['flow', 'publish-reviewed-data', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(invalidReviewedArgsResult.exitCode, 2);
  assert.match(invalidReviewedArgsResult.stderr, /INVALID_ARGS/u);

  const invalidReviewedModeResult = await executeCli(
    ['flow', 'publish-reviewed-data', '--commit', '--dry-run'],
    makeDeps(),
  );
  assert.equal(invalidReviewedModeResult.exitCode, 2);
  assert.match(invalidReviewedModeResult.stderr, /FLOW_PUBLISH_REVIEWED_MODE_CONFLICT/u);

  const invalidReviewedFlowPolicyResult = await executeCli(
    ['flow', 'publish-reviewed-data', '--flow-publish-policy', 'bad-policy'],
    makeDeps(),
  );
  assert.equal(invalidReviewedFlowPolicyResult.exitCode, 2);
  assert.match(
    invalidReviewedFlowPolicyResult.stderr,
    /FLOW_PUBLISH_REVIEWED_FLOW_POLICY_INVALID/u,
  );

  const invalidReviewedProcessPolicyResult = await executeCli(
    ['flow', 'publish-reviewed-data', '--process-publish-policy', 'bad-policy'],
    makeDeps(),
  );
  assert.equal(invalidReviewedProcessPolicyResult.exitCode, 2);
  assert.match(
    invalidReviewedProcessPolicyResult.stderr,
    /FLOW_PUBLISH_REVIEWED_PROCESS_POLICY_INVALID/u,
  );

  const invalidReviewedWorkersResult = await executeCli(
    ['flow', 'publish-reviewed-data', '--max-workers', '0'],
    makeDeps(),
  );
  assert.equal(invalidReviewedWorkersResult.exitCode, 2);
  assert.match(invalidReviewedWorkersResult.stderr, /INVALID_FLOW_PUBLISH_REVIEWED_MAX_WORKERS/u);

  const invalidRegenArgsResult = await executeCli(
    ['flow', 'regen-product', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(invalidRegenArgsResult.exitCode, 2);
  assert.match(invalidRegenArgsResult.stderr, /INVALID_ARGS/u);

  const invalidValidateArgsResult = await executeCli(
    ['flow', 'validate-processes', '--bad-flag'],
    makeDeps(),
  );
  assert.equal(invalidValidateArgsResult.exitCode, 2);
  assert.match(invalidValidateArgsResult.stderr, /INVALID_ARGS/u);

  const invalidValidateTidasModeResult = await executeCli(
    ['flow', 'validate-processes', '--tidas-mode', 'bad-mode'],
    makeDeps(),
  );
  assert.equal(invalidValidateTidasModeResult.exitCode, 2);
  assert.match(invalidValidateTidasModeResult.stderr, /INVALID_FLOW_VALIDATE_TIDAS_MODE/u);

  const invalidRegenPolicyResult = await executeCli(
    ['flow', 'regen-product', '--auto-patch-policy', 'bad-policy'],
    makeDeps(),
  );
  assert.equal(invalidRegenPolicyResult.exitCode, 2);
  assert.match(invalidRegenPolicyResult.stderr, /INVALID_FLOW_REGEN_AUTO_PATCH_POLICY/u);

  const invalidRegenTidasModeResult = await executeCli(
    ['flow', 'regen-product', '--tidas-mode', 'bad-mode'],
    makeDeps(),
  );
  assert.equal(invalidRegenTidasModeResult.exitCode, 2);
  assert.match(invalidRegenTidasModeResult.stderr, /INVALID_FLOW_REGEN_TIDAS_MODE/u);

  const invalidRegenPoolResult = await executeCli(
    ['flow', 'regen-product', '--process-pool-file', './pool.jsonl'],
    makeDeps(),
  );
  assert.equal(invalidRegenPoolResult.exitCode, 2);
  assert.match(invalidRegenPoolResult.stderr, /FLOW_REGEN_PROCESS_POOL_REQUIRES_APPLY/u);
});

test('executeCli supports alternate qa flow input modes and validates numeric flow-qa flags', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-flow-qa-alt-dispatch-'));
  const rowsFile = path.join(dir, 'flows.json');
  const observedOptions: RunFlowQaOptions[] = [];

  writeFileSync(rowsFile, '[]\n', 'utf8');

  try {
    const runFlowQaImpl = async (options: RunFlowQaOptions) => {
      observedOptions.push(options);
      const inputMode: 'flows_dir' | 'run_root' | 'rows_file' = options.flowsDir
        ? 'flows_dir'
        : options.runRoot
          ? 'run_root'
          : 'rows_file';
      const effectiveFlowsDir =
        options.flowsDir ??
        options.runRoot ??
        path.join(path.dirname(options.outDir), 'qa-input', 'flows');
      return {
        schema_version: 1 as const,
        generated_at_utc: '2026-03-30T00:00:00.000Z',
        status: 'completed_local_flow_qa' as const,
        run_id: options.runId ?? 'flow-run',
        out_dir: options.outDir,
        rows_file: options.rowsFile ?? path.join(options.outDir, 'flows.jsonl'),
        input_mode: inputMode,
        effective_flows_dir: effectiveFlowsDir,
        logic_version: options.logicVersion ?? 'flow-v1.0-cli',
        flow_count: 1,
        similarity_threshold: options.similarityThreshold ?? 0.92,
        methodology_rule_source: options.methodologyId ?? 'built_in',
        with_reference_context: false as const,
        reference_context_mode: 'disabled' as const,
        rule_finding_count: 1,
        llm_finding_count: 0,
        finding_count: 1,
        severity_counts: { warning: 1 },
        rule_counts: { sample_rule: 1 },
        llm: {
          enabled: Boolean(options.enableLlm),
          batch_count: 0,
          reviewed_flow_count: 0,
          truncated: false,
          batch_results: [],
        },
        files: {
          qa_input_summary: path.join(options.outDir, 'qa-input-summary.json'),
          materialization_summary: null,
          rule_findings: path.join(options.outDir, 'rule_findings.jsonl'),
          llm_findings: path.join(options.outDir, 'llm_findings.jsonl'),
          findings: path.join(options.outDir, 'findings.jsonl'),
          flow_summaries: path.join(options.outDir, 'flow_summaries.jsonl'),
          similarity_pairs: path.join(options.outDir, 'similarity_pairs.jsonl'),
          summary: path.join(options.outDir, 'flow_qa_summary.json'),
          qa_zh: path.join(options.outDir, 'flow_qa_zh.md'),
          qa_en: path.join(options.outDir, 'flow_qa_en.md'),
          timing: path.join(options.outDir, 'flow_qa_timing.md'),
          report: path.join(options.outDir, 'flow_qa_report.json'),
        },
      };
    };

    const flowsDir = path.join(dir, 'flows');
    const flowsDirResult = await executeCli(
      ['qa', 'flow', '--flows-dir', flowsDir, '--out-dir', path.join(dir, 'flow-qas')],
      {
        ...makeDeps(),
        runFlowQaImpl,
      },
    );
    assert.equal(flowsDirResult.exitCode, 0);
    assert.equal(observedOptions[0].flowsDir, flowsDir);
    assert.equal(observedOptions[0].rowsFile, undefined);
    assert.equal(observedOptions[0].runRoot, undefined);
    assert.equal(observedOptions[0].runId, undefined);

    const runRoot = path.join(dir, 'run-root');
    const runRootResult = await executeCli(
      [
        'qa',
        'flow',
        '--run-root',
        runRoot,
        '--run-id',
        'run-root-review',
        '--out-dir',
        path.join(dir, 'review-run-root'),
        '--start-ts',
        '2026-03-30T00:00:00.000Z',
        '--end-ts',
        '2026-03-30T00:05:00.000Z',
        '--logic-version',
        'flow-v2',
        '--llm-model',
        'gpt-5.4-mini',
      ],
      {
        ...makeDeps(),
        runFlowQaImpl,
      },
    );
    assert.equal(runRootResult.exitCode, 0);
    assert.equal(observedOptions[1].runRoot, runRoot);
    assert.equal(observedOptions[1].flowsDir, undefined);
    assert.equal(observedOptions[1].runId, 'run-root-review');
    assert.equal(observedOptions[1].startTs, '2026-03-30T00:00:00.000Z');
    assert.equal(observedOptions[1].endTs, '2026-03-30T00:05:00.000Z');
    assert.equal(observedOptions[1].logicVersion, 'flow-v2');
    assert.equal(observedOptions[1].llmModel, 'gpt-5.4-mini');

    const badFlagResult = await executeCli(['qa', 'flow', '--bad-flag'], makeDeps());
    assert.equal(badFlagResult.exitCode, 2);
    assert.match(badFlagResult.stderr, /INVALID_ARGS/u);

    const invalidMaxFlowsResult = await executeCli(
      [
        'qa',
        'flow',
        '--rows-file',
        rowsFile,
        '--out-dir',
        path.join(dir, 'bad-max'),
        '--llm-max-flows',
        '0',
      ],
      makeDeps(),
    );
    assert.equal(invalidMaxFlowsResult.exitCode, 2);
    assert.match(invalidMaxFlowsResult.stderr, /INVALID_LLM_MAX_FLOWS/u);

    const invalidBatchSizeResult = await executeCli(
      [
        'qa',
        'flow',
        '--rows-file',
        rowsFile,
        '--out-dir',
        path.join(dir, 'bad-batch'),
        '--llm-batch-size',
        '0',
      ],
      makeDeps(),
    );
    assert.equal(invalidBatchSizeResult.exitCode, 2);
    assert.match(invalidBatchSizeResult.stderr, /INVALID_LLM_BATCH_SIZE/u);

    const invalidThresholdResult = await executeCli(
      [
        'qa',
        'flow',
        '--rows-file',
        rowsFile,
        '--out-dir',
        path.join(dir, 'bad-threshold'),
        '--similarity-threshold',
        '0',
      ],
      makeDeps(),
    );
    assert.equal(invalidThresholdResult.exitCode, 2);
    assert.match(invalidThresholdResult.stderr, /INVALID_SIMILARITY_THRESHOLD/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeCli returns planned command message for other unimplemented process subcommands', async () => {
  const result = await executeCli(['process', 'delete'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Command 'process delete'/u);

  const flowRegenHelp = await executeCli(['flow', 'regen-product', '--help'], makeDeps());
  assert.equal(flowRegenHelp.exitCode, 0);
  assert.match(flowRegenHelp.stdout, /tiangong-lca flow regen-product/u);
  assert.match(flowRegenHelp.stdout, /Apply deterministic patches and run local validation/u);
});

test('executeCli returns dedicated help for implemented lifecyclemodel validate-build', async () => {
  const result = await executeCli(['lifecyclemodel', 'validate-build', '--help'], makeDeps());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /model validation reports/u);
  assert.match(result.stdout, /tidas_bundle/u);
  assert.doesNotMatch(result.stdout, /Planned contract:/u);
  assert.equal(result.stderr, '');
});

test('executeCli returns planned command message when a command is missing a subcommand', async () => {
  const result = await executeCli(['job'], makeDeps());
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Command 'job'/u);
});

test('qa process rejects empty explicit reference evidence before invoking its owner', async () => {
  for (const file of ['', '  ']) {
    let calls = 0;
    const result = await executeCli(
      [
        'qa',
        'process',
        '--rows-file',
        'rows.json',
        '--out-dir',
        'qa',
        '--reference-rows-file',
        file,
      ],
      {
        ...makeDeps(),
        runProcessQaImpl: async () => {
          calls++;
          throw new Error('Owner must not run for malformed selection.');
        },
      },
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /INVALID_REFERENCE_ROWS_FILE/u);
    assert.equal(calls, 0);
  }
});
