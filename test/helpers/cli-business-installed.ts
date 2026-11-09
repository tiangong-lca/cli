import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBusinessBackend } from './cli-business-backend.js';
import {
  businessActor,
  businessReviewer,
  businessOutsider,
  businessFixture,
  businessIdentity,
  businessEdit,
  writableTypes,
  wrappers,
  information,
} from './cli-business-fixtures.js';

type Json = Record<string, unknown>;
export async function assertInstalledBusiness(installedPackageRoot: string, consumerRoot: string) {
  const directory = path.join(consumerRoot, 'core-business');
  mkdirSync(directory, { mode: 0o700 });
  const home = path.join(directory, 'private-home');
  mkdirSync(home, { mode: 0o700 });
  const bin = path.join(installedPackageRoot, 'bin', 'tiangong-lca.js');
  const backend = createBusinessBackend(),
    service = await backend.start();
  let counter = 0;
  const jsonFile = (value: unknown) => {
    const file = path.join(directory, `${counter++}.json`);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const invoke = async (
    args: string[],
    actor = businessActor,
    expectedExit = 0,
    expectedErrorCode?: string,
  ) => {
    const child = spawn(process.execPath, [bin, ...args, '--json'], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TMPDIR: process.env.TMPDIR,
        HOME: home,
        USERPROFILE: home,
        TIANGONG_LCA_API_BASE_URL: `${service.origin}/functions/v1`,
        TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-fixture',
        TIANGONG_LCA_AUTH_MODE: 'access-token',
        TIANGONG_LCA_ACCESS_TOKEN:
          actor === businessActor
            ? 'submitter-token'
            : actor === businessReviewer
              ? 'reviewer-token'
              : 'outsider-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, expectedExit, `${args.join(' ')}\n${stderr}\n${stdout}`);
    if (expectedErrorCode) {
      assert.equal(stdout, '');
      const error = JSON.parse(stderr) as { error: { code: string } };
      assert.equal(error.error.code, expectedErrorCode);
      return {};
    }
    assert.equal(stderr, '');
    const value = JSON.parse(stdout) as Json;
    assert.ok(!stdout.includes('submitter-token') && !stdout.includes('reviewer-token'));
    if (value.replyTemplate) {
      assert.ok(existsSync(String(value.replyTemplate)));
      assert.ok(String(value.replyTemplate).startsWith(realpathSync(installedPackageRoot)));
    }
    return value;
  };
  const binding = (requestId: string, actor = businessActor) => ({
    requestId,
    expectedActor: actor,
    expectedEnvironment: service.origin,
  });
  const request = (type: string, action: string, input: unknown, actor = businessActor, exit = 0) =>
    invoke(['dataset', type, action, '--input', jsonFile(input)], actor, exit);
  const review = (action: string, input: unknown, actor = businessActor, exit = 0) =>
    invoke(['review', action, '--input', jsonFile(input)], actor, exit);
  const get = async (
    type: (typeof writableTypes)[number],
    identity: { id: string; version: string },
  ) => {
    const file = path.join(directory, `read-${counter++}.json`);
    await invoke([
      'dataset',
      type,
      'get',
      '--id',
      identity.id,
      '--version',
      identity.version,
      '--output',
      file,
    ]);
    return JSON.parse(readFileSync(file, 'utf8')) as Json;
  };
  try {
    for (const command of ['search', 'flow', 'process', 'lifecyclemodel', 'qa', 'publish']) {
      await invoke([command, '--help'], businessActor, 2, 'UNKNOWN_COMMAND');
    }
    for (const command of [
      'contract',
      'context-pack',
      'curation-queue',
      'author',
      'patch',
      'save-draft',
      'validate',
      'support-cache',
      'verify-remote',
      'bilingual',
      'evidence-search',
      'references',
    ]) {
      await invoke(['dataset', command, '--help'], businessActor, 2, 'UNKNOWN_COMMAND');
    }
    assert.equal(backend.calls.length, 0, 'Retired paths must not contact the backend');
    for (const type of writableTypes) {
      const content = businessFixture(type),
        identity = businessIdentity(type, content);
      const creation = { ...identity, ...binding(`${type}-create`), content };
      await request(type, 'create', creation);
      const createdCount = backend.calls.filter((c) => c.path.startsWith('/functions/')).length;
      assert.equal((await request(type, 'create', creation)).outcome, 'original_result_returned');
      assert.equal(
        backend.calls.filter((c) => c.path.startsWith('/functions/')).length,
        createdCount,
      );
      assert.deepEqual(await get(type, identity), content);
      const patched = businessEdit(type, content);
      const output = path.join(directory, `patch-${type}.json`);
      await invoke([
        'dataset',
        type,
        'patch',
        '--input',
        jsonFile({
          content,
          expectedDigest: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
          operations: [
            {
              op: 'add',
              path: `/${wrappers[type]}/${information[type]}/dataSetInformation/common:generalComment`,
              value: { '@xml:lang': 'en', '#text': 'Edited fixture' },
              basis: 'Controlled integration fixture',
            },
          ],
        }),
        '--output',
        output,
      ]);
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), patched);
      assert.deepEqual(await get(type, identity), content);
      await invoke([
        'dataset',
        type,
        'validate',
        '--input',
        jsonFile(patched),
        '--checks',
        'schema,business,references',
      ]);
      await request(type, 'save', {
        ...identity,
        ...binding(`${type}-save`),
        content: patched,
        expectedContent: content,
      });
      assert.deepEqual(await get(type, identity), patched);
      const count = backend.calls.filter((c) => c.path.startsWith('/functions/')).length;
      await request(
        type,
        'save',
        { ...identity, ...binding(`${type}-stale`), content, expectedContent: content },
        businessActor,
        1,
      );
      assert.equal(backend.calls.filter((c) => c.path.startsWith('/functions/')).length, count);

      const submitted = await review('submit', {
        ...binding(`${type}-submit`),
        targets: [{ type, ...identity }],
      });
      assert.equal(submitted.status, 'accepted');
      const reviewId = String((submitted.data as Json).reviewId);
      await invoke(['review', 'get', '--id', reviewId]);
      const materials = await invoke(['review', 'materials', '--id', reviewId]);
      assert.equal((materials.data as Json).historicalSnapshot, false);
      backend.assign(reviewId);
      await invoke(['review', 'list', '--role', 'reviewer'], businessReviewer);
      const draft = {
        ...binding(`${type}-draft`, businessReviewer),
        reviewId,
        expectedState: 1,
        json: { comment: { message: 'Controlled fixture assessment' } },
      };
      assert.equal(
        (await review('comment', draft, businessReviewer)).outcome,
        'review_draft_saved',
      );
      await review(
        'decide',
        {
          ...binding(`${type}-reject`, businessReviewer),
          reviewId,
          expectedState: 1,
          decision: 'reject',
          reason: 'Controlled rejection fixture',
        },
        businessReviewer,
      );
      assert.equal(backend.reviews.get(reviewId)!.state_code, 1);
      backend.finalize(reviewId);
      const revised = businessEdit(type, patched, 'Corrected after rejection');
      await request(type, 'save', {
        ...identity,
        ...binding(`${type}-revision`),
        content: revised,
        expectedContent: patched,
      });
      const resubmitted = await review('resubmit', {
        ...binding(`${type}-resubmit`),
        targets: [{ type, ...identity }],
        reviewId,
        expectedState: -1,
        changeSummary: 'Corrected fixture evidence',
      });
      const nextId = String((resubmitted.data as Json).reviewId);
      backend.assign(nextId);
      await review(
        'comment',
        { ...draft, ...binding(`${type}-draft2`, businessReviewer), reviewId: nextId },
        businessReviewer,
      );
      await review(
        'decide',
        {
          ...binding(`${type}-approve`, businessReviewer),
          reviewId: nextId,
          expectedState: 1,
          decision: 'approve',
        },
        businessReviewer,
      );
      assert.equal(backend.reviews.get(nextId)!.state_code, 1);
      backend.finalize(nextId);
    }
    // A complete valid Model generates one qualified candidate, without saving it.
    const processFile = jsonFile(businessFixture('process'));
    const modelRequest = {
      source_model: { json_ordered: businessFixture('model') },
      projection: {
        mode: 'primary-only',
        process_id: '99999999-9999-4999-8999-999999999999',
        process_version: '00.00.001',
      },
      process_sources: { process_json_files: [processFile] },
    };
    await invoke([
      'dataset',
      'model',
      'graph',
      '--input',
      jsonFile({ content: businessFixture('model') }),
    ]);
    const generated: Json[] = [];
    const beforeGeneration = backend.calls.length;
    for (const action of ['build-resulting-process', 'aggregate']) {
      const output = path.join(directory, `${action}.json`);
      const value = await invoke([
        'dataset',
        'model',
        action,
        '--input',
        jsonFile(modelRequest),
        '--output',
        output,
      ]);
      assert.equal(value.operation, 'dataset model build-resulting-process');
      const result = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(result.qualification.status, 'qualified');
      delete result.bundle.report.generated_at;
      generated.push(result.bundle);
    }
    assert.deepEqual(generated[0], generated[1]);
    assert.equal(backend.calls.length, beforeGeneration);
    const candidate = (generated[0]!.projected_processes as Json[])[0]!.json_ordered as Json;
    await invoke([
      'dataset',
      'process',
      'validate',
      '--input',
      jsonFile(candidate),
      '--checks',
      'schema,business,references',
    ]);
    const projectedIdentity = businessIdentity('process', candidate);
    await request('process', 'create', {
      ...projectedIdentity,
      ...binding('projected-process-create'),
      content: candidate,
    });
    assert.deepEqual(await get('process', projectedIdentity), candidate);

    // Attachment transfer is independently observed; only the separate save updates Source.
    const source = businessFixture('source');
    const sourceInfo = ((source.sourceDataSet as Json).sourceInformation as Json)
      .dataSetInformation as Json;
    sourceInfo['common:UUID'] = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    sourceInfo.referenceToDigitalFile = { '@uri': 'fixture.pdf' };
    const sourceIdentity = businessIdentity('source', source);
    await request('source', 'create', {
      ...sourceIdentity,
      ...binding('attachment-source-create'),
      content: source,
    });
    const bytes = Buffer.from('synthetic-pdf-fixture');
    const attachment = path.join(directory, 'fixture.pdf');
    writeFileSync(attachment, bytes);
    const uploadRequest = {
      content: source,
      bucket: 'external_docs',
      attachments: [
        {
          name: 'fixture.pdf',
          path: attachment,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };
    const uploadOutput = path.join(directory, 'attachment-candidate.json');
    const upload = await invoke([
      'dataset',
      'source',
      'upload-attachments',
      '--input',
      jsonFile(uploadRequest),
      '--output',
      uploadOutput,
    ]);
    assert.equal(upload.outcome, 'attachments_uploaded');
    assert.deepEqual(await get('source', sourceIdentity), source);
    const uploaded = JSON.parse(readFileSync(uploadOutput, 'utf8')).content;
    await request('source', 'save', {
      ...sourceIdentity,
      ...binding('attachment-source-save'),
      content: uploaded,
      expectedContent: source,
    });
    assert.deepEqual(await get('source', sourceIdentity), uploaded);
    const changedUpload = businessEdit('source', uploaded, 'Saved response intentionally lost');
    const lostSave = {
      ...sourceIdentity,
      ...binding('lost-save'),
      content: changedUpload,
      expectedContent: uploaded,
    };
    backend.loseReplies.add('app_dataset_save_draft');
    assert.equal((await request('source', 'save', lostSave, businessActor, 1)).status, 'unknown');
    const saves = backend.calls.filter((c) => c.path.endsWith('/app_dataset_save_draft')).length;
    assert.equal((await request('source', 'save', lostSave, businessActor, 1)).status, 'unknown');
    assert.equal(
      backend.calls.filter((c) => c.path.endsWith('/app_dataset_save_draft')).length,
      saves,
    );
    assert.deepEqual(await get('source', sourceIdentity), changedUpload);

    // Fresh native processes share the same private durable journal, never an in-memory cache.
    const content = businessFixture('contact'),
      identity = businessIdentity('contact', content);
    const root = content.contactDataSet as Json;
    const info = root.contactInformation as Json;
    (info.dataSetInformation as Json)['common:UUID'] = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const exact = businessIdentity('contact', content);
    const lost = { ...exact, ...binding('lost-create'), content };
    backend.loseReplies.add('app_dataset_create');
    assert.equal((await request('contact', 'create', lost, businessActor, 1)).status, 'unknown');
    const posted = backend.calls.filter((c) => c.path.endsWith('/app_dataset_create')).length;
    assert.equal((await request('contact', 'create', lost, businessActor, 1)).status, 'unknown');
    assert.equal(
      backend.calls.filter((c) => c.path.endsWith('/app_dataset_create')).length,
      posted,
    );
    assert.deepEqual(await get('contact', exact), content);
    await request(
      'contact',
      'create',
      { ...lost, ...binding('lost-create', businessOutsider) },
      businessOutsider,
      1,
    );
    assert.equal(
      backend.calls.filter((c) => c.path.endsWith('/app_dataset_create')).length,
      posted,
    );
    backend.loseReplies.add('app_dataset_submit_review');
    const submission = { ...binding('lost-submit'), targets: [{ type: 'contact', ...exact }] };
    assert.equal((await review('submit', submission, businessActor, 1)).status, 'unknown');
    const submissions = backend.calls.filter((c) =>
      c.path.endsWith('/app_dataset_submit_review'),
    ).length;
    assert.equal((await review('submit', submission, businessActor, 1)).status, 'unknown');
    assert.equal(
      backend.calls.filter((c) => c.path.endsWith('/app_dataset_submit_review')).length,
      submissions,
    );
    const own = [...backend.reviews.values()].find(
      (r) => ((r.json as Json).data as Json).id === exact.id,
    )!;
    const reviewId = String(own.id);
    backend.assign(reviewId);
    await review(
      'comment',
      { ...binding('lost-decision-draft', businessReviewer), reviewId, expectedState: 1, json: {} },
      businessReviewer,
    );
    const decision = {
      ...binding('lost-decision', businessReviewer),
      reviewId,
      expectedState: 1,
      decision: 'approve',
    };
    backend.loseReplies.add('app_review_batch_decision');
    assert.equal((await review('decide', decision, businessReviewer, 1)).status, 'unknown');
    const decisions = backend.calls.filter((c) =>
      c.path.endsWith('/app_review_batch_decision'),
    ).length;
    assert.equal((await review('decide', decision, businessReviewer, 1)).status, 'unknown');
    assert.equal(
      backend.calls.filter((c) => c.path.endsWith('/app_review_batch_decision')).length,
      decisions,
    );
    assert.notEqual(exact.id, identity.id);
  } finally {
    await service.close();
  }
}
