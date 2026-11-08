import { mkdirSync, existsSync, readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { contentDigest } from '../application/dataset-content.js';
import {
  datasetKinds,
  datasetTables,
  requireContent,
  text,
  object,
  type DatasetPorts,
  type DatasetType,
} from '../application/dataset-types.js';
import { result, CommandInputError } from '../shared/command-result.js';
import { writeCommandOutput } from '../shared/command-files.js';
import { withBatchRunLock } from '../lib/batch/run-lock.js';
import { datasetIdentity } from '../lib/dataset-local.js';
import { fetchCurrentUser } from '../lib/auth-identity-receipt.js';
import {
  resolveDatasetCommandTransport,
  createDatasetRecord,
  saveDraftDatasetRecord,
  deleteDatasetRecord,
} from '../lib/dataset-command.js';
import { datasetReader } from './dataset-read.js';
import type { FetchLike } from '../lib/http.js';
import { qualifyDatasetWrite } from './dataset-write-checks.js';
import { writeModelDraft } from './model-write.js';

export function datasetWriter(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  stateDirectory = path.join(os.homedir(), '.local', 'state', 'tiangong-lca', 'dataset-operations'),
  qualify: typeof qualifyDatasetWrite = qualifyDatasetWrite,
): DatasetPorts['mutate'] {
  return async (type: DatasetType, action, request, dryRun) => {
    const allowed = [
      'id',
      'version',
      'content',
      'expectedContent',
      'requestId',
      'expectedActor',
      'expectedEnvironment',
    ];
    if (Object.keys(request).some((key) => !allowed.includes(key)))
      throw new CommandInputError(
        'REQUEST_FIELD_UNSUPPORTED',
        'Request contains an unsupported field. Inspect the write request contract.',
      );
    const id = text(request.id, 'id');
    const version = text(request.version, 'version');
    const requestId = text(request.requestId, 'requestId');
    const expectedActor = text(request.expectedActor, 'expectedActor');
    const expectedEnvironment = text(request.expectedEnvironment, 'expectedEnvironment');
    if (!/^[0-9a-f-]{36}$/iu.test(id) || !/^\d{2}\.\d{2}\.\d{3}$/u.test(version))
      throw new CommandInputError(
        'IDENTITY_INVALID',
        'Writes require an explicit UUID and exact 00.00.000 version.',
      );
    if (type === 'model' && action === 'delete')
      throw new CommandInputError(
        'CAPABILITY_UNSUPPORTED',
        'Model deletion is outside this interface.',
      );
    if (type === 'lciamethod' || type === 'flowproperty' || type === 'unitgroup')
      throw new CommandInputError('CAPABILITY_UNSUPPORTED', 'Reference data is read-only.');
    const content = requireContent(
      type,
      action === 'delete' ? request.expectedContent : request.content,
    );
    const identity = datasetIdentity({}, content, datasetKinds[type]);
    if (identity.id !== id || identity.version !== version)
      throw new CommandInputError(
        'IDENTITY_MISMATCH',
        'Content identity must equal the explicit target id and version.',
      );
    const expected =
      action !== 'create' ? object(request.expectedContent, 'expectedContent') : null;
    const transport = await resolveDatasetCommandTransport({ env, fetchImpl, timeoutMs: 10_000 });
    const environment = new URL(transport.functionsBaseUrl).origin;
    const actor = await fetchCurrentUser({
      projectBaseUrl: environment,
      publishableKey: transport.publishableKey,
      accessToken: transport.accessToken,
      timeoutMs: transport.timeoutMs,
      fetchImpl,
    });
    if (environment !== expectedEnvironment || actor.userId !== expectedActor)
      throw new CommandInputError(
        'IDENTITY_BINDING_MISMATCH',
        'Current actor or environment does not match the write request.',
      );
    const value = result(`dataset ${type} ${action}`);
    value.context = {
      environment,
      actor: { id: actor.userId, source: 'online' },
      requestId,
      effectiveInput: { id, version, action, contentDigest: contentDigest(content) },
      observation: { source: 'remote', time: new Date().toISOString() },
    };
    value.data = { subject: { type, id, version }, contentDigest: contentDigest(content) };
    if (action === 'delete' || (type === 'model' && action === 'save')) {
      value.completeness.notChecked = ['server_content_compare_and_swap'];
      value.warnings.push({
        code: 'PREFLIGHT_CONTENT_CHECK_ONLY',
        message:
          'Expected content is checked before dispatch. The existing service does not compare that content again inside its write transaction.',
      });
    }
    const read = datasetReader(env, fetchImpl);
    const lookup = async () =>
      (await read(type, { id, version, limit: 1, offset: 0 })).records[0] ?? null;
    let previousGraph: Record<string, unknown> | undefined;
    const preflight = async () => {
      if (action !== 'delete') await qualify(type, content, env, fetchImpl);
      const current = await lookup();
      previousGraph = current?.modelGraph;
      if (action === 'create' && current)
        throw new CommandInputError(
          'CREATE_CONFLICT',
          'The target version already exists. Create does not save or upsert.',
        );
      if (
        action !== 'create' &&
        (!current ||
          current.owner !== actor.userId ||
          current.stateCode !== 0 ||
          !isDeepStrictEqual(current.content, expected))
      )
        throw new CommandInputError(
          action === 'delete' ? 'DELETE_CONFLICT' : 'SAVE_CONFLICT',
          'Existing owner draft and complete expectedContent must match current content.',
        );
    };
    if (dryRun) {
      await preflight();
      value.outcome = 'preview_completed';
      value.summary =
        'Readable write preconditions checked; no mutation or request record was created.';
      value.completeness = {
        ...value.completeness,
        notChecked: [
          'server_write_time_admission',
          ...((value.completeness.notChecked as string[]) ?? []),
        ],
        dryRun: true,
      };
      return value;
    }
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const key = contentDigest(requestId);
    const journal = path.join(stateDirectory, `${key}.json`);
    const binding = contentDigest({ action, type, request, actor: actor.userId, environment });
    return withBatchRunLock(
      { runPath: path.join(stateDirectory, key), reason: 'dataset-request', identity: key },
      () =>
        withBatchRunLock(
          {
            runPath: path.join(stateDirectory, contentDigest({ type, id, version, environment })),
            reason: 'dataset-target',
            identity: 'dataset-target',
          },
          async () => {
            const persist = (state: string, response?: unknown) =>
              writeCommandOutput(
                journal,
                {
                  schemaVersion: 1,
                  binding,
                  action,
                  type,
                  requestId,
                  id,
                  version,
                  actor: actor.userId,
                  environment,
                  state,
                  contentDigest: contentDigest(content),
                  intent: request,
                  response: response ?? null,
                },
                true,
              );
            const unknown = async () => {
              value.status = 'unknown';
              value.outcome = 'write_outcome_unknown';
              value.summary =
                'Original write outcome is unconfirmed. This request will not be dispatched again.';
              value.data.recovery = { journal, requestId, replayAllowed: false };
              const current = await lookup().catch(() => null);
              value.data.readback = {
                available: current !== null,
                contentMatchesIntent:
                  current !== null && isDeepStrictEqual(current.content, content),
                establishesRequestOutcome: false,
              };
              value.nextActions = [
                {
                  description:
                    'Read the exact target and reconcile the original request; do not generate a new request to hide an unknown result.',
                  command: `tiangong-lca dataset ${type} get --id ${id} --version ${version} --json`,
                },
              ];
              return value;
            };
            if (existsSync(journal)) {
              const stat = lstatSync(journal);
              if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0))
                throw new CommandInputError(
                  'JOURNAL_UNSAFE',
                  'Recovery journal must be a private regular file.',
                );
              const previous = object(
                JSON.parse(readFileSync(journal, 'utf8')),
                'recovery journal',
              );
              if (previous.binding !== binding)
                throw new CommandInputError(
                  'REQUEST_CONFLICT',
                  'requestId is already bound to different content, intent, actor or environment.',
                );
              if (previous.state === 'completed') {
                value.outcome = 'original_result_returned';
                value.summary =
                  'Returned the locally recorded original successful result; no mutation repeated.';
                value.data.originalResult = previous.response;
                return value;
              }
              return unknown();
            }
            await preflight();
            // The exact intent is durable before the helper reaches its single transport dispatch.
            let dispatched = false;
            const beforeDispatch = () => {
              persist('dispatched');
              dispatched = true;
            };
            try {
              const response =
                action === 'delete'
                  ? await deleteDatasetRecord({
                      transport,
                      table: datasetTables[type],
                      id,
                      version,
                      beforeDispatch,
                    })
                  : type === 'model'
                    ? await writeModelDraft(
                        transport,
                        id,
                        version,
                        content,
                        beforeDispatch,
                        action,
                        previousGraph,
                      )
                    : action === 'create'
                      ? await createDatasetRecord({
                          transport,
                          table: datasetTables[type],
                          id,
                          payload: content,
                          beforeDispatch,
                        })
                      : await saveDraftDatasetRecord({
                          transport,
                          table: datasetTables[type],
                          id,
                          version,
                          payload: content,
                          expectedJsonOrdered: expected!,
                          beforeDispatch,
                        });
              const current = await lookup();
              if (
                action === 'delete'
                  ? current !== null
                  : !current || !isDeepStrictEqual(current.content, content)
              ) {
                persist('unknown');
                return unknown();
              }
              persist('completed', response);
              value.data.readback = {
                ...(action === 'delete' ? { targetAbsent: true } : { contentMatchesIntent: true }),
                subject: { type, id, version },
              };
              value.outcome = action === 'delete' ? 'dataset_deleted' : 'dataset_written';
              value.summary =
                action === 'delete'
                  ? 'Draft deletion acknowledged and target absence independently observed.'
                  : 'Dataset write acknowledged and exact content independently read back.';
              value.nextActions = [
                {
                  description: 'Read the saved dataset.',
                  command: `tiangong-lca dataset ${type} get --id ${id} --version ${version} --json`,
                },
              ];
              return value;
            } catch (error) {
              if (!dispatched) throw error;
              try {
                persist('unknown');
              } catch {
                value.warnings.push({
                  code: 'JOURNAL_UPDATE_UNAVAILABLE',
                  message:
                    'The original pre-dispatch record remains the recovery basis; do not replay this write.',
                });
              }
              return unknown();
            }
          },
        ),
    );
  };
}
