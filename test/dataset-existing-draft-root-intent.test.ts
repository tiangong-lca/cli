import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { CliError } from '../src/lib/errors.js';
import { sha256Json } from '../src/lib/dataset-maintenance-contract.js';
import type { ExactReferenceConsumer } from '../src/lib/dataset-exact-reference-intent.js';
import type { RemoteDatasetReference } from '../src/lib/dataset-remote-verify.js';
import {
  assertExistingDraftRootInputsCurrent,
  loadExistingDraftRootIntent,
} from '../src/lib/dataset-existing-draft-root-intent.js';

type ObjectValue = Record<string, unknown>;
const actor = '00000000-0000-4000-8000-000000000090';
const id = 'a0000000-0000-4000-8000-000000000001';
const foreign = '00000000-0000-4000-8000-000000000091';
const project = 'abcdefghijklmnopqrst';
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function set(value: ObjectValue, keys: string[], next: unknown) {
  let current = value;
  for (const key of keys.slice(0, -1)) current = current[key] as ObjectValue;
  current[keys[keys.length - 1]!] = next;
}
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-existing-draft-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const intentFile = path.join(root, 'intent.json'),
    reviewFile = path.join(root, 'review.json');
  const consumer: ExactReferenceConsumer = {
    row_index: 0,
    table: 'processes',
    id,
    version: '00.00.002',
    payload_sha256: sha256Json({ scientific: 'complete intended revision' }),
  };
  const selected = {
    table: 'processes',
    id,
    version: consumer.version,
    user_id: actor,
    state_code: 0,
    payload_sha256: sha256Json({ scientific: 'complete before image' }),
    row_sha256: 'a'.repeat(64),
  };
  const baseline = {
    ...selected,
    version: '00.00.004',
    user_id: foreign,
    state_code: 100,
    row_sha256: 'b'.repeat(64),
  };
  const review: ObjectValue = {
    schema_version: 'dataset-existing-draft-root-review.v1',
    decision: 'revise_selected_draft',
    reason:
      'The complete intended revision reconciles the published scientific baseline in the fixed draft.',
    candidate: { ...consumer },
    selected: { ...selected },
    published_baseline: { ...baseline },
  };
  fs.writeFileSync(reviewFile, JSON.stringify(review));
  const intent: ObjectValue = {
    schema_version: 'dataset-existing-draft-root.v1',
    project_ref: project,
    actor_user_id: actor,
    candidate: { ...consumer },
    selection: {
      strategy: 'sole_current_owner_draft',
      drafts: [selected],
      reviews: [],
      published_baseline: baseline,
    },
    review: { file: './review.json', sha256: digest(reviewFile) },
  };
  const references: RemoteDatasetReference[] = [
    {
      row_index: 0,
      role: 'root',
      table: 'processes',
      id,
      version: consumer.version,
      type: 'process data set',
      path: '/processDataSet',
      short_description: null,
    },
  ];
  const write = () => fs.writeFileSync(intentFile, JSON.stringify(intent));
  const writeReview = () => {
    fs.writeFileSync(reviewFile, JSON.stringify(review));
    set(intent, ['review', 'sha256'], digest(reviewFile));
    write();
  };
  write();
  const input = { file: intentFile as unknown, consumers: [consumer], references };
  return { root, intentFile, reviewFile, intent, review, write, writeReview, input };
}
function invalid(run: () => unknown) {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof CliError && error.code === 'DATASET_EXISTING_DRAFT_ROOT_INVALID',
  );
}

test('binds a distinct complete revision to one fixed older owner draft and newer foreign-owned public baseline', (t) => {
  const f = fixture(t);
  f.input.references.push({
    ...f.input.references[0]!,
    role: 'reference',
    table: 'lifecyclemodels',
  });
  const loaded = loadExistingDraftRootIntent(f.input);
  assert.deepEqual(loaded.candidate, f.input.consumers[0]);
  assert.equal(loaded.selection.drafts[0].state_code, 0);
  assert.notEqual(loaded.candidate.payload_sha256, loaded.selection.drafts[0].payload_sha256);
  assert.equal(loaded.selection.published_baseline.user_id, foreign);
  assert.equal(loaded.review_file.path, f.reviewFile);
  assert.equal(loaded.file.bytes, fs.statSync(f.intentFile).size);
  assert.equal(loaded.file.sha256, digest(f.intentFile));
  assertExistingDraftRootInputsCurrent(loaded, f.input.consumers);
});

test('normalizes UUID case and resolves absolute explicitly selected review paths', (t) => {
  const f = fixture(t);
  set(f.intent, ['candidate', 'id'], id.toUpperCase());
  set(f.intent, ['selection', 'drafts', '0', 'id'], id.toUpperCase());
  set(f.intent, ['review', 'file'], f.reviewFile);
  f.input.references[0]!.id = id.toUpperCase();
  f.write();
  assert.equal(loadExistingDraftRootIntent(f.input).candidate.id, id);
});

const badIntentFields: Array<[string[], unknown]> = [
  [['schema_version'], 'dataset-exact-reference-intent.v1'],
  [['project_ref'], 'bad'],
  [['actor_user_id'], 'bad'],
  [['actor_user_id'], null],
  [['actor_user_id'], ''],
  [['actor_user_id'], ' '.repeat(4097)],
  [['actor_user_id'], `${actor}\n`],
  [['candidate'], null],
  [['candidate'], []],
  [['candidate'], 5],
  [['candidate', 'extra'], true],
  [['candidate', 'id'], undefined],
  [['candidate', 'id,version'], 'joined keys cannot hide omitted fields'],
  [['candidate', 'row_index'], 1],
  [['candidate', 'table'], 'lifecyclemodels'],
  [['candidate', 'version'], '0.0.2'],
  [['candidate', 'payload_sha256'], 'A'.repeat(64)],
  [['selection'], null],
  [['selection', 'strategy'], 'pick_latest'],
  [['selection', 'drafts'], null],
  [['selection', 'drafts'], []],
  [
    ['selection', 'drafts'],
    [{}, {}],
  ],
  [['selection', 'reviews'], null],
  [['selection', 'reviews'], [{ version: '00.00.003' }]],
  [['selection', 'drafts', '0', 'table'], 'flows'],
  [['selection', 'drafts', '0', 'state_code'], 20],
  [['selection', 'drafts', '0', 'id'], foreign],
  [['selection', 'drafts', '0', 'version'], '00.00.001'],
  [['selection', 'drafts', '0', 'user_id'], foreign],
  [['selection', 'drafts', '0', 'state_code'], 100],
  [['selection', 'drafts', '0', 'row_sha256'], 'bad'],
  [['selection', 'published_baseline', 'id'], foreign],
  [['selection', 'published_baseline', 'state_code'], 0],
  [['selection', 'published_baseline', 'version'], '00.00.002'],
  [['selection', 'published_baseline', 'version'], '00.00.001'],
  [['review', 'file'], ' ./review.json'],
  [['review', 'file'], './review.json\0'],
  [['review', 'sha256'], 'c'.repeat(64)],
  [['review', 'sha256'], 'invalid'],
];
for (const [keys, value] of badIntentFields) {
  test(`rejects invalid intent ${keys.join('.')} = ${JSON.stringify(value)?.slice(0, 90)}`, (t) => {
    const f = fixture(t);
    set(f.intent, keys, value);
    f.write();
    invalid(() => loadExistingDraftRootIntent(f.input));
  });
}

test('rejects joined object keys even when their sorted concatenation could match expected keys', (t) => {
  const f = fixture(t);
  const candidate = f.intent.candidate as ObjectValue;
  candidate['id,payload_sha256'] = id;
  delete candidate.id;
  delete candidate.payload_sha256;
  f.write();
  invalid(() => loadExistingDraftRootIntent(f.input));
});

const badReviews: Array<[string[], unknown]> = [
  [['schema_version'], 'other'],
  [['decision'], 'use_selected_exact'],
  [['reason'], null],
  [['reason'], '  '],
  [['reason'], 'r'.repeat(8193)],
  [['candidate', 'payload_sha256'], 'c'.repeat(64)],
  [['selected', 'payload_sha256'], 'c'.repeat(64)],
  [['selected', 'row_sha256'], 'c'.repeat(64)],
  [['published_baseline', 'row_sha256'], 'c'.repeat(64)],
  [['published_baseline', 'payload_sha256'], 'c'.repeat(64)],
];
for (const [keys, value] of badReviews) {
  test(`rejects unbound compatibility review ${keys.join('.')}`, (t) => {
    const f = fixture(t);
    set(f.review, keys, value);
    f.writeReview();
    invalid(() => loadExistingDraftRootIntent(f.input));
  });
}

test('requires exactly one matching current candidate and typed root', (t) => {
  const variants: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.input.consumers = [];
    },
    (f) => {
      f.input.consumers.push({ ...f.input.consumers[0]! });
    },
    (f) => {
      f.input.consumers[0]!.payload_sha256 = 'c'.repeat(64);
    },
    (f) => {
      f.input.references = [];
    },
    (f) => {
      f.input.references.push({ ...f.input.references[0]! });
    },
    (f) => {
      f.input.references[0]!.row_index = 1;
    },
    (f) => {
      f.input.references[0]!.table = 'lifecyclemodels';
    },
    (f) => {
      f.input.references[0]!.id = null;
    },
    (f) => {
      f.input.references[0]!.id = foreign;
    },
    (f) => {
      f.input.references[0]!.version = '00.00.004';
    },
  ];
  for (const mutate of variants) {
    const f = fixture(t);
    mutate(f);
    invalid(() => loadExistingDraftRootIntent(f.input));
  }
});

test('rejects missing, nonregular, symlinked, oversized and invalid UTF-8 or JSON selected files', (t) => {
  for (const role of ['intent', 'review'] as const) {
    for (const mode of ['missing', 'directory', 'symlink', 'large', 'utf8', 'json'] as const) {
      const f = fixture(t),
        selected = role === 'intent' ? f.intentFile : f.reviewFile;
      fs.unlinkSync(selected);
      if (mode === 'directory') fs.mkdirSync(selected);
      if (mode === 'symlink')
        fs.symlinkSync(role === 'intent' ? f.reviewFile : f.intentFile, selected);
      if (mode === 'large') fs.writeFileSync(selected, Buffer.alloc(8 * 1024 * 1024 + 1));
      if (mode === 'utf8') fs.writeFileSync(selected, Buffer.from([0x7b, 0xff, 0x7d]));
      if (mode === 'json') fs.writeFileSync(selected, '{');
      invalid(() => loadExistingDraftRootIntent(f.input));
    }
  }
});

test('checks file bytes again after the size observation', (t) => {
  const f = fixture(t);
  t.mock.method(fs, 'readFileSync', () => Buffer.alloc(8 * 1024 * 1024 + 1));
  invalid(() => loadExistingDraftRootIntent(f.input));
});

test('rejects unsupported selected file locators and top-level values', (t) => {
  const f = fixture(t);
  for (const file of [null, '', ` ${f.intentFile}`])
    invalid(() => loadExistingDraftRootIntent({ ...f.input, file }));
  for (const value of [null, [], 4, {}]) {
    fs.writeFileSync(f.intentFile, JSON.stringify(value));
    invalid(() => loadExistingDraftRootIntent(f.input));
  }
});

test('rechecks complete candidate and raw bytes of both selected files at use', (t) => {
  for (const role of ['intent', 'review', 'candidate', 'count', 'size'] as const) {
    const f = fixture(t),
      loaded = loadExistingDraftRootIntent(f.input);
    if (role === 'candidate') f.input.consumers[0]!.payload_sha256 = 'c'.repeat(64);
    else if (role === 'count') f.input.consumers = [];
    else if (role === 'size') loaded.file.bytes++;
    else fs.appendFileSync(role === 'intent' ? f.intentFile : f.reviewFile, ' ');
    invalid(() => assertExistingDraftRootInputsCurrent(loaded, f.input.consumers));
  }
});
