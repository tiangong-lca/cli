import {
  parseFlowIdentityPlan,
  type FlowIdentityPlan,
} from './dataset-maintenance-flow-identity-contract.js';
import { type JsonObject } from './maintenance/contract/types.js';
import {
  type FlowIdentityFreeze,
  type FlowIdentityApproval,
  type FlowIdentityExecutionIdentity,
  token,
  hash,
  uuid,
  instant,
  integer,
} from './maintenance/flow-identity/base.js';
import {
  deterministicUuidFromSha256,
  parseFlowIdentityFreeze,
  parseFlowIdentityApproval,
  buildFlowIdentityExecutionIdentity,
  buildFlowIdentityScopePreflightRequest,
} from './maintenance/flow-identity/requests.js';
import {
  parseScopeProcess,
  parseCompensationEnvelope,
} from './maintenance/flow-identity/status.js';
export {
  type FlowIdentityFreeze,
  type FlowIdentityApproval,
  type FlowIdentityExecutionIdentity,
  type FlowIdentityExecutionPermit,
  type FlowIdentityPermitResponse,
  type FlowIdentityScopePreflightProof,
  type FlowIdentityScopeLookupProof,
  type FlowIdentityScopeProof,
  type FlowIdentityProcessProof,
  type FlowIdentityScopeProcessStatus,
  type FlowIdentityDerivativeResidue,
  type FlowIdentityDerivativeTargetProof,
  type FlowIdentityDerivativeSetProof,
  type FlowIdentityCompensationTarget,
  type FlowIdentityWholeScopeProof,
  type FlowIdentityScopeStatus,
  type FlowIdentityFinalizeProof,
} from './maintenance/flow-identity/base.js';
export {
  computeFlowIdentityFreezeSha256,
  computeFlowIdentityApprovalIdentitySha256,
  parseFlowIdentityFreeze,
  parseFlowIdentityApproval,
  buildFlowIdentityExecutionIdentity,
  buildFlowIdentityScopePreflightRequest,
  buildFlowIdentityScopeLookupRequest,
  splitFlowIdentityPermitResponse,
  computeFlowIdentityProcessRequestSha256,
  buildFlowIdentityProcessRequest,
  buildFlowIdentityFinalizeRequest,
} from './maintenance/flow-identity/requests.js';
export {
  parseFlowIdentityScopePreflightProof,
  parseFlowIdentityScopeLookupProof,
  parseFlowIdentityProcessProof,
} from './maintenance/flow-identity/proofs.js';
export {
  parseFlowIdentityScopeStatus,
  flowIdentityScopeHasCurrentDerivativeClosure,
  flowIdentityScopeIsReadyToFinalize,
  parseFlowIdentityFinalizeProof,
} from './maintenance/flow-identity/status.js';
export {
  parseFlowIdentityDerivativeSetProof,
  parseFlowIdentityWholeScopeProof,
} from './maintenance/flow-identity/derivative-proofs.js';

export function prepareFlowIdentityExecution(options: {
  plan: unknown;
  freeze: unknown;
  approval: unknown;
}): {
  plan: FlowIdentityPlan;
  freeze: FlowIdentityFreeze;
  approval: FlowIdentityApproval;
  identity: FlowIdentityExecutionIdentity;
  preflightRequest: JsonObject;
} {
  const plan = parseFlowIdentityPlan(options.plan);
  const freeze = parseFlowIdentityFreeze(options.freeze, plan);
  const approval = parseFlowIdentityApproval(options.approval, plan, freeze);
  const identity = buildFlowIdentityExecutionIdentity({ plan, freeze, approval });
  return {
    plan,
    freeze,
    approval,
    identity,
    preflightRequest: buildFlowIdentityScopePreflightRequest({ plan, identity }),
  };
}

export const __testInternals = {
  deterministicUuidFromSha256,
  hash,
  instant,
  integer,
  parseScopeProcess,
  parseCompensationEnvelope,
  token,
  uuid,
};
