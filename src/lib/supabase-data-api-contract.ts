import { CliError } from './errors.js';
import { DATA_API_RPC_REPLAY_CLASSIFICATION } from './supabase-data-api-replay.js';
export {
  DATA_API_RPC_REPLAY_CLASSIFICATION,
  isDataApiAuthRefreshReplaySafe,
} from './supabase-data-api-replay.js';

export const DATA_API_PROFILE_ENV = 'TIANGONG_LCA_DATA_API_PROFILE';
export const DATA_API_PROFILES = ['api-contract-v1'] as const;
export type DataApiProfile = (typeof DATA_API_PROFILES)[number];
export type DataApiRole = 'anon' | 'authenticated' | 'service_role';

export const CORE_PUBLIC_RELATIONS = [
  'contacts',
  'flowproperties',
  'flows',
  'ilcd',
  'lciamethods',
  'lifecyclemodels',
  'processes',
  'sources',
  'unitgroups',
] as const;
export type CorePublicRelation = (typeof CORE_PUBLIC_RELATIONS)[number];

export const DATA_API_RELATION_CONSUMERS = {
  contacts: [
    'src/lib/dataset-get.ts',
    'src/lib/dataset-save-draft-run.ts',
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/process-refresh-references.ts',
    'src/lib/dataset-maintenance-clear-account.ts',
  ],
  flowproperties: [
    'src/lib/dataset-support-cache.ts',
    'src/lib/dataset-save-draft-run.ts',
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/dataset-maintenance-flow-identity-capture.ts',
    'src/lib/process-refresh-references.ts',
  ],
  flows: [
    'src/lib/flow-read.ts',
    'src/lib/flow-list.ts',
    'src/lib/flow-publish-version.ts',
    'src/lib/dataset-save-draft-run.ts',
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/dataset-maintenance-flow-identity-capture.ts',
    'src/lib/process-refresh-references.ts',
    'src/lib/dataset-maintenance-clear-account.ts',
  ],
  ilcd: [],
  lciamethods: [
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/process-refresh-references.ts',
  ],
  lifecyclemodels: [
    'src/lib/lifecyclemodel-bundle-save.ts',
    'src/lib/process-dedup-review.ts',
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/supabase-json-ordered-write.ts',
    'src/lib/dataset-maintenance-clear-account.ts',
  ],
  processes: [
    'src/lib/process-get.ts',
    'src/lib/process-list.ts',
    'src/lib/process-save-draft.ts',
    'src/lib/process-scope-statistics.ts',
    'src/lib/process-dedup-review.ts',
    'src/lib/process-refresh-references.ts',
    'src/lib/dataset-save-draft-run.ts',
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/supabase-json-ordered-write.ts',
    'src/lib/supabase-rest.ts',
    'src/lib/dataset-maintenance-clear-account.ts',
  ],
  sources: [
    'src/lib/dataset-get.ts',
    'src/lib/dataset-save-draft-run.ts',
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/supabase-json-ordered-write.ts',
    'src/lib/process-refresh-references.ts',
    'src/lib/dataset-maintenance-clear-account.ts',
  ],
  unitgroups: [
    'src/lib/dataset-support-cache.ts',
    'src/lib/dataset-save-draft-run.ts',
    'src/lib/dataset-remote-verify.ts',
    'src/lib/dataset-maintenance-remote.ts',
    'src/lib/dataset-maintenance-flow-identity-capture.ts',
    'src/lib/process-refresh-references.ts',
  ],
} as const satisfies Record<CorePublicRelation, readonly string[]>;

type RpcTarget = {
  targetSchema: 'api';
  signature: string;
};

export const DATA_API_RPC_TARGETS = {
  // Native Source caller: database 1a21182b56bfb5f7d27ea9dc6684950daab568c6,
  // supabase/workspace/schemas/api/functions/search_sources/definition.sql (CLI #324).
  search_sources: {
    targetSchema: 'api',
    signature:
      'api.search_sources(query_text text, filter_condition jsonb, page_size integer, page_current integer, data_source text, this_user_id text, team_id_filter uuid, state_code_filter integer)',
  },
  cmd_dataset_alias_execution_admit_guarded: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_alias_execution_admit_guarded(p_request jsonb)',
  },
  cmd_dataset_alias_execution_gate_guarded: {
    targetSchema: 'api',
    signature:
      'api.cmd_dataset_alias_execution_gate_guarded(p_request_id uuid, p_preflight_token text, p_gate_name text)',
  },
  cmd_dataset_alias_execution_preflight_guarded: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_alias_execution_preflight_guarded(p_request jsonb)',
  },
  cmd_dataset_alias_execution_read: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_alias_execution_read(p_request_id uuid)',
  },
  cmd_dataset_delete: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_delete(p_table text, p_id uuid, p_version text, p_audit jsonb)',
  },
  cmd_dataset_derivative_rebuild_plan_guarded: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_derivative_rebuild_plan_guarded(p_plan jsonb)',
  },
  cmd_dataset_derivative_rebuild_read: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_derivative_rebuild_read(p_request_id uuid)',
  },
  cmd_dataset_derivative_rebuild_snapshot: {
    targetSchema: 'api',
    signature:
      'api.cmd_dataset_derivative_rebuild_snapshot(p_table text, p_id uuid, p_version text)',
  },
  cmd_dataset_flow_identity_capture_attest_guarded: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_flow_identity_capture_attest_guarded(p_request jsonb)',
  },
  cmd_dataset_flow_identity_process_rewrite_guarded: {
    targetSchema: 'api',
    signature:
      'api.cmd_dataset_flow_identity_process_rewrite_guarded(p_scope_id uuid, p_request jsonb, p_authorization jsonb)',
  },
  cmd_dataset_flow_identity_scope_finalize_guarded: {
    targetSchema: 'api',
    signature:
      'api.cmd_dataset_flow_identity_scope_finalize_guarded(p_scope_id uuid, p_request jsonb, p_authorization jsonb)',
  },
  cmd_dataset_flow_identity_scope_lookup: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_flow_identity_scope_lookup(p_request jsonb)',
  },
  cmd_dataset_flow_identity_scope_preflight_guarded: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_flow_identity_scope_preflight_guarded(p_request jsonb)',
  },
  cmd_dataset_flow_identity_scope_read: {
    targetSchema: 'api',
    signature: 'api.cmd_dataset_flow_identity_scope_read(p_scope_id uuid)',
  },
  cmd_dataset_flow_identity_scope_recover_guarded: {
    targetSchema: 'api',
    signature:
      'api.cmd_dataset_flow_identity_scope_recover_guarded(p_scope_id uuid, p_request jsonb)',
  },
  cmd_dataset_save_draft: {
    targetSchema: 'api',
    signature:
      'api.cmd_dataset_save_draft(p_table text, p_id uuid, p_version text, p_json_ordered jsonb, p_model_id uuid, p_rule_verification boolean, p_audit jsonb, p_model_version text)',
  },
} as const satisfies Record<string, RpcTarget>;

export type DataApiRpc = keyof typeof DATA_API_RPC_TARGETS;

export const DATA_API_CONTRACT = {
  schemaVersion: 'tiangong-lca-cli.data-api-contract.v1',
  databaseContract: {
    repository: 'tiangong-lca/database-engine',
    databaseCommit: '1320dcc506fe37af6b625ae30fbe0bec38cf87c6',
    migrationHead: '20260902104500',
    migrationSetGitTreeSha: '88e212220c0037cee673d0522340d3cca5e791dd',
    contractMigrations: {
      fullSchemaCutover: {
        path: 'supabase/migrations/20260805130000_full_schema_cutover.sql',
        sha256: 'd409022fb25d9313d17b0f76216ca6e4abbfce7d6c5b6e74c869314d1c7e5afb',
      },
      apiContractClosure: {
        path: 'supabase/migrations/20260806160000_api_contract_closure.sql',
        sha256: 'e0e7aec8e03d70c60ee0d5c2b332ce73fa7b4b229725c9a9fcb0e1a1d7e8c511',
      },
      processModelVersionContract: {
        path: 'supabase/migrations/20260902100000_process_model_version_contract.sql',
        sha256: '99cbaf474098281ea8c57fcef093174d0ef78a18300f133dd8cc6f9e59a4a29b',
      },
      processSaveDraftModelVersion: {
        path: 'supabase/migrations/20260902103509_add_process_model_version_to_dataset_save_draft.sql',
        sha256: 'ca93f3279673e292803bd8c477aec76b772c7246e16114808d31e64994037723',
      },
      migrationHead: {
        path: 'supabase/migrations/20260902104500_use_exact_model_version_in_review_ownership.sql',
        sha256: '538ec3001f7683b57817e4a89973ded127522ce94521720ed583de99711bbe60',
      },
    },
    contractReady: true,
    snapshotRole: 'frozen-process-model-version-contract',
    provenanceIssue: 'tiangong-lca/database-engine#589',
    publicCoreTableCount: 9,
    publicRoutineCount: 0,
  },
  profiles: {
    'api-contract-v1': {
      phase: 'contract',
      description: 'Frozen api RPC profile for database-engine migration head 20260902104500.',
    },
  },
  corePublicRelations: CORE_PUBLIC_RELATIONS,
  relationConsumers: DATA_API_RELATION_CONSUMERS,
  views: [],
  rpcs: DATA_API_RPC_TARGETS,
  rpcReplayClassification: DATA_API_RPC_REPLAY_CLASSIFICATION,
  cliRolePolicy: {
    anon: 'deny',
    authenticated: 'allow',
    service_role: 'deny',
  },
  retryPolicy: {
    reads:
      'GET/HEAD and manifest-classified read RPCs permit one auth-refresh replay only after 401/403',
    mutations:
      'no automatic transport retry; recovery must use the capability idempotency/read path',
  },
  retiredCapabilities: [
    {
      capability: 'rpc:cmd_dataset_alias_plan_guarded',
      targetSchema: 'private',
      reason:
        'The whole-plan executor is private. Authenticated CLI execution uses the frozen alias execution preflight/gate/admit/read api capabilities.',
    },
  ],
  blockers: [],
} as const;

export type ResolvedDataApiCapability = {
  kind: 'relation' | 'rpc';
  name: string;
  schema: 'public' | 'api';
  profile: DataApiProfile;
  role: DataApiRole;
  signature: string | null;
};

function isCorePublicRelation(value: string): value is CorePublicRelation {
  return (CORE_PUBLIC_RELATIONS as readonly string[]).includes(value);
}

function isDataApiRpc(value: string): value is DataApiRpc {
  return Object.hasOwn(DATA_API_RPC_TARGETS, value);
}

export function resolveDataApiProfile(env: NodeJS.ProcessEnv = process.env): DataApiProfile {
  const value = env[DATA_API_PROFILE_ENV]?.trim() || 'api-contract-v1';
  if ((DATA_API_PROFILES as readonly string[]).includes(value)) {
    return value as DataApiProfile;
  }
  throw new CliError(`Unsupported ${DATA_API_PROFILE_ENV}: ${value}`, {
    code: 'DATA_API_PROFILE_INVALID',
    exitCode: 2,
    details: { supported: DATA_API_PROFILES },
  });
}

function assertCliRole(role: DataApiRole): void {
  if (role !== 'authenticated') {
    throw new CliError(`The CLI Data API adapter does not accept the ${role} role.`, {
      code: 'DATA_API_ROLE_FORBIDDEN',
      exitCode: 2,
      details: { role, allowed_roles: ['authenticated'] },
    });
  }
}

export function resolveDataApiCapability(options: {
  kind: 'relation' | 'rpc';
  name: string;
  env?: NodeJS.ProcessEnv;
  profile?: DataApiProfile;
  role?: DataApiRole;
}): ResolvedDataApiCapability {
  const profile = options.profile ?? resolveDataApiProfile(options.env);
  const role = options.role ?? 'authenticated';
  assertCliRole(role);

  if (options.kind === 'relation') {
    if (!isCorePublicRelation(options.name)) {
      throw new CliError(`Unmanifested Data API relation: ${options.name}`, {
        code: 'DATA_API_CAPABILITY_UNMANIFESTED',
        exitCode: 2,
        details: { kind: options.kind, name: options.name },
      });
    }
    return {
      kind: 'relation',
      name: options.name,
      schema: 'public',
      profile,
      role,
      signature: null,
    };
  }

  if (!isDataApiRpc(options.name)) {
    throw new CliError(`Unmanifested Data API RPC: ${options.name}`, {
      code: 'DATA_API_CAPABILITY_UNMANIFESTED',
      exitCode: 2,
      details: { kind: options.kind, name: options.name },
    });
  }
  const target = DATA_API_RPC_TARGETS[options.name];
  return {
    kind: 'rpc',
    name: options.name,
    schema: 'api',
    profile,
    role,
    signature: target.signature,
  };
}

export function applyDataApiProfileHeaders(
  headers: HeadersInit | undefined,
  capability: ResolvedDataApiCapability,
  method = 'GET',
): Record<string, string> {
  const resolved = new Headers(headers);
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') {
    resolved.set('Accept-Profile', capability.schema);
  } else {
    resolved.set('Content-Profile', capability.schema);
  }
  return Object.fromEntries(resolved.entries());
}

export function resolveDataApiCapabilityFromUrl(options: {
  url: string;
  method?: string;
  env?: NodeJS.ProcessEnv;
  profile?: DataApiProfile;
}): ResolvedDataApiCapability {
  const parsed = new URL(options.url);
  const marker = '/rest/v1/';
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0) {
    throw new CliError(`URL is not a Supabase Data API route: ${options.url}`, {
      code: 'DATA_API_URL_INVALID',
      exitCode: 2,
    });
  }
  const segments = parsed.pathname
    .slice(markerIndex + marker.length)
    .split('/')
    .filter(Boolean);
  if (segments[0] === 'rpc' && segments[1]) {
    return resolveDataApiCapability({
      kind: 'rpc',
      name: segments[1],
      env: options.env,
      profile: options.profile,
    });
  }
  if (segments[0]) {
    return resolveDataApiCapability({
      kind: 'relation',
      name: segments[0],
      env: options.env,
      profile: options.profile,
    });
  }
  throw new CliError(`Data API URL has no relation or RPC name: ${options.url}`, {
    code: 'DATA_API_URL_INVALID',
    exitCode: 2,
  });
}

export function isDataApiUrl(url: string): boolean {
  return new URL(url).pathname.includes('/rest/v1/');
}

export function buildDataApiUrl(
  restBaseUrl: string,
  capability: Pick<ResolvedDataApiCapability, 'kind' | 'name'>,
): string {
  const base = restBaseUrl.replace(/\/+$/u, '');
  return capability.kind === 'rpc'
    ? `${base}/rpc/${capability.name}`
    : `${base}/${capability.name}`;
}
