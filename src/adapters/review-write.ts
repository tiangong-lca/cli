import os from 'node:os';
import path from 'node:path';
import {
  datasetTables,
  editableTypes,
  object,
  text,
  isObject,
  type DatasetType,
  type JsonObject,
} from '../application/dataset-types.js';
import { resolveDatasetCommandTransport } from '../lib/dataset-command.js';
import { fetchCurrentUser } from '../lib/auth-identity-receipt.js';
import { buildSupabaseAuthHeaders } from '../lib/supabase-client.js';
import type { FetchLike } from '../lib/http.js';
import { result, CommandInputError } from '../shared/command-result.js';
import { datasetReader } from './dataset-read.js';
import { reviewReader } from './review-read.js';
import { runMutationIntent } from './mutation-intent.js';
import { contentDigest } from '../application/dataset-content.js';

export function reviewWriter(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  directory = path.join(os.homedir(), '.local', 'state', 'tiangong-lca', 'review-operations'),
) {
  return async (action: string, request: JsonObject, dryRun: boolean) => {
    const allowed = [
      'requestId',
      'expectedActor',
      'expectedEnvironment',
      ...(action === 'submit' || action === 'resubmit'
        ? [
            'targets',
            'includeRelated',
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
    const transport = await resolveDatasetCommandTransport({ env, fetchImpl, timeoutMs: 10_000 });
    const environment = new URL(transport.functionsBaseUrl).origin;
    const actor = await fetchCurrentUser({
      projectBaseUrl: environment,
      publishableKey: transport.publishableKey,
      accessToken: transport.accessToken,
      timeoutMs: 10_000,
      fetchImpl,
    });
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
    const preflight = async () => {
      if (action !== 'submit') {
        const reviewId = text(request.reviewId, 'reviewId');
        const page = await reviewReader(env, fetchImpl)({ id: reviewId, limit: 1, offset: 0 });
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
        const page = await datasetReader(env, fetchImpl)(type!, {
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
      }
    };
    const endpoint = submitting
      ? 'app_dataset_submit_review'
      : action === 'comment'
        ? 'app_review_save_comment_draft'
        : 'app_review_batch_decision';
    const body = submitting
      ? { table: datasetTables[type!], id, version }
      : action === 'comment'
        ? { reviewId: id, json: request.json }
        : {
            reviewIds: [id],
            decision: request.decision,
            ...(request.reason === undefined ? {} : { reason: request.reason }),
          };
    value.data.request = {
      endpoint,
      bodyDigest: contentDigest(body),
      ...(submitting ? { target } : { reviewId: id }),
    };
    value.nextActions = [
      {
        description: 'Read the actual current review record; acceptance is not approval.',
        ...(submitting
          ? { command: 'tiangong-lca review list --role submitter --json' }
          : { command: `tiangong-lca review get --id ${id} --json` }),
      },
    ];
    if (dryRun) {
      await preflight();
      value.outcome = 'preview_completed';
      value.summary =
        'Readable preconditions checked without mutation. Related submission scope and final admission are evaluated by the server at dispatch.';
      value.completeness = {
        ...value.completeness,
        dryRun: true,
        notChecked: [
          ...(value.completeness.notChecked as string[]),
          'server_write_time_admission',
          ...(submitting ? ['server_related_scope'] : []),
        ],
      };
      return value;
    }
    return runMutationIntent({
      directory,
      binding: { action, request, actor: actor.userId, environment },
      requestId,
      target: `${environment}:${submitting ? `${type}:${id}:${version}` : id}`,
      value,
      preflight,
      dispatch: async () => {
        const response = await fetchImpl(`${transport.functionsBaseUrl}/${endpoint}`, {
          method: 'POST',
          headers: {
            ...buildSupabaseAuthHeaders(transport.publishableKey, transport.accessToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const payload: unknown = JSON.parse(await response.text());
        if (!isObject(payload) || typeof payload.ok !== 'boolean')
          throw new Error('invalid acknowledgement');
        if (!response.ok && payload.ok !== false) throw new Error('contradictory acknowledgement');
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
          const code =
            typeof payload.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/u.test(payload.code)
              ? payload.code
              : 'REVIEW_REJECTED';
          value.data.receipt = {
            ok: false,
            code,
            ...(Array.isArray(payload.results)
              ? {
                  results: payload.results.map((item: unknown) =>
                    isObject(item)
                      ? {
                          reviewId: item.reviewId,
                          ok: item.ok,
                          code:
                            typeof item.code === 'string' &&
                            /^[A-Z][A-Z0-9_]{1,100}$/u.test(item.code)
                              ? item.code
                              : null,
                        }
                      : { ok: false },
                  ),
                }
              : {}),
          };
          value.status = 'failed';
          value.outcome = 'service_rejected';
          value.summary = 'Review service rejected the operation; inspect the structured receipt.';
          value.error = {
            category: 'service',
            code,
            message: value.summary,
          };
        } else {
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
          if (submitting) {
            const data = object(payload.data, 'submission data');
            const reviewId = text(data.reviewId, 'returned reviewId');
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(reviewId))
              throw new Error('invalid review acknowledgement identity');
            value.data.reviewId = reviewId;
            value.nextActions = [
              {
                description: 'Read the accepted review.',
                command: `tiangong-lca review get --id ${reviewId} --json`,
              },
            ];
          }
        }
        return value;
      },
    });
  };
}
