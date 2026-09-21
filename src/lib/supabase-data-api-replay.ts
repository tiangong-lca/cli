export type RpcReplayClassification = {
  operation: 'read' | 'mutation';
  authRefreshReplay: 'once-after-401-403' | 'never';
};

export const DATA_API_RPC_REPLAY_CLASSIFICATION = {
  cmd_dataset_alias_execution_admit_guarded: { operation: 'mutation', authRefreshReplay: 'never' },
  cmd_dataset_alias_execution_gate_guarded: { operation: 'mutation', authRefreshReplay: 'never' },
  cmd_dataset_alias_execution_preflight_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_alias_execution_read: {
    operation: 'read',
    authRefreshReplay: 'once-after-401-403',
  },
  // Versioned (v2) protected lifecycle: the same classifications as their v1 counterparts,
  // because the review forbids an authentication retry from ever replaying an admission.
  cmd_dataset_alias_execution_admit_v2_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_alias_execution_gate_v2_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_alias_execution_preflight_v2_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_alias_execution_read_v2: {
    operation: 'read',
    authRefreshReplay: 'once-after-401-403',
  },
  cmd_dataset_delete: { operation: 'mutation', authRefreshReplay: 'never' },
  cmd_dataset_derivative_rebuild_plan_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_derivative_rebuild_read: {
    operation: 'read',
    authRefreshReplay: 'once-after-401-403',
  },
  cmd_dataset_derivative_rebuild_snapshot: {
    operation: 'read',
    authRefreshReplay: 'once-after-401-403',
  },
  cmd_dataset_flow_identity_capture_attest_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_flow_identity_process_rewrite_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_flow_identity_scope_finalize_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_flow_identity_scope_lookup: {
    operation: 'read',
    authRefreshReplay: 'once-after-401-403',
  },
  cmd_dataset_flow_identity_scope_preflight_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_flow_identity_scope_read: {
    operation: 'read',
    authRefreshReplay: 'once-after-401-403',
  },
  cmd_dataset_flow_identity_scope_recover_guarded: {
    operation: 'mutation',
    authRefreshReplay: 'never',
  },
  cmd_dataset_save_draft: { operation: 'mutation', authRefreshReplay: 'never' },
} as const satisfies Record<string, RpcReplayClassification>;

export function isDataApiAuthRefreshReplaySafe(options: { url: string; method: string }): boolean {
  const method = options.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;
  if (method !== 'POST') return false;

  const parsed = new URL(options.url);
  const match = parsed.pathname.match(/\/rest\/v1\/rpc\/([^/]+)\/?$/u);
  const rpc = match?.[1];
  if (!rpc || !Object.hasOwn(DATA_API_RPC_REPLAY_CLASSIFICATION, rpc)) return false;
  const classification =
    DATA_API_RPC_REPLAY_CLASSIFICATION[rpc as keyof typeof DATA_API_RPC_REPLAY_CLASSIFICATION];
  return (
    classification.operation === 'read' && classification.authRefreshReplay === 'once-after-401-403'
  );
}
