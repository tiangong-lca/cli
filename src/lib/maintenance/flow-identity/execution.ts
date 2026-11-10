import { existsSync } from 'node:fs';
import path from 'node:path';
import { writePrivateImmutableJson } from '../../dataset-maintenance-protected-artifacts.js';
import {
  buildFlowIdentityFinalizeRequest,
  buildFlowIdentityProcessRequest,
  splitFlowIdentityPermitResponse,
} from './requests.js';
import {
  flowIdentityScopeHasCurrentDerivativeClosure,
  flowIdentityScopeIsReadyToFinalize,
  parseFlowIdentityFinalizeProof,
} from './status.js';
import { parseFlowIdentityProcessProof } from './proofs.js';
import type {
  FlowIdentityExecutionPermit,
  FlowIdentityFinalizeProof,
  FlowIdentityScopeStatus,
} from './base.js';
import { isJsonObject } from '../contract/values.js';
import { flowIdentityRestrictedSha256 } from '../../dataset-maintenance-flow-identity-wire.js';
import { isMaintenanceRpcDomainFailure } from '../../dataset-maintenance-remote.js';
import {
  type RunFlowIdentityOptions,
  type FlowIdentityRunReport,
  type PreparedRun,
  type RunDependencies,
  OPERATOR_REVIEW_REQUIRED,
  fail,
  errorDetails,
  assertDomainFailureHasNoPermit,
} from './run-types.js';
import { prepareRun, assertContext } from './run-preparation.js';
import {
  readStoredDomainRejection,
  finalizeArtifactPath,
  readStoredFinalizeAttempt,
  storedFinalizeAttemptHashes,
  readStoredFinalizeProof,
  obtainScope,
  readScope,
} from './scope-recovery.js';
import {
  validateCompletedRequests,
  requirePendingProcess,
  report,
  reportProcessDomainRejection,
  completedRunStatus,
  waitForFinalizeDecision,
} from './run-results.js';

export async function executeRun(
  command: RunFlowIdentityOptions,
  dependencies: RunDependencies,
  preparedInput?: PreparedRun,
): Promise<FlowIdentityRunReport> {
  const prepared = preparedInput ?? prepareRun(command);
  const mode = command.commit ? 'commit' : 'status_only';
  const context = await dependencies.resolveContext({
    env: command.env,
    fetchImpl: command.fetchImpl,
    timeoutMs: command.timeoutMs,
    now: command.now,
  });
  assertContext(prepared, context);
  if (command.commit && dependencies.claimApproval) {
    const recovery = prepared.recovery;
    dependencies.claimApproval({
      env: command.env,
      claim: {
        schema_version: 'dataset-flow-identity-local-approval-claim.v1',
        claimed_at_utc: dependencies.now().toISOString(),
        approval_kind: recovery ? 'recovery' : 'initial',
        approval_identity_sha256: recovery
          ? recovery.recoveryApproval.recovery_approval_identity_sha256
          : prepared.approval.execution_approval_identity_sha256,
        execution_identity_sha256: prepared.identity.identity_sha256,
        request_id: recovery
          ? String(recovery.recoveryRequest.request_id)
          : prepared.identity.request_id,
        environment: 'production',
        project_ref: prepared.plan.project_ref,
        actor_user_id: prepared.plan.account.user_id,
        actor_email: prepared.plan.account.email,
        target_visibility: 'owner_draft',
        user_state_claim: 'authenticated_actor_state_100_plus_own_state_0',
        plan_sha256: prepared.plan.plan_sha256,
        freeze_sha256: recovery
          ? recovery.recoveryFreeze.recovery_freeze_sha256
          : prepared.freeze.freeze_sha256,
        canonical_out_dir: prepared.outDir,
        maximum_cli_apply_spawns: 1,
        approval_reusable: false,
      },
    });
  }
  const obtained = await obtainScope({ command, prepared, context, dependencies });
  const scope = obtained.scope;
  const executionPermit = obtained.executionPermit;
  if (isMaintenanceRpcDomainFailure(scope)) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope: null,
      database: null,
      issues: [
        {
          code: scope.code,
          message:
            typeof scope.message === 'string'
              ? scope.message
              : 'The database deterministically rejected scope preflight.',
          details: scope,
        },
      ],
      now: dependencies.now(),
    });
  }
  if (obtained.recoveryAmbiguity) {
    return report({
      prepared,
      mode,
      status: 'indeterminate',
      scope,
      database: obtained.recoveryAmbiguity.observed,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_RECOVERY_RESPONSE_AMBIGUOUS',
          message:
            'Recovery admission response was ambiguous; scope was read once and recovery was not retried. A fresh exact recovery freeze and approval are required.',
          details: obtained.recoveryAmbiguity.error,
        },
      ],
      now: dependencies.now(),
    });
  }
  let status = await readScope({ prepared, context, scope, dependencies });
  validateCompletedRequests(prepared, status);
  if (status.status === 'failed' || status.status === 'live_drift') {
    return report({
      prepared,
      mode,
      status: status.status === 'live_drift' ? 'blocked' : 'failed',
      scope,
      database: status,
      issues:
        status.status === 'live_drift'
          ? [
              {
                code: status.code ?? 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
                message:
                  'The database dynamically reproved primary or guard drift; no process submission or compensation is allowed.',
              },
            ]
          : [],
      now: dependencies.now(),
    });
  }
  if (!status.live_guard_current || !status.protected_closure_current) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
          message:
            'The exactly sealed pending/blocker/orphan closure changed; no process submission is allowed.',
        },
      ],
      now: dependencies.now(),
    });
  }
  if (status.status === 'completed') {
    return report({
      prepared,
      mode,
      status: completedRunStatus(status),
      scope,
      database: status,
      now: dependencies.now(),
    });
  }
  if (command.statusOnly) {
    status = await waitForFinalizeDecision({
      command,
      prepared,
      context,
      scope,
      initial: status,
      dependencies,
    });
    return report({
      prepared,
      mode,
      status:
        status.status === 'completed'
          ? completedRunStatus(status)
          : status.status === 'live_drift'
            ? 'blocked'
            : status.status === 'failed'
              ? 'failed'
              : 'pending',
      scope,
      database: status,
      issues: status.compensation_required
        ? [
            {
              code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
              message:
                'A derivative-only compensation needs a separate plan, freeze, and exact approval; the process mutation will not be replayed.',
              details: { compensation_targets: status.compensation_targets },
            },
          ]
        : status.status !== 'completed' && flowIdentityScopeIsReadyToFinalize(status)
          ? [
              {
                code: 'FLOW_IDENTITY_FINALIZE_READY',
                message:
                  'The derivative closure is ready. Status-only mode remains read-only; an explicit approved commit invocation is required to finalize.',
              },
            ]
          : [],
      now: dependencies.now(),
    });
  }

  if (executionPermit === null) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_FRESH_RECOVERY_APPROVAL_REQUIRED',
          message:
            'This wrapper has no live database permit. Scope read remains available, but any further process or finalize write requires a fresh exact recovery freeze and human approval.',
          details: {
            approval_reusable: false,
            maximum_wrapper_invocations: 1,
            completed_process_count: status.completed_process_count,
            next_ordinal: status.next_ordinal,
            whole_scope_proof_sha256: status.whole_scope_proof_sha256,
          },
        },
      ],
      now: dependencies.now(),
    });
  }
  let livePermit: FlowIdentityExecutionPermit = executionPermit;

  let nextOrdinal: number | null = status.next_ordinal;
  let submittedProcesses = 0;
  while (
    !status.primary_complete &&
    nextOrdinal !== null &&
    nextOrdinal <= prepared.plan.processes.length
  ) {
    if (
      !status.primary_current ||
      !status.live_guard_current ||
      !status.protected_closure_current
    ) {
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
            message:
              'The exactly sealed pending/blocker/orphan closure changed; no next process will be submitted.',
          },
        ],
        now: dependencies.now(),
      });
    }
    const ordinal = nextOrdinal;
    const { ledger, template } = requirePendingProcess(prepared, status, ordinal);
    const request = buildFlowIdentityProcessRequest({
      scopeProofSha256: scope.scope_proof_sha256,
      ordinal,
      processIntentProofSha256: ledger.process_intent_proof_sha256,
    });
    const markerPath = path.join(
      prepared.outDir,
      `process-attempt-${String(ordinal).padStart(6, '0')}.json`,
    );
    const domainRejectionPath = path.join(
      prepared.outDir,
      `process-domain-rejection-${String(ordinal).padStart(6, '0')}.json`,
    );
    if (existsSync(markerPath)) {
      const storedRejection = readStoredDomainRejection({
        filePath: domainRejectionPath,
        label: `Flow identity process ${ordinal} domain rejection`,
        requestHashField: 'process_request_sha256',
        expectedRequestSha256: String(request.process_request_sha256),
      });
      if (storedRejection) {
        return reportProcessDomainRejection({
          prepared,
          mode,
          context,
          scope,
          dependencies,
          ordinal,
          requestSha256: String(request.process_request_sha256),
          response: storedRejection,
          rejectionPath: domainRejectionPath,
        });
      }
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_PROCESS_ATTEMPT_AMBIGUOUS',
            message: `Process ${ordinal} has a local attempt marker but no durable completed proof; no automatic retry is allowed.`,
          },
        ],
        now: dependencies.now(),
      });
    }
    writePrivateImmutableJson(markerPath, {
      schema_version: 'dataset-flow-identity-process-attempt.v2',
      generated_at_utc: dependencies.now().toISOString(),
      scope_id: scope.scope_id,
      scope_proof_sha256: scope.scope_proof_sha256,
      ordinal,
      process_request_sha256: request.process_request_sha256,
      max_posts: 1,
      automatic_retry: false,
    });
    try {
      const raw = await dependencies.rewrite({
        context,
        scopeId: scope.scope_id,
        request,
        authorization: livePermit,
      });
      if (isMaintenanceRpcDomainFailure(raw)) {
        assertDomainFailureHasNoPermit(raw, `Process ${ordinal}`);
        return reportProcessDomainRejection({
          prepared,
          mode,
          context,
          scope,
          dependencies,
          ordinal,
          requestSha256: String(request.process_request_sha256),
          response: raw,
          rejectionPath: domainRejectionPath,
        });
      }
      const envelope = splitFlowIdentityPermitResponse({
        value: raw,
        expectedGeneration: livePermit.generation + 1,
        expectedInvocationId: livePermit.invocation_id,
        permitRequired: true,
        label: `Flow identity process ${ordinal}`,
      });
      const proof = parseFlowIdentityProcessProof({
        value: envelope.proof,
        scopeId: scope.scope_id,
        process: template.process,
        requestSha256: String(request.process_request_sha256),
        receiptId: prepared.plan.receipt_id,
        receiptProofSha256: prepared.plan.receipt_proof_sha256,
        mappingGuardSetSha256: prepared.plan.mapping_guard_set_sha256,
        processIntentSetSha256: prepared.plan.process_intent_set_sha256,
        processIntentProofSha256: ledger.process_intent_proof_sha256,
        processCount: prepared.plan.processes.length,
        expectedInvocationId: livePermit.invocation_id,
        expectedPermitGenerationBefore: livePermit.generation,
      });
      writePrivateImmutableJson(
        path.join(prepared.outDir, `process-proof-${String(ordinal).padStart(6, '0')}.json`),
        proof,
      );
      // permitRequired=true above already rejects null before the proof parser.
      livePermit = envelope.executionPermit!;
      submittedProcesses += 1;
      nextOrdinal = proof.next_ordinal;
    } catch (error) {
      writePrivateImmutableJson(
        path.join(
          prepared.outDir,
          `process-transport-error-${String(ordinal).padStart(6, '0')}.json`,
        ),
        {
          schema_version: 'dataset-flow-identity-process-transport-error.v1',
          observed_at_utc: dependencies.now().toISOString(),
          ordinal,
          process_request_sha256: request.process_request_sha256,
          automatic_retry: false,
          recovery: 'read_scope_only',
          error: errorDetails(error),
        },
      );
      let recovered: FlowIdentityScopeStatus | null = null;
      try {
        recovered = await readScope({ prepared, context, scope, dependencies });
        validateCompletedRequests(prepared, recovered);
      } catch (readError) {
        writePrivateImmutableJson(
          path.join(
            prepared.outDir,
            `process-recovery-read-error-${String(ordinal).padStart(6, '0')}.json`,
          ),
          { observed_at_utc: dependencies.now().toISOString(), error: errorDetails(readError) },
        );
      }
      return report({
        prepared,
        mode,
        status: 'indeterminate',
        scope,
        database: recovered,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_PROCESS_RESPONSE_AMBIGUOUS',
            message:
              'Process response was ambiguous; durable scope was read once and no process submission was retried.',
            details: errorDetails(error),
          },
        ],
        now: dependencies.now(),
      });
    }
  }

  if (submittedProcesses > 0) {
    status = await readScope({ prepared, context, scope, dependencies });
    validateCompletedRequests(prepared, status);
  }

  if (!status.primary_current || !status.live_guard_current || !status.protected_closure_current) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
          message:
            'The exactly sealed pending/blocker/orphan closure changed after the last process; finalize is forbidden.',
        },
      ],
      now: dependencies.now(),
    });
  }

  status = await waitForFinalizeDecision({
    command,
    prepared,
    context,
    scope,
    initial: status,
    dependencies,
  });
  if (status.status === 'completed') {
    return report({
      prepared,
      mode,
      status: completedRunStatus(status),
      scope,
      database: status,
      now: dependencies.now(),
    });
  }
  if (status.status === 'live_drift' || status.status === 'failed') {
    return report({
      prepared,
      mode,
      status: status.status === 'live_drift' ? 'blocked' : 'failed',
      scope,
      database: status,
      issues:
        status.status === 'live_drift'
          ? [
              {
                code: status.code ?? 'FLOW_IDENTITY_PRIMARY_OR_GUARD_DRIFT',
                message:
                  'The database dynamically reproved primary or guard drift while derivatives were settling; finalize was not submitted.',
              },
            ]
          : [],
      now: dependencies.now(),
    });
  }
  if (!status.primary_current || !status.live_guard_current || !status.protected_closure_current) {
    return report({
      prepared,
      mode,
      status: 'blocked',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_PROTECTED_CLOSURE_DRIFT',
          message:
            'The exactly sealed closure changed while derivatives were settling; finalize was not submitted.',
        },
      ],
      now: dependencies.now(),
    });
  }
  if (status.compensation_required) {
    return report({
      prepared,
      mode,
      status: 'pending',
      scope,
      database: status,
      issues: [
        {
          code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
          message:
            'A derivative-only compensation needs a separate plan, freeze, and exact approval; finalize was not submitted and the process mutation will not be replayed.',
          details: { compensation_targets: status.compensation_targets },
        },
      ],
      now: dependencies.now(),
    });
  }
  if (!flowIdentityScopeIsReadyToFinalize(status)) {
    return report({
      prepared,
      mode,
      status: 'pending',
      scope,
      database: status,
      issues: [
        {
          code: 'FLOW_IDENTITY_DERIVATIVES_PENDING',
          message:
            'Derivative closure is still pending at the wait deadline; finalize was not submitted. This in-memory permit is discarded when the wrapper exits, so continuation requires a fresh exact recovery freeze and human approval.',
        },
      ],
      now: dependencies.now(),
    });
  }

  const finalizeRequest = buildFlowIdentityFinalizeRequest({
    scopeProofSha256: scope.scope_proof_sha256,
    plan: prepared.plan,
    status,
  });
  const finalizeRequestSha256 = flowIdentityRestrictedSha256(finalizeRequest);
  const finalizeAttemptPath = finalizeArtifactPath(prepared, 'attempt', finalizeRequestSha256);
  const finalizeRejectionPath = finalizeArtifactPath(
    prepared,
    'domain-rejection',
    finalizeRequestSha256,
  );
  const finalizeProofPath = finalizeArtifactPath(prepared, 'proof', finalizeRequestSha256);
  const finalizeTransportPath = finalizeArtifactPath(
    prepared,
    'transport-error',
    finalizeRequestSha256,
  );
  const priorAttemptHashes = storedFinalizeAttemptHashes(prepared);
  const exactStoredRequest = readStoredFinalizeAttempt({
    prepared,
    scope,
    requestSha256: finalizeRequestSha256,
  });
  if (exactStoredRequest) {
    const storedRejection = readStoredDomainRejection({
      filePath: finalizeRejectionPath,
      label: 'Flow identity finalize domain rejection',
      requestHashField: 'request_sha256',
      expectedRequestSha256: finalizeRequestSha256,
    });
    const storedProof = readStoredFinalizeProof({
      prepared,
      scope,
      request: exactStoredRequest,
      requestSha256: finalizeRequestSha256,
    });
    if (storedRejection && storedProof) {
      fail(
        'Finalize request has contradictory rejection and proof artifacts.',
        'DATASET_FLOW_IDENTITY_FINALIZE_ARTIFACT_CONFLICT',
      );
    }
    if (storedRejection) {
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: storedRejection.code,
            message:
              typeof storedRejection.message === 'string'
                ? storedRejection.message
                : 'The database deterministically rejected finalize.',
            details: {
              response: storedRejection,
              request_sha256: finalizeRequestSha256,
              recovery: OPERATOR_REVIEW_REQUIRED,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
    if (storedProof) {
      return report({
        prepared,
        mode,
        status:
          storedProof.status === 'failed'
            ? 'failed'
            : storedProof.status === 'live_drift'
              ? 'blocked'
              : 'pending',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_FINALIZE_REQUEST_ALREADY_PROVEN',
            message:
              'This exact finalize request already has a durable proof and will not be posted again. A new explicit finalize requires a prior derivatives_pending proof and a later status that creates a new request hash.',
            details: {
              request_sha256: finalizeRequestSha256,
              proof_status: storedProof.status,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
    return report({
      prepared,
      mode,
      status: 'indeterminate',
      scope,
      database: status,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_AMBIGUOUS',
          message:
            'This exact finalize request has an attempt but no durable proof or domain rejection; the scope was read first and finalize will not be posted again.',
          details: { request_sha256: finalizeRequestSha256 },
        },
      ],
      now: dependencies.now(),
    });
  }
  if (existsSync(finalizeRejectionPath) || existsSync(finalizeProofPath)) {
    fail(
      'Finalize terminal artifact exists without its exact attempt.',
      'DATASET_FLOW_IDENTITY_FINALIZE_ARTIFACT_INVALID',
    );
  }
  for (const priorRequestSha256 of priorAttemptHashes) {
    const priorRequest = readStoredFinalizeAttempt({
      prepared,
      scope,
      requestSha256: priorRequestSha256,
    });
    if (!priorRequest) continue;
    const priorRejection = readStoredDomainRejection({
      filePath: finalizeArtifactPath(prepared, 'domain-rejection', priorRequestSha256),
      label: 'Prior flow identity finalize domain rejection',
      requestHashField: 'request_sha256',
      expectedRequestSha256: priorRequestSha256,
    });
    const priorProof = readStoredFinalizeProof({
      prepared,
      scope,
      request: priorRequest,
      requestSha256: priorRequestSha256,
    });
    if (priorRejection || !priorProof) {
      return report({
        prepared,
        mode,
        status: priorRejection ? 'blocked' : 'indeterminate',
        scope,
        database: status,
        issues: [
          {
            code: priorRejection?.code ?? 'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_AMBIGUOUS',
            message:
              'A prior finalize attempt is not backed by a valid derivatives_pending proof; no new finalize request is allowed in this output directory.',
            details: {
              prior_request_sha256: priorRequestSha256,
              current_request_sha256: finalizeRequestSha256,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
    if (priorProof.status !== 'derivatives_pending') {
      return report({
        prepared,
        mode,
        status: priorProof.status === 'failed' ? 'failed' : 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: 'DATASET_FLOW_IDENTITY_FINALIZE_NEW_REQUEST_NOT_AUTHORIZED',
            message:
              'Only a valid derivatives_pending proof can authorize a later explicit finalize with a new status-derived request hash.',
            details: {
              prior_request_sha256: priorRequestSha256,
              prior_status: priorProof.status,
              current_request_sha256: finalizeRequestSha256,
            },
          },
        ],
        now: dependencies.now(),
      });
    }
  }
  writePrivateImmutableJson(finalizeAttemptPath, {
    schema_version: 'dataset-flow-identity-finalize-attempt.v3',
    generated_at_utc: dependencies.now().toISOString(),
    scope_id: scope.scope_id,
    request_sha256: finalizeRequestSha256,
    request: finalizeRequest,
    max_posts: 1,
    automatic_retry: false,
  });
  let finalizeProof: FlowIdentityFinalizeProof;
  try {
    const raw = await dependencies.finalize({
      context,
      scopeId: scope.scope_id,
      request: finalizeRequest,
      authorization: livePermit,
    });
    if (
      isJsonObject(raw) &&
      raw.schema_version === 'dataset-flow-identity-scope-finalize-result.v2'
    ) {
      const permitUsed = livePermit;
      const envelope =
        raw.ok === true
          ? splitFlowIdentityPermitResponse({
              value: raw,
              expectedGeneration: permitUsed.generation + 1,
              expectedInvocationId: permitUsed.invocation_id,
              permitRequired: raw.status === 'derivatives_pending',
              permitForbidden: raw.status !== 'derivatives_pending',
              label: 'Flow identity finalize',
            })
          : (() => {
              if (Object.hasOwn(raw, 'execution_permit')) {
                fail(
                  'Rejected flow identity finalize response contained a bearer permit.',
                  'DATASET_FLOW_IDENTITY_DOMAIN_REJECTION_PERMIT_INVALID',
                );
              }
              return { proof: raw, executionPermit: null };
            })();
      finalizeProof = parseFlowIdentityFinalizeProof({
        value: envelope.proof,
        plan: prepared.plan,
        scopeId: scope.scope_id,
        scopeProofSha256: scope.scope_proof_sha256,
        request: finalizeRequest,
        expectedInvocationId: permitUsed.invocation_id,
        expectedPermitGenerationBefore: permitUsed.generation,
      });
      if (envelope.executionPermit !== null) livePermit = envelope.executionPermit;
      writePrivateImmutableJson(finalizeProofPath, finalizeProof);
    } else if (isMaintenanceRpcDomainFailure(raw)) {
      assertDomainFailureHasNoPermit(raw, 'Finalize');
      writePrivateImmutableJson(finalizeRejectionPath, {
        schema_version: 'dataset-flow-identity-finalize-domain-rejection.v1',
        status: 'rejected',
        scope_id: scope.scope_id,
        request_sha256: finalizeRequestSha256,
        automatic_retry: false,
        approval_reusable: false,
        recovery: OPERATOR_REVIEW_REQUIRED,
        response: raw,
      });
      return report({
        prepared,
        mode,
        status: 'blocked',
        scope,
        database: status,
        issues: [
          {
            code: raw.code,
            message:
              typeof raw.message === 'string'
                ? raw.message
                : 'The database deterministically rejected finalize.',
            details: {
              response: raw,
              request_sha256: finalizeRequestSha256,
              recovery: OPERATOR_REVIEW_REQUIRED,
            },
          },
        ],
        now: dependencies.now(),
      });
    } else {
      fail(
        'Finalize returned neither a guarded proof nor a deterministic domain rejection.',
        'DATASET_FLOW_IDENTITY_FINALIZE_RESPONSE_INVALID',
      );
    }
  } catch (error) {
    writePrivateImmutableJson(finalizeTransportPath, {
      schema_version: 'dataset-flow-identity-finalize-transport-error.v1',
      observed_at_utc: dependencies.now().toISOString(),
      scope_id: scope.scope_id,
      request_sha256: finalizeRequestSha256,
      automatic_retry: false,
      recovery: 'read_scope_only',
      error: errorDetails(error),
    });
    let recovered: FlowIdentityScopeStatus | null = null;
    try {
      recovered = await readScope({ prepared, context, scope, dependencies });
      validateCompletedRequests(prepared, recovered);
    } catch {
      // The immutable transport error is sufficient; never replace it with a blind finalize retry.
    }
    return report({
      prepared,
      mode,
      status: 'indeterminate',
      scope,
      database: recovered,
      issues: [
        {
          code: 'DATASET_FLOW_IDENTITY_FINALIZE_RESPONSE_AMBIGUOUS',
          message:
            'Finalize response was ambiguous; scope was read once and finalize was not retried in this invocation.',
          details: errorDetails(error),
        },
      ],
      now: dependencies.now(),
    });
  }
  status = await readScope({ prepared, context, scope, dependencies });
  validateCompletedRequests(prepared, status);
  return report({
    prepared,
    mode,
    status:
      finalizeProof.status === 'completed' &&
      status.status === 'completed' &&
      flowIdentityScopeHasCurrentDerivativeClosure(status)
        ? 'passed'
        : status.status === 'live_drift' || finalizeProof.status === 'live_drift'
          ? 'blocked'
          : status.status === 'failed' || finalizeProof.status === 'failed'
            ? 'failed'
            : 'pending',
    scope,
    database: status,
    issues: finalizeProof.compensation_required
      ? [
          {
            code: 'FLOW_IDENTITY_DERIVATIVE_COMPENSATION_REQUIRED',
            message:
              'A derivative-only compensation needs a separate plan, freeze, and exact approval; the process mutation will not be replayed.',
            details: { compensation_targets: finalizeProof.compensation_targets },
          },
        ]
      : [],
    now: dependencies.now(),
  });
}
