import { isDeepStrictEqual } from 'node:util';
import { contentDigest } from './dataset-content.js';
import {
  requireContent,
  text,
  object,
  type DatasetType,
  type DatasetPorts,
  type JsonObject,
} from './dataset-types.js';
import { result, CommandInputError, type CommandResult } from '../shared/command-result.js';
import type { MutationJournal } from './operation-ports.js';

export type WritableDatasetType = Exclude<DatasetType, 'lciamethod' | 'flowproperty' | 'unitgroup'>;
export type DatasetMutationAction = 'create' | 'save' | 'delete';
export type DatasetWriteDispatch = {
  type: WritableDatasetType;
  action: DatasetMutationAction;
  id: string;
  version: string;
  content: JsonObject;
  expected: JsonObject | null;
  previousGraph?: JsonObject;
  beforeDispatch(): void;
};
export type DatasetWritePorts = {
  identity(): Promise<{ environment: string; actor: { userId: string } }>;
  contentIdentity(
    content: JsonObject,
    type: WritableDatasetType,
  ): { id: string | null; version: string | null };
  read: DatasetPorts['read'];
  qualify(type: DatasetType, content: JsonObject): Promise<void>;
  withJournal<T>(
    requestId: string,
    target: JsonObject,
    execute: (journal: MutationJournal) => Promise<T>,
  ): Promise<T>;
  dispatch(input: DatasetWriteDispatch): Promise<unknown>;
};

export async function executeDatasetWrite(
  type: DatasetType,
  action: DatasetMutationAction,
  request: JsonObject,
  dryRun: boolean,
  ports: DatasetWritePorts,
): Promise<CommandResult> {
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
  const identity = ports.contentIdentity(content, type);
  if (identity.id !== id || identity.version !== version)
    throw new CommandInputError(
      'IDENTITY_MISMATCH',
      'Content identity must equal the explicit target id and version.',
    );
  const expected = action !== 'create' ? object(request.expectedContent, 'expectedContent') : null;
  const { environment, actor } = await ports.identity();
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
  const read = ports.read;
  const lookup = async () =>
    (await read(type, { id, version, limit: 1, offset: 0 })).records[0] ?? null;
  let previousGraph: Record<string, unknown> | undefined;
  const preflight = async () => {
    if (action !== 'delete') await ports.qualify(type, content);
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
  const binding = contentDigest({ action, type, request, actor: actor.userId, environment });
  return ports.withJournal(requestId, { type, id, version, environment }, async (store) => {
    const journal = store.path;
    const persist = (state: string, response?: unknown) =>
      store.write({
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
      });
    const unknown = async () => {
      value.status = 'unknown';
      value.outcome = 'write_outcome_unknown';
      value.summary =
        'Original write outcome is unconfirmed. This request will not be dispatched again.';
      value.data.recovery = { journal, requestId, replayAllowed: false };
      const current = await lookup().catch(() => null);
      value.data.readback = {
        available: current !== null,
        contentMatchesIntent: current !== null && isDeepStrictEqual(current.content, content),
        establishesRequestOutcome: false,
      };
      return value;
    };
    const previous = store.read();
    if (previous) {
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
      const response = await ports.dispatch({
        type,
        action,
        id,
        version,
        content,
        expected,
        previousGraph,
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
  });
}
