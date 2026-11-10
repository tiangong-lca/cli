import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { writePrivateImmutableJson } from '../../dataset-maintenance-protected-artifacts.js';
import {
  buildFlowIdentityScopeLookupRequest,
  splitFlowIdentityPermitResponse,
} from './requests.js';
import { parseFlowIdentityFinalizeProof, parseFlowIdentityScopeStatus } from './status.js';
import {
  parseFlowIdentityScopePreflightProof,
  parseFlowIdentityScopeLookupProof,
} from './proofs.js';
import type {
  FlowIdentityFinalizeProof,
  FlowIdentityScopeProof,
  FlowIdentityScopeStatus,
} from './base.js';
import {
  assertFreshRecoveryBaseline,
  parseFlowIdentityRecoveryProof,
} from '../../dataset-maintenance-flow-identity-recovery.js';
import { isJsonObject } from '../contract/values.js';
import type { JsonObject } from '../contract/types.js';
import { flowIdentityRestrictedSha256 } from '../../dataset-maintenance-flow-identity-wire.js';
import {
  isMaintenanceRpcDomainFailure,
  type MaintenanceRpcDomainFailure,
  type DatasetMaintenanceRemoteContext,
} from '../../dataset-maintenance-remote.js';
import {
  type RunFlowIdentityOptions,
  type PreparedRun,
  type RunDependencies,
  type ObtainedScope,
  fail,
  errorDetails,
  assertDomainFailureHasNoPermit,
} from './run-types.js';
import { readCanonicalJson } from './run-preparation.js';

export function numberedArtifact(directory: string, prefix: string): string {
  let ordinal = 1;
  while (existsSync(path.join(directory, `${prefix}.${String(ordinal).padStart(6, '0')}.json`))) {
    ordinal += 1;
  }
  return path.join(directory, `${prefix}.${String(ordinal).padStart(6, '0')}.json`);
}

export function writeStatusSnapshot(prepared: PreparedRun, value: unknown): void {
  writePrivateImmutableJson(numberedArtifact(prepared.outDir, 'scope-status'), value);
}

export function readStoredScopeProof(prepared: PreparedRun): FlowIdentityScopeProof | null {
  const filePath = path.join(prepared.outDir, 'scope-preflight-proof.json');
  if (existsSync(filePath)) {
    return parseFlowIdentityScopePreflightProof(
      readCanonicalJson(filePath, 'Flow identity scope preflight proof'),
      prepared.plan,
    );
  }
  const lookupPath = path.join(prepared.outDir, 'scope-lookup-proof.json');
  if (!existsSync(lookupPath)) return null;
  return parseFlowIdentityScopeLookupProof(
    readCanonicalJson(lookupPath, 'Flow identity scope lookup proof'),
    prepared.plan,
    prepared.identity,
  );
}

export function readStoredDomainRejection(options: {
  filePath: string;
  label: string;
  requestHashField: 'request_sha256' | 'process_request_sha256';
  expectedRequestSha256: string;
}): MaintenanceRpcDomainFailure | null {
  if (!existsSync(options.filePath)) return null;
  const value = readCanonicalJson(options.filePath, options.label);
  if (
    !isJsonObject(value) ||
    value.status !== 'rejected' ||
    value.automatic_retry !== false ||
    value.approval_reusable !== false ||
    value[options.requestHashField] !== options.expectedRequestSha256 ||
    !isMaintenanceRpcDomainFailure(value.response)
  ) {
    fail(
      `${options.label} does not contain an exact database domain rejection.`,
      'DATASET_FLOW_IDENTITY_DOMAIN_REJECTION_INVALID',
    );
  }
  return value.response;
}

export function finalizeArtifactPath(
  prepared: PreparedRun,
  kind: 'attempt' | 'domain-rejection' | 'proof' | 'transport-error',
  requestSha256: string,
): string {
  return path.join(prepared.outDir, `finalize-${kind}-${requestSha256}.json`);
}

export function readStoredFinalizeAttempt(options: {
  prepared: PreparedRun;
  scope: FlowIdentityScopeProof;
  requestSha256: string;
}): JsonObject | null {
  const filePath = finalizeArtifactPath(options.prepared, 'attempt', options.requestSha256);
  if (!existsSync(filePath)) return null;
  const value = readCanonicalJson(filePath, 'Flow identity finalize attempt');
  if (
    !isJsonObject(value) ||
    value.schema_version !== 'dataset-flow-identity-finalize-attempt.v3' ||
    value.scope_id !== options.scope.scope_id ||
    value.request_sha256 !== options.requestSha256 ||
    value.max_posts !== 1 ||
    value.automatic_retry !== false ||
    !isJsonObject(value.request) ||
    flowIdentityRestrictedSha256(value.request) !== options.requestSha256
  ) {
    fail(
      'Flow identity finalize attempt does not bind the exact request.',
      'DATASET_FLOW_IDENTITY_FINALIZE_ATTEMPT_INVALID',
    );
  }
  return value.request;
}

export function storedFinalizeAttemptHashes(prepared: PreparedRun): string[] {
  return readdirSync(prepared.outDir)
    .map((name) => /^finalize-attempt-([a-f0-9]{64})\.json$/u.exec(name)?.[1] ?? null)
    .filter((value): value is string => value !== null)
    .sort();
}

export function readStoredFinalizeProof(options: {
  prepared: PreparedRun;
  scope: FlowIdentityScopeProof;
  request: JsonObject;
  requestSha256: string;
}): FlowIdentityFinalizeProof | null {
  const filePath = finalizeArtifactPath(options.prepared, 'proof', options.requestSha256);
  if (!existsSync(filePath)) return null;
  return parseFlowIdentityFinalizeProof({
    value: readCanonicalJson(filePath, 'Flow identity finalize proof'),
    plan: options.prepared.plan,
    scopeId: options.scope.scope_id,
    scopeProofSha256: options.scope.scope_proof_sha256,
    request: options.request,
  });
}

export async function obtainScope(options: {
  command: RunFlowIdentityOptions;
  prepared: PreparedRun;
  context: DatasetMaintenanceRemoteContext;
  dependencies: RunDependencies;
}): Promise<ObtainedScope> {
  if (options.prepared.recovery) {
    if (options.command.statusOnly) {
      fail(
        'Recovery admission is write-capable and requires an explicit commit invocation.',
        'DATASET_FLOW_IDENTITY_RECOVERY_COMMIT_REQUIRED',
      );
    }
    const recovery = options.prepared.recovery;
    const baselineRaw = await options.dependencies.read({
      context: options.context,
      scopeId: recovery.scope.scope_id,
    });
    if (isMaintenanceRpcDomainFailure(baselineRaw)) {
      assertDomainFailureHasNoPermit(baselineRaw, 'Recovery baseline read');
      return { scope: baselineRaw, executionPermit: null };
    }
    const baseline = parseFlowIdentityScopeStatus(
      baselineRaw,
      options.prepared.plan,
      recovery.scope.scope_id,
      recovery.scope.scope_proof_sha256,
    );
    assertFreshRecoveryBaseline(baseline, recovery.recoveryFreeze);
    writeStatusSnapshot(options.prepared, baseline);
    const requestSha256 = flowIdentityRestrictedSha256(recovery.recoveryRequest);
    if (!options.dependencies.recover) {
      fail(
        'Recovery RPC dependency is unavailable.',
        'DATASET_FLOW_IDENTITY_RECOVERY_RPC_UNAVAILABLE',
      );
    }
    writePrivateImmutableJson(path.join(options.prepared.outDir, 'scope-recovery-attempt.json'), {
      schema_version: 'dataset-flow-identity-recovery-attempt.v1',
      generated_at_utc: options.dependencies.now().toISOString(),
      scope_id: recovery.scope.scope_id,
      request_sha256: requestSha256,
      recovery_approval_identity_sha256:
        recovery.recoveryApproval.recovery_approval_identity_sha256,
      maximum_wrapper_invocations: 1,
      maximum_cli_apply_spawns: 1,
      approval_reusable: false,
      automatic_retry: false,
    });
    let raw: JsonObject;
    try {
      raw = await options.dependencies.recover({
        context: options.context,
        scopeId: recovery.scope.scope_id,
        request: recovery.recoveryRequest,
      });
    } catch (error) {
      const details = errorDetails(error);
      writePrivateImmutableJson(
        path.join(options.prepared.outDir, 'scope-recovery-transport-error.json'),
        {
          schema_version: 'dataset-flow-identity-recovery-transport-error.v1',
          observed_at_utc: options.dependencies.now().toISOString(),
          scope_id: recovery.scope.scope_id,
          request_sha256: requestSha256,
          approval_reusable: false,
          automatic_retry: false,
          recovery: 'read_scope_only',
          error: details,
        },
      );
      let observed: FlowIdentityScopeStatus | null = null;
      try {
        const observedRaw = await options.dependencies.read({
          context: options.context,
          scopeId: recovery.scope.scope_id,
        });
        if (!isMaintenanceRpcDomainFailure(observedRaw)) {
          observed = parseFlowIdentityScopeStatus(
            observedRaw,
            options.prepared.plan,
            recovery.scope.scope_id,
            recovery.scope.scope_proof_sha256,
          );
          writeStatusSnapshot(options.prepared, observed);
        } else {
          assertDomainFailureHasNoPermit(observedRaw, 'Recovery ambiguity status read');
        }
      } catch {
        // The immutable transport error is sufficient; never retry recovery admission.
      }
      return {
        scope: recovery.scope,
        executionPermit: null,
        recoveryAmbiguity: { observed, error: details },
      };
    }
    if (isMaintenanceRpcDomainFailure(raw)) {
      assertDomainFailureHasNoPermit(raw, 'Scope recovery');
      writePrivateImmutableJson(
        path.join(options.prepared.outDir, 'scope-recovery-domain-rejection.json'),
        {
          schema_version: 'dataset-flow-identity-recovery-domain-rejection.v1',
          status: 'rejected',
          scope_id: recovery.scope.scope_id,
          request_sha256: requestSha256,
          approval_reusable: false,
          automatic_retry: false,
          response: raw,
        },
      );
      return { scope: raw, executionPermit: null };
    }
    const envelope = splitFlowIdentityPermitResponse({
      value: raw,
      expectedGeneration: 0,
      permitRequired: raw.replay !== true,
      permitForbidden: raw.replay === true,
      label: 'Flow identity scope recovery',
    });
    const recoveryProof = parseFlowIdentityRecoveryProof({
      value: envelope.proof,
      freeze: recovery.recoveryFreeze,
      approval: recovery.recoveryApproval,
      request: recovery.recoveryRequest,
      expectedInvocationId: envelope.executionPermit?.invocation_id,
    });
    writePrivateImmutableJson(
      path.join(
        options.prepared.outDir,
        recovery.scope.schema_version === 'dataset-flow-identity-scope-lookup-result.v1'
          ? 'scope-lookup-proof.json'
          : 'scope-preflight-proof.json',
      ),
      recovery.scope,
    );
    writePrivateImmutableJson(
      path.join(options.prepared.outDir, 'scope-recovery-proof.json'),
      recoveryProof,
    );
    return { scope: recovery.scope, executionPermit: envelope.executionPermit };
  }
  const stored = readStoredScopeProof(options.prepared);
  if (stored) return { scope: stored, executionPermit: null };
  const storedRejection = readStoredDomainRejection({
    filePath: path.join(options.prepared.outDir, 'scope-preflight-domain-rejection.json'),
    label: 'Flow identity scope preflight domain rejection',
    requestHashField: 'request_sha256',
    expectedRequestSha256: flowIdentityRestrictedSha256(options.prepared.preflightRequest),
  });
  if (storedRejection) return { scope: storedRejection, executionPermit: null };
  if (options.command.statusOnly) {
    if (!options.prepared.approvalClaim || !options.dependencies.lookup) {
      fail(
        'Status-only recovery requires an immutable local scope proof or a consumed local approval claim with the read-only lookup capability.',
        'DATASET_FLOW_IDENTITY_SCOPE_PROOF_REQUIRED',
      );
    }
    const rawLookup = await options.dependencies.lookup({
      context: options.context,
      request: buildFlowIdentityScopeLookupRequest({ identity: options.prepared.identity }),
    });
    if (isMaintenanceRpcDomainFailure(rawLookup)) {
      assertDomainFailureHasNoPermit(rawLookup, 'Scope lookup');
      return { scope: rawLookup, executionPermit: null };
    }
    const lookupProof = parseFlowIdentityScopeLookupProof(
      rawLookup,
      options.prepared.plan,
      options.prepared.identity,
    );
    writePrivateImmutableJson(
      path.join(options.prepared.outDir, 'scope-lookup-proof.json'),
      lookupProof,
    );
    return { scope: lookupProof, executionPermit: null };
  }
  writePrivateImmutableJson(path.join(options.prepared.outDir, 'scope-preflight-attempt.json'), {
    schema_version: 'dataset-flow-identity-preflight-attempt.v2',
    generated_at_utc: options.dependencies.now().toISOString(),
    request_id: options.prepared.identity.request_id,
    plan_sha256: options.prepared.plan.plan_sha256,
    request_sha256: flowIdentityRestrictedSha256(options.prepared.preflightRequest),
    exact_replay_allowed: false,
    automatic_retry: false,
  });
  const raw = await options.dependencies.preflight({
    context: options.context,
    request: options.prepared.preflightRequest,
  });
  if (isMaintenanceRpcDomainFailure(raw)) {
    assertDomainFailureHasNoPermit(raw, 'Scope preflight');
    writePrivateImmutableJson(
      path.join(options.prepared.outDir, 'scope-preflight-domain-rejection.json'),
      {
        schema_version: 'dataset-flow-identity-preflight-domain-rejection.v1',
        status: 'rejected',
        request_sha256: flowIdentityRestrictedSha256(options.prepared.preflightRequest),
        automatic_retry: false,
        approval_reusable: false,
        recovery: 'new_capture_freeze_and_exact_approval_required',
        response: raw,
      },
    );
    return { scope: raw, executionPermit: null };
  }
  const envelope = splitFlowIdentityPermitResponse({
    value: raw,
    expectedGeneration: 0,
    permitRequired: raw.replay !== true,
    permitForbidden: raw.replay === true,
    label: 'Flow identity scope preflight',
  });
  const proof = parseFlowIdentityScopePreflightProof(envelope.proof, options.prepared.plan);
  writePrivateImmutableJson(
    path.join(options.prepared.outDir, 'scope-preflight-proof.json'),
    proof,
  );
  return { scope: proof, executionPermit: envelope.executionPermit };
}

export async function readScope(options: {
  prepared: PreparedRun;
  context: DatasetMaintenanceRemoteContext;
  scope: FlowIdentityScopeProof;
  dependencies: RunDependencies;
}): Promise<FlowIdentityScopeStatus> {
  const raw = await options.dependencies.read({
    context: options.context,
    scopeId: options.scope.scope_id,
  });
  const status = parseFlowIdentityScopeStatus(
    raw,
    options.prepared.plan,
    options.scope.scope_id,
    options.scope.scope_proof_sha256,
  );
  writeStatusSnapshot(options.prepared, status);
  return status;
}
