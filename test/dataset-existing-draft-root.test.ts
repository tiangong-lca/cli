import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCli } from '../src/cli.js';
import { loadExistingDraftRootIntent } from '../src/lib/dataset-existing-draft-root-intent.js';
import { evaluateExistingDraftRoot } from '../src/lib/dataset-existing-draft-root.js';
import type { ExistingDraftRootObservation } from '../src/lib/dataset-existing-draft-root-remote.js';
import { buildSnapshotCompleteness } from '../src/lib/dataset-maintenance-pagination.js';
import {
  __testInternals,
  collectRemoteReferences,
  runDatasetRemoteVerify,
  type RemoteVerificationCheck,
  type RunDatasetRemoteVerifyOptions,
} from '../src/lib/dataset-remote-verify.js';
import { buildSupabaseTestEnv, makeSupabaseAuthResponse } from './helpers/supabase-auth.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = id(90),
  owner = id(91),
  processId = id(1),
  project = 'abcdefghijklmnopqrst';
const selectedVersion = '00.00.002',
  publicVersion = '00.00.004';
const sha = __testInternals.sha256Json;
const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function payload(version = selectedVersion, name = 'Revised candidate') {
  return {
    processDataSet: {
      processInformation: { dataSetInformation: { 'common:UUID': processId, name } },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
}
function remoteRow(version: string, state: 0 | 100) {
  return {
    id: processId,
    version,
    user_id: state === 0 ? actor : owner,
    state_code: state,
    modified_at: '2026-10-21T00:00:00.000Z',
    json_ordered: payload(version, 'Before image'),
    team_id: null,
    model_id: null,
    model_version: null,
    review_id: null,
  };
}
function snapshot(row: ReturnType<typeof remoteRow>) {
  return {
    table: 'processes' as const,
    id: row.id,
    version: row.version,
    user_id: row.user_id,
    state_code: row.state_code,
    payload_sha256: sha(row.json_ordered),
    row_sha256: sha(row),
  };
}
function completeness(drafts = 1, reviews = 0) {
  return buildSnapshotCompleteness({
    tables: ['drafts', 'reviews'] as const,
    requestedPageSize: 1000,
    results: (
      [
        ['drafts', drafts],
        ['reviews', reviews],
      ] as const
    ).map(([table, count]) => ({
      table,
      completeness: {
        status: 'complete',
        complete: true,
        strategy: 'postgrest_exact_count',
        requested_page_size: 1000,
        effective_page_size: count,
        pages_fetched: 1,
        rows_fetched: count,
        exact_total: count,
        termination_reason: 'content_range_total_reached',
        content_range_verified: true,
        ordering_verified: true,
        duplicate_count: 0,
      },
    })),
  });
}
function fixture(t: import('node:test').TestContext, references = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-existing-draft-root-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const candidate: Record<string, unknown> = payload();
  if (references) {
    Object.assign(candidate.processDataSet as object, {
      exchanges: {
        exchange: {
          referenceToFlowDataSet: {
            '@type': 'flow data set',
            '@refObjectId': processId,
            '@version': selectedVersion,
          },
        },
      },
      predecessor: {
        '@type': 'process data set',
        '@refObjectId': processId,
        '@version': '00.00.001',
      },
    });
  }
  const input = path.join(dir, 'candidate.json'),
    intentFile = path.join(dir, 'root.json'),
    reviewFile = path.join(dir, 'review.json');
  write(input, [candidate]);
  const draft = remoteRow(selectedVersion, 0),
    published = remoteRow(publicVersion, 100);
  const candidateIdentity = {
    row_index: 0,
    table: 'processes' as const,
    id: processId,
    version: selectedVersion,
    payload_sha256: sha(candidate),
  };
  const intent = {
    schema_version: 'dataset-existing-draft-root.v1',
    project_ref: project,
    actor_user_id: actor,
    candidate: candidateIdentity,
    selection: {
      strategy: 'sole_current_owner_draft',
      drafts: [snapshot(draft)],
      reviews: [],
      published_baseline: snapshot(published),
    },
    review: { file: reviewFile, sha256: '' },
  };
  write(reviewFile, {
    schema_version: 'dataset-existing-draft-root-review.v1',
    decision: 'revise_selected_draft',
    reason: 'Revise this standalone owner draft while preserving the reviewed public boundary.',
    candidate: candidateIdentity,
    selected: snapshot(draft),
    published_baseline: snapshot(published),
  });
  intent.review.sha256 = digest(reviewFile);
  write(intentFile, intent);
  const observation = (): ExistingDraftRootObservation => ({
    selected: snapshot(draft),
    published_baseline: snapshot(published),
    drafts: [snapshot(draft)],
    reviews: [],
    completeness: completeness(),
  });
  const calls: string[] = [];
  const options: RunDatasetRemoteVerifyOptions = {
    inputPath: input,
    outDir: path.join(dir, 'verify'),
    existingDraftRootFile: intentFile,
    rootPolicy: 'candidate',
    resolveReferenceIdentityImpl: async () => {
      calls.push('identity');
      return { project_ref: project, user_id: actor };
    },
    observeExistingDraftRootImpl: async (request) => {
      assert.deepEqual(request, { id: processId, version: selectedVersion, actorUserId: actor });
      calls.push('observe');
      return observation();
    },
    lookupDatasetImpl: async (request) => {
      calls.push(`metadata:${request.table}:${request.version}`);
      return {
        exact: { id: request.id, version: request.version! },
        latest: { id: request.id, version: publicVersion },
        exact_source_url: null,
        latest_source_url: null,
      };
    },
    lookupRootPayloadImpl: async () => ({
      id: processId,
      version: selectedVersion,
      user_id: actor,
      state_code: 0,
      modified_at: null,
      payload: draft.json_ordered,
      source_url: null,
    }),
  };
  return {
    dir,
    candidate,
    input,
    intent,
    intentFile,
    reviewFile,
    draft,
    published,
    observation,
    calls,
    options,
  };
}
function checks(report: Awaited<ReturnType<typeof runDatasetRemoteVerify>>) {
  return fs
    .readFileSync(report.files.checks, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RemoteVerificationCheck);
}
function rootCheck(report: Awaited<ReturnType<typeof runDatasetRemoteVerify>>) {
  return checks(report).find((check) => check.role === 'root' && check.path === '/processDataSet')!;
}

test('explicit root evidence qualifies only the selected older draft and produces read-only evidence', async (t) => {
  const f = fixture(t);
  for (const rootPolicy of ['existing', 'candidate'] as const) {
    const report = await runDatasetRemoteVerify({
      ...f.options,
      rootPolicy,
      existingDraftRootFile: undefined,
      outDir: path.join(f.dir, rootPolicy),
    });
    assert.equal(report.status, 'blocked_remote_verification');
    assert.equal(rootCheck(report).status, 'version_outdated');
    assert.equal(rootCheck(report).existing_draft_root, undefined);
  }
  f.calls.length = 0;
  const report = await runDatasetRemoteVerify(f.options);
  assert.equal(report.status, 'passed_remote_verification');
  assert.equal(report.counts.blockers, 0);
  assert.deepEqual(f.calls, [
    'identity',
    'observe',
    `metadata:processes:${selectedVersion}`,
    'observe',
    'identity',
  ]);
  assert.deepEqual(rootCheck(report).existing_draft_root, {
    intent_sha256: digest(f.intentFile),
    review_sha256: digest(f.reviewFile),
    applied: true,
    read_only: true,
    save_ready: false,
    original_status: 'version_outdated',
    initial: f.observation(),
    rechecked: f.observation(),
    failure: null,
  });
  assert.deepEqual(fs.readdirSync(path.dirname(report.files.report)), [
    'blockers.jsonl',
    'remote-verification-report.json',
    'remote-verification.jsonl',
  ]);
  assert.equal(fs.readFileSync(f.input, 'utf8'), JSON.stringify([f.candidate]));
});

test('root qualification leaves typed UUID collisions and predecessor versions blocked', async (t) => {
  const f = fixture(t, true);
  const report = await runDatasetRemoteVerify(f.options);
  assert.equal(rootCheck(report).status, 'ok');
  const children = checks(report).filter((check) => check.role === 'reference');
  assert.equal(children.length, 2);
  assert.deepEqual(
    children
      .map((check) => [check.table, check.version, check.status])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ['flows', selectedVersion, 'version_outdated'],
      ['processes', '00.00.001', 'version_outdated'],
    ],
  );
  assert.ok(children.every((check) => check.existing_draft_root === undefined));
  assert.equal(report.status, 'blocked_remote_verification');
});

function referencePayload(table: string, version: string) {
  if (table === 'processes') return payload(version, 'Predecessor definition');
  return {
    flowDataSet: {
      flowInformation: { dataSetInformation: { 'common:UUID': processId } },
      administrativeInformation: { publicationAndOwnership: { 'common:dataSetVersion': version } },
    },
  };
}

function referenceIntent(f: ReturnType<typeof fixture>) {
  const refs = collectRemoteReferences([f.candidate]).filter((ref) => ref.role === 'reference');
  const pins = refs.map((ref, index) => {
    const selected = {
      table: ref.table!,
      id: ref.id!,
      version: ref.version!,
      user_id: owner,
      state_code: 100,
      payload_sha256: sha(referencePayload(ref.table!, ref.version!)),
    };
    const latest = {
      ...selected,
      version: publicVersion,
      payload_sha256: sha(referencePayload(ref.table!, publicVersion)),
    };
    const file = path.join(f.dir, `child-review-${index}.json`);
    write(file, {
      schema_version: 'dataset-exact-reference-review.v1',
      decision: 'use_selected_exact',
      reason: 'The original boundary is required for this candidate.',
      selected,
      latest,
    });
    return { row_index: 0, path: ref.path, selected, review: { file, sha256: digest(file) } };
  });
  const file = path.join(f.dir, 'references.json');
  const value = {
    schema_version: 'dataset-exact-reference-intent.v1',
    project_ref: project,
    actor_user_id: actor,
    consumers: [f.intent.candidate],
    references: pins,
  };
  write(file, value);
  return { file, value };
}

test('separately reviewed exact child intents compose with root qualification', async (t) => {
  const f = fixture(t, true),
    refs = referenceIntent(f);
  const report = await runDatasetRemoteVerify({
    ...f.options,
    referenceIntentFile: refs.file,
    lookupReferencePayloadImpl: async (request) => ({
      id: request.id,
      version: request.version ?? publicVersion,
      user_id: owner,
      state_code: 100,
      modified_at: null,
      source_url: null,
      payload: referencePayload(request.table, request.version ?? publicVersion),
    }),
  });
  assert.equal(report.status, 'passed_remote_verification');
  assert.equal(checks(report).filter((check) => check.reference_intent?.applied).length, 2);
  assert.equal(checks(report).filter((check) => check.existing_draft_root?.applied).length, 1);
  assert.equal(f.calls.filter((call) => call === 'identity').length, 2);
});

test('reference intent cannot declare a root and root evidence requires candidate policy', async (t) => {
  for (const mode of ['reference-root', 'existing-policy'] as const) {
    const f = fixture(t, true),
      refs = referenceIntent(f);
    if (mode === 'reference-root') {
      refs.value.references[0].path = '/processDataSet';
      write(refs.file, refs.value);
    }
    await assert.rejects(
      runDatasetRemoteVerify({
        ...f.options,
        referenceIntentFile: mode === 'reference-root' ? refs.file : undefined,
        rootPolicy: mode === 'existing-policy' ? 'existing' : 'candidate',
      }),
      {
        code:
          mode === 'reference-root'
            ? 'DATASET_REFERENCE_INTENT_INVALID'
            : 'DATASET_EXISTING_DRAFT_ROOT_INVALID',
      },
    );
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.options.outDir!), false);
  }
});

test('root qualification does not bypass an explicitly requested candidate payload comparison', async (t) => {
  const f = fixture(t);
  const report = await runDatasetRemoteVerify({
    ...f.options,
    compareRootPayload: true,
    targetUserId: actor,
    stateCode: 0,
  });
  assert.equal(rootCheck(report).status, 'ok');
  assert.equal(report.status, 'blocked_remote_verification');
  assert.equal(report.counts.root_payload_mismatches, 1);
  assert.ok(report.blockers.some((blocker) => blocker.code === 'payload_mismatch'));
});

test('actor and project mismatches fail before dataset reads; final identity is independently refreshed', async (t) => {
  for (const mode of [
    'actor',
    'project',
    'reference-actor',
    'reference-project',
    'final-identity',
  ] as const) {
    const f = fixture(t, true),
      refs = referenceIntent(f);
    if (mode === 'reference-actor') refs.value.actor_user_id = id(92);
    if (mode === 'reference-project') refs.value.project_ref = 'zzzzzzzzzzzzzzzzzzzz';
    write(refs.file, refs.value);
    let identities = 0;
    await assert.rejects(
      runDatasetRemoteVerify({
        ...f.options,
        referenceIntentFile: mode.startsWith('reference-') ? refs.file : undefined,
        resolveReferenceIdentityImpl: async () => {
          identities++;
          return {
            project_ref: mode === 'project' ? 'zzzzzzzzzzzzzzzzzzzz' : project,
            user_id:
              mode === 'actor' || (mode === 'final-identity' && identities === 2) ? id(92) : actor,
          };
        },
      }),
      {
        code: mode.startsWith('reference-')
          ? 'DATASET_EXISTING_DRAFT_ROOT_INVALID'
          : 'DATASET_EXISTING_DRAFT_ROOT_IDENTITY_MISMATCH',
      },
    );
    assert.equal(fs.existsSync(f.options.outDir!), false);
    if (mode !== 'final-identity') assert.deepEqual(f.calls, []);
    else assert.equal(identities, 2);
  }
});

test('initial and final draft, public baseline, selection, review and completeness drift stay blocked', async (t) => {
  const modes = [
    'before-payload',
    'before-row',
    'baseline',
    'selected',
    'drafts',
    'reviews',
    'completeness',
    'draft-count',
    'review-count',
  ] as const;
  for (const phase of ['initial', 'final'] as const) {
    for (const mode of modes) {
      const f = fixture(t);
      let observations = 0;
      const report = await runDatasetRemoteVerify({
        ...f.options,
        observeExistingDraftRootImpl: async () => {
          observations++;
          const seen = f.observation();
          if (
            (phase === 'initial' && observations === 1) ||
            (phase === 'final' && observations === 2)
          ) {
            if (mode === 'before-payload') seen.drafts[0].payload_sha256 = 'a'.repeat(64);
            if (mode === 'before-row') seen.drafts[0].row_sha256 = 'a'.repeat(64);
            if (mode === 'baseline') seen.published_baseline.row_sha256 = 'a'.repeat(64);
            if (mode === 'selected') seen.selected.row_sha256 = 'a'.repeat(64);
            if (mode === 'drafts') seen.drafts.push({ ...seen.selected, version: '00.00.003' });
            if (mode === 'reviews')
              seen.reviews.push({
                id: processId,
                version: selectedVersion,
                user_id: actor,
                state_code: 20,
                review_id: id(93),
              });
            if (mode === 'completeness') Object.assign(seen.completeness, { complete: false });
            if (mode === 'draft-count') seen.completeness = completeness(2, 0);
            if (mode === 'review-count') seen.completeness = completeness(1, 1);
          }
          return seen;
        },
      });
      assert.equal(report.status, 'blocked_remote_verification', `${phase}:${mode}`);
      assert.equal(rootCheck(report).status, 'existing_draft_root_mismatch');
      assert.equal(
        rootCheck(report).existing_draft_root?.failure,
        phase === 'initial' ? 'initial_selection_mismatch' : 'selection_changed',
        `${phase}:${mode}`,
      );
    }
  }
});

test('unavailable transport, failed observations and blocked base metadata cannot qualify a root', async (t) => {
  for (const mode of [
    'no-transport',
    'initial-failure',
    'final-failure',
    'metadata-failure',
    'metadata-missing',
  ] as const) {
    const f = fixture(t);
    let observations = 0;
    const report = await runDatasetRemoteVerify({
      ...f.options,
      observeExistingDraftRootImpl:
        mode === 'no-transport'
          ? undefined
          : async () => {
              observations++;
              if (
                (mode === 'initial-failure' && observations === 1) ||
                (mode === 'final-failure' && observations === 2)
              )
                throw new Error('Unavailable');
              return f.observation();
            },
      lookupDatasetImpl: async (request) => {
        if (mode === 'metadata-failure') throw new Error('Metadata failed');
        if (mode === 'metadata-missing')
          return { exact: null, latest: null, exact_source_url: null, latest_source_url: null };
        return f.options.lookupDatasetImpl!(request);
      },
    });
    assert.equal(report.status, 'blocked_remote_verification', mode);
    assert.equal(
      rootCheck(report).existing_draft_root?.failure,
      mode.startsWith('metadata-') ? 'base_check_blocked' : 'observation_failed',
    );
  }
});

test('local candidate, control and review drift prevent report output; restored evidence reruns without a write attempt', async (t) => {
  for (const mode of ['candidate', 'intent', 'review'] as const) {
    const f = fixture(t);
    const changed =
      mode === 'candidate' ? f.input : mode === 'intent' ? f.intentFile : f.reviewFile;
    const original = fs.readFileSync(changed);
    await assert.rejects(
      runDatasetRemoteVerify({
        ...f.options,
        lookupDatasetImpl: async (request) => {
          if (mode === 'candidate')
            write(f.input, [payload(selectedVersion, 'Changed during verification')]);
          else fs.appendFileSync(changed, ' ');
          return f.options.lookupDatasetImpl!(request);
        },
      }),
      { code: 'DATASET_EXISTING_DRAFT_ROOT_INVALID' },
    );
    assert.equal(fs.existsSync(f.options.outDir!), false);
    fs.writeFileSync(changed, original);
    const report = await runDatasetRemoteVerify(f.options);
    assert.equal(report.status, 'passed_remote_verification');
    assert.ok(!fs.readdirSync(f.options.outDir!).some((file) => /attempt|receipt/u.test(file)));
  }
});

test('in-memory candidate input is rebound after root observations and rejects mutation before report output', async (t) => {
  for (const phase of ['unchanged', 'initial', 'final'] as const) {
    const f = fixture(t);
    const rawInput = { rows: [f.candidate] };
    // An absent source file proves the selected in-memory input is the authority.
    fs.unlinkSync(f.input);
    let observations = 0;
    const verification = runDatasetRemoteVerify({
      ...f.options,
      rawInput,
      observeExistingDraftRootImpl: async () => {
        observations++;
        if (
          (phase === 'initial' && observations === 1) ||
          (phase === 'final' && observations === 2)
        ) {
          Object.assign(f.candidate.processDataSet as object, { changedDuringObservation: true });
        }
        return f.observation();
      },
    });
    if (phase === 'unchanged') {
      const report = await verification;
      assert.equal(report.status, 'passed_remote_verification');
      assert.equal(rootCheck(report).existing_draft_root?.applied, true);
      assert.equal(fs.existsSync(f.input), false);
      assert.deepEqual(fs.readdirSync(path.dirname(report.files.report)), [
        'blockers.jsonl',
        'remote-verification-report.json',
        'remote-verification.jsonl',
      ]);
    } else {
      await assert.rejects(verification, { code: 'DATASET_EXISTING_DRAFT_ROOT_INVALID' });
      assert.equal(fs.existsSync(f.options.outDir!), false);
    }
    assert.equal(observations, 2);
  }
});

test('evaluator rejects wrong typed root occurrence and permits a base ok check only with complete observations', async (t) => {
  const f = fixture(t);
  const intent = loadExistingDraftRootIntent({
    file: f.intentFile,
    consumers: [f.intent.candidate],
    references: collectRemoteReferences([f.candidate]),
  });
  const report = await runDatasetRemoteVerify(f.options),
    check = rootCheck(report);
  for (const change of [
    { role: 'reference' as const },
    { row_index: 1 },
    { path: '/other' },
    { table: 'flows' as const },
    { id: id(99) },
    { version: publicVersion },
    { exact_version: null },
    { status: 'missing_dataset' as const },
  ]) {
    const result = evaluateExistingDraftRoot({
      intent,
      check: { ...check, ...change },
      initial: f.observation(),
      rechecked: f.observation(),
      lookupFailed: false,
    });
    assert.equal(result.existing_draft_root?.failure, 'base_check_blocked');
  }
  const ok = evaluateExistingDraftRoot({
    intent,
    check: { ...check, status: 'ok' },
    initial: f.observation(),
    rechecked: f.observation(),
    lookupFailed: false,
  });
  assert.equal(ok.existing_draft_root?.applied, true);
  for (const phase of ['initial', 'final'] as const) {
    const blocked = evaluateExistingDraftRoot({
      intent,
      check,
      initial: phase === 'initial' ? null : f.observation(),
      rechecked: phase === 'final' ? null : f.observation(),
      lookupFailed: false,
    });
    assert.equal(
      blocked.existing_draft_root?.failure,
      phase === 'initial' ? 'initial_selection_mismatch' : 'selection_changed',
    );
  }
});

const cliDefaults = {
  env: {},
  fetchImpl: async () => {
    throw new Error('Unexpected network request');
  },
  dotEnvStatus: { loaded: false, path: '/unused/.env', count: 0 },
};
test('public root qualification rejects an additional candidate dataset wrapper before any observation', async (t) => {
  const f = fixture(t);
  f.candidate.flowDataSet = {
    flowInformation: { dataSetInformation: { 'common:UUID': id(2) } },
    administrativeInformation: {
      publicationAndOwnership: { 'common:dataSetVersion': selectedVersion },
    },
  };
  f.intent.candidate.payload_sha256 = sha(f.candidate);
  const review = JSON.parse(fs.readFileSync(f.reviewFile, 'utf8'));
  review.candidate = f.intent.candidate;
  write(f.reviewFile, review);
  f.intent.review.sha256 = digest(f.reviewFile);
  write(f.intentFile, f.intent);
  write(f.input, [f.candidate]);
  const result = await executeCli(
    [
      'dataset',
      'verify-remote',
      '--input',
      f.input,
      '--out-dir',
      f.options.outDir,
      '--root-policy',
      'candidate',
      '--existing-draft-root-file',
      f.intentFile,
      '--json',
    ],
    {
      ...cliDefaults,
      runDatasetRemoteVerifyImpl: async (options) =>
        runDatasetRemoteVerify({ ...f.options, ...options }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /DATASET_EXISTING_DRAFT_ROOT_INVALID/u);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.options.outDir), false);
});
test('public CLI rejects repeated and empty root flags, documents qualification and forwards the selected file', async () => {
  for (const flags of [
    ['--existing-draft-root-file', ''],
    ['--existing-draft-root-file='],
    ['--existing-draft-root-file', 'a', '--existing-draft-root-file=b'],
  ]) {
    let calls = 0;
    const result = await executeCli(
      ['dataset', 'verify-remote', '--input', 'rows.json', '--out-dir', 'verify', ...flags],
      {
        ...cliDefaults,
        runDatasetRemoteVerifyImpl: async () => {
          calls++;
          throw new Error('Unexpected invocation');
        },
      },
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /DATASET_EXISTING_DRAFT_ROOT_INVALID/u);
    assert.equal(calls, 0);
  }
  const help = await executeCli(['dataset', 'verify-remote', '--help'], cliDefaults);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /--existing-draft-root-file/u);
  const result = await executeCli(
    [
      'dataset',
      'verify-remote',
      '--input',
      'rows.json',
      '--out-dir',
      'verify',
      '--root-policy',
      'candidate',
      '--existing-draft-root-file=root.json',
    ],
    {
      ...cliDefaults,
      runDatasetRemoteVerifyImpl: async (options) => {
        assert.equal(options.existingDraftRootFile, 'root.json');
        assert.equal(options.rootPolicy, 'candidate');
        throw new Error('Forwarded successfully');
      },
    },
  );
  assert.match(result.stderr, /Forwarded successfully/u);
});

function jsonResponse(rows: unknown[], count = rows.length) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-range'
          ? rows.length
            ? `0-${rows.length - 1}/${count}`
            : `*/${count}`
          : name.toLowerCase() === 'content-type'
            ? 'application/json'
            : null,
    },
    text: async () => JSON.stringify(rows),
  };
}

test('public executeCli uses fresh identity and real authenticated GET adapters for both complete selections', async (t) => {
  const f = fixture(t),
    urls: URL[] = [];
  const result = await executeCli(
    [
      'dataset',
      'verify-remote',
      '--input',
      f.input,
      '--out-dir',
      f.options.outDir!,
      '--root-policy',
      'candidate',
      '--existing-draft-root-file',
      f.intentFile,
    ],
    {
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: `https://${project}.supabase.co/functions/v1`,
        TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
        TIANGONG_LCA_ACCESS_TOKEN: 'root-test-token',
      }),
      dotEnvStatus: cliDefaults.dotEnvStatus,
      fetchImpl: async (input, init) => {
        assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
        const url = new URL(String(input));
        urls.push(url);
        if (url.pathname === '/auth/v1/user')
          return makeSupabaseAuthResponse({ userId: actor, accessToken: 'root-test-token' });
        assert.ok(url.pathname.endsWith('/processes'), url.pathname);
        const params = url.searchParams;
        if (params.get('select') === 'id,version')
          return jsonResponse([
            { id: processId, version: params.get('version')?.slice(3) ?? publicVersion },
          ]);
        if (params.has('and')) return jsonResponse([]);
        assert.ok(params.get('select')?.includes('json_ordered'));
        return jsonResponse([params.get('state_code') === 'eq.100' ? f.published : f.draft]);
      },
    },
  );
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  const report = JSON.parse(
    fs.readFileSync(
      path.join(f.options.outDir!, 'outputs', 'remote-verification-report.json'),
      'utf8',
    ),
  ) as Awaited<ReturnType<typeof runDatasetRemoteVerify>>;
  assert.equal(report.status, 'passed_remote_verification');
  assert.equal(urls.filter((url) => url.pathname === '/auth/v1/user').length, 3);
  const exactBodies = urls.filter(
    (url) =>
      url.searchParams.has('version') && url.searchParams.get('select')?.includes('json_ordered'),
  );
  assert.equal(exactBodies.length, 2);
  for (const url of exactBodies) {
    assert.equal(url.searchParams.get('version'), `eq.${selectedVersion}`);
    assert.equal(url.searchParams.get('user_id'), `eq.${actor}`);
    assert.equal(url.searchParams.get('state_code'), 'eq.0');
  }
  assert.equal(urls.filter((url) => url.searchParams.get('state_code') === 'eq.0').length, 4);
  assert.equal(urls.filter((url) => url.searchParams.has('and')).length, 2);
  assert.ok(!JSON.stringify(report).includes('root-test-token'));
});

test('root payload adapter requires one actor draft defensively and records the constrained source URL', async () => {
  const runtime = {
    apiBaseUrl: `https://${project}.supabase.co`,
    publishableKey: 'public-key',
    getAccessToken: async () => 'root-test-token',
  };
  const draft = remoteRow(selectedVersion, 0);
  for (const rows of [
    [],
    [draft, draft],
    [{ ...draft, user_id: owner }],
    [{ ...draft, state_code: 20 }],
    [draft],
  ]) {
    let calls = 0;
    const result = await __testInternals.lookupRemoteDatasetPayload({
      runtime,
      timeoutMs: 1000,
      request: { table: 'processes', id: processId, version: selectedVersion },
      ownerDraftUserId: actor,
      requireUnique: true,
      fetchImpl: async (input, init) => {
        calls++;
        const url = new URL(String(input));
        assert.equal(init?.method, 'GET');
        assert.equal(init?.body, undefined);
        assert.equal(url.searchParams.get('id'), `eq.${processId}`);
        assert.equal(url.searchParams.get('version'), `eq.${selectedVersion}`);
        assert.equal(url.searchParams.get('user_id'), `eq.${actor}`);
        assert.equal(url.searchParams.get('state_code'), 'eq.0');
        return jsonResponse(rows);
      },
    });
    assert.equal(calls, 1);
    if (rows.length !== 1 || rows[0] !== draft) {
      assert.equal(result, null);
    } else {
      assert.deepEqual(result?.payload, draft.json_ordered);
      const source = new URL(result!.source_url!);
      assert.equal(source.searchParams.get('user_id'), `eq.${actor}`);
      assert.equal(source.searchParams.get('state_code'), 'eq.0');
    }
  }
  const ordinary = await __testInternals.lookupRemoteDatasetPayload({
    runtime,
    timeoutMs: 1000,
    request: { table: 'processes', id: processId, version: selectedVersion },
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.has('user_id'), false);
      assert.equal(url.searchParams.has('state_code'), false);
      return jsonResponse([{ ...draft, user_id: owner, state_code: 20 }]);
    },
  });
  assert.equal(ordinary?.user_id, owner);
  assert.equal(ordinary?.state_code, 20);
});

test('public optional root readbacks always request the bound actor draft and block conflicting requirements', async (t) => {
  const cases = [
    { flags: ['--compare-root-payload'], statuses: ['payload_mismatch'] },
    { flags: ['--target-user-id', actor], statuses: [] },
    { flags: ['--state-code', '0'], statuses: [] },
    {
      flags: ['--compare-root-payload', '--target-user-id', actor],
      statuses: ['payload_mismatch'],
    },
    { flags: ['--compare-root-payload', '--state-code', '0'], statuses: ['payload_mismatch'] },
    { flags: ['--target-user-id', actor, '--state-code', '0'], statuses: [] },
    {
      flags: ['--compare-root-payload', '--target-user-id', actor, '--state-code', '0'],
      statuses: ['payload_mismatch'],
    },
    { flags: ['--target-user-id', owner], statuses: ['owner_mismatch'] },
    { flags: ['--state-code', '20'], statuses: ['state_code_mismatch'] },
    {
      flags: ['--compare-root-payload', '--target-user-id', owner, '--state-code', '20'],
      statuses: ['owner_mismatch', 'state_code_mismatch', 'payload_mismatch'],
    },
  ];
  for (const scenario of cases) {
    const f = fixture(t);
    const bodies: { url: URL; rows: unknown[] }[] = [];
    const result = await executeCli(
      [
        'dataset',
        'verify-remote',
        '--input',
        f.input,
        '--out-dir',
        f.options.outDir!,
        '--root-policy',
        'candidate',
        '--existing-draft-root-file',
        f.intentFile,
        ...scenario.flags,
      ],
      {
        env: buildSupabaseTestEnv({
          TIANGONG_LCA_API_BASE_URL: `https://${project}.supabase.co/functions/v1`,
          TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
          TIANGONG_LCA_ACCESS_TOKEN: 'root-test-token',
        }),
        dotEnvStatus: cliDefaults.dotEnvStatus,
        fetchImpl: async (input, init) => {
          assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
          assert.equal(init?.body, undefined);
          const url = new URL(String(input));
          if (url.pathname === '/auth/v1/user')
            return makeSupabaseAuthResponse({ userId: actor, accessToken: 'root-test-token' });
          assert.equal(url.pathname, '/rest/v1/processes');
          const params = url.searchParams;
          if (params.get('select') === 'id,version')
            return jsonResponse([
              { id: processId, version: params.get('version')?.slice(3) ?? publicVersion },
            ]);
          if (params.has('and')) return jsonResponse([]);
          if (params.has('version')) {
            assert.equal(params.get('id'), `eq.${processId}`);
            assert.equal(params.get('version'), `eq.${selectedVersion}`);
            assert.equal(params.get('user_id'), `eq.${actor}`);
            assert.equal(params.get('state_code'), 'eq.0');
            const rows = [f.draft].filter(
              (row) =>
                params.get('user_id') === `eq.${row.user_id}` &&
                params.get('state_code') === `eq.${row.state_code}`,
            );
            bodies.push({ url, rows });
            return jsonResponse(rows);
          }
          return jsonResponse([params.get('state_code') === 'eq.100' ? f.published : f.draft]);
        },
      },
    );
    assert.equal(result.exitCode, scenario.statuses.length ? 1 : 0, result.stderr || result.stdout);
    const report = JSON.parse(
      fs.readFileSync(
        path.join(f.options.outDir!, 'outputs', 'remote-verification-report.json'),
        'utf8',
      ),
    ) as Awaited<ReturnType<typeof runDatasetRemoteVerify>>;
    assert.equal(
      report.status,
      scenario.statuses.length ? 'blocked_remote_verification' : 'passed_remote_verification',
    );
    assert.equal(rootCheck(report).existing_draft_root?.applied, true);
    assert.equal(bodies.length, 3, scenario.flags.join(' '));
    assert.ok(bodies.every(({ rows }) => rows.length === 1 && rows[0] === f.draft));
    const readback = checks(report).filter((check) => check.path.endsWith('#readback'));
    for (const status of scenario.statuses)
      assert.ok(
        checks(report).some((check) => check.status === status),
        status,
      );
    assert.ok(readback.length > 0);
    for (const check of readback) {
      const source = new URL(check.exact_source_url!);
      assert.equal(source.searchParams.get('user_id'), `eq.${actor}`);
      assert.equal(source.searchParams.get('state_code'), 'eq.0');
    }
    assert.deepEqual(fs.readdirSync(path.dirname(report.files.report)), [
      'blockers.jsonl',
      'remote-verification-report.json',
      'remote-verification.jsonl',
    ]);
  }
});

test('public initial, final and optional body reads return no out-of-scope data after owner or state drift', async (t) => {
  for (const phase of ['initial', 'optional', 'final'] as const) {
    for (const drift of ['owner', 'state'] as const) {
      const f = fixture(t);
      const bodies: { phase: string; rows: unknown[] }[] = [];
      const result = await executeCli(
        [
          'dataset',
          'verify-remote',
          '--input',
          f.input,
          '--out-dir',
          f.options.outDir!,
          '--root-policy',
          'candidate',
          '--existing-draft-root-file',
          f.intentFile,
          '--target-user-id',
          actor,
          '--state-code',
          '0',
        ],
        {
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: `https://${project}.supabase.co/functions/v1`,
            TIANGONG_LCA_DISABLE_SESSION_CACHE: 'true',
            TIANGONG_LCA_ACCESS_TOKEN: 'root-test-token',
          }),
          dotEnvStatus: cliDefaults.dotEnvStatus,
          fetchImpl: async (input, init) => {
            assert.equal((init?.method ?? 'GET').toUpperCase(), 'GET');
            assert.equal(init?.body, undefined);
            const url = new URL(String(input));
            if (url.pathname === '/auth/v1/user')
              return makeSupabaseAuthResponse({ userId: actor, accessToken: 'root-test-token' });
            assert.equal(url.pathname, '/rest/v1/processes');
            const params = url.searchParams;
            if (params.get('select') === 'id,version')
              return jsonResponse([
                { id: processId, version: params.get('version')?.slice(3) ?? publicVersion },
              ]);
            if (params.has('and')) return jsonResponse([]);
            if (params.has('version')) {
              const currentPhase = ['initial', 'optional', 'final'][bodies.length]!;
              assert.equal(params.get('user_id'), `eq.${actor}`);
              assert.equal(params.get('state_code'), 'eq.0');
              const current =
                currentPhase !== phase
                  ? f.draft
                  : {
                      ...f.draft,
                      ...(drift === 'owner' ? { user_id: owner } : { state_code: 20 }),
                      json_ordered: payload(selectedVersion, 'Out-of-scope secret body'),
                    };
              const rows = [current].filter(
                (row) =>
                  params.get('user_id') === `eq.${row.user_id}` &&
                  params.get('state_code') === `eq.${row.state_code}`,
              );
              bodies.push({ phase: currentPhase, rows });
              return jsonResponse(rows);
            }
            return jsonResponse([params.get('state_code') === 'eq.100' ? f.published : f.draft]);
          },
        },
      );
      assert.equal(result.exitCode, 1, `${phase}:${drift}: ${result.stderr || result.stdout}`);
      const report = JSON.parse(
        fs.readFileSync(
          path.join(f.options.outDir!, 'outputs', 'remote-verification-report.json'),
          'utf8',
        ),
      ) as Awaited<ReturnType<typeof runDatasetRemoteVerify>>;
      assert.equal(report.status, 'blocked_remote_verification');
      assert.equal(bodies.length, 3);
      assert.deepEqual(bodies.find((body) => body.phase === phase)?.rows, []);
      assert.ok(!JSON.stringify(bodies).includes('Out-of-scope secret body'));
      if (phase === 'optional') {
        assert.equal(rootCheck(report).existing_draft_root?.applied, true);
        const readback = checks(report).find((check) => check.path.endsWith('#readback'))!;
        assert.equal(readback.status, 'missing_dataset');
        assert.equal(readback.remote_user_id, null);
        assert.equal(readback.remote_state_code, null);
        assert.equal(readback.remote_payload_sha256, null);
      } else {
        assert.equal(rootCheck(report).existing_draft_root?.applied, false);
        assert.equal(rootCheck(report).existing_draft_root?.failure, 'observation_failed');
      }
      assert.deepEqual(fs.readdirSync(path.dirname(report.files.report)), [
        'blockers.jsonl',
        'remote-verification-report.json',
        'remote-verification.jsonl',
      ]);
      assert.equal(fs.readFileSync(f.input, 'utf8'), JSON.stringify([f.candidate]));
    }
  }
});
