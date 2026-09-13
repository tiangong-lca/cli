import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact, writeTextArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import {
  coerceText,
  deepGet,
  isRecord,
  loadRowsFromFile,
  normalizeText,
  type JsonRecord,
} from './flow-governance.js';
import {
  type SdkValidationEntity,
  validateEntityWithDeepFallback,
} from './tidas-sdk-validation.js';

const CONTACT_UUID = 'f4b4c314-8c4c-4c83-968f-5b3c7724f6a8';
const CONTACT_VERSION = '01.00.000';
const COMPLIANCE_SOURCE_UUID = 'd92a1a12-2545-49e2-a585-55c259997756';
const COMPLIANCE_SOURCE_VERSION = '20.20.002';
const ILCD_FORMAT_SOURCE_UUID = 'a97a0155-0234-4b87-b4ce-a45da52f2a40';
const ILCD_FORMAT_SOURCE_VERSION = '03.00.003';
const DEFAULT_MASS_FLOW_PROPERTY_UUID = '93a60a56-a3c8-11da-a746-0800200b9a66';
const DEFAULT_MASS_FLOW_PROPERTY_VERSION = '03.00.003';
const DEFAULT_MASS_FLOW_PROPERTY_NAME = 'Mass';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const VERSION_QUERY_RE = /([?&]version=)(\d+\.\d+\.\d+)/u;
const LOCAL_URI_VERSION_RE = /_(\d+\.\d+\.\d+)\.xml$/u;
const LEGACY_OUTPUT_PREFIX = 'flows_tidas_sdk_plus_classification';
const GENERIC_MASS_HINTS = new Set([
  'flow property for kg',
  'flow property for kilogram',
  'flow property for kilograms',
  'kg',
  'kilogram',
  'kilograms',
  'mass',
  'mass flow',
  'mass flow kg',
]);

type FlowValidationIssue = {
  validator: 'tidas_sdk' | 'flow_property_contract';
  path: string;
  message: string;
  code: string;
};

type FlowRemediationAuditRow = {
  id: unknown;
  user_id: unknown;
  state_code: unknown;
  version_before: string;
  version_after: string;
  valid_after_remediation: boolean;
  applied_fixes: string[];
  original_reason: unknown[];
  final_reason: FlowValidationIssue[];
};

type FlowRemediationRowResult = {
  row: JsonRecord;
  valid: boolean;
  appliedFixes: string[];
  finalReasons: FlowValidationIssue[];
  versionBefore: string;
  versionAfter: string;
};

type FlowValidationResult =
  | {
      success: true;
    }
  | {
      success: false;
      issues: FlowValidationIssue[];
    };

type FlowSdkModule = {
  createFlow?: (
    data?: unknown,
    validationConfig?: {
      mode?: 'strict' | 'weak' | 'ignore';
      throwOnError?: boolean;
      deepValidation?: boolean;
    },
  ) => SdkValidationEntity;
};

type FlowRemediationFiles = {
  allRemediated: string;
  readyForMcp: string;
  residualManualQueue: string;
  audit: string;
  report: string;
  prompt: string;
};

export type FlowRemediationReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed_local_flow_remediation';
  input_file: string;
  out_dir: string;
  counts: {
    input_rows: number;
    state_code_0_rows: number;
    state_code_100_rows: number;
    remediated_rows: number;
    ready_for_mcp_rows: number;
    residual_manual_rows: number;
  };
  applied_fix_counts: Record<string, number>;
  residual_manual_ids: string[];
  validation_backend: 'tidas_sdk';
  files: {
    all_remediated: string;
    ready_for_mcp: string;
    residual_manual_queue: string;
    audit: string;
    prompt: string;
    report: string;
  };
};

export type RunFlowRemediateOptions = {
  inputFile: string;
  outDir: string;
};

type FlowRemediationDeps = {
  loadSdkModule?: () => FlowSdkModule & { location?: string };
  now?: () => Date;
};

type FlowPropertyDescriptor = {
  uuid: string;
  name: string;
  version: string;
};

function build_sdk_candidates(): string[] {
  return ['@tiangong-lca/tidas-sdk/core'];
}

function resolve_sdk_module_from_candidates(
  requireFn: NodeJS.Require,
  candidates: string[],
): FlowSdkModule & { location: string } {
  const details: string[] = [];
  for (const candidate of candidates) {
    try {
      const loaded = requireFn(candidate) as FlowSdkModule;
      if (typeof loaded.createFlow === 'function') {
        return {
          ...loaded,
          location: candidate,
        };
      }
      details.push(`Candidate missing createFlow export: ${candidate}`);
    } catch (error) {
      details.push(`Failed to load ${candidate}: ${String(error)}`);
    }
  }

  throw new CliError('Unable to resolve the local tidas-sdk flow factory.', {
    code: 'FLOW_REMEDIATE_SDK_NOT_FOUND',
    exitCode: 2,
    details,
  });
}

function resolve_local_sdk_module(): FlowSdkModule & { location: string } {
  return resolve_sdk_module_from_candidates(createRequire(import.meta.url), build_sdk_candidates());
}

function assert_input_file(inputFile: string): string {
  if (!inputFile) {
    throw new CliError('Missing required --input-file value.', {
      code: 'FLOW_REMEDIATE_INPUT_REQUIRED',
      exitCode: 2,
    });
  }

  const resolved = path.resolve(inputFile);
  if (!existsSync(resolved)) {
    throw new CliError(`Flow remediation input file not found: ${resolved}`, {
      code: 'FLOW_REMEDIATE_INPUT_NOT_FOUND',
      exitCode: 2,
    });
  }

  return resolved;
}

function assert_out_dir(outDir: string): string {
  if (!outDir) {
    throw new CliError('Missing required --out-dir value.', {
      code: 'FLOW_REMEDIATE_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }
  return path.resolve(outDir);
}

function build_output_files(outDir: string): FlowRemediationFiles {
  return {
    allRemediated: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_remediated_all.jsonl`),
    readyForMcp: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_remediated_ready_for_mcp.jsonl`),
    residualManualQueue: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_residual_manual_queue.jsonl`),
    audit: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_remediation_audit.jsonl`),
    report: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_remediation_report.json`),
    prompt: path.join(outDir, `${LEGACY_OUTPUT_PREFIX}_residual_manual_queue_prompt.md`),
  };
}

function build_local_dataset_uri(datasetKind: string, uuidValue: string, version: string): string {
  if (!uuidValue) {
    return '';
  }

  const folderMap: Record<string, string> = {
    process: 'processes',
    'process data set': 'processes',
    flow: 'flows',
    'flow data set': 'flows',
    source: 'sources',
    'source data set': 'sources',
    contact: 'contacts',
    'contact data set': 'contacts',
    'flow property data set': 'flowproperties',
  };
  const kind = datasetKind.trim().toLowerCase();
  const folder = folderMap[kind] ?? 'datasets';
  const versionText = version.trim() || '01.01.000';
  return `../${folder}/${uuidValue}_${versionText}.xml`;
}

function build_dataset_format_reference(): JsonRecord {
  return {
    '@refObjectId': ILCD_FORMAT_SOURCE_UUID,
    '@type': 'source data set',
    '@uri': build_local_dataset_uri('source', ILCD_FORMAT_SOURCE_UUID, ILCD_FORMAT_SOURCE_VERSION),
    '@version': ILCD_FORMAT_SOURCE_VERSION,
    'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'ILCD format' }],
  };
}

function normalize_multilang_entries(value: unknown): JsonRecord[] | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [{ '@xml:lang': 'en', '#text': text }] : null;
  }

  if (Array.isArray(value)) {
    const entries = value.flatMap((item) => normalize_multilang_entries(item) ?? []);
    return entries.length ? entries : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const text = coerceText(value['#text']);
  if (!text) {
    return null;
  }

  return [
    {
      '@xml:lang': coerceText(value['@xml:lang']) || 'en',
      '#text': text,
    },
  ];
}

function first_text(value: unknown, fallback = ''): string {
  const normalized = normalize_multilang_entries(value);
  return normalized?.[0]?.['#text'] ? String(normalized[0]['#text']) : fallback;
}

function normalize_multilang_field(container: JsonRecord, key: string, fixes: string[]): void {
  if (!(key in container)) {
    return;
  }
  const normalized = normalize_multilang_entries(container[key]);
  if (!normalized) {
    delete container[key];
    fixes.push(`remove_empty_multilang:${key}`);
    return;
  }
  if (JSON.stringify(container[key]) !== JSON.stringify(normalized)) {
    container[key] = normalized;
    fixes.push(`normalize_multilang:${key}`);
  }
}

function normalize_name_block(dataSetInfo: JsonRecord, fixes: string[]): void {
  const nameBlock = isRecord(dataSetInfo.name) ? dataSetInfo.name : null;
  if (!nameBlock) {
    return;
  }

  for (const key of [
    'baseName',
    'flowProperties',
    'mixAndLocationTypes',
    'treatmentStandardsRoutes',
  ]) {
    if (!(key in nameBlock)) {
      continue;
    }
    const normalized = normalize_multilang_entries(nameBlock[key]);
    if (!normalized) {
      delete nameBlock[key];
      fixes.push(`remove_empty_name_field:${key}`);
      continue;
    }
    if (JSON.stringify(nameBlock[key]) !== JSON.stringify(normalized)) {
      nameBlock[key] = normalized;
      fixes.push(`normalize_name_field:${key}`);
    }
  }
}

function bump_ilcd_version(version: string): string {
  const parts = version.split('.');
  const numbers = [0, 0, 0].map((_, index) => {
    const raw = parts[index];
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isInteger(parsed) ? parsed : 0;
  });
  numbers[2] += 1;
  return `${numbers[0].toString().padStart(2, '0')}.${numbers[1].toString().padStart(2, '0')}.${numbers[2]
    .toString()
    .padStart(3, '0')}`;
}

function version_from_uri(uri: string): string {
  const text = uri.trim();
  if (!text) {
    return '';
  }
  const localMatch = text.match(LOCAL_URI_VERSION_RE);
  if (localMatch) {
    return localMatch[1] as string;
  }
  const queryMatch = text.match(VERSION_QUERY_RE);
  return queryMatch?.[2] ?? '';
}

function normalize_reference_block(
  ref: unknown,
  defaultType: string,
  shortDescriptionFallback: string,
): JsonRecord | null {
  if (!isRecord(ref)) {
    return null;
  }
  const refObjectId = coerceText(ref['@refObjectId']).toLowerCase();
  if (!refObjectId) {
    return null;
  }

  const refType = coerceText(ref['@type']) || defaultType;
  const version =
    coerceText(ref['@version']) ||
    version_from_uri(coerceText(ref['@uri'])) ||
    (refObjectId === ILCD_FORMAT_SOURCE_UUID
      ? ILCD_FORMAT_SOURCE_VERSION
      : refObjectId === COMPLIANCE_SOURCE_UUID
        ? COMPLIANCE_SOURCE_VERSION
        : '');
  const shortDescription =
    normalize_multilang_entries(ref['common:shortDescription']) ??
    (shortDescriptionFallback ? [{ '@xml:lang': 'en', '#text': shortDescriptionFallback }] : null);

  const result: JsonRecord = {
    '@type': refType,
    '@refObjectId': refObjectId,
    '@uri': version
      ? build_local_dataset_uri(refType, refObjectId, version)
      : coerceText(ref['@uri']),
  };
  if (version) {
    result['@version'] = version;
  }
  if (shortDescription) {
    result['common:shortDescription'] = shortDescription;
  }
  return result;
}

function canonical_contact_reference(): JsonRecord {
  return {
    '@type': 'contact data set',
    '@refObjectId': CONTACT_UUID,
    '@uri': build_local_dataset_uri('contact data set', CONTACT_UUID, CONTACT_VERSION),
    '@version': CONTACT_VERSION,
    'common:shortDescription': [
      { '@xml:lang': 'en', '#text': 'Tiangong LCA Data Working Group' },
      { '@xml:lang': 'zh', '#text': '天工LCA数据团队' },
    ],
  };
}

function canonical_compliance_block(): JsonRecord {
  return {
    'common:referenceToComplianceSystem': {
      '@refObjectId': COMPLIANCE_SOURCE_UUID,
      '@type': 'source data set',
      '@uri': build_local_dataset_uri(
        'source data set',
        COMPLIANCE_SOURCE_UUID,
        COMPLIANCE_SOURCE_VERSION,
      ),
      '@version': COMPLIANCE_SOURCE_VERSION,
      'common:shortDescription': [
        { '@xml:lang': 'en', '#text': 'ILCD Data Network - Entry-level' },
      ],
    },
    'common:approvalOfOverallCompliance': 'Fully compliant',
  };
}

function normalize_hint_text(value: unknown): string {
  return normalizeText(first_text(value));
}

function infer_flow_property_descriptor_from_hint(value: unknown): FlowPropertyDescriptor | null {
  const normalized = normalize_hint_text(value);
  if (!normalized) {
    return null;
  }

  if (
    GENERIC_MASS_HINTS.has(normalized) ||
    (normalized.startsWith('flow property for ') && /\b(kg|kilogram|kilograms)\b/u.test(normalized))
  ) {
    return {
      uuid: DEFAULT_MASS_FLOW_PROPERTY_UUID,
      name: DEFAULT_MASS_FLOW_PROPERTY_NAME,
      version: DEFAULT_MASS_FLOW_PROPERTY_VERSION,
    };
  }

  return null;
}

function build_flow_property_item(
  descriptor: FlowPropertyDescriptor,
  internalId: string,
  meanValue: string,
): JsonRecord {
  return {
    '@dataSetInternalID': internalId,
    meanValue,
    referenceToFlowPropertyDataSet: {
      '@type': 'flow property data set',
      '@refObjectId': descriptor.uuid,
      '@uri': build_local_dataset_uri(
        'flow property data set',
        descriptor.uuid,
        descriptor.version,
      ),
      '@version': descriptor.version,
      'common:shortDescription': [{ '@xml:lang': 'en', '#text': descriptor.name }],
    },
  };
}

function normalize_flow_properties(
  dataset: JsonRecord,
  fixes: string[],
): { items: JsonRecord[]; unresolved: FlowValidationIssue[] } {
  const flowPropertiesBlock = isRecord(dataset.flowProperties) ? dataset.flowProperties : {};
  dataset.flowProperties = flowPropertiesBlock;
  const rawItems = flowPropertiesBlock.flowProperty;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  const normalizedItems: JsonRecord[] = [];
  const preservedRows: unknown[] = [];
  const unresolved: FlowValidationIssue[] = [];
  let repairedUnknownUuid = false;
  let filledMissingUuid = false;
  let usedDefaultMassFallback = false;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isRecord(item)) {
      preservedRows.push(item);
      unresolved.push({
        validator: 'tidas_sdk',
        path: 'flowDataSet.flowProperties.flowProperty',
        message: 'flowProperty item is not an object',
        code: 'unsupported_item_type',
      });
      continue;
    }

    const reference = isRecord(item.referenceToFlowPropertyDataSet)
      ? item.referenceToFlowPropertyDataSet
      : null;
    const hint = reference?.['common:shortDescription'] ?? reference;
    const internalId = coerceText(item['@dataSetInternalID']) || String(index);
    const meanValue = coerceText(item.meanValue);
    const refUuid = coerceText(reference?.['@refObjectId']).toLowerCase();
    const refVersion =
      coerceText(reference?.['@version']) || version_from_uri(coerceText(reference?.['@uri']));
    let descriptor: FlowPropertyDescriptor | null;

    if (refUuid && UUID_RE.test(refUuid)) {
      descriptor = {
        uuid: refUuid,
        name: first_text(hint, DEFAULT_MASS_FLOW_PROPERTY_NAME),
        version:
          refVersion ||
          (refUuid === DEFAULT_MASS_FLOW_PROPERTY_UUID
            ? DEFAULT_MASS_FLOW_PROPERTY_VERSION
            : '01.01.000'),
      };
    } else {
      descriptor = infer_flow_property_descriptor_from_hint(hint);
      if (descriptor) {
        if (refUuid) {
          repairedUnknownUuid = true;
        } else {
          filledMissingUuid = true;
        }
      }
    }

    if (!descriptor) {
      unresolved.push({
        validator: 'tidas_sdk',
        path: 'flowDataSet.flowProperties.flowProperty.referenceToFlowPropertyDataSet.@refObjectId',
        message: refUuid
          ? `Unknown flow property UUID: ${refUuid}`
          : 'Unable to infer flow property UUID from the reference block',
        code: 'unknown_flow_property_uuid',
      });
      normalizedItems.push({ ...item });
      preservedRows.push(normalizedItems.at(-1));
      continue;
    }

    const canonical = build_flow_property_item(descriptor, internalId, meanValue);
    // Repair only the reference leaves that this operation owns. Do not rebuild
    // the property or erase comments, uncertainty, derivation or custom fields.
    normalizedItems.push({
      ...item,
      referenceToFlowPropertyDataSet: {
        ...(canonical.referenceToFlowPropertyDataSet as JsonRecord),
        ...reference,
        '@refObjectId': descriptor.uuid,
        '@version': descriptor.version,
      },
    });
    preservedRows.push(normalizedItems.at(-1));
  }

  if (!normalizedItems.length) {
    if (!items.length) {
      normalizedItems.push(
        build_flow_property_item(
          {
            uuid: DEFAULT_MASS_FLOW_PROPERTY_UUID,
            name: DEFAULT_MASS_FLOW_PROPERTY_NAME,
            version: DEFAULT_MASS_FLOW_PROPERTY_VERSION,
          },
          '0',
          '1.0',
        ),
      );
      usedDefaultMassFallback = true;
      preservedRows.push(normalizedItems[0]);
    } else {
      flowPropertiesBlock.flowProperty = rawItems;
      return { items: [], unresolved };
    }
  }

  flowPropertiesBlock.flowProperty = preservedRows.length === 1 ? preservedRows[0] : preservedRows;
  fixes.push('normalize_flow_properties');
  if (repairedUnknownUuid) {
    fixes.push('repair_unknown_flow_property_uuid_from_short_description');
  }
  if (filledMissingUuid) {
    fixes.push('fill_missing_flow_property_uuid_from_short_description');
  }
  if (usedDefaultMassFallback) {
    fixes.push('set_default_mass_flow_property');
  }
  return { items: normalizedItems, unresolved };
}

function normalize_quantitative_reference(
  dataset: JsonRecord,
  normalizedFlowProperties: JsonRecord[],
  fixes: string[],
  unresolved: FlowValidationIssue[],
): void {
  const flowInformation = isRecord(dataset.flowInformation) ? dataset.flowInformation : {};
  dataset.flowInformation = flowInformation;
  const quantitativeReference = isRecord(flowInformation.quantitativeReference)
    ? flowInformation.quantitativeReference
    : {};
  flowInformation.quantitativeReference = quantitativeReference;

  if (!normalizedFlowProperties.length) {
    unresolved.push({
      validator: 'tidas_sdk',
      path: 'flowDataSet.flowInformation.quantitativeReference.referenceToReferenceFlowProperty',
      message:
        'Cannot infer referenceToReferenceFlowProperty without any valid flowProperty entries',
      code: 'missing_flow_properties',
    });
    return;
  }

  const allowedIds = new Set(
    normalizedFlowProperties
      .map((item) => coerceText(item['@dataSetInternalID']))
      .filter((value) => value.length > 0),
  );
  const current = coerceText(quantitativeReference.referenceToReferenceFlowProperty);
  const matches = normalizedFlowProperties.filter(
    (item) => coerceText(item['@dataSetInternalID']) === current,
  );
  if (!allowedIds.has(current) || matches.length !== 1) {
    unresolved.push({
      validator: 'tidas_sdk',
      path: 'flowDataSet.flowInformation.quantitativeReference.referenceToReferenceFlowProperty',
      message:
        'The declared reference must resolve uniquely; selecting the first property would change the quantity basis.',
      code: 'flow_property_reference_unresolved',
    });
  }
}

function normalize_technology_multilang_fields(dataset: JsonRecord, fixes: string[]): void {
  const technology = deepGet(dataset, ['flowInformation', 'technology']);
  if (!isRecord(technology)) {
    return;
  }
  normalize_multilang_field(technology, 'technologicalApplicability', fixes);
}

function normalize_technical_specification(dataset: JsonRecord, fixes: string[]): void {
  const technology = deepGet(dataset, ['flowInformation', 'technology']);
  if (!isRecord(technology) || !('referenceToTechnicalSpecification' in technology)) {
    return;
  }
  const normalized = normalize_reference_block(
    technology.referenceToTechnicalSpecification,
    'source data set',
    first_text(technology.referenceToTechnicalSpecification),
  );
  if (!normalized) {
    delete technology.referenceToTechnicalSpecification;
    fixes.push('remove_invalid_reference_to_technical_specification');
    return;
  }
  if (JSON.stringify(technology.referenceToTechnicalSpecification) !== JSON.stringify(normalized)) {
    technology.referenceToTechnicalSpecification = normalized;
    fixes.push('normalize_reference_to_technical_specification');
  }
}

function update_permanent_dataset_uri(uriValue: unknown, targetVersion: string): unknown {
  const uri = coerceText(uriValue);
  if (!uri) {
    return uriValue;
  }
  if (VERSION_QUERY_RE.test(uri)) {
    return uri.replace(VERSION_QUERY_RE, `$1${targetVersion}`);
  }
  return uriValue;
}

function parse_validation_error(error: unknown): FlowValidationIssue[] {
  if (isRecord(error) && Array.isArray(error.issues)) {
    const issues = error.issues.filter(isRecord).map((issue) => {
      const pathValue = Array.isArray(issue.path)
        ? issue.path.map((part) => String(part)).join('.')
        : '<exception>';
      return {
        validator: 'tidas_sdk' as const,
        path: pathValue || '<exception>',
        message: coerceText(issue.message) || String(error),
        code: coerceText(issue.code) || 'validation_error',
      };
    });
    if (issues.length) {
      return issues;
    }
  }

  return [
    {
      validator: 'tidas_sdk',
      path: '<exception>',
      message: String(error),
      code: 'exception',
    },
  ];
}

function validate_flow_payload(
  payload: JsonRecord,
  deps: FlowRemediationDeps,
): FlowValidationResult {
  const sdkModule = (deps.loadSdkModule ?? resolve_local_sdk_module)();
  if (typeof sdkModule.createFlow !== 'function') {
    throw new CliError('Resolved tidas-sdk core module does not expose createFlow.', {
      code: 'FLOW_REMEDIATE_SDK_INVALID',
      exitCode: 2,
      details: sdkModule.location ?? null,
    });
  }

  try {
    const result = validateEntityWithDeepFallback(payload, sdkModule.createFlow);
    if (!result) {
      throw new CliError(
        'Resolved tidas-sdk flow entity does not expose validateEnhanced() or validate().',
        {
          code: 'FLOW_REMEDIATE_SDK_INVALID',
          exitCode: 2,
          details: sdkModule.location ?? null,
        },
      );
    }
    if (isRecord(result) && result.success === true) {
      return { success: true };
    }
    return {
      success: false,
      issues: parse_validation_error(isRecord(result) ? result.error : result),
    };
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    return {
      success: false,
      issues: parse_validation_error(error),
    };
  }
}

function remediate_row(row: JsonRecord, deps: FlowRemediationDeps): FlowRemediationRowResult {
  const working = JSON.parse(JSON.stringify(row)) as JsonRecord;
  const payload = isRecord(working.json_ordered) ? working.json_ordered : null;
  const flowDataSet = isRecord(payload?.flowDataSet) ? payload.flowDataSet : null;

  if (!payload || !flowDataSet) {
    return {
      row: working,
      valid: false,
      appliedFixes: [],
      finalReasons: [
        {
          validator: 'tidas_sdk',
          path: 'json_ordered.flowDataSet',
          message: 'Missing flowDataSet payload',
          code: 'missing_flow_dataset',
        },
      ],
      versionBefore: '',
      versionAfter: '',
    };
  }

  const fixes: string[] = [];
  const residualUnresolved: FlowValidationIssue[] = [];
  const flowInformation = isRecord(flowDataSet.flowInformation) ? flowDataSet.flowInformation : {};
  flowDataSet.flowInformation = flowInformation;
  const dataSetInformation = isRecord(flowInformation.dataSetInformation)
    ? flowInformation.dataSetInformation
    : {};
  flowInformation.dataSetInformation = dataSetInformation;

  normalize_name_block(dataSetInformation, fixes);
  for (const key of [
    'common:synonyms',
    'common:generalComment',
    'common:shortDescription',
    'common:name',
    'common:shortName',
  ]) {
    normalize_multilang_field(dataSetInformation, key, fixes);
  }
  if (isRecord(dataSetInformation['common:other'])) {
    delete dataSetInformation['common:other'];
    fixes.push('remove_common_other_object');
  }
  if (dataSetInformation.CASNumber === '') {
    delete dataSetInformation.CASNumber;
    fixes.push('remove_empty_cas_number');
  }

  const administrativeInformation = isRecord(flowDataSet.administrativeInformation)
    ? flowDataSet.administrativeInformation
    : {};
  flowDataSet.administrativeInformation = administrativeInformation;
  const dataEntryBy = isRecord(administrativeInformation.dataEntryBy)
    ? administrativeInformation.dataEntryBy
    : {};
  administrativeInformation.dataEntryBy = dataEntryBy;
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  administrativeInformation.publicationAndOwnership = publicationAndOwnership;

  const formatReference = build_dataset_format_reference();
  if (
    JSON.stringify(dataEntryBy['common:referenceToDataSetFormat']) !==
    JSON.stringify(formatReference)
  ) {
    dataEntryBy['common:referenceToDataSetFormat'] = formatReference;
    fixes.push('set_reference_to_dataset_format');
  }

  const contactReference = canonical_contact_reference();
  if (
    JSON.stringify(dataEntryBy['common:referenceToPersonOrEntityEnteringTheData']) !==
    JSON.stringify(contactReference)
  ) {
    dataEntryBy['common:referenceToPersonOrEntityEnteringTheData'] = contactReference;
    fixes.push('set_reference_to_person_or_entity_entering_the_data');
  }
  if (
    JSON.stringify(publicationAndOwnership['common:referenceToOwnershipOfDataSet']) !==
    JSON.stringify(contactReference)
  ) {
    publicationAndOwnership['common:referenceToOwnershipOfDataSet'] = contactReference;
    fixes.push('set_reference_to_ownership_of_dataset');
  }

  const modellingAndValidation = isRecord(flowDataSet.modellingAndValidation)
    ? flowDataSet.modellingAndValidation
    : {};
  flowDataSet.modellingAndValidation = modellingAndValidation;
  const complianceDeclarations = isRecord(modellingAndValidation.complianceDeclarations)
    ? modellingAndValidation.complianceDeclarations
    : {};
  modellingAndValidation.complianceDeclarations = complianceDeclarations;
  const complianceBlock = canonical_compliance_block();
  if (JSON.stringify(complianceDeclarations.compliance) !== JSON.stringify(complianceBlock)) {
    complianceDeclarations.compliance = complianceBlock;
    fixes.push('set_compliance_block');
  }

  const flowProperties = normalize_flow_properties(flowDataSet, fixes);
  residualUnresolved.push(...flowProperties.unresolved);
  normalize_quantitative_reference(flowDataSet, flowProperties.items, fixes, residualUnresolved);
  residualUnresolved.push(
    ...inspectFlowProperties(flowDataSet).issues.map((issue) => ({
      validator: 'flow_property_contract' as const,
      path: `flowDataSet.${issue.path}`,
      message: issue.message,
      code: issue.code,
    })),
  );
  normalize_technology_multilang_fields(flowDataSet, fixes);
  normalize_technical_specification(flowDataSet, fixes);

  const flowUuid =
    coerceText(dataSetInformation['common:UUID']) || coerceText(working.id) || 'unknown-flow';
  if (!coerceText(publicationAndOwnership['common:dataSetVersion'])) {
    publicationAndOwnership['common:dataSetVersion'] = '01.01.000';
  }

  const versionBefore = coerceText(publicationAndOwnership['common:dataSetVersion']);
  let versionAfter = versionBefore;
  const stateCode = Number.parseInt(coerceText(working.state_code) || '0', 10) || 0;

  if (stateCode === 100) {
    versionAfter = bump_ilcd_version(versionBefore);
    if (versionAfter !== versionBefore) {
      publicationAndOwnership['common:dataSetVersion'] = versionAfter;
      fixes.push('bump_dataset_version');
      publicationAndOwnership['common:referenceToPrecedingDataSetVersion'] = {
        '@type': 'flow data set',
        '@refObjectId': flowUuid,
        '@uri': build_local_dataset_uri('flow data set', flowUuid, versionBefore),
        '@version': versionBefore,
        'common:shortDescription': [
          {
            '@xml:lang': 'en',
            '#text': first_text(deepGet(dataSetInformation, ['name', 'baseName']), flowUuid),
          },
        ],
      };
      fixes.push('set_reference_to_preceding_dataset_version');
      const permanentUri = update_permanent_dataset_uri(
        publicationAndOwnership['common:permanentDataSetURI'],
        versionAfter,
      );
      if (permanentUri !== publicationAndOwnership['common:permanentDataSetURI']) {
        publicationAndOwnership['common:permanentDataSetURI'] = permanentUri;
        fixes.push('update_permanent_dataset_uri_version');
      }
      if ('version' in working) {
        working.version = versionAfter;
      }
    }
  } else if (
    isRecord(publicationAndOwnership['common:referenceToPrecedingDataSetVersion']) &&
    !Object.keys(publicationAndOwnership['common:referenceToPrecedingDataSetVersion'] as JsonRecord)
      .length
  ) {
    delete publicationAndOwnership['common:referenceToPrecedingDataSetVersion'];
    fixes.push('remove_empty_reference_to_preceding_dataset_version');
  }

  const validation = validate_flow_payload(payload, deps);
  const finalReasons =
    validation.success === true
      ? residualUnresolved
      : [...residualUnresolved, ...validation.issues];

  working.json_ordered = payload;
  working.reason = finalReasons;

  return {
    row: working,
    valid: finalReasons.length === 0,
    appliedFixes: fixes,
    finalReasons,
    versionBefore,
    versionAfter,
  };
}

function build_prompt(manualRows: JsonRecord[], manualFile: string, promptFile: string): string {
  if (!manualRows.length) {
    return `本轮 deterministic remediation 之后，residual manual queue 为 0。

输入文件：
\`${manualFile}\`

结果：
1. 当前没有需要再交给 OpenClaw 手工修复的 flow。
2. 可直接对 ready-for-MCP 文件执行后续批量处理。
3. 如果后续换了新的输入批次，再重新生成 residual manual queue prompt。
`;
  }

  const queueIds = manualRows
    .map((row) => coerceText(row.id))
    .filter((value) => value.length > 0)
    .map((value) => `- \`${value}\``)
    .join('\n');
  const outputFile = path.join(
    path.dirname(promptFile),
    `${LEGACY_OUTPUT_PREFIX}_residual_manual_fixed.jsonl`,
  );
  const stillInvalidFile = path.join(
    path.dirname(promptFile),
    `${LEGACY_OUTPUT_PREFIX}_residual_manual_still_invalid.jsonl`,
  );

  return `你现在要处理 residual manual queue 中 deterministic remediator 之后仍未通过 tidas-sdk 本地校验的 flow。

输入文件：
\`${manualFile}\`

输出文件：
\`${outputFile}\`

执行要求：
1. 只修改每条记录里的 json_ordered.flowDataSet，保留外层 envelope key：id、user_id、json_ordered、reason、state_code。
2. 保持相同 UUID，不要改 id。
3. state_code=0 的 flow 保持当前 common:dataSetVersion 不变。
4. state_code=100 的 flow 已经完成 deterministic version bump，并已补 common:referenceToPrecedingDataSetVersion；除非绝对必要，不要再次 bump version。
5. 优先补齐合法的 flowProperties.flowProperty 和 flowInformation.quantitativeReference.referenceToReferenceFlowProperty，让数据先通过本地 TIDAS SDK 校验。
6. 不要无故重写 classification、命名、comment；如果必须改，改动最小，并在结果里保留必要说明。
7. 每条输出仍按一行一个 JSON object 的 JSONL 形式写入。
8. 修复成功的行把 reason 置为 []；如果仍无法修复，单独另存并写明残留原因。

当前 residual manual queue 共 ${manualRows.length} 条：
${queueIds || '- None'}

建议步骤：
1. 逐条读取 reason 和 json_ordered.flowDataSet。
2. 先判断缺失的是 flowProperties 本体，还是只有 quantitative reference 丢失。
3. 能从现有 classificationInformation、baseName、flow type、name.flowProperties 推断合法 flow property 的，补成最小合法块。
4. 每改完一条都本地验证一次 TIDAS SDK。
5. 把通过校验的 patched row 写到 \`${outputFile}\`。

如果你还要保留未解决项，另写一个旁路文件：
\`${stillInvalidFile}\`
`;
}

export async function runFlowRemediate(
  options: RunFlowRemediateOptions,
  deps: FlowRemediationDeps = {},
): Promise<FlowRemediationReport> {
  const inputFile = assert_input_file(options.inputFile);
  const outDir = assert_out_dir(options.outDir);
  const rows = loadRowsFromFile(inputFile);
  const files = build_output_files(outDir);
  const now = deps.now ?? (() => new Date());

  const remediatedRows: JsonRecord[] = [];
  const validRows: JsonRecord[] = [];
  const manualRows: JsonRecord[] = [];
  const auditRows: FlowRemediationAuditRow[] = [];
  const appliedFixCounts: Record<string, number> = {};

  for (const row of rows) {
    const result = remediate_row(row, deps);
    remediatedRows.push(result.row);
    if (result.valid) {
      validRows.push(result.row);
    } else {
      manualRows.push(result.row);
    }

    result.appliedFixes.forEach((fix) => {
      appliedFixCounts[fix] = (appliedFixCounts[fix] ?? 0) + 1;
    });

    auditRows.push({
      id: row.id,
      user_id: row.user_id,
      state_code: row.state_code,
      version_before: result.versionBefore,
      version_after: result.versionAfter,
      valid_after_remediation: result.valid,
      applied_fixes: result.appliedFixes,
      original_reason: Array.isArray(row.reason) ? row.reason : [],
      final_reason: result.finalReasons,
    });
  }

  writeJsonLinesArtifact(files.allRemediated, remediatedRows);
  writeJsonLinesArtifact(files.readyForMcp, validRows);
  writeJsonLinesArtifact(files.residualManualQueue, manualRows);
  writeJsonLinesArtifact(files.audit, auditRows);
  writeTextArtifact(
    files.prompt,
    build_prompt(manualRows, files.residualManualQueue, files.prompt),
  );

  const report: FlowRemediationReport = {
    schema_version: 1,
    generated_at_utc: now().toISOString(),
    status: 'completed_local_flow_remediation',
    input_file: inputFile,
    out_dir: outDir,
    counts: {
      input_rows: rows.length,
      state_code_0_rows: rows.filter(
        (row) => Number.parseInt(coerceText(row.state_code) || '0', 10) === 0,
      ).length,
      state_code_100_rows: rows.filter(
        (row) => Number.parseInt(coerceText(row.state_code) || '0', 10) === 100,
      ).length,
      remediated_rows: remediatedRows.length,
      ready_for_mcp_rows: validRows.length,
      residual_manual_rows: manualRows.length,
    },
    applied_fix_counts: Object.fromEntries(
      Object.entries(appliedFixCounts).sort(([left], [right]) => left.localeCompare(right)),
    ),
    residual_manual_ids: manualRows
      .map((row) => coerceText(row.id))
      .filter((value) => value.length > 0),
    validation_backend: 'tidas_sdk',
    files: {
      all_remediated: files.allRemediated,
      ready_for_mcp: files.readyForMcp,
      residual_manual_queue: files.residualManualQueue,
      audit: files.audit,
      prompt: files.prompt,
      report: files.report,
    },
  };

  writeJsonArtifact(files.report, report);
  return report;
}

export const __testInternals = {
  assert_input_file,
  assert_out_dir,
  build_dataset_format_reference,
  build_flow_property_item,
  build_output_files,
  build_prompt,
  build_local_dataset_uri,
  bump_ilcd_version,
  canonical_compliance_block,
  canonical_contact_reference,
  infer_flow_property_descriptor_from_hint,
  normalize_flow_properties,
  normalize_multilang_entries,
  normalize_multilang_field,
  normalize_name_block,
  normalize_quantitative_reference,
  normalize_reference_block,
  parse_validation_error,
  remediate_row,
  resolve_sdk_module_from_candidates,
  update_permanent_dataset_uri,
  validate_flow_payload,
  version_from_uri,
};
import { inspectFlowProperties } from './flow-property-contract.js';
