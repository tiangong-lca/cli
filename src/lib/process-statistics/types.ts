export type JsonRecord = Record<string, unknown>;

export type ProcessScopeStatisticsScope = 'visible' | 'current-user';

export type SnapshotRow = {
  id: string;
  version: string;
  state_code: number | null;
  user_id: string | null;
  modified_at: string | null;
  model_id: string | null;
  json: JsonRecord;
};

export type ClassificationEntry = {
  level: number;
  text: string;
};

export type StatisticsMetadata = {
  userId: string | null;
  maskedUserEmail: string | null;
  totalRowsReportedByRemote: number | null;
};

export type StatisticsOptions = {
  scope: ProcessScopeStatisticsScope;
  stateCodes: number[];
};

export type CountRecord = {
  count: number;
  [key: string]: unknown;
};

export type ProcessScopeStatisticsSummary = {
  schema_version: 1;
  generated_at_utc: string;
  scope: ProcessScopeStatisticsScope;
  state_codes: number[];
  user_id: string | null;
  masked_user_email: string | null;
  total_process_rows: number;
  total_rows_reported_by_remote: number | null;
  rows_by_state_code: Record<string, number>;
  distinct_visible_owner_user_ids: number;
  domain_count_primary: number;
  domain_count_leaf: number;
  craft_count: number;
  unit_process_rows: number;
  unit_process_share: number;
  product_count: number;
  products_with_flow_id: number;
  products_without_flow_id: number;
  rows_missing_classification: number;
  rows_missing_craft: number;
  rows_missing_product: number;
  rows_missing_reference_exchange: number;
  metric_definitions: Record<string, string>;
};

export type ProcessScopeStatisticsArtifacts = {
  summary: ProcessScopeStatisticsSummary;
  domainPrimarySummary: Array<{
    domain: string;
    count: number;
    sample_path?: string;
  }>;
  domainLeafSummary: Array<{
    domain: string;
    count: number;
    sample_path?: string;
  }>;
  craftSummary: Array<{
    craft_signature: string;
    label: string;
    count: number;
    source_kind: string;
  }>;
  productSummary: Array<{
    product_key: string;
    label: string;
    count: number;
    stable_flow_id: string;
    stable_flow_version: string;
    source_kind: string;
  }>;
  typeOfDataSetSummary: Array<{
    type_of_dataset: string;
    count: number;
  }>;
  craftSourceSummary: Array<{
    source_kind: string;
    count: number;
  }>;
  productSourceSummary: Array<{
    source_kind: string;
    count: number;
  }>;
};
