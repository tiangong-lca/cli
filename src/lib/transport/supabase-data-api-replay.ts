export type RpcReplayClassification = {
  operation: 'read' | 'mutation';
  authRefreshReplay: 'once-after-401-403' | 'never';
};

export const DATA_API_RPC_REPLAY_CLASSIFICATION = {
  qry_review_get_items: { operation: 'read', authRefreshReplay: 'once-after-401-403' },
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
