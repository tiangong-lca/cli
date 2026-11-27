import {
  applyServiceRejection,
  serviceRejection,
  type ServiceRejectionRules,
} from './service-rejection.js';
import {
  isReviewOAuthRouteDenial,
  ReviewReadServiceError,
  reviewServiceDiagnostic,
} from './review-service-diagnostic.js';
import {
  datasetTables,
  editableTypes,
  object,
  text,
  isObject,
  type DatasetType,
  type JsonObject,
  type DatasetPorts,
  type ReviewRead,
} from './dataset-types.js';
import { result, CommandInputError, type CommandResult } from '../shared/command-result.js';
import { contentDigest } from './dataset-content.js';

export type ReviewMutationAction = 'submit' | 'resubmit' | 'comment' | 'decide';

export type ReviewScopeTarget = {
  table: string;
  id: string;
  version: string;
  is_root: boolean;
  previous_state_code: number;
  proposed_state_code: number;
  owner_match: boolean;
};

export type ReviewSubmitScope = {
  submissionMode: 'root' | 'reference_repair';
  scopeDigest: string;
  targets: ReviewScopeTarget[];
};

// Only refusals whose service branches precede durable writes qualify here.
// Reference checks inside cmd_review_submit can follow reference creation.
const submissionRefusals = {
  INVALID_DATASET_TABLE: { status: 400, category: 'input' },
  ROOT_DATASET_NOT_OWNED: { status: 403, category: 'authentication' },
  APPROVED_DATASET_IMMUTABLE: { status: 409, category: 'conflict' },
  DATA_UNDER_REVIEW: { status: 409, category: 'conflict' },
  REVIEW_SCOPE_DRIFT: { status: 409, category: 'conflict' },
} satisfies ServiceRejectionRules;
const reviewerRequired = { status: 403, category: 'authentication' } as const;
const reviewRefusals: Record<ReviewMutationAction, ServiceRejectionRules> = {
  submit: submissionRefusals,
  resubmit: submissionRefusals,
  comment: {
    REVIEWER_REQUIRED: reviewerRequired,
    INVALID_COMMENT_JSON: { status: 400, category: 'input' },
    INVALID_REVIEW_STATE: { status: 409, category: 'conflict' },
    INVALID_COMMENT_STATE: { status: 409, category: 'conflict' },
  },
  decide: {
    REVIEWER_REQUIRED: reviewerRequired,
    REVIEW_COMMENT_NOT_PENDING: { status: 409, category: 'conflict' },
  },
};

const reviewScopeTables = [
  'contacts',
  'sources',
  'unitgroups',
  'flowproperties',
  'flows',
  'processes',
  'lifecyclemodels',
] as const;

type ReviewSubmissionTarget = { table: string; id: string; version: string };
type NormalizedExpectedScopeTarget = {
  table: string;
  id: string;
  version: string;
  proposed_state_code?: number;
};

function normalizeExpectedScopeDigest(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/iu.test(raw.trim()))
    throw new CommandInputError(
      'REVIEW_SCOPE_INVALID',
      'expectedScopeDigest must be a 64-character hex digest.',
    );
  return raw.trim().toLowerCase();
}

function normalizeExpectedScopeTargets(raw: unknown): NormalizedExpectedScopeTarget[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new CommandInputError(
      'REVIEW_SCOPE_INVALID',
      'expectedScopeTargets must be a non-empty array.',
    );
  return raw.map((item) => {
    if (!isObject(item))
      throw new CommandInputError(
        'REVIEW_SCOPE_INVALID',
        'Each expectedScopeTargets item must be a JSON object.',
      );
    if (
      Object.keys(item).some(
        (key) => !['type', 'table', 'id', 'version', 'proposedStateCode'].includes(key),
      )
    )
      throw new CommandInputError(
        'REVIEW_SCOPE_INVALID',
        'Unsupported field inside expectedScopeTargets.',
      );
    const typeTable =
      typeof item.type === 'string' &&
      Object.prototype.hasOwnProperty.call(datasetTables, item.type)
        ? datasetTables[item.type as DatasetType]
        : undefined;
    const rawTable = typeof item.table === 'string' ? item.table.trim().toLowerCase() : undefined;
    const table = rawTable ?? typeTable;
    if (
      (item.type !== undefined && !typeTable) ||
      (typeTable && rawTable && typeTable !== rawTable) ||
      !table ||
      !reviewScopeTables.includes(table as never)
    )
      throw new CommandInputError(
        'REVIEW_SCOPE_INVALID',
        'Each expectedScopeTargets entry must identify a supported dataset table or type.',
      );
    if (
      typeof item.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(item.id) ||
      typeof item.version !== 'string' ||
      !/^\d{2}\.\d{2}\.\d{3}$/u.test(item.version) ||
      (item.proposedStateCode !== undefined && !Number.isInteger(item.proposedStateCode))
    )
      throw new CommandInputError(
        'REVIEW_SCOPE_INVALID',
        'Each expectedScopeTargets entry requires UUID id, 00.00.000 version, and integer proposedStateCode when given.',
      );
    return {
      table,
      id: item.id.toLowerCase(),
      version: item.version,
      ...(item.proposedStateCode !== undefined
        ? { proposed_state_code: item.proposedStateCode as number }
        : {}),
    };
  });
}

function parsePreviewScope(response: {
  ok: boolean;
  payload: unknown;
  status?: number;
}): ReviewSubmitScope {
  const { ok, payload, status } = response;
  if (!ok || !isObject(payload) || payload.ok !== true) {
    const httpStatus =
      isObject(payload) && typeof payload.status === 'number' ? payload.status : status;
    const { message, serviceCode } = reviewServiceDiagnostic(payload, httpStatus);
    const code =
      serviceCode ??
      (isObject(payload) && typeof payload.code === 'string'
        ? payload.code
        : 'REVIEW_SCOPE_PREVIEW_FAILED');
    const oauthDenied = isReviewOAuthRouteDenial(message);
    throw new ReviewReadServiceError({
      code,
      ...(httpStatus ? { httpStatus } : {}),
      category:
        oauthDenied || code === 'REFERENCE_ACCESS_DENIED'
          ? 'authorization'
          : code === 'AUTH_REQUIRED' || code === 'ROOT_DATASET_NOT_OWNED' || httpStatus === 401
            ? 'authentication'
            : code === 'DATA_UNDER_REVIEW' || code === 'APPROVED_DATASET_IMMUTABLE'
              ? 'conflict'
              : 'service',
      message: message ?? 'Review submission scope preview failed.',
    });
  }
  const data = payload.data;
  if (
    !isObject(data) ||
    (data.submissionMode !== 'root' && data.submissionMode !== 'reference_repair') ||
    typeof data.scopeDigest !== 'string' ||
    !/^[0-9a-f]{64}$/iu.test(data.scopeDigest) ||
    !Array.isArray(data.targets) ||
    data.targets.length === 0 ||
    data.targets.some(
      (target) =>
        !isObject(target) ||
        typeof target.table !== 'string' ||
        typeof target.id !== 'string' ||
        typeof target.version !== 'string' ||
        typeof target.is_root !== 'boolean' ||
        !Number.isInteger(target.previous_state_code) ||
        !Number.isInteger(target.proposed_state_code) ||
        typeof target.owner_match !== 'boolean',
    )
  ) {
    throw new ReviewReadServiceError({
      code: 'REVIEW_SCOPE_INVALID_RESPONSE',
      category: 'service',
      message: 'Review submission scope preview returned an invalid response.',
    });
  }
  return {
    submissionMode: data.submissionMode,
    scopeDigest: data.scopeDigest.toLowerCase(),
    targets: data.targets as ReviewScopeTarget[],
  };
}

function hasScopeDrift(
  scope: ReviewSubmitScope,
  expectedDigest?: string,
  expectedTargets?: NormalizedExpectedScopeTarget[],
): boolean {
  if (expectedDigest !== undefined && expectedDigest !== scope.scopeDigest) return true;
  if (expectedTargets === undefined) return false;
  for (const expected of expectedTargets) {
    const matched = scope.targets.find(
      (actual) =>
        actual.table === expected.table &&
        actual.id === expected.id &&
        actual.version === expected.version,
    );
    if (!matched) return true;
    if (
      expected.proposed_state_code !== undefined &&
      expected.proposed_state_code !== matched.proposed_state_code
    )
      return true;
  }
  for (const actual of scope.targets) {
    if (!actual.is_root && actual.previous_state_code >= 20) continue;
    const matched = expectedTargets.find(
      (expected) =>
        expected.table === actual.table &&
        expected.id === actual.id &&
        expected.version === actual.version &&
        (expected.proposed_state_code === undefined ||
          expected.proposed_state_code === actual.proposed_state_code),
    );
    if (!matched) return true;
  }
  return false;
}

export type ReviewMutationIntent = {
  binding: JsonObject;
  requestId: string;
  target: string;
  value: CommandResult;
  preflight(): Promise<void>;
  dispatch(operationKey: string): Promise<CommandResult>;
  recover?(operationKey: string): Promise<string | null>;
};
export type ReviewWritePorts = {
  identity(): Promise<{ environment: string; actor: { userId: string } }>;
  readReview: ReviewRead;
  readDataset: DatasetPorts['read'];
  previewSubmissionScope(
    target: ReviewSubmissionTarget,
  ): Promise<{ ok: boolean; payload: unknown; status?: number }>;
  endpoint(action: ReviewMutationAction): string;
  dispatch(
    action: ReviewMutationAction,
    body: JsonObject,
    operationKey?: string,
  ): Promise<{ ok: boolean; payload: unknown; status?: number }>;
  recoverSubmission(target: ReviewSubmissionTarget, operationKey: string): Promise<string | null>;
  executeIntent(options: ReviewMutationIntent): Promise<CommandResult>;
};

export async function executeReviewWrite(
  action: ReviewMutationAction,
  request: JsonObject,
  dryRun: boolean,
  ports: ReviewWritePorts,
): Promise<CommandResult> {
  const allowed = [
    'requestId',
    'expectedActor',
    'expectedEnvironment',
    ...(action === 'submit' || action === 'resubmit'
      ? [
          'targets',
          'includeRelated',
          'expectedScopeDigest',
          'expectedScopeTargets',
          ...(action === 'resubmit' ? ['reviewId', 'expectedState', 'changeSummary'] : []),
        ]
      : [
          'reviewId',
          'expectedState',
          ...(action === 'decide' ? ['decision', 'reason'] : ['json']),
        ]),
  ];
  if (Object.keys(request).some((key) => !allowed.includes(key)))
    throw new CommandInputError(
      'REQUEST_FIELD_UNSUPPORTED',
      'Unsupported Review request field. Explicit packages and historical rounds are deferred; inspect --help.',
    );
  const requestId = text(request.requestId, 'requestId');
  const expectedActor = text(request.expectedActor, 'expectedActor');
  const expectedEnvironment = text(request.expectedEnvironment, 'expectedEnvironment');
  const submitting = action === 'submit' || action === 'resubmit';
  if (!['submit', 'resubmit', 'comment', 'decide'].includes(action))
    throw new CommandInputError(
      'CAPABILITY_UNSUPPORTED',
      'No existing Review service mapping for this action.',
    );
  if (
    submitting &&
    (request.includeRelated === false ||
      !Array.isArray(request.targets) ||
      request.targets.length !== 1 ||
      (request.includeRelated !== undefined && request.includeRelated !== true))
  )
    throw new CommandInputError(
      'REVIEW_SELECTION_UNSUPPORTED',
      'Existing submission accepts one starting object and always includes business-related data.',
    );
  const target = submitting ? object((request.targets as unknown[])[0], 'targets[0]') : null;
  if (target && Object.keys(target).some((key) => !['type', 'id', 'version'].includes(key)))
    throw new CommandInputError(
      'REVIEW_SELECTION_UNSUPPORTED',
      'Existing submission selects exact type/id/version; custom revisions or package bindings are deferred.',
    );
  const type = target ? (text(target.type, 'target.type') as DatasetType) : null;
  if (type && !editableTypes.includes(type))
    throw new CommandInputError(
      'REVIEW_TYPE_UNSUPPORTED',
      'Select flow, process, model, source or contact.',
    );
  const id = target ? text(target.id, 'target.id') : text(request.reviewId, 'reviewId');
  const version = target ? text(target.version, 'target.version') : undefined;
  if (
    !/^[0-9a-f-]{36}$/iu.test(id) ||
    (version !== undefined && !/^\d{2}\.\d{2}\.\d{3}$/u.test(version))
  )
    throw new CommandInputError(
      'IDENTITY_INVALID',
      'Review requires explicit UUID and exact dataset version.',
    );
  if (action !== 'submit' && !Number.isInteger(request.expectedState))
    throw new CommandInputError(
      'STATE_REQUIRED',
      'expectedState must be the observed review state integer.',
    );
  if (action === 'resubmit') {
    text(request.reviewId, 'reviewId');
    text(request.changeSummary, 'changeSummary');
    if (request.expectedState !== -1)
      throw new CommandInputError(
        'REVIEW_STATE_UNSUPPORTED',
        'Existing resubmission starts from a rejected review (state -1).',
      );
  }
  if (
    action === 'decide' &&
    (!['approve', 'reject'].includes(String(request.decision)) ||
      (request.decision === 'reject'
        ? typeof request.reason !== 'string' ||
          !request.reason.trim() ||
          Array.from(request.reason).length > 1000
        : request.reason !== undefined))
  )
    throw new CommandInputError(
      'DECISION_INVALID',
      'Choose approve without reason, or reject with a nonempty reason of at most 1000 characters.',
    );
  if (action === 'comment') object(request.json, 'json');
  const expectedScopeDigest = submitting
    ? normalizeExpectedScopeDigest(request.expectedScopeDigest)
    : undefined;
  const expectedScopeTargets = submitting
    ? normalizeExpectedScopeTargets(request.expectedScopeTargets)
    : undefined;
  const { environment, actor } = await ports.identity();
  if (actor.userId !== expectedActor || environment !== expectedEnvironment)
    throw new CommandInputError(
      'IDENTITY_BINDING_MISMATCH',
      'Current actor or environment differs from the request.',
    );
  const value = result(`review ${action}`);
  value.context = {
    environment,
    actor: { id: actor.userId, source: 'online' },
    requestId,
    effectiveInput: {
      ...(target ? { target } : { reviewId: id, expectedState: request.expectedState }),
      ...(submitting ? { includeRelated: true } : {}),
      ...(expectedScopeDigest ? { expectedScopeDigest } : {}),
      ...(expectedScopeTargets ? { expectedScopeTargets } : {}),
      ...(action === 'comment' ? { draftDigest: contentDigest(request.json) } : {}),
      ...(action === 'decide' ? { decision: request.decision } : {}),
    },
    defaultedInputs:
      submitting && request.includeRelated === undefined ? { includeRelated: true } : {},
    observation: { source: 'current_service', time: new Date().toISOString() },
  };
  value.completeness = {
    notChecked: [
      'historical_package',
      'server_request_idempotency',
      ...(action === 'submit' ? [] : ['server_expected_review_state_compare']),
    ],
  };
  const submission = target ? { table: datasetTables[type!], id, version: version! } : undefined;
  let previewedScope: ReviewSubmitScope | undefined;
  const preflight = async () => {
    if (action !== 'submit') {
      const reviewId = text(request.reviewId, 'reviewId');
      const page = await ports.readReview({ id: reviewId, limit: 1, offset: 0 });
      const review = page.records[0];
      if (!review || review.state_code !== request.expectedState)
        throw new CommandInputError(
          'REVIEW_STATE_CONFLICT',
          'Review is missing, invisible or has changed state.',
        );
      if (action === 'resubmit') {
        const data = object(object(review.json, 'review.json').data, 'review.json.data');
        if (data.table !== datasetTables[type!] || data.id !== id || data.version !== version)
          throw new CommandInputError(
            'REVIEW_TARGET_CONFLICT',
            'Resubmission must identify the rejected review dataset exactly.',
          );
        value.data.previousReview = {
          id: reviewId,
          state: review.state_code,
          changeSummary: request.changeSummary,
          association: 'caller_observed_not_server_round_link',
        };
      }
    }
    if (submitting) {
      const page = await ports.readDataset(type!, {
        id,
        version,
        limit: 1,
        offset: 0,
      });
      const row = page.records[0];
      if (!row || row.owner !== actor.userId || row.stateCode !== 0)
        throw new CommandInputError(
          'REVIEW_TARGET_CONFLICT',
          'Submission requires the exact owned draft dataset.',
        );
      previewedScope = parsePreviewScope(await ports.previewSubmissionScope(submission!));
      value.data.scope = previewedScope;
    }
  };
  const endpoint = ports.endpoint(action);
  const body =
    submission ??
    (action === 'comment'
      ? { reviewId: id, json: request.json }
      : {
          reviewIds: [id],
          decision: request.decision,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        });
  value.data.request = {
    endpoint,
    bodyDigest: contentDigest(body),
    ...(submitting ? { target } : { reviewId: id }),
  };
  if (dryRun) {
    await preflight();
    value.completeness = {
      ...value.completeness,
      dryRun: true,
      notChecked: [...(value.completeness.notChecked as string[]), 'server_write_time_admission'],
    };
    if (
      submitting &&
      previewedScope &&
      hasScopeDrift(previewedScope, expectedScopeDigest, expectedScopeTargets)
    ) {
      value.status = 'failed';
      value.outcome = 'rejected';
      value.summary = 'Related review submission scope does not match the authorized scope.';
      value.error = {
        httpStatus: 409,
        code: 'REVIEW_SCOPE_DRIFT',
        category: 'conflict',
        message: value.summary,
      };
      value.data.receipt = {
        ok: false,
        code: 'REVIEW_SCOPE_DRIFT',
        httpStatus: 409,
        details: {
          submissionMode: previewedScope.submissionMode,
          expectedScopeDigest: expectedScopeDigest ?? null,
          actualScopeDigest: previewedScope.scopeDigest,
          actualTargets: previewedScope.targets,
        },
      };
      return value;
    }
    value.outcome = 'preview_completed';
    value.summary = submitting
      ? 'Readable preconditions and server related scope checked without mutation. Final write-time admission and scope binding are enforced atomically by the server at dispatch.'
      : 'Readable preconditions checked without mutation. Related submission scope and final admission are evaluated by the server at dispatch.';
    return value;
  }
  return ports.executeIntent({
    binding: { action, request, actor: actor.userId, environment },
    requestId,
    target: `${environment}:${submitting ? `${type}:${id}:${version}` : id}`,
    value,
    preflight,
    ...(submission ? { recover: (key: string) => ports.recoverSubmission(submission, key) } : {}),
    dispatch: async (key) => {
      const dispatchBody = submission
        ? {
            ...submission,
            expectedScopeDigest: expectedScopeDigest ?? previewedScope?.scopeDigest,
            ...(expectedScopeTargets ? { expectedScopeTargets } : {}),
          }
        : body;
      const { ok, payload, status } = await ports.dispatch(
        action,
        dispatchBody,
        submission ? key : undefined,
      );
      value.data.serviceResponse = reviewServiceDiagnostic(payload, status);
      if (!isObject(payload) || typeof payload.ok !== 'boolean')
        throw new Error('invalid acknowledgement');
      if (!ok && payload.ok !== false) throw new Error('contradictory acknowledgement');
      if (action === 'decide' && (payload.ok || payload.results !== undefined)) {
        if (
          !Array.isArray(payload.results) ||
          payload.results.length !== 1 ||
          !isObject(payload.results[0]) ||
          payload.results[0].reviewId !== id ||
          payload.results[0].ok !== payload.ok
        )
          throw new Error('decision acknowledgement does not match the single requested review');
      }
      if (payload.ok === false) {
        const selected =
          action === 'decide' && Array.isArray(payload.results) ? payload.results[0] : payload;
        const rejection = serviceRejection(selected, status, reviewRefusals[action]);
        if (!rejection) throw new Error('Unproven rejection acknowledgement');
        applyServiceRejection(value, rejection);
        const { message, httpStatus } = reviewServiceDiagnostic(selected, status);
        value.error = {
          ...(httpStatus && { httpStatus }),
          code: rejection.code,
          category: isReviewOAuthRouteDenial(message) ? 'authorization' : rejection.category,
          message: message ?? value.summary,
        };
        const driftDetails =
          rejection.code === 'REVIEW_SCOPE_DRIFT' &&
          isObject(selected) &&
          isObject(selected.details)
            ? selected.details
            : undefined;
        value.data.receipt = {
          ok: false,
          code: rejection.code,
          ...(httpStatus && { httpStatus }),
          ...(message && { message }),
          ...(driftDetails ? { details: driftDetails } : {}),
        };
      } else {
        if (submitting) {
          const data = object(payload.data, 'submission data');
          const reviewId = text(data.reviewId, 'returned reviewId');
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(reviewId))
            throw new Error('invalid review acknowledgement identity');
          value.data.reviewId = reviewId;
          if (typeof data.submissionMode === 'string')
            value.data.submissionMode = data.submissionMode;
          if (Array.isArray(data.affectedDatasets))
            value.data.affectedDatasets = data.affectedDatasets;
        }
        value.data.receipt = payload;
        value.status = submitting ? 'accepted' : 'completed';
        value.outcome = submitting
          ? 'review_submitted'
          : action === 'comment'
            ? 'review_draft_saved'
            : 'reviewer_decision_recorded';
        value.summary = submitting
          ? 'Existing service accepted the submission with its business-related data.'
          : action === 'comment'
            ? 'Reviewer draft saved; this can replace the current draft and does not record a decision.'
            : 'Reviewer decision recorded; this is not a claim of overall review completion.';
      }
      delete value.data.serviceResponse;
      return value;
    },
  });
}
