import { applyServiceRejection, ServiceRejectedError } from './service-rejection.js';
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
import type { MutationDiagnostic, MutationEvidence, MutationJournal } from './operation-ports.js';

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
  qualify(
    type: DatasetType,
    content: JsonObject,
  ): Promise<void | Array<{ code: string; message: string }>>;
  describeFailure?(error: unknown): MutationDiagnostic;
  failureData?(error: unknown): JsonObject;
  withJournal<T>(
    requestId: string,
    target: JsonObject,
    execute: (journal: MutationJournal) => Promise<T>,
  ): Promise<T>;
  dispatch(input: DatasetWriteDispatch): Promise<unknown>;
};

// app_dataset_create validates the target with Zod's generic UUID schema.
const createIdPattern =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;

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
  if (action === 'create' && type !== 'model' && !createIdPattern.test(id))
    throw new CommandInputError(
      'IDENTITY_INVALID',
      'id must be a UUID accepted by the create service. Generate a standard UUID for a new dataset.',
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
  let evidence: MutationEvidence = {
    stage: 'preflight',
    acknowledged: false,
    readback: { available: false, contentMatchesIntent: false },
  };
  const diagnose = (error: unknown): MutationDiagnostic => {
    if (ports.describeFailure) return ports.describeFailure(error);
    if (error instanceof CommandInputError)
      return {
        category: error.category,
        code: error.code,
        message: 'Dataset write preconditions failed. Inspect the reported code and details.',
      };
    return {
      category: 'service',
      code: 'DATASET_WRITE_FAILED',
      message: 'Dataset write failed. Inspect the exact target and recovery evidence.',
    };
  };
  const failed = (error: unknown) => {
    evidence.diagnostic = diagnose(error);
    value.status = 'failed';
    value.error = evidence.diagnostic;
    value.outcome = evidence.diagnostic.category;
    value.summary = evidence.diagnostic.message;
    value.data = { ...value.data, ...evidence, ...ports.failureData?.(error) };
    if (error instanceof CommandInputError && 'details' in error)
      value.data.details = error.details;
    return value;
  };
  const preflight = async () => {
    if (action !== 'delete') {
      const warnings = await ports.qualify(type, content);
      if (warnings) value.warnings.push(...warnings);
    }
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
    value.completeness.dryRun = true;
    try {
      await preflight();
    } catch (error) {
      return failed(error);
    }
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
  return ports.withJournal(
    requestId,
    { type, id, version, environment, actor: actor.userId },
    async (store) => {
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
          response: response ?? evidence.acknowledgement ?? null,
          ...evidence,
        });
      const unknown = async (original = { path: journal, requestId }) => {
        value.status = 'unknown';
        value.error = {
          category: 'service',
          code: 'WRITE_OUTCOME_UNKNOWN',
          message: 'The original mutation outcome could not be established. Do not replay.',
        };
        value.outcome = 'write_outcome_unknown';
        value.summary =
          'Original write outcome is unconfirmed. This request will not be dispatched again.';
        value.data = {
          ...value.data,
          ...evidence,
          recovery: { journal: original.path, requestId: original.requestId, replayAllowed: false },
          readback: { ...evidence.readback, establishesRequestOutcome: false },
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
        if (previous.state === 'rejected') {
          const original = object(previous.response, 'original rejection') as CommandResult;
          return { ...original, outcome: 'service_rejected' };
        }
        if (previous.state === 'completed') {
          value.outcome = 'original_result_returned';
          value.summary =
            'Returned the locally recorded original successful result; no mutation repeated.';
          value.data.originalResult = previous.response;
          return value;
        }
        evidence = previous as unknown as MutationEvidence;
        const current = await lookup().catch(() => null);
        evidence = {
          stage: evidence.stage ?? 'dispatch',
          acknowledged: evidence.acknowledged ?? false,
          ...(evidence.acknowledgement ? { acknowledgement: evidence.acknowledgement } : {}),
          ...(evidence.diagnostic ? { diagnostic: evidence.diagnostic } : {}),
          readback: evidence.readback ?? {
            available: current !== null,
            contentMatchesIntent: current !== null && isDeepStrictEqual(current.content, content),
          },
        };
        return unknown();
      }
      const unresolved = store.findTargetRecord?.(['unknown', 'dispatched']);
      if (unresolved) {
        const record = unresolved.record;
        evidence = {
          stage: (record.stage as MutationEvidence['stage'] | undefined) ?? 'dispatch',
          acknowledged: record.acknowledged === true,
          ...(record.acknowledgement
            ? { acknowledgement: record.acknowledgement as JsonObject }
            : {}),
          ...(record.diagnostic ? { diagnostic: record.diagnostic as MutationDiagnostic } : {}),
          readback: (record.readback as MutationEvidence['readback'] | undefined) ?? {
            available: false,
            contentMatchesIntent: false,
          },
        };
        return unknown({ path: unresolved.path, requestId: record.requestId as string });
      }
      // The exact intent is durable before the helper reaches its single transport dispatch.
      let dispatched = false;
      let readbackAttempted = false;
      const beforeDispatch = () => {
        evidence.stage = 'dispatch';
        persist('dispatched');
        dispatched = true;
      };
      try {
        await preflight();
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
        evidence.acknowledged = true;
        // Retain only acknowledgement facts; arbitrary service fields may contain credentials.
        const ack = response as JsonObject | null;
        const data = ack?.data as JsonObject | undefined;
        evidence.acknowledgement = {
          received: true,
          ...(typeof ack?.ok === 'boolean' ? { ok: ack.ok } : {}),
          ...(ack?.modelId === id ? { modelId: id } : {}),
          ...(ack?.version === version ? { version } : {}),
          ...(data?.id === id && data.version === version ? { data: { id, version } } : {}),
        };
        evidence.stage = 'readback';
        evidence.diagnostic = {
          category: 'service',
          code: 'WRITE_READBACK_PENDING',
          message: 'The write was acknowledged; independent readback has not completed.',
        };
        // Preserve the service acknowledgement before attempting independent readback.
        persist('unknown');
        readbackAttempted = true;
        const current = await lookup();
        evidence.readback = {
          available: current !== null,
          contentMatchesIntent: current !== null && isDeepStrictEqual(current.content, content),
        };
        if (
          action === 'delete'
            ? current !== null
            : !current || !isDeepStrictEqual(current.content, content)
        ) {
          evidence.diagnostic = {
            category: 'conflict',
            code: 'WRITE_READBACK_MISMATCH',
            message: 'Exact target readback did not match the acknowledged write intent.',
          };
          persist('unknown');
          return unknown();
        }
        delete evidence.diagnostic;
        persist('completed');
        Object.assign(value.data, evidence);
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
        if (!dispatched) {
          evidence.stage = 'preflight';
          failed(error);
          return value;
        }
        evidence.diagnostic = diagnose(error);
        if (!evidence.acknowledged && error instanceof ServiceRejectedError) {
          applyServiceRejection(value, error.receipt);
          Object.assign(value.data, evidence);
          try {
            persist('rejected', value);
          } catch {
            value.warnings.push({
              code: 'JOURNAL_UPDATE_UNAVAILABLE',
              message:
                'The refusal was observed, but its durable result could not be saved. The original request remains non-replayable.',
            });
          }
          return value;
        }
        try {
          if (!readbackAttempted) {
            const current = await lookup().catch(() => null);
            evidence.readback = {
              available: current !== null,
              contentMatchesIntent: current !== null && isDeepStrictEqual(current.content, content),
            };
          }
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
  );
}
