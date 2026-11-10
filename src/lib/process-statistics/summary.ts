import type {
  JsonRecord,
  SnapshotRow,
  ClassificationEntry,
  StatisticsMetadata,
  StatisticsOptions,
  CountRecord,
  ProcessScopeStatisticsArtifacts,
} from './types.js';

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeSnapshotRow(value: unknown): SnapshotRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = normalizeOptionalToken(value.id);
  const version = normalizeOptionalToken(value.version);
  const payload = normalizePayload(value.json);
  if (!id || !version || !payload) {
    return null;
  }
  return {
    id,
    version,
    state_code: typeof value.state_code === 'number' ? value.state_code : null,
    user_id: normalizeOptionalToken(value.user_id),
    modified_at: normalizeOptionalToken(value.modified_at),
    model_id: normalizeOptionalToken(value.model_id),
    json: payload,
  };
}

export function normalizePayload(value: unknown): JsonRecord | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function getLangList(value: unknown): JsonRecord[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is JsonRecord => isRecord(item));
  }
  if (isRecord(value)) {
    const langString = value['common:langString'];
    if (Array.isArray(langString)) {
      return langString.filter((item): item is JsonRecord => isRecord(item));
    }
    if (isRecord(langString)) {
      return [langString];
    }
    if (typeof value['#text'] === 'string' || typeof value['@xml:lang'] === 'string') {
      return [value];
    }
  }
  if (typeof value === 'string') {
    return [{ '@xml:lang': 'en', '#text': value }];
  }
  return [];
}

export function getLangText(value: unknown, lang: string | null): string {
  const list = getLangList(value);
  const exact =
    lang === null
      ? null
      : list.find(
          (item) =>
            trimText(item['@xml:lang']).toLowerCase() === lang.toLowerCase() &&
            trimText(item['#text']),
        );
  const fallback = list.find((item) => trimText(item['#text']));
  return trimText((exact ?? fallback)?.['#text']);
}

export function getAnyLangText(value: unknown): string {
  return getLangText(value, null);
}

export function asArray(value: unknown): unknown[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function extractClassificationEntries(
  dataSetInformation: JsonRecord,
): ClassificationEntry[] {
  const classes = asArray(
    (dataSetInformation.classificationInformation as JsonRecord | undefined)?.[
      'common:classification'
    ] &&
      (
        (dataSetInformation.classificationInformation as JsonRecord)['common:classification'] as
          JsonRecord | undefined
      )?.['common:class'],
  );

  return classes
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const level = Number.parseInt(trimText(entry['@level']) || '0', 10);
      const text = trimText(entry['#text']);
      if (!text) {
        return null;
      }
      return { level, text };
    })
    .filter((entry): entry is ClassificationEntry => entry !== null)
    .sort((left, right) => left.level - right.level);
}

export function normalizeSignature(text: string): string {
  return trimText(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u3000\u00a0]/gu, ' ')
    .replace(/[，,;；:：()（）[\]{}<>|/\\]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function firstClause(text: string): string {
  const normalized = trimText(text);
  if (!normalized) {
    return '';
  }
  const [first] = normalized.split(/[.;；。]/u);
  return first.trim();
}

export function renderProcessName(name: JsonRecord): string {
  const parts = [
    getLangText(name.baseName, 'en') ||
      getLangText(name.baseName, 'zh') ||
      getAnyLangText(name.baseName),
    getLangText(name.treatmentStandardsRoutes, 'en') ||
      getLangText(name.treatmentStandardsRoutes, 'zh') ||
      getAnyLangText(name.treatmentStandardsRoutes),
    getLangText(name.mixAndLocationTypes, 'en') ||
      getLangText(name.mixAndLocationTypes, 'zh') ||
      getAnyLangText(name.mixAndLocationTypes),
    getLangText(name.functionalUnitFlowProperties, 'en') ||
      getLangText(name.functionalUnitFlowProperties, 'zh') ||
      getAnyLangText(name.functionalUnitFlowProperties),
  ].filter((part) => trimText(part));

  return parts.join('; ');
}

export function extractCraftCandidate(
  dataSetInformation: JsonRecord,
  technology: JsonRecord,
): {
  source_kind: string;
  label: string;
  signature: string;
} {
  const name = isRecord(dataSetInformation.name) ? dataSetInformation.name : {};
  const candidates = [
    {
      source_kind: 'treatmentStandardsRoutes',
      label:
        getLangText(name.treatmentStandardsRoutes, 'en') ||
        getLangText(name.treatmentStandardsRoutes, 'zh') ||
        getAnyLangText(name.treatmentStandardsRoutes),
    },
    {
      source_kind: 'technologyDescriptionAndIncludedProcesses',
      label:
        firstClause(getLangText(technology.technologyDescriptionAndIncludedProcesses, 'en')) ||
        firstClause(getLangText(technology.technologyDescriptionAndIncludedProcesses, 'zh')) ||
        firstClause(getAnyLangText(technology.technologyDescriptionAndIncludedProcesses)),
    },
    {
      source_kind: 'baseName',
      label:
        getLangText(name.baseName, 'en') ||
        getLangText(name.baseName, 'zh') ||
        getAnyLangText(name.baseName),
    },
  ];

  for (const candidate of candidates) {
    if (trimText(candidate.label)) {
      return {
        ...candidate,
        signature: normalizeSignature(candidate.label),
      };
    }
  }

  return {
    source_kind: 'missing',
    label: '',
    signature: '',
  };
}

export function extractReferenceProduct(
  processDataSet: JsonRecord,
  dataSetInformation: JsonRecord,
): {
  key: string;
  stable_flow_id: string;
  stable_flow_version: string;
  label: string;
  source_kind: string;
  missing_reference_exchange: boolean;
} {
  const processInformation = isRecord(processDataSet.processInformation)
    ? processDataSet.processInformation
    : {};
  const quantRef = isRecord(processInformation.quantitativeReference)
    ? processInformation.quantitativeReference
    : {};
  const refInternalId = trimText(quantRef.referenceToReferenceFlow);
  const exchangesBlock = isRecord(processDataSet.exchanges) ? processDataSet.exchanges : {};
  const exchanges = asArray(exchangesBlock.exchange);
  const refExchange = exchanges.find(
    (exchange) => isRecord(exchange) && trimText(exchange['@dataSetInternalID']) === refInternalId,
  );
  const exchange = isRecord(refExchange) ? refExchange : null;
  const flowRef =
    exchange && isRecord(exchange.referenceToFlowDataSet) ? exchange.referenceToFlowDataSet : {};

  const flowRefId = trimText(flowRef['@refObjectId']);
  const flowRefVersion = trimText(flowRef['@version']);
  const shortDescription =
    getLangText(flowRef['common:shortDescription'], 'en') ||
    getLangText(flowRef['common:shortDescription'], 'zh') ||
    getAnyLangText(flowRef['common:shortDescription']);
  const name = isRecord(dataSetInformation.name) ? dataSetInformation.name : {};
  const fallbackBaseName =
    getLangText(name.baseName, 'en') ||
    getLangText(name.baseName, 'zh') ||
    getAnyLangText(name.baseName);
  const fallbackProcessName = renderProcessName(name);

  if (flowRefId) {
    return {
      key: `flow:${flowRefId}`,
      stable_flow_id: flowRefId,
      stable_flow_version: flowRefVersion,
      label: shortDescription || fallbackProcessName || flowRefId,
      source_kind: 'reference_flow_id',
      missing_reference_exchange: exchange === null,
    };
  }

  if (shortDescription) {
    return {
      key: `label:${normalizeSignature(shortDescription)}`,
      stable_flow_id: '',
      stable_flow_version: '',
      label: shortDescription,
      source_kind: 'reference_flow_short_description',
      missing_reference_exchange: exchange === null,
    };
  }

  if (fallbackBaseName) {
    return {
      key: `base:${normalizeSignature(fallbackBaseName)}`,
      stable_flow_id: '',
      stable_flow_version: '',
      label: fallbackBaseName,
      source_kind: 'process_base_name',
      missing_reference_exchange: exchange === null,
    };
  }

  return {
    key: '',
    stable_flow_id: '',
    stable_flow_version: '',
    label: '',
    source_kind: 'missing',
    missing_reference_exchange: exchange === null,
  };
}

export function incrementCount(
  map: Map<string, CountRecord>,
  key: string,
  seed: Record<string, unknown> = {},
): void {
  const existing = map.get(key) ?? {
    count: 0,
    ...seed,
  };
  existing.count += 1;
  map.set(key, existing);
}

export function toSortedArray(map: Map<string, CountRecord>): Array<{ key: string } & CountRecord> {
  return [...map.entries()]
    .map(([key, value]) => ({
      key,
      ...value,
    }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export function calculateStatistics(
  rows: SnapshotRow[],
  options: StatisticsOptions,
  metadata: StatisticsMetadata,
  generatedAtUtc: string,
): ProcessScopeStatisticsArtifacts {
  const stateCodeCounts = new Map<string, CountRecord>();
  const typeOfDataSetCounts = new Map<string, CountRecord>();
  const domainPrimaryCounts = new Map<string, CountRecord>();
  const domainLeafCounts = new Map<string, CountRecord>();
  const craftCounts = new Map<string, CountRecord>();
  const craftSourceCounts = new Map<string, CountRecord>();
  const productCounts = new Map<string, CountRecord>();
  const productSourceCounts = new Map<string, CountRecord>();
  const ownerCounts = new Map<string, CountRecord>();

  let rowsMissingClassification = 0;
  let rowsMissingCraft = 0;
  let rowsMissingProduct = 0;
  let rowsMissingReferenceExchange = 0;
  let unitProcessRows = 0;

  for (const row of rows) {
    incrementCount(stateCodeCounts, String(row.state_code ?? 'null'));
    incrementCount(ownerCounts, row.user_id ?? 'missing');

    const processDataSet = isRecord(row.json.processDataSet) ? row.json.processDataSet : {};
    const processInformation = isRecord(processDataSet.processInformation)
      ? processDataSet.processInformation
      : {};
    const dataSetInformation = isRecord(processInformation.dataSetInformation)
      ? processInformation.dataSetInformation
      : {};
    const technology = isRecord(processInformation.technology) ? processInformation.technology : {};
    const modellingAndValidation = isRecord(processDataSet.modellingAndValidation)
      ? processDataSet.modellingAndValidation
      : {};
    const lciMethod = isRecord(modellingAndValidation.LCIMethodAndAllocation)
      ? modellingAndValidation.LCIMethodAndAllocation
      : {};

    const typeOfDataSet = trimText(lciMethod.typeOfDataSet) || 'missing';
    incrementCount(typeOfDataSetCounts, typeOfDataSet);
    if (typeOfDataSet.toLowerCase().includes('unit process')) {
      unitProcessRows += 1;
    }

    const classificationEntries = extractClassificationEntries(dataSetInformation);
    const primaryDomain =
      classificationEntries.find((entry) => entry.level === 1)?.text ??
      classificationEntries[classificationEntries.length - 1]?.text ??
      '';
    const leafDomain = classificationEntries[classificationEntries.length - 1]?.text ?? '';
    if (primaryDomain) {
      incrementCount(domainPrimaryCounts, primaryDomain, {
        sample_path: classificationEntries.map((entry) => entry.text).join(' > '),
      });
    } else {
      rowsMissingClassification += 1;
    }
    if (leafDomain) {
      incrementCount(domainLeafCounts, leafDomain, {
        sample_path: classificationEntries.map((entry) => entry.text).join(' > '),
      });
    }

    const craft = extractCraftCandidate(dataSetInformation, technology);
    if (craft.signature) {
      incrementCount(craftCounts, craft.signature, {
        label: craft.label,
        source_kind: craft.source_kind,
      });
      incrementCount(craftSourceCounts, craft.source_kind);
    } else {
      rowsMissingCraft += 1;
    }

    const product = extractReferenceProduct(processDataSet, dataSetInformation);
    if (product.key) {
      incrementCount(productCounts, product.key, {
        label: product.label,
        stable_flow_id: product.stable_flow_id,
        stable_flow_version: product.stable_flow_version,
        source_kind: product.source_kind,
      });
      incrementCount(productSourceCounts, product.source_kind);
    } else {
      rowsMissingProduct += 1;
    }
    if (product.missing_reference_exchange) {
      rowsMissingReferenceExchange += 1;
    }
  }

  const domainPrimarySummary = toSortedArray(domainPrimaryCounts).map((item) => ({
    domain: item.key,
    count: item.count,
    sample_path: item.sample_path as string | undefined,
  }));
  const domainLeafSummary = toSortedArray(domainLeafCounts).map((item) => ({
    domain: item.key,
    count: item.count,
    sample_path: item.sample_path as string | undefined,
  }));
  const craftSummary = toSortedArray(craftCounts).map((item) => ({
    craft_signature: item.key,
    label: item.label as string,
    count: item.count,
    source_kind: item.source_kind as string,
  }));
  const productSummary = toSortedArray(productCounts).map((item) => ({
    product_key: item.key,
    label: item.label as string,
    count: item.count,
    stable_flow_id: item.stable_flow_id as string,
    stable_flow_version: item.stable_flow_version as string,
    source_kind: item.source_kind as string,
  }));
  const typeOfDataSetSummary = toSortedArray(typeOfDataSetCounts).map((item) => ({
    type_of_dataset: item.key,
    count: item.count,
  }));

  return {
    summary: {
      schema_version: 1,
      generated_at_utc: generatedAtUtc,
      scope: options.scope,
      state_codes: options.stateCodes,
      user_id: metadata.userId,
      masked_user_email: metadata.maskedUserEmail,
      total_process_rows: rows.length,
      total_rows_reported_by_remote: metadata.totalRowsReportedByRemote,
      rows_by_state_code: Object.fromEntries(
        [...stateCodeCounts.entries()].map(([key, value]) => [key, value.count]),
      ),
      distinct_visible_owner_user_ids: ownerCounts.size,
      domain_count_primary: domainPrimaryCounts.size,
      domain_count_leaf: domainLeafCounts.size,
      craft_count: craftCounts.size,
      unit_process_rows: unitProcessRows,
      unit_process_share: rows.length === 0 ? 0 : unitProcessRows / rows.length,
      product_count: productCounts.size,
      products_with_flow_id: productSummary.filter((item) => item.stable_flow_id).length,
      products_without_flow_id: productSummary.filter((item) => !item.stable_flow_id).length,
      rows_missing_classification: rowsMissingClassification,
      rows_missing_craft: rowsMissingCraft,
      rows_missing_product: rowsMissingProduct,
      rows_missing_reference_exchange: rowsMissingReferenceExchange,
      metric_definitions: {
        domain_count_primary:
          'Unique level-1 classification text; fallback to the deepest available classification when level 1 is missing.',
        craft_count:
          'Unique normalized craft or route signatures derived from treatmentStandardsRoutes, or fallback technology/base-name text.',
        unit_process_rows: 'Rows whose typeOfDataSet contains the phrase "Unit process".',
        product_count:
          'Unique reference products, keyed by reference flow ID when present and by normalized label fallback otherwise.',
      },
    },
    domainPrimarySummary,
    domainLeafSummary,
    craftSummary,
    productSummary,
    typeOfDataSetSummary,
    craftSourceSummary: toSortedArray(craftSourceCounts).map((item) => ({
      source_kind: item.key,
      count: item.count,
    })),
    productSourceSummary: toSortedArray(productSourceCounts).map((item) => ({
      source_kind: item.key,
      count: item.count,
    })),
  };
}

export function normalizeOptionalToken(value: unknown): string | null {
  const trimmed = trimText(value);
  return trimmed ? trimmed : null;
}
