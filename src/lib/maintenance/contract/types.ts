import type { DatasetMaintenanceSnapshotCompleteness } from '../../dataset-maintenance-pagination.js';

export type JsonObject = Record<string, unknown>;

export const MAINTENANCE_MUTABLE_TABLES = ['contacts', 'sources', 'flows', 'processes'] as const;

export const MAINTENANCE_SUPPORT_TABLES = ['unitgroups', 'flowproperties'] as const;

export const MAINTENANCE_SCAN_TABLES = [
  ...MAINTENANCE_MUTABLE_TABLES,
  'lifecyclemodels',
  ...MAINTENANCE_SUPPORT_TABLES,
] as const;

export type DatasetMaintenanceMutableTable = (typeof MAINTENANCE_MUTABLE_TABLES)[number];
export type DatasetMaintenanceSupportTable = (typeof MAINTENANCE_SUPPORT_TABLES)[number];
export type DatasetMaintenanceActionTable = DatasetMaintenanceMutableTable | 'flowproperties';
export type DatasetMaintenanceScanTable = (typeof MAINTENANCE_SCAN_TABLES)[number];
export type DatasetMaintenanceOperation =
  | 'delete'
  | 'retire'
  | 'redo-import'
  | 'repair-references'
  | 'merge-support-aliases'
  | 'rebuild-derivatives';
export type DatasetMaintenanceActionKind =
  'save_draft' | 'delete' | 'update_json_ordered' | 'rebuild_derivatives';
export type DatasetMaintenanceTargetMode = 'owner_draft';

export const DERIVATIVE_REBUILD_COMPONENTS = ['extracted_md', 'embedding_ft'] as const;
export type DatasetMaintenanceDerivativeComponent = (typeof DERIVATIVE_REBUILD_COMPONENTS)[number];

export type DatasetMaintenanceDerivativeSnapshot = {
  schema_version: 'dataset-derivative-snapshot.v1';
  table: 'processes';
  id: string;
  version: string;
  user_id: string;
  state_code: 0;
  modified_at: string;
  json_sha256: string;
  json_ordered_sha256: string;
  extracted_md_sha256: string | null;
  embedding_ft_sha256: string | null;
  embedding_ft_at: string | null;
  snapshot_sha256: string;
};

export type DatasetMaintenanceAliasDimension = 'time' | 'length_time';

export type DatasetMaintenanceEntityRef = {
  id: string;
  version: string;
};

export type DatasetMaintenanceAliasBatch = {
  batch_id: string;
  dimension: DatasetMaintenanceAliasDimension;
  factor: string;
  source: {
    unitgroup: DatasetMaintenanceEntityRef;
    flowproperty: DatasetMaintenanceEntityRef;
  };
  target: {
    unitgroup: DatasetMaintenanceEntityRef;
    flowproperty: DatasetMaintenanceEntityRef;
  };
};

export type DatasetMaintenanceExchangeInstance = {
  exchange_index: number;
  data_set_internal_id: string;
  flow_id: string;
  flow_version: string;
  direction: 'Input' | 'Output';
  before_exchange_sha256: string;
  before_mean_amount: string;
  before_resulting_amount: string;
};

export type DatasetMaintenanceAliasMutation =
  | { kind: 'flowproperty_unitgroup_reference' }
  | {
      kind: 'flow_flowproperty_reference';
      flow_property_internal_id: string;
      source_flowproperty_id: string;
      source_flowproperty_version: string;
    }
  | {
      kind: 'process_exchange_amounts';
      exchanges: Array<{
        index: number;
        internal_id: string;
        flow_id: string;
        flow_version: string;
        direction: 'Input' | 'Output';
        before_exchange_sha256: string;
      }>;
    };

export type DatasetMaintenanceScopeAction = {
  action_id: string;
  action: DatasetMaintenanceActionKind;
  table: DatasetMaintenanceActionTable;
  id: string;
  version: string;
  expected_user_id: string;
  expected_state_code: 0;
  reason_code: string;
  reason: string;
  evidence: unknown[];
  batch_id?: string;
  exchange_instances?: DatasetMaintenanceExchangeInstance[];
  desired_payload_path?: string;
  expected_before_sha256?: string;
  components?: DatasetMaintenanceDerivativeComponent[];
};

export type DatasetMaintenanceScope = {
  schema_version: 1;
  task_id: string;
  operation: DatasetMaintenanceOperation;
  account: {
    user_id: string;
    email?: string;
  };
  source_import_run_id?: string;
  source_lineage?: unknown;
  target_mode?: DatasetMaintenanceTargetMode;
  alias_batches?: DatasetMaintenanceAliasBatch[];
  actions: DatasetMaintenanceScopeAction[];
};

export type DatasetMaintenanceRemoteRow = {
  table: DatasetMaintenanceScanTable;
  id: string;
  version: string;
  user_id: string | null;
  state_code: number | null;
  modified_at: string | null;
  json?: JsonObject | null;
  json_ordered: JsonObject | null;
  model_id: string | null;
  rule_verification: boolean | null;
};

export type DatasetMaintenanceRowSnapshot = DatasetMaintenanceRemoteRow & {
  row_sha256: string;
  payload_sha256: string | null;
};

export type DatasetMaintenanceBlocker = {
  code: string;
  message: string;
  action_id?: string;
  table?: DatasetMaintenanceScanTable;
  id?: string;
  version?: string;
  details?: unknown;
};

export type DatasetMaintenanceProtectedRow = {
  table: DatasetMaintenanceScanTable;
  id: string;
  version: string;
  modified_at: string | null;
  row_sha256: string;
  payload_sha256: string | null;
  reason: 'non_action_visible_row' | 'blocked_action_row';
};

export type DatasetMaintenanceReferenceImpact = {
  target_action_id: string;
  target_table: DatasetMaintenanceActionTable;
  target_id: string;
  target_version: string;
  phase: 'current' | 'projected';
  source_table: DatasetMaintenanceScanTable;
  source_id: string;
  source_version: string;
  reference_path: string;
  reference_version: string | null;
};

export type DatasetMaintenancePlanAction = DatasetMaintenanceScopeAction & {
  ordinal: number;
  status: 'ready' | 'blocked';
  before: DatasetMaintenanceRowSnapshot | null;
  desired_payload: {
    path: string;
    sha256: string;
  } | null;
  blockers: DatasetMaintenanceBlocker[];
  alias_mutation?: DatasetMaintenanceAliasMutation;
  derivative_before?: DatasetMaintenanceDerivativeSnapshot;
  rollback: {
    strategy:
      | 'save_before_snapshot'
      | 'restore_deleted_before_snapshot'
      | 'restore_atomic_alias_before_snapshot'
      | 'none_derivative_only';
    before_payload_sha256: string | null;
    before_payload: JsonObject | null;
    model_id: string | null;
    rule_verification: boolean | null;
  };
};

export type DatasetMaintenanceAliasExchangeRewrite = DatasetMaintenanceExchangeInstance & {
  action_id: string;
  process_id: string;
  process_version: string;
  after_mean_amount: string;
  after_resulting_amount: string;
  after_exchange_sha256: string;
};

export type DatasetMaintenanceAliasBatchPlan = DatasetMaintenanceAliasBatch & {
  action_ids: string[];
  target_snapshots: {
    unitgroup: DatasetMaintenanceRowSnapshot | null;
    flowproperty: DatasetMaintenanceRowSnapshot | null;
    source_unitgroup: DatasetMaintenanceRowSnapshot | null;
  };
  conversion_evidence: {
    source_unitgroup_payload_sha256: string | null;
    source_reference_unit: JsonObject | null;
    target_conversion_unit: JsonObject | null;
  };
  exchange_rewrites: DatasetMaintenanceAliasExchangeRewrite[];
  summary: {
    rows: number;
    flowproperties: number;
    flows: number;
    processes: number;
    exchanges: number;
    amount_fields: number;
    unrelated_exchanges: number;
  };
  postconditions: {
    source_unitgroup_incoming_refs: number;
    source_flowproperty_flow_refs: number;
    target_flow_refs: number;
    target_exchange_refs: number;
  };
};

export type DatasetMaintenancePlan = {
  schema_version: 1;
  generated_at_utc: string;
  task_id: string;
  operation: DatasetMaintenanceOperation;
  operation_id: string;
  account: {
    user_id: string;
    email: string | null;
  };
  source_import_run_id: string | null;
  source_lineage: unknown;
  target_mode: DatasetMaintenanceTargetMode | null;
  status: 'ready' | 'blocked';
  scope_sha256: string;
  visible_snapshot_sha256: string;
  snapshot_completeness?: DatasetMaintenanceSnapshotCompleteness<DatasetMaintenanceScanTable>;
  projected_reference_sha256: string;
  plan_sha256: string;
  summary: {
    actions: number;
    save_draft: number;
    delete: number;
    update_json_ordered?: number;
    rebuild_derivatives?: number;
    atomic_batches?: number;
    scaled_exchanges?: number;
    scaled_amount_fields?: number;
    unrelated_exchanges_preserved?: number;
    protected_rows: number;
    blockers: number;
    current_reference_impacts: number;
    projected_reference_impacts: number;
  };
  artifacts: {
    maintenance_scope: string;
    rls_visible_snapshot: string;
    protected_rows: string;
    reference_impact_report: string;
    maintenance_plan: string;
    dry_run_report: string;
    payload_dir: string;
    exchange_rewrite_plan?: string;
    derivative_baseline?: string;
  };
  actions: DatasetMaintenancePlanAction[];
  alias_batches?: DatasetMaintenanceAliasBatchPlan[];
  protected_rows: DatasetMaintenanceProtectedRow[];
  blockers: DatasetMaintenanceBlocker[];
};

export type DatasetMaintenanceProgressEntry = {
  schema_version: 1;
  plan_sha256: string;
  operation_id: string;
  action_id: string;
  action: DatasetMaintenanceActionKind;
  table: DatasetMaintenanceActionTable;
  id: string;
  version: string;
  reason_code: string;
  audit_context: {
    plan_sha256: string;
    operation_id: string;
    action_id: string;
    reason_code: string;
    source: 'tiangong-lca dataset maintenance apply';
    target_mode?: DatasetMaintenanceTargetMode;
  };
  actor: {
    user_id: string;
    email: string;
  };
  started_at_utc: string;
  ended_at_utc: string;
  before_sha256: string;
  after_sha256: string | null;
  remote_result_sha256: string | null;
  result: 'success' | 'failed';
  error: string | null;
  rollback: DatasetMaintenancePlanAction['rollback'];
  batch_id?: string;
  target_mode?: DatasetMaintenanceTargetMode;
  batch_request_sha256?: string;
  database_audit_id?: string;
  summary_audit_id?: string;
  plan_request_sha256?: string;
  plan_summary_audit_id?: string;
};
