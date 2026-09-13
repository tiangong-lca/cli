import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeAssetDir } from '@tiangong-lca/tidas-sdk/tools';
import { writeJsonArtifact, writeJsonLinesArtifact } from './artifacts.js';
import {
  cloneJson,
  firstNonEmpty,
  isRecord,
  readDatasetRowsInput,
  trimToken,
  unwrapDatasetPayload,
  type JsonObject,
} from './dataset-local.js';
import { CliError } from './errors.js';
import { readJsonInput } from './io.js';

export type DatasetClassificationType =
  | 'contact'
  | 'flow-elementary'
  | 'flow-product'
  | 'flowproperty'
  | 'lciamethod'
  | 'location'
  | 'process'
  | 'source'
  | 'unitgroup';

type ClassificationValueKey = '@catId' | '@classId' | '@code';

export type ClassificationEntry = {
  level: number;
  code: string;
  text: string;
  value_key: ClassificationValueKey;
};

export type ClassificationPathEntry = {
  '@level': string;
  '@classId'?: string;
  '@catId'?: string;
  '@code'?: string;
  '#text': string;
};

export type DatasetClassificationChildrenReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed' | 'blocked';
  command: 'dataset classification children';
  category_type: DatasetClassificationType;
  schema_file: string;
  parent_code: string | null;
  query: string | null;
  counts: {
    children: number;
    returned: number;
  };
  children: Array<ClassificationEntry & { path: ClassificationPathEntry[] }>;
  blockers: Array<{ code: string; message: string }>;
  files?: {
    report: string;
  };
};

export type DatasetClassificationPathReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed' | 'blocked';
  command: 'dataset classification path';
  category_type: DatasetClassificationType;
  schema_file: string;
  code: string;
  path: ClassificationPathEntry[];
  blockers: Array<{ code: string; message: string }>;
  files?: {
    report: string;
  };
};

export type DatasetClassificationApplyReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed' | 'blocked';
  command: 'dataset classification apply';
  input_path: string;
  decisions_path: string;
  out_path: string;
  default_category_type: DatasetClassificationType | null;
  counts: {
    rows: number;
    decisions: number;
    applied: number;
    blockers: number;
  };
  blockers: DatasetClassificationBlocker[];
  files: {
    classified_rows: string;
    evidence: string;
    report: string;
  };
};

export type DatasetClassificationAuditFinding = {
  row_index: number;
  dataset_id: string | null;
  dataset_version: string | null;
  path: string;
  value: string;
  status: 'valid' | 'invalid';
  description: string | null;
};

export type DatasetClassificationAuditReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed' | 'blocked';
  command: 'dataset classification audit';
  category_type: DatasetClassificationType;
  schema_file: string;
  input_path: string;
  counts: {
    rows: number;
    location_targets: number;
    valid: number;
    invalid: number;
  };
  findings: DatasetClassificationAuditFinding[];
  blockers: DatasetClassificationBlocker[];
  files?: {
    findings: string;
    report: string;
  };
};

export type DatasetClassificationBlocker = {
  code: string;
  message: string;
  decision_index?: number;
  row_index?: number;
  dataset_id?: string | null;
  dataset_version?: string | null;
};

export type RunDatasetClassificationChildrenOptions = {
  type: string;
  parent?: string | null;
  query?: string | null;
  limit?: number | null;
  outDir?: string | null;
  now?: Date;
};

export type RunDatasetClassificationPathOptions = {
  type: string;
  code: string;
  outDir?: string | null;
  now?: Date;
};

export type RunDatasetClassificationAuditOptions = {
  inputPath: string;
  type: string;
  outDir?: string | null;
  rawInput?: unknown;
  now?: Date;
};

export type RunDatasetClassificationApplyOptions = {
  inputPath: string;
  decisionsPath: string;
  outPath: string;
  type?: string | null;
  outDir?: string | null;
  rawInput?: unknown;
  rawDecisions?: unknown;
  now?: Date;
};

type CategoryConfig = {
  type: DatasetClassificationType;
  schemaFile: string;
  defaultValueKey: ClassificationValueKey;
  target: 'common:category' | 'common:class' | 'location';
};

type ClassificationNavigator = {
  entries: ClassificationEntry[];
  entriesByCode: Map<string, ClassificationEntry>;
  childMap: Map<string, ClassificationEntry[]>;
  parentMap: Map<string, ClassificationEntry | null>;
};

type NormalizedDecision = {
  decisionIndex: number;
  rowIndex: number | null;
  datasetId: string | null;
  datasetVersion: string | null;
  categoryType: DatasetClassificationType;
  path: ClassificationPathEntry[];
  targetPath: string | null;
  basis: string | null;
  evidence: unknown;
};

type LocationTarget = {
  path: string;
  parentPath: string;
  parent: JsonObject;
  key: string;
  value: string;
};

type PreparedClassificationRow = {
  index: number;
  row: JsonObject;
  payload: JsonObject;
  rootKey: string | null;
  informationKey: string | null;
  id: string | null;
  version: string | null;
};

const CATEGORY_CONFIGS: Record<DatasetClassificationType, CategoryConfig> = {
  contact: {
    type: 'contact',
    schemaFile: 'tidas_contacts_category.json',
    defaultValueKey: '@classId',
    target: 'common:class',
  },
  'flow-elementary': {
    type: 'flow-elementary',
    schemaFile: 'tidas_flows_elementary_category.json',
    defaultValueKey: '@catId',
    target: 'common:category',
  },
  'flow-product': {
    type: 'flow-product',
    schemaFile: 'tidas_flows_product_category.json',
    defaultValueKey: '@classId',
    target: 'common:class',
  },
  flowproperty: {
    type: 'flowproperty',
    schemaFile: 'tidas_flowproperties_category.json',
    defaultValueKey: '@classId',
    target: 'common:class',
  },
  lciamethod: {
    type: 'lciamethod',
    schemaFile: 'tidas_lciamethods_category.json',
    defaultValueKey: '@classId',
    target: 'common:class',
  },
  location: {
    type: 'location',
    schemaFile: 'tidas_locations_category.json',
    defaultValueKey: '@code',
    target: 'location',
  },
  process: {
    type: 'process',
    schemaFile: 'tidas_processes_category.json',
    defaultValueKey: '@classId',
    target: 'common:class',
  },
  source: {
    type: 'source',
    schemaFile: 'tidas_sources_category.json',
    defaultValueKey: '@classId',
    target: 'common:class',
  },
  unitgroup: {
    type: 'unitgroup',
    schemaFile: 'tidas_unitgroups_category.json',
    defaultValueKey: '@classId',
    target: 'common:class',
  },
};

const DATASET_ROOTS = [
  { rootKey: 'contactDataSet', informationKey: 'contactInformation', type: 'contact' },
  { rootKey: 'flowDataSet', informationKey: 'flowInformation', type: 'flow-product' },
  {
    rootKey: 'flowPropertyDataSet',
    informationKey: 'flowPropertiesInformation',
    type: 'flowproperty',
  },
  { rootKey: 'LCIAMethodDataSet', informationKey: 'LCIAMethodInformation', type: 'lciamethod' },
  {
    rootKey: 'lifeCycleModelDataSet',
    informationKey: 'lifeCycleModelInformation',
    type: 'lifecyclemodel',
  },
  { rootKey: 'processDataSet', informationKey: 'processInformation', type: 'process' },
  { rootKey: 'sourceDataSet', informationKey: 'sourceInformation', type: 'source' },
  { rootKey: 'unitGroupDataSet', informationKey: 'unitGroupInformation', type: 'unitgroup' },
] as const;

const TYPE_ALIASES: Record<string, DatasetClassificationType> = {
  contact: 'contact',
  contacts: 'contact',
  elementary: 'flow-elementary',
  elementaryflow: 'flow-elementary',
  elementaryflows: 'flow-elementary',
  'elementary-flow': 'flow-elementary',
  'elementary-flows': 'flow-elementary',
  flowelementary: 'flow-elementary',
  'flow-elementary': 'flow-elementary',
  flowproduct: 'flow-product',
  flowproducts: 'flow-product',
  'flow-product': 'flow-product',
  'flow-products': 'flow-product',
  flows: 'flow-product',
  product: 'flow-product',
  productflow: 'flow-product',
  productflows: 'flow-product',
  'product-flow': 'flow-product',
  'product-flows': 'flow-product',
  flowproperties: 'flowproperty',
  flowproperty: 'flowproperty',
  lcia: 'lciamethod',
  lciamethod: 'lciamethod',
  lciamethods: 'lciamethod',
  location: 'location',
  locations: 'location',
  process: 'process',
  processes: 'process',
  source: 'source',
  sources: 'source',
  unitgroup: 'unitgroup',
  unitgroups: 'unitgroup',
};

function normalizeType(value: unknown): DatasetClassificationType {
  const token = trimToken(value)
    ?.toLowerCase()
    .replace(/[_\s]+/gu, '-');
  const normalized = token ? (TYPE_ALIASES[token] ?? TYPE_ALIASES[token.replace(/-/gu, '')]) : null;
  if (!normalized) {
    throw new CliError(`Unsupported classification type: ${String(value ?? '')}`, {
      code: 'CLASSIFICATION_TYPE_UNSUPPORTED',
      exitCode: 2,
    });
  }
  return normalized;
}

function schemasDir(candidatesOverride?: string[]): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = candidatesOverride ?? [
    path.resolve(here, '../../assets/tidas-schemas'),
    path.resolve(here, '../../../assets/tidas-schemas'),
    path.resolve(process.cwd(), 'assets/tidas-schemas'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new CliError('Bundled TIDAS schemas were not found under assets/tidas-schemas.', {
      code: 'TIDAS_SCHEMAS_NOT_FOUND',
      exitCode: 2,
    });
  }
  return found;
}

function schemaPath(
  config: CategoryConfig,
  resolveTidasAssets: () => string = () => resolveRuntimeAssetDir('tidas'),
): string {
  try {
    const schema = path.join(resolveTidasAssets(), 'schemas', config.schemaFile);
    if (existsSync(schema)) return schema;
  } catch {
    // A missing SDK catalog must not fall back to a different local snapshot.
  }
  throw new CliError(`TIDAS SDK classification schema ${config.schemaFile} is unavailable.`, {
    code: 'TIDAS_CLASSIFICATION_SDK_SCHEMA_UNAVAILABLE',
    exitCode: 2,
    details: { category_type: config.type, schema_file: config.schemaFile },
  });
}

const FALLBACK_LOCATION_TARGET_KEYS = new Set([
  '@location',
  '@subLocation',
  'impactLocation',
  'impactSubLocation',
  'interventionLocation',
  'interventionSubLocation',
  'intervensionSubLocation',
  'location',
  'locationOfSupply',
  'subLocation',
]);
let cachedLocationTargetKeys: Set<string> | null = null;

function lastSchemaPropertyName(schemaPathSegments: string[]): string | null {
  let propertyName: string | null = null;
  for (let index = 0; index < schemaPathSegments.length - 1; index += 1) {
    if (schemaPathSegments[index] === 'properties') {
      propertyName = schemaPathSegments[index + 1]!;
    }
  }
  return propertyName;
}

function collectLocationRefKeysFromSchema(
  value: unknown,
  schemaPathSegments: string[],
  keys: Set<string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectLocationRefKeysFromSchema(item, [...schemaPathSegments, String(index)], keys),
    );
    return;
  }
  if (!isRecord(value)) return;

  if (value.$ref === 'tidas_locations_category.json') {
    const propertyName = lastSchemaPropertyName(schemaPathSegments);
    if (propertyName) keys.add(propertyName);
  }
  for (const [key, child] of Object.entries(value)) {
    collectLocationRefKeysFromSchema(child, [...schemaPathSegments, key], keys);
  }
}

function locationTargetKeys(): Set<string> {
  if (cachedLocationTargetKeys) return cachedLocationTargetKeys;
  const keys = new Set<string>();
  const dir = schemasDir();
  for (const fileName of readdirSync(dir).filter(isJsonSchemaFileName)) {
    const document = JSON.parse(readFileSync(path.join(dir, fileName), 'utf8')) as unknown;
    collectLocationRefKeysFromSchema(document, [], keys);
  }
  cachedLocationTargetKeys = new Set([...FALLBACK_LOCATION_TARGET_KEYS, ...keys]);
  return cachedLocationTargetKeys;
}

function isJsonSchemaFileName(fileName: string): boolean {
  return fileName.endsWith('.json');
}

function constText(value: unknown): string | null {
  return isRecord(value) ? firstNonEmpty(value.const) : null;
}

function collectEntriesFromNode(
  node: unknown,
  defaultValueKey: ClassificationValueKey,
  entries: ClassificationEntry[],
): void {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectEntriesFromNode(entry, defaultValueKey, entries));
    return;
  }
  if (!isRecord(node)) return;

  if (isRecord(node.properties)) {
    const properties = node.properties;
    const level = firstNonEmpty(constText(properties['@level']), '0');
    const valueKey =
      (['@classId', '@catId', '@code'] as const).find((key) => constText(properties[key])) ??
      defaultValueKey;
    const code = constText(properties[valueKey]);
    const text = constText(properties['#text']);
    if (level && code && text) {
      const parsedLevel = Number(level);
      if (Number.isInteger(parsedLevel)) {
        entries.push({ level: parsedLevel, code, text, value_key: valueKey });
      }
    }
  } else if (node.const !== undefined && typeof node.description === 'string') {
    entries.push({
      level: 0,
      code: String(node.const),
      text: node.description,
      value_key: '@code',
    });
  }

  for (const value of Object.values(node)) {
    if (isRecord(value) || Array.isArray(value)) {
      collectEntriesFromNode(value, defaultValueKey, entries);
    }
  }
}

function loadEntries(type: DatasetClassificationType): {
  config: CategoryConfig;
  schema: string;
  entries: ClassificationEntry[];
} {
  const config = CATEGORY_CONFIGS[type];
  const schema = schemaPath(config);
  const document = JSON.parse(readFileSync(schema, 'utf8')) as unknown;
  const entries: ClassificationEntry[] = [];
  collectEntriesFromNode(document, config.defaultValueKey, entries);
  return { config, schema, entries: orderCatalogEntries(type, entries) };
}

function orderCatalogEntries(
  type: DatasetClassificationType,
  entries: ClassificationEntry[],
): ClassificationEntry[] {
  // SDK JSON-schema oneOf members need not be in tree order. Elementary IDs
  // encode their ancestry, including categories appended to the SDK catalog.
  return type === 'flow-elementary'
    ? [...entries].sort((left, right) =>
        left.code.localeCompare(right.code, 'en', { numeric: true }),
      )
    : entries;
}

function buildNavigator(entries: ClassificationEntry[]): ClassificationNavigator {
  const childMap = new Map<string, ClassificationEntry[]>();
  const parentMap = new Map<string, ClassificationEntry | null>();
  const entriesByCode = new Map<string, ClassificationEntry>();
  const lastPerLevel = new Map<number, ClassificationEntry>();

  for (const entry of entries) {
    entriesByCode.set(entry.code, entry);
    if (entry.level === 0) {
      const roots = childMap.get('') ?? [];
      roots.push(entry);
      childMap.set('', roots);
      parentMap.set(entry.code, null);
    } else {
      let parent: ClassificationEntry | null = null;
      for (let level = entry.level - 1; level >= 0; level -= 1) {
        parent = lastPerLevel.get(level) ?? null;
        if (parent) break;
      }
      if (parent) {
        const children = childMap.get(parent.code) ?? [];
        children.push(entry);
        childMap.set(parent.code, children);
        parentMap.set(entry.code, parent);
      }
    }
    lastPerLevel.set(entry.level, entry);
  }
  return { entries, entriesByCode, childMap, parentMap };
}

function navigatorFor(type: DatasetClassificationType): {
  config: CategoryConfig;
  schema: string;
  navigator: ClassificationNavigator;
} {
  const { config, schema, entries } = loadEntries(type);
  return { config, schema, navigator: buildNavigator(entries) };
}

function pathForCode(navigator: ClassificationNavigator, code: string): ClassificationEntry[] {
  const entry = navigator.entriesByCode.get(code);
  if (!entry) return [];
  const pathEntries = [entry];
  let current = entry;
  while (true) {
    const parent = navigator.parentMap.get(current.code);
    if (!parent) break;
    pathEntries.push(parent);
    current = parent;
  }
  return pathEntries.reverse();
}

function toPathEntry(entry: ClassificationEntry): ClassificationPathEntry {
  return {
    '@level': String(entry.level),
    [entry.value_key]: entry.code,
    '#text': entry.text,
  } as ClassificationPathEntry;
}

function normalizedClassificationLabel(value: unknown): string | null {
  const token = firstNonEmpty(value);
  return token
    ? token.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US')
    : null;
}

function classificationPathError(
  code: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new CliError(message, {
    code,
    exitCode: 2,
    details,
  });
}

/**
 * Resolve one complete classification path against the bundled TIDAS catalog.
 *
 * Plain labels are accepted only when the complete root-to-node path resolves
 * uniquely. Explicit class/category objects are canonicalized only after every
 * code, level, label, and parent edge matches the catalog. No identifier is
 * synthesized here.
 */
export function resolveTidasClassificationPath(
  typeValue: DatasetClassificationType,
  rawPath: unknown,
): ClassificationPathEntry[] {
  const type = normalizeType(typeValue);
  return resolveClassificationPathAgainstCatalog(type, rawPath, navigatorFor(type));
}

function resolveClassificationPathAgainstCatalog(
  type: DatasetClassificationType,
  rawPath: unknown,
  catalog: { config: CategoryConfig; navigator: ClassificationNavigator },
): ClassificationPathEntry[] {
  const { config, navigator } = catalog;
  if (!Array.isArray(rawPath) || rawPath.length === 0) {
    classificationPathError(
      'TIDAS_CLASSIFICATION_PATH_REQUIRED',
      `A complete ${type} classification path from the bundled TIDAS catalog is required.`,
      { category_type: type, schema_file: config.schemaFile },
    );
  }

  const entries = rawPath as unknown[];
  const allLabels = entries.every((entry) => typeof entry === 'string');
  const allObjects = entries.every(isRecord);
  if (!allLabels && !allObjects) {
    classificationPathError(
      'TIDAS_CLASSIFICATION_PATH_MIXED',
      'Classification path entries must be either all catalog labels or all explicit catalog objects.',
      { category_type: type, schema_file: config.schemaFile },
    );
  }

  if (allLabels) {
    const labels = entries.map(normalizedClassificationLabel);
    if (labels.some((label) => !label)) {
      classificationPathError(
        'TIDAS_CLASSIFICATION_PATH_LABEL_INVALID',
        'Classification path labels must be non-empty strings.',
        { category_type: type, schema_file: config.schemaFile },
      );
    }
    const matches = navigator.entries
      .filter((entry) => entry.level === labels.length - 1)
      .map((entry) => pathForCode(navigator, entry.code))
      .filter(
        (candidate) =>
          candidate.length === labels.length &&
          candidate.every(
            (entry, index) => normalizedClassificationLabel(entry.text) === labels[index],
          ),
      );
    if (matches.length === 0) {
      classificationPathError(
        'TIDAS_CLASSIFICATION_PATH_UNKNOWN',
        `Classification labels do not resolve to a ${type} path in the bundled TIDAS catalog.`,
        {
          category_type: type,
          schema_file: config.schemaFile,
          labels: entries,
        },
      );
    }
    if (matches.length > 1) {
      classificationPathError(
        'TIDAS_CLASSIFICATION_PATH_AMBIGUOUS',
        `Classification labels resolve to more than one ${type} path; provide explicit catalog IDs.`,
        {
          category_type: type,
          schema_file: config.schemaFile,
          labels: entries,
          matching_leaf_codes: matches.map((match) => match.at(-1)!.code),
        },
      );
    }
    return (matches[0] as ClassificationEntry[]).map(toPathEntry);
  }

  const objects = entries as JsonObject[];
  const codes = objects.map(classCode);
  if (codes.some((code) => !code)) {
    classificationPathError(
      'TIDAS_CLASSIFICATION_ID_REQUIRED',
      'Every explicit classification path entry must contain its TIDAS catalog ID.',
      { category_type: type, schema_file: config.schemaFile },
    );
  }
  const canonical = pathForCode(navigator, codes.at(-1) as string);
  const canonicalCodes = canonical.map((entry) => entry.code);
  if (
    canonical.length !== objects.length ||
    canonicalCodes.some((code, index) => code !== codes[index])
  ) {
    classificationPathError(
      'TIDAS_CLASSIFICATION_PATH_INVALID',
      'Explicit classification IDs are unknown or do not form one complete catalog path.',
      {
        category_type: type,
        schema_file: config.schemaFile,
        provided_codes: codes,
        canonical_codes: canonicalCodes,
      },
    );
  }
  canonical.forEach((entry, index) => {
    const supplied = objects[index] as JsonObject;
    const suppliedLevel = firstNonEmpty(supplied['@level']);
    const suppliedLabel = normalizedClassificationLabel(supplied['#text']);
    if (suppliedLevel !== null && suppliedLevel !== String(entry.level)) {
      classificationPathError(
        'TIDAS_CLASSIFICATION_LEVEL_MISMATCH',
        `Classification level for code ${entry.code} does not match the catalog.`,
        {
          category_type: type,
          code: entry.code,
          expected_level: String(entry.level),
          supplied_level: suppliedLevel,
        },
      );
    }
    if (suppliedLabel !== null && suppliedLabel !== normalizedClassificationLabel(entry.text)) {
      classificationPathError(
        'TIDAS_CLASSIFICATION_LABEL_MISMATCH',
        `Classification label for code ${entry.code} does not match the catalog.`,
        {
          category_type: type,
          code: entry.code,
          expected_label: entry.text,
          supplied_label: supplied['#text'],
        },
      );
    }
  });
  return canonical.map(toPathEntry);
}

function classCode(value: unknown): string | null {
  return isRecord(value)
    ? firstNonEmpty(
        value['@classId'],
        value['@catId'],
        value['@code'],
        value.class_id,
        value.classId,
        value.cat_id,
        value.catId,
        value.code,
      )
    : null;
}

function pathExpression(pathSegments: Array<string | number>): string {
  return pathSegments.map(String).join('.');
}

function normalizeTargetPath(value: unknown): string | null {
  const raw = firstNonEmpty(value);
  if (!raw) return null;
  if (raw.startsWith('/')) {
    return raw
      .split('/')
      .slice(1)
      .map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'))
      .join('.');
  }
  return raw;
}

function decisionTargetPath(decision: JsonObject): string | null {
  return normalizeTargetPath(
    decision.target_path ??
      decision.targetPath ??
      decision.field_path ??
      decision.fieldPath ??
      decision.location_path ??
      decision.locationPath ??
      decision.json_pointer ??
      decision.jsonPointer,
  );
}

function normalizePathFromClasses(
  type: DatasetClassificationType,
  classes: unknown,
): ClassificationPathEntry[] {
  const { navigator } = navigatorFor(type);
  const rawClasses = Array.isArray(classes) ? classes : isRecord(classes) ? [classes] : [];
  if (rawClasses.length === 0) return [];
  const leafCode = classCode(rawClasses[rawClasses.length - 1]);
  if (!leafCode) return [];
  const canonical = pathForCode(navigator, leafCode);
  const rawCodes = rawClasses.map(classCode).filter(Boolean);
  const canonicalCodes = canonical.map((entry) => entry.code);
  if (
    rawCodes.length > 0 &&
    rawCodes.join('/') !== canonicalCodes.slice(0, rawCodes.length).join('/')
  ) {
    return [];
  }
  return canonical.map(toPathEntry);
}

function normalizePathFromDecision(
  type: DatasetClassificationType,
  decision: JsonObject,
): ClassificationPathEntry[] {
  const explicit =
    decision.classes ??
    decision.classification_classes ??
    (isRecord(decision.classification)
      ? (decision.classification['common:class'] ??
        decision.classification['common:category'] ??
        decision.classification.classes)
      : null);
  const explicitPath = normalizePathFromClasses(type, explicit);
  if (explicitPath.length > 0) return explicitPath;

  const directCode = firstNonEmpty(
    decision.code,
    decision.class_id,
    decision.classId,
    decision.cat_id,
    decision.catId,
    decision.leaf_code,
    decision.leafCode,
  );
  if (directCode) {
    const { navigator } = navigatorFor(type);
    return pathForCode(navigator, directCode).map(toPathEntry);
  }

  const rawLabels = decision.classification_path ?? decision.classificationPath;
  const rawIds = decision.class_ids ?? decision.classIds;
  const labels: unknown[] = Array.isArray(rawLabels) ? rawLabels : [];
  const ids: unknown[] = Array.isArray(rawIds) ? rawIds : [];
  if (labels.length > 0 && labels.length === ids.length) {
    return normalizePathFromClasses(
      type,
      labels.map((label, index) => ({
        '@level': String(index),
        '@classId': ids[index],
        '#text': label,
      })),
    );
  }

  return [];
}

function normalizeDecisionType(
  decision: JsonObject,
  fallbackType: DatasetClassificationType | null,
): DatasetClassificationType | null {
  const raw = firstNonEmpty(
    decision.category_type,
    decision.categoryType,
    decision.classification_type,
    decision.classificationType,
    decision.type,
  );
  return raw ? normalizeType(raw) : fallbackType;
}

function readJsonLines(filePath: string): JsonObject[] {
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        throw new CliError(`Classification decision line ${index + 1} is not an object.`, {
          code: 'CLASSIFICATION_DECISION_INVALID',
          exitCode: 2,
        });
      }
      return parsed;
    });
}

function normalizeStructuredDecisions(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.decisions)) return value.decisions.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.rows)) return value.rows.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function readDecisions(pathValue: string, rawInput?: unknown): JsonObject[] {
  if (!pathValue) {
    throw new CliError('Missing required --decisions value.', {
      code: 'CLASSIFICATION_DECISIONS_REQUIRED',
      exitCode: 2,
    });
  }
  if (rawInput !== undefined) return normalizeStructuredDecisions(rawInput);
  const resolved = path.resolve(pathValue);
  if (!existsSync(resolved)) {
    throw new CliError(`Classification decisions file not found: ${resolved}`, {
      code: 'CLASSIFICATION_DECISIONS_NOT_FOUND',
      exitCode: 2,
    });
  }
  return resolved.toLowerCase().endsWith('.jsonl')
    ? readJsonLines(resolved)
    : normalizeStructuredDecisions(readJsonInput(resolved));
}

function prepareRows(inputPath: string, rawInput?: unknown): PreparedClassificationRow[] {
  return readDatasetRowsInput(inputPath, rawInput).map((row, index) => {
    const clonedRow = cloneJson(row);
    const payload = unwrapDatasetPayload(clonedRow);
    const descriptor = DATASET_ROOTS.find((candidate) => isRecord(payload[candidate.rootKey]));
    const root = descriptor ? (payload[descriptor.rootKey] as JsonObject) : {};
    const info =
      descriptor && isRecord(root[descriptor.informationKey])
        ? (root[descriptor.informationKey] as JsonObject)
        : {};
    const dataSetInformation = isRecord(info.dataSetInformation)
      ? (info.dataSetInformation as JsonObject)
      : {};
    const administrativeInformation = isRecord(root.administrativeInformation)
      ? (root.administrativeInformation as JsonObject)
      : {};
    const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
      ? (administrativeInformation.publicationAndOwnership as JsonObject)
      : {};
    return {
      index,
      row: clonedRow,
      payload,
      rootKey: descriptor?.rootKey ?? null,
      informationKey: descriptor?.informationKey ?? null,
      id: firstNonEmpty(clonedRow.id, dataSetInformation['common:UUID']),
      version: firstNonEmpty(clonedRow.version, publicationAndOwnership['common:dataSetVersion']),
    };
  });
}

function classificationContainer(
  row: PreparedClassificationRow,
  type: DatasetClassificationType,
): JsonObject | null {
  if (CATEGORY_CONFIGS[type].target === 'location') return null;
  if (!row.rootKey || !row.informationKey) return null;
  const root = row.payload[row.rootKey];
  if (!isRecord(root)) return null;
  const info = root[row.informationKey];
  if (!isRecord(info)) return null;
  if (!isRecord(info.dataSetInformation)) info.dataSetInformation = {};
  const dataSetInformation = info.dataSetInformation as JsonObject;
  if (!isRecord(dataSetInformation.classificationInformation)) {
    dataSetInformation.classificationInformation = {};
  }
  const classificationInformation = dataSetInformation.classificationInformation as JsonObject;
  const target = CATEGORY_CONFIGS[type].target;
  if (target === 'common:category') {
    if (!isRecord(classificationInformation['common:elementaryFlowCategorization'])) {
      classificationInformation['common:elementaryFlowCategorization'] = {};
    }
    return classificationInformation['common:elementaryFlowCategorization'] as JsonObject;
  }
  if (!isRecord(classificationInformation['common:classification'])) {
    classificationInformation['common:classification'] = {};
  }
  return classificationInformation['common:classification'] as JsonObject;
}

function currentClassification(
  row: PreparedClassificationRow,
  type: DatasetClassificationType,
): unknown {
  const container = classificationContainer(row, type);
  if (!container) return null;
  return CATEGORY_CONFIGS[type].target === 'common:category'
    ? container['common:category']
    : container['common:class'];
}

function setClassification(
  row: PreparedClassificationRow,
  type: DatasetClassificationType,
  classificationPath: ClassificationPathEntry[],
): boolean {
  const container = classificationContainer(row, type);
  if (!container) return false;
  if (CATEGORY_CONFIGS[type].target === 'common:category') {
    container['common:category'] = cloneJson(classificationPath);
  } else {
    container['common:class'] = cloneJson(classificationPath);
  }
  return true;
}

function isLocationTargetKey(key: string): boolean {
  return locationTargetKeys().has(key);
}

function locationTargetStringValue(value: unknown): {
  parent: JsonObject | null;
  key: string | null;
  pathSuffix: Array<string | number>;
  value: string;
} | null {
  if (typeof value === 'string') {
    return {
      parent: null,
      key: null,
      pathSuffix: [],
      value: value.trim(),
    };
  }
  if (isRecord(value) && typeof value['#text'] === 'string') {
    return {
      parent: value,
      key: '#text',
      pathSuffix: ['#text'],
      value: value['#text'].trim(),
    };
  }
  return null;
}

function collectLocationTargets(
  value: unknown,
  pathSegments: Array<string | number> = [],
  targets: LocationTarget[] = [],
): LocationTarget[] {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        collectLocationTargets(item, [...pathSegments, index], targets),
      );
    }
    return targets;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...pathSegments, key];
    if (isLocationTargetKey(key)) {
      const targetValue = locationTargetStringValue(child);
      if (targetValue) {
        const leafPath = [...childPath, ...targetValue.pathSuffix];
        const parent = targetValue.pathSuffix.length > 0 ? targetValue.parent : value;
        const targetKey = targetValue.pathSuffix.length > 0 ? targetValue.key : key;
        targets.push({
          path: pathExpression(leafPath),
          parentPath: pathExpression(targetValue.pathSuffix.length > 0 ? childPath : pathSegments),
          parent: parent as JsonObject,
          key: targetKey as string,
          value: targetValue.value,
        });
      }
    }
    collectLocationTargets(child, childPath, targets);
  }
  return targets;
}

function locationCodeFromPath(classificationPath: ClassificationPathEntry[]): string | null {
  const leaf = classificationPath.at(-1);
  return classCode(leaf);
}

function resolveLocationTarget(
  row: PreparedClassificationRow,
  decision: NormalizedDecision,
): LocationTarget[] {
  const targets = collectLocationTargets(row.payload);
  if (!decision.targetPath) return targets;
  const matchingTargets = targets.filter(
    (target) => target.path === decision.targetPath || target.parentPath === decision.targetPath,
  );
  if (matchingTargets.length > 0) return matchingTargets;
  const createdTarget = createMissingLocationTarget(row, decision.targetPath);
  return createdTarget ? [createdTarget] : [];
}

function targetPathSegments(targetPath: string): string[] {
  return targetPath
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function createMissingLocationTarget(
  row: PreparedClassificationRow,
  targetPath: string,
): LocationTarget | null {
  const segments = targetPathSegments(targetPath);
  const key = segments.at(-1);
  if (!key || !isLocationTargetKey(key)) return null;
  let cursor: unknown = row.payload;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(cursor)) return null;
    const existing = cursor[segment];
    if (existing === undefined || existing === null) {
      cursor[segment] = {};
      cursor = cursor[segment];
      continue;
    }
    if (!isRecord(existing)) return null;
    cursor = existing;
  }
  if (!isRecord(cursor)) return null;
  const existing = cursor[key];
  if (existing !== undefined && existing !== null && existing !== '') return null;
  return {
    path: targetPath,
    parentPath: pathExpression(segments.slice(0, -1)),
    parent: cursor,
    key,
    value: typeof existing === 'string' ? existing : '',
  };
}

function decisionMatchesRow(decision: NormalizedDecision, row: PreparedClassificationRow): boolean {
  if (decision.rowIndex !== null) return decision.rowIndex === row.index;
  if (!decision.datasetId || decision.datasetId !== row.id) return false;
  return !decision.datasetVersion || decision.datasetVersion === row.version;
}

function normalizeDecision(
  decision: JsonObject,
  decisionIndex: number,
  fallbackType: DatasetClassificationType | null,
  blockers: DatasetClassificationBlocker[],
): NormalizedDecision | null {
  const rawRowIndex = decision.row_index ?? decision.rowIndex;
  const rowIndexText = firstNonEmpty(rawRowIndex);
  const rowIndex =
    typeof rawRowIndex === 'number'
      ? rawRowIndex
      : rowIndexText === null
        ? null
        : Number(rowIndexText);
  const validRowIndex =
    typeof rowIndex === 'number' && Number.isInteger(rowIndex) ? rowIndex : null;
  const datasetId = firstNonEmpty(
    decision.dataset_id,
    decision.datasetId,
    decision.id,
    decision.uuid,
  );
  const datasetVersion = firstNonEmpty(
    decision.dataset_version,
    decision.datasetVersion,
    decision.version,
  );
  const categoryType = normalizeDecisionType(decision, fallbackType);
  if (validRowIndex === null && !datasetId) {
    blockers.push({
      code: 'classification_decision_target_missing',
      message: 'Classification decision must target row_index or dataset_id.',
      decision_index: decisionIndex,
    });
    return null;
  }
  if (!categoryType) {
    blockers.push({
      code: 'classification_decision_type_missing',
      message:
        'Classification decision must provide a category_type or the command must pass --type.',
      decision_index: decisionIndex,
      row_index: validRowIndex ?? undefined,
      dataset_id: datasetId,
      dataset_version: datasetVersion,
    });
    return null;
  }
  const classificationPath = normalizePathFromDecision(categoryType, decision);
  if (classificationPath.length === 0) {
    blockers.push({
      code: 'classification_decision_path_invalid',
      message:
        'Classification decision must resolve to a valid path in the bundled TIDAS category schema.',
      decision_index: decisionIndex,
      row_index: validRowIndex ?? undefined,
      dataset_id: datasetId,
      dataset_version: datasetVersion,
    });
    return null;
  }
  return {
    decisionIndex,
    rowIndex: validRowIndex,
    datasetId,
    datasetVersion,
    categoryType,
    path: classificationPath,
    targetPath: decisionTargetPath(decision),
    basis: firstNonEmpty(decision.basis),
    evidence: decision.evidence ?? null,
  };
}

function maybeWriteReport<T extends { files?: { report: string } }>(
  report: T,
  outDir: string | null | undefined,
  filename: string,
): T {
  if (!outDir) return report;
  const reportPath = path.join(path.resolve(outDir), 'outputs', filename);
  const finalReport = { ...report, files: { report: reportPath } };
  writeJsonArtifact(reportPath, finalReport);
  return finalReport;
}

export async function runDatasetClassificationChildren(
  options: RunDatasetClassificationChildrenOptions,
): Promise<DatasetClassificationChildrenReport> {
  const type = normalizeType(options.type);
  const { config, navigator } = navigatorFor(type);
  const parentCode = firstNonEmpty(options.parent);
  const rawChildren = navigator.childMap.get(parentCode ?? '') ?? [];
  const parentKnown = !parentCode || navigator.entriesByCode.has(parentCode);
  const query = firstNonEmpty(options.query)?.toLowerCase() ?? null;
  const filtered = query
    ? rawChildren.filter(
        (entry) =>
          entry.code.toLowerCase().includes(query) || entry.text.toLowerCase().includes(query),
      )
    : rawChildren;
  const limit = options.limit && options.limit > 0 ? options.limit : null;
  const returned = limit ? filtered.slice(0, limit) : filtered;
  const report: DatasetClassificationChildrenReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: parentKnown ? 'completed' : 'blocked',
    command: 'dataset classification children',
    category_type: type,
    schema_file: config.schemaFile,
    parent_code: parentCode,
    query,
    counts: {
      children: rawChildren.length,
      returned: returned.length,
    },
    children: returned.map((entry) => ({
      ...entry,
      path: pathForCode(navigator, entry.code).map(toPathEntry),
    })),
    blockers: parentKnown
      ? []
      : [{ code: 'classification_parent_unknown', message: `Unknown parent code: ${parentCode}` }],
  };
  return maybeWriteReport(report, options.outDir, 'classification-children-report.json');
}

export async function runDatasetClassificationPath(
  options: RunDatasetClassificationPathOptions,
): Promise<DatasetClassificationPathReport> {
  const type = normalizeType(options.type);
  const { config, navigator } = navigatorFor(type);
  const code = firstNonEmpty(options.code);
  if (!code) {
    throw new CliError('Missing required --code value.', {
      code: 'CLASSIFICATION_CODE_REQUIRED',
      exitCode: 2,
    });
  }
  const pathEntries = pathForCode(navigator, code).map(toPathEntry);
  const report: DatasetClassificationPathReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: pathEntries.length > 0 ? 'completed' : 'blocked',
    command: 'dataset classification path',
    category_type: type,
    schema_file: config.schemaFile,
    code,
    path: pathEntries,
    blockers:
      pathEntries.length > 0
        ? []
        : [
            {
              code: 'classification_code_unknown',
              message: `Unknown classification code: ${code}`,
            },
          ],
  };
  return maybeWriteReport(report, options.outDir, 'classification-path-report.json');
}

export async function runDatasetClassificationAudit(
  options: RunDatasetClassificationAuditOptions,
): Promise<DatasetClassificationAuditReport> {
  if (!options.inputPath) {
    throw new CliError('Missing required --input value.', {
      code: 'CLASSIFICATION_AUDIT_INPUT_REQUIRED',
      exitCode: 2,
    });
  }
  const type = normalizeType(options.type);
  if (type !== 'location') {
    throw new CliError('dataset classification audit currently supports only --type location.', {
      code: 'CLASSIFICATION_AUDIT_TYPE_UNSUPPORTED',
      exitCode: 2,
    });
  }
  const { config, navigator } = navigatorFor(type);
  const rows = prepareRows(options.inputPath, options.rawInput);
  const findings: DatasetClassificationAuditFinding[] = [];
  const blockers: DatasetClassificationBlocker[] = [];
  for (const row of rows) {
    for (const target of collectLocationTargets(row.payload)) {
      const entry = navigator.entriesByCode.get(target.value);
      const status = entry ? 'valid' : 'invalid';
      findings.push({
        row_index: row.index,
        dataset_id: row.id,
        dataset_version: row.version,
        path: target.path,
        value: target.value,
        status,
        description: entry?.text ?? null,
      });
      if (!entry) {
        blockers.push({
          code: 'location_code_invalid',
          message: 'Location value is not a code from the bundled TIDAS location schema.',
          row_index: row.index,
          dataset_id: row.id,
          dataset_version: row.version,
        });
      }
    }
  }
  const invalid = findings.filter((finding) => finding.status === 'invalid').length;
  const outDir = options.outDir ? path.resolve(options.outDir) : null;
  const findingsPath = outDir
    ? path.join(outDir, 'outputs', 'location-audit-findings.jsonl')
    : null;
  const reportPath = outDir ? path.join(outDir, 'outputs', 'location-audit-report.json') : null;
  const report: DatasetClassificationAuditReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: invalid > 0 ? 'blocked' : 'completed',
    command: 'dataset classification audit',
    category_type: type,
    schema_file: config.schemaFile,
    input_path: path.resolve(options.inputPath),
    counts: {
      rows: rows.length,
      location_targets: findings.length,
      valid: findings.length - invalid,
      invalid,
    },
    findings,
    blockers,
    ...(findingsPath && reportPath
      ? {
          files: {
            findings: findingsPath,
            report: reportPath,
          },
        }
      : {}),
  };
  if (findingsPath && reportPath) {
    writeJsonLinesArtifact(findingsPath, findings);
    writeJsonArtifact(reportPath, report);
  }
  return report;
}

export async function runDatasetClassificationApply(
  options: RunDatasetClassificationApplyOptions,
): Promise<DatasetClassificationApplyReport> {
  if (!options.inputPath) {
    throw new CliError('Missing required --input value.', {
      code: 'CLASSIFICATION_INPUT_REQUIRED',
      exitCode: 2,
    });
  }
  if (!options.outPath) {
    throw new CliError('Missing required --out value.', {
      code: 'CLASSIFICATION_OUT_REQUIRED',
      exitCode: 2,
    });
  }
  const fallbackType = options.type ? normalizeType(options.type) : null;
  const rows = prepareRows(options.inputPath, options.rawInput);
  const rawDecisions = readDecisions(options.decisionsPath, options.rawDecisions);
  const blockers: DatasetClassificationBlocker[] = [];
  const decisions = rawDecisions
    .map((decision, index) => normalizeDecision(decision, index, fallbackType, blockers))
    .filter((decision): decision is NormalizedDecision => Boolean(decision));
  const evidence = [];

  for (const decision of decisions) {
    const matches = rows.filter((row) => decisionMatchesRow(decision, row));
    if (matches.length !== 1) {
      blockers.push({
        code:
          matches.length === 0
            ? 'classification_target_not_found'
            : 'classification_target_ambiguous',
        message:
          matches.length === 0
            ? 'Classification decision did not match an input row.'
            : 'Classification decision matched more than one input row.',
        decision_index: decision.decisionIndex,
        row_index: decision.rowIndex ?? undefined,
        dataset_id: decision.datasetId,
        dataset_version: decision.datasetVersion,
      });
      continue;
    }
    const row = matches[0] as PreparedClassificationRow;
    if (decision.categoryType === 'location') {
      const code = locationCodeFromPath(decision.path);
      const targetMatches = resolveLocationTarget(row, decision);
      if (!code || targetMatches.length !== 1) {
        blockers.push({
          code:
            targetMatches.length === 0 ? 'location_target_not_found' : 'location_target_ambiguous',
          message:
            targetMatches.length === 0
              ? 'Location decision did not match a location field in the input row.'
              : 'Location decision matched more than one location field; provide target_path.',
          decision_index: decision.decisionIndex,
          row_index: row.index,
          dataset_id: row.id,
          dataset_version: row.version,
        });
        continue;
      }
      const target = targetMatches[0] as LocationTarget;
      const previous = target.value;
      target.parent[target.key] = code;
      evidence.push({
        decision_index: decision.decisionIndex,
        row_index: row.index,
        dataset_id: row.id,
        dataset_version: row.version,
        category_type: decision.categoryType,
        target_path: target.path,
        previous_location: previous,
        applied_location: code,
        applied_location_path: cloneJson(decision.path),
        basis: decision.basis,
        evidence: decision.evidence,
      });
      continue;
    }
    const previous = currentClassification(row, decision.categoryType);
    if (!setClassification(row, decision.categoryType, decision.path)) {
      blockers.push({
        code: 'classification_container_missing',
        message: 'Input row does not contain a supported classification container for this type.',
        decision_index: decision.decisionIndex,
        row_index: row.index,
        dataset_id: row.id,
        dataset_version: row.version,
      });
      continue;
    }
    evidence.push({
      decision_index: decision.decisionIndex,
      row_index: row.index,
      dataset_id: row.id,
      dataset_version: row.version,
      category_type: decision.categoryType,
      previous_classification: previous,
      applied_classification: cloneJson(decision.path),
      basis: decision.basis,
      evidence: decision.evidence,
    });
  }

  const outDir = options.outDir
    ? path.resolve(options.outDir)
    : path.dirname(path.resolve(options.outPath));
  const evidencePath = path.join(outDir, 'outputs', 'classification-apply-evidence.jsonl');
  const reportPath = path.join(outDir, 'outputs', 'classification-apply-report.json');
  writeJsonLinesArtifact(
    options.outPath,
    rows.map((row) => row.payload),
  );
  writeJsonLinesArtifact(evidencePath, evidence);
  const report: DatasetClassificationApplyReport = {
    schema_version: 1,
    generated_at_utc: (options.now ?? new Date()).toISOString(),
    status: blockers.length > 0 ? 'blocked' : 'completed',
    command: 'dataset classification apply',
    input_path: path.resolve(options.inputPath),
    decisions_path: path.resolve(options.decisionsPath),
    out_path: path.resolve(options.outPath),
    default_category_type: fallbackType,
    counts: {
      rows: rows.length,
      decisions: rawDecisions.length,
      applied: evidence.length,
      blockers: blockers.length,
    },
    blockers,
    files: {
      classified_rows: path.resolve(options.outPath),
      evidence: evidencePath,
      report: reportPath,
    },
  };
  writeJsonArtifact(reportPath, report);
  return report;
}

export const __testInternals = {
  buildNavigator,
  classCode,
  classificationContainer,
  collectEntriesFromNode,
  collectLocationRefKeysFromSchema,
  collectLocationTargets,
  constText,
  createMissingLocationTarget,
  currentClassification,
  decisionMatchesRow,
  decisionTargetPath,
  isJsonSchemaFileName,
  lastSchemaPropertyName,
  loadEntries,
  locationCodeFromPath,
  locationTargetStringValue,
  locationTargetKeys,
  maybeWriteReport,
  navigatorFor,
  normalizeDecision,
  normalizeDecisionType,
  normalizePathFromClasses,
  normalizePathFromDecision,
  normalizeStructuredDecisions,
  normalizeTargetPath,
  normalizeType,
  orderCatalogEntries,
  pathForCode,
  prepareRows,
  readDecisions,
  resolveLocationTarget,
  resolveClassificationPathAgainstCatalog,
  schemasDir,
  schemaPath,
  setClassification,
  targetPathSegments,
  toPathEntry,
};
