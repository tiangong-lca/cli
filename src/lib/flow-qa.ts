import { inspectFlowProperties } from './flow-property-contract.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeJsonArtifact, writeJsonLinesArtifact, writeTextArtifact } from './artifacts.js';
import { CliError } from './errors.js';
import {
  coerceText,
  deepGet,
  extractFlowRecord,
  flowDatasetFromRow,
  isRecord,
  listify,
  loadRowsFromFile,
  normalizeText,
} from './flow-governance.js';
import type { JsonRecord } from './flow-governance.js';
import type { FetchLike } from './http.js';
import { invokeLlm, readLlmRuntimeEnv, type LlmRuntimeEnv } from './llm.js';
import {
  getRuntimeRuleset,
  isRuntimeRuleBlocker,
  resolveRuntimeRuleId,
} from './runtime-rulesets.js';

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/u;

type ClassificationEntry = {
  level: string;
  class_id?: string;
  cat_id?: string;
  text: string;
};

type FlowRuleFinding = {
  flow_uuid: string;
  base_version: string;
  severity: string;
  rule_id?: string;
  ruleset_id?: 'flow-authoring/strict';
  methodology_rule_id?: string | null;
  message?: string;
  fixability?: string;
  source: 'rule' | 'llm';
  rule_source?: string;
  evidence?: JsonRecord;
  action?: string;
};

type FlowSummary = {
  flow_uuid: string;
  base_version: string;
  type_of_dataset: string;
  names: {
    primary_en: string;
    primary_zh: string;
    all_texts: string[];
  };
  classification: {
    leaf: {
      class_id: string;
      text: string;
      key: string;
    };
    path: ClassificationEntry[];
  };
  flow_property: JsonRecord;
  quantitative_reference: {
    reference_flow_property_internal_id: string;
  };
  unitgroup: {
    uuid: string;
    name: string;
    reference_unit_name: string;
    lookup_status: string;
    lookup_source: string;
  };
  rule_signals: Array<{
    rule_id: string;
    severity: string;
    message: string;
    evidence: JsonRecord;
  }>;
  similarity_candidates: Array<{
    other_flow_uuid: string;
    other_base_version: string;
    similarity: number;
    other_name_en: string;
    classification_group: string;
  }>;
  source_file?: string;
  _name_fingerprint: string;
};

type FlowSimilarityPair = {
  classification_group: string;
  flow_property_uuid: string;
  unitgroup_uuid: string;
  left_flow_uuid: string;
  right_flow_uuid: string;
  left_version: string;
  right_version: string;
  similarity: number;
  left_name_en: string;
  right_name_en: string;
};

type FlowQaLlmBatchResult = {
  batch_index: number;
  batch_size: number;
  enabled: boolean;
  ok: boolean;
  reason?: string;
  raw_preview?: string;
};

export type FlowQaLlmResult = {
  enabled: boolean;
  ok?: boolean;
  reason?: string;
  batch_count: number;
  reviewed_flow_count: number;
  truncated: boolean;
  batch_results: FlowQaLlmBatchResult[];
};

type FlowQaLlmRunResult = FlowQaLlmResult & {
  llmFindings: FlowRuleFinding[];
};

type FlowRulesetGate = {
  status: 'passed' | 'needs_review' | 'blocked';
  ruleset_id: 'flow-authoring/strict';
  ruleset_version: '1';
  ruleset_source_version: string;
  ruleset_rule_ids: string[];
  counts: {
    findings: number;
    blockers: number;
  };
  blockers: FlowRuleFinding[];
  next_action: 'continue' | 'review_findings' | 'fix_blockers';
};

export type FlowQaReport = {
  schema_version: 1;
  generated_at_utc: string;
  status: 'completed_local_flow_qa';
  run_id: string;
  out_dir: string;
  rows_file: string;
  input_mode: 'rows_file' | 'flows_dir' | 'run_root';
  effective_flows_dir: string;
  logic_version: string;
  ruleset_id?: 'flow-authoring/strict';
  ruleset_version?: '1';
  ruleset_source_version?: string;
  ruleset_rule_ids?: string[];
  flow_count: number;
  similarity_threshold: number;
  methodology_rule_source: string;
  with_reference_context: false;
  reference_context_mode: 'disabled';
  rule_finding_count: number;
  llm_finding_count: number;
  finding_count: number;
  blocker_count?: number;
  severity_counts: Record<string, number>;
  rule_counts: Record<string, number>;
  methodology_rule_counts?: Record<string, number>;
  ruleset_gate?: FlowRulesetGate;
  llm: FlowQaLlmResult;
  files: {
    qa_input_summary: string;
    materialization_summary: string | null;
    rule_findings: string;
    llm_findings: string;
    findings: string;
    ruleset_gate?: string;
    flow_summaries: string;
    similarity_pairs: string;
    summary: string;
    qa_zh: string;
    qa_en: string;
    timing: string;
    report: string;
  };
};

export type RunFlowQaOptions = {
  rowsFile?: string;
  flowsDir?: string;
  runRoot?: string;
  runId?: string;
  outDir: string;
  startTs?: string;
  endTs?: string;
  logicVersion?: string;
  enableLlm?: boolean;
  llmModel?: string;
  llmMaxFlows?: number;
  llmBatchSize?: number;
  similarityThreshold?: number;
  methodologyId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: () => Date;
};

function walkStrings(node: unknown): string[] {
  if (typeof node === 'string') {
    return node.trim() ? [node.trim()] : [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((item) => walkStrings(item));
  }

  if (!isRecord(node)) {
    return [];
  }

  const strings: string[] = [];
  if (typeof node['#text'] === 'string' && String(node['#text']).trim()) {
    strings.push(String(node['#text']).trim());
  }

  Object.values(node).forEach((value) => {
    strings.push(...walkStrings(value));
  });
  return strings;
}

function langTextForLang(value: unknown, lang: string): string {
  for (const item of listify(value)) {
    if (!isRecord(item)) {
      continue;
    }

    if (coerceText(item['@xml:lang']).toLowerCase() !== lang.toLowerCase()) {
      continue;
    }

    const text = coerceText(item['#text']);
    if (text) {
      return text;
    }
  }

  for (const item of listify(value)) {
    const text = coerceText(item);
    if (text) {
      return text;
    }
  }

  return '';
}

function findUuidInNode(node: unknown): string {
  if (isRecord(node)) {
    for (const key of ['@refObjectId', '@uri']) {
      const raw = coerceText(node[key]);
      const match = raw.match(UUID_RE);
      if (match) {
        return match[0].toLowerCase();
      }
    }
  }

  const raw = coerceText(node);
  const match = raw.match(UUID_RE);
  return match ? match[0].toLowerCase() : '';
}

function flowRoot(doc: JsonRecord): JsonRecord {
  return isRecord(doc.flowDataSet) ? { ...doc.flowDataSet } : { ...doc };
}

function flowUuid(flow: JsonRecord): string {
  return coerceText(deepGet(flow, ['flowInformation', 'dataSetInformation', 'common:UUID']));
}

function flowVersion(flow: JsonRecord): string {
  return coerceText(
    deepGet(flow, [
      'administrativeInformation',
      'publicationAndOwnership',
      'common:dataSetVersion',
    ]),
  );
}

function flowType(flow: JsonRecord): string {
  return (
    coerceText(
      deepGet(flow, ['modellingAndValidation', 'LCIMethodAndAllocation', 'typeOfDataSet']),
    ) || coerceText(deepGet(flow, ['modellingAndValidation', 'LCIMethod', 'typeOfDataSet']))
  );
}

function nameNode(flow: JsonRecord): unknown {
  return deepGet(flow, ['flowInformation', 'dataSetInformation', 'name']);
}

function nameTexts(flow: JsonRecord): string[] {
  return walkStrings(nameNode(flow));
}

function namePrimary(flow: JsonRecord, lang: string): string {
  const name = nameNode(flow);
  if (!isRecord(name)) {
    return '';
  }

  return langTextForLang(name.baseName, lang);
}

function nameFingerprint(flow: JsonRecord): string {
  const name = nameNode(flow);
  if (!isRecord(name)) {
    return '';
  }

  const parts: string[] = [];
  for (const key of ['baseName', 'treatmentStandardsRoutes', 'mixAndLocationTypes']) {
    const values = listify(name[key])
      .map((item) => (isRecord(item) ? coerceText(item['#text']) : coerceText(item)))
      .filter(Boolean);
    if (values.length) {
      parts.push(values.join(' | '));
    }
  }

  const text = parts.length ? parts.join(' || ') : nameTexts(flow).join(' || ');
  return normalizeText(text);
}

function classificationEntries(flow: JsonRecord): ClassificationEntry[] {
  return listify(
    deepGet(flow, [
      'flowInformation',
      'dataSetInformation',
      'classificationInformation',
      'common:classification',
      'common:class',
    ]),
  )
    .filter(isRecord)
    .map((item) => ({
      level: coerceText(item['@level']),
      class_id: coerceText(item['@classId']),
      text: coerceText(item['#text']),
    }));
}

function elementaryClassEntries(flow: JsonRecord): ClassificationEntry[] {
  return listify(
    deepGet(flow, [
      'flowInformation',
      'dataSetInformation',
      'classificationInformation',
      'common:elementaryFlowCategorization',
      'common:category',
    ]),
  )
    .filter(isRecord)
    .map((item) => ({
      level: coerceText(item['@level']),
      cat_id: coerceText(item['@catId']),
      text: coerceText(item['#text']),
    }));
}

function classificationLeaf(flow: JsonRecord): { class_id: string; text: string; key: string } {
  const entries = classificationEntries(flow);
  if (!entries.length) {
    return {
      class_id: '',
      text: '',
      key: '',
    };
  }

  const leaf = entries[entries.length - 1]!;
  const classId = leaf.class_id as string;
  const key = `${classId}|${leaf.text}`.replace(/^\||\|$/gu, '');
  return {
    class_id: classId,
    text: leaf.text,
    key,
  };
}

function flowProperties(flow: JsonRecord): JsonRecord[] {
  return listify(deepGet(flow, ['flowProperties', 'flowProperty'])).filter(isRecord);
}

function pickReferenceFlowProperty(flow: JsonRecord): {
  prop: JsonRecord | null;
  internalId: string;
} {
  const inspected = inspectFlowProperties(flow);
  return { prop: inspected.reference, internalId: inspected.referenceInternalId };
}

function quantitativeReferenceInternalId(flow: JsonRecord): string {
  return coerceText(
    deepGet(flow, ['flowInformation', 'quantitativeReference', 'referenceToReferenceFlowProperty']),
  );
}

function flowPropertyRef(prop: JsonRecord): {
  uuid: string;
  version: string;
  short_name_en: string;
} {
  const ref = isRecord(prop.referenceToFlowPropertyDataSet)
    ? prop.referenceToFlowPropertyDataSet
    : null;
  return {
    uuid: findUuidInNode(ref),
    version: coerceText(ref?.['@version']),
    short_name_en: langTextForLang(ref?.['common:shortDescription'], 'en'),
  };
}

function computeSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }

  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = new Set(right.split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) {
    return 0;
  }

  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  });
  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function createRuleFinding(
  flowUuidValue: string,
  baseVersion: string,
  severity: string,
  ruleId: string,
  message: string,
  options?: {
    fixability?: string;
    evidence?: JsonRecord;
    action?: string;
    ruleSource?: string;
  },
): FlowRuleFinding {
  const ruleset = getRuntimeRuleset('flow-authoring/strict');
  return {
    flow_uuid: flowUuidValue,
    base_version: baseVersion,
    severity,
    rule_id: ruleId,
    ruleset_id: ruleset.id,
    methodology_rule_id: resolveRuntimeRuleId(ruleset.id, ruleId),
    message,
    fixability: options?.fixability ?? 'manual',
    source: 'rule',
    ...(options?.ruleSource ? { rule_source: options.ruleSource } : {}),
    ...(options?.evidence ? { evidence: options.evidence } : {}),
    ...(options?.action ? { action: options.action } : {}),
  };
}

function flowRulesetGate(findings: FlowRuleFinding[]): FlowRulesetGate {
  const ruleset = getRuntimeRuleset('flow-authoring/strict');
  const blockers = findings.filter(
    (finding) =>
      finding.severity === 'error' ||
      finding.severity === 'blocker' ||
      isRuntimeRuleBlocker(finding.methodology_rule_id),
  );
  const status = blockers.length > 0 ? 'blocked' : findings.length > 0 ? 'needs_review' : 'passed';
  return {
    status,
    ruleset_id: ruleset.id,
    ruleset_version: ruleset.version,
    ruleset_source_version: ruleset.source_version,
    ruleset_rule_ids: ruleset.rule_ids,
    counts: {
      findings: findings.length,
      blockers: blockers.length,
    },
    blockers,
    next_action:
      status === 'blocked'
        ? 'fix_blockers'
        : status === 'needs_review'
          ? 'review_findings'
          : 'continue',
  };
}

function applyMethodologyChecks(
  flow: JsonRecord,
  flowUuidValue: string,
  baseVersion: string,
  ruleSource: string,
): FlowRuleFinding[] {
  const findings: FlowRuleFinding[] = [];
  const allowedTypes = new Set(['elementary flow', 'product flow', 'waste flow']);
  const typeOfDataset = flowType(flow).toLowerCase();
  if (typeOfDataset && !allowedTypes.has(typeOfDataset)) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'error',
        'methodology_invalid_type_of_dataset',
        'typeOfDataSet not in allowed set: Elementary flow | Product flow | Waste flow.',
        {
          evidence: {
            typeOfDataSet: flowType(flow),
          },
          ruleSource,
        },
      ),
    );
  }

  const baseNameItems = listify(
    deepGet(flow, ['flowInformation', 'dataSetInformation', 'name', 'baseName']),
  );
  const baseNameEn = langTextForLang(baseNameItems, 'en');
  if (!baseNameEn) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'warning',
        'methodology_missing_base_name_en',
        'English baseName is missing (methodology marks English as mandatory).',
        {
          fixability: 'auto',
          ruleSource,
        },
      ),
    );
  }

  if (
    baseNameItems.some((item) => {
      const text = isRecord(item) ? coerceText(item['#text']) : coerceText(item);
      return text.includes(';');
    })
  ) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'warning',
        'methodology_basename_semicolon',
        'baseName contains semicolon; methodology requires comma-separated descriptors.',
        {
          fixability: 'auto',
          ruleSource,
        },
      ),
    );
  }

  const quantId = quantitativeReferenceInternalId(flow);
  const propertyIds = new Set(
    flowProperties(flow)
      .map((prop) => coerceText(prop['@dataSetInternalID']))
      .filter(Boolean),
  );
  if (quantId && !propertyIds.has(quantId)) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'error',
        'methodology_quant_ref_missing_target',
        'referenceToReferenceFlowProperty points to a non-existing flowProperty internal ID.',
        {
          evidence: {
            referenceToReferenceFlowProperty: quantId,
            available_internal_ids: [...propertyIds].sort(),
          },
          ruleSource,
        },
      ),
    );
  }

  for (const [entries, label, idKey, maxLevel] of [
    [classificationEntries(flow), 'product_classification', 'class_id', 4],
    [elementaryClassEntries(flow), 'elementary_classification', 'cat_id', 2],
  ] as const) {
    const levels: number[] = [];
    entries.forEach((entry) => {
      const level = Number.parseInt(entry.level, 10);
      if (Number.isInteger(level)) {
        levels.push(level);
      }

      if (!coerceText(entry[idKey])) {
        findings.push(
          createRuleFinding(
            flowUuidValue,
            baseVersion,
            'warning',
            `methodology_missing_${idKey}`,
            `${label} entry has level but missing ${idKey}.`,
            {
              evidence: {
                entry,
              },
              ruleSource,
            },
          ),
        );
      }
    });

    if (levels.length) {
      const uniqueLevels = [...new Set(levels)].sort((left, right) => left - right);
      const expectedLevels: number[] = [];
      for (
        let level = uniqueLevels[0];
        level <= Math.min(maxLevel, uniqueLevels[uniqueLevels.length - 1]);
        level += 1
      ) {
        expectedLevels.push(level);
      }
      if (
        uniqueLevels[0] !== 0 ||
        JSON.stringify(uniqueLevels) !== JSON.stringify(expectedLevels)
      ) {
        findings.push(
          createRuleFinding(
            flowUuidValue,
            baseVersion,
            'warning',
            `methodology_${label}_level_gap`,
            `${label} levels should be continuous and start from 0.`,
            {
              evidence: {
                levels: uniqueLevels,
              },
              ruleSource,
            },
          ),
        );
      }
    }
  }

  return findings;
}

function buildFlowSummaryAndRuleFindings(
  doc: JsonRecord,
  methodologyRuleSource: string,
): {
  summary: FlowSummary;
  findings: FlowRuleFinding[];
} {
  const flow = flowRoot(doc);
  const flowUuidValue = flowUuid(flow) || '(missing-uuid)';
  const baseVersion = flowVersion(flow);
  const typeOfDataset = flowType(flow);
  const names = nameTexts(flow);
  const leaf = classificationLeaf(flow);
  const summary: FlowSummary = {
    flow_uuid: flowUuidValue,
    base_version: baseVersion,
    type_of_dataset: typeOfDataset,
    names: {
      primary_en: namePrimary(flow, 'en'),
      primary_zh: namePrimary(flow, 'zh'),
      all_texts: names.slice(0, 20),
    },
    classification: {
      leaf,
      path: classificationEntries(flow).slice(0, 20),
    },
    flow_property: {},
    quantitative_reference: {
      reference_flow_property_internal_id: quantitativeReferenceInternalId(flow),
    },
    unitgroup: {
      uuid: '',
      name: '',
      reference_unit_name: '',
      lookup_status: 'disabled',
      lookup_source: '',
    },
    rule_signals: [],
    similarity_candidates: [],
    _name_fingerprint: nameFingerprint(flow),
  };

  const findings: FlowRuleFinding[] = [];

  if (!typeOfDataset) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'error',
        'missing_type_of_dataset',
        'typeOfDataSet is missing under modellingAndValidation.LCIMethod.',
      ),
    );
  } else if (typeOfDataset.toLowerCase() === 'elementary flow') {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'warning',
        'elementary_flow_in_flow_qa',
        'Flow type is Elementary flow; check whether this batch should exclude it.',
        {
          fixability: 'review-needed',
          evidence: {
            typeOfDataSet: typeOfDataset,
          },
        },
      ),
    );
  }

  if (!names.length) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'warning',
        'missing_name_text',
        'No textual entries found under flowInformation.dataSetInformation.name.',
      ),
    );
  } else if (names.some((value) => value.toLowerCase().includes('emergy'))) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'warning',
        'name_contains_emergy',
        "Name subtree contains 'Emergy'.",
        {
          fixability: 'review-needed',
          evidence: {
            matched_count: names.filter((value) => value.toLowerCase().includes('emergy')).length,
          },
        },
      ),
    );
  }

  if (!leaf.key) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'warning',
        'missing_classification_leaf',
        'Classification leaf is missing.',
      ),
    );
  }

  const { prop, internalId } = pickReferenceFlowProperty(flow);
  if (!prop) {
    findings.push(
      createRuleFinding(
        flowUuidValue,
        baseVersion,
        'error',
        'missing_flow_property',
        'No flowProperties.flowProperty entry found.',
      ),
    );
  } else {
    const ref = flowPropertyRef(prop);
    summary.flow_property = {
      selected_internal_id: internalId,
      referenced_uuid: ref.uuid,
      referenced_version: ref.version,
      referenced_short_name_en: ref.short_name_en,
      available_count: flowProperties(flow).length,
    };

    if (!ref.uuid) {
      findings.push(
        createRuleFinding(
          flowUuidValue,
          baseVersion,
          'error',
          'invalid_flow_property_reference',
          'Could not parse flow property UUID from referenceToFlowPropertyDataSet.',
          {
            evidence: {
              selected_internal_id: internalId,
            },
          },
        ),
      );
    }
  }
  for (const issue of inspectFlowProperties(flow).issues) {
    findings.push(
      createRuleFinding(flowUuidValue, baseVersion, 'error', issue.code, issue.message, {
        fixability: 'review-needed',
        evidence: { path: issue.path },
      }),
    );
  }

  findings.push(...applyMethodologyChecks(flow, flowUuidValue, baseVersion, methodologyRuleSource));

  summary.rule_signals = findings.slice(0, 20).map((finding) => ({
    rule_id: coerceText(finding.rule_id),
    severity: finding.severity,
    message: coerceText(finding.message),
    evidence: finding.evidence ?? {},
  }));

  return {
    summary,
    findings,
  };
}

function buildSimilarity(
  summaries: FlowSummary[],
  threshold: number,
): {
  pairs: FlowSimilarityPair[];
  candidatesByFlow: Record<string, FlowSummary['similarity_candidates']>;
} {
  const grouped: Record<string, FlowSummary[]> = {};
  const candidatesByFlow: Record<string, FlowSummary['similarity_candidates']> = {};
  const pairs: FlowSimilarityPair[] = [];

  summaries.forEach((summary) => {
    const leafKey = summary.classification.leaf.key;
    const flowPropertyUuid = coerceText(summary.flow_property.referenced_uuid);
    const unitgroupUuid = summary.unitgroup.uuid;
    if (!leafKey || !summary._name_fingerprint) {
      return;
    }

    const key = `${leafKey}::${flowPropertyUuid}::${unitgroupUuid}`;
    grouped[key] ??= [];
    grouped[key].push(summary);
  });

  Object.entries(grouped).forEach(([key, rows]) => {
    if (rows.length < 2) {
      return;
    }

    const [classificationGroup, flowPropertyUuid, unitgroupUuid] = key.split('::');
    for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
        const left = rows[leftIndex];
        const right = rows[rightIndex];
        const similarity = computeSimilarity(left._name_fingerprint, right._name_fingerprint);
        if (similarity < threshold) {
          continue;
        }

        const pair: FlowSimilarityPair = {
          classification_group: classificationGroup,
          flow_property_uuid: flowPropertyUuid,
          unitgroup_uuid: unitgroupUuid,
          left_flow_uuid: left.flow_uuid,
          right_flow_uuid: right.flow_uuid,
          left_version: left.base_version,
          right_version: right.base_version,
          similarity: Number(similarity.toFixed(6)),
          left_name_en: left.names.primary_en,
          right_name_en: right.names.primary_en,
        };
        pairs.push(pair);

        for (const [source, target] of [
          [left, right],
          [right, left],
        ] as const) {
          candidatesByFlow[source.flow_uuid] ??= [];
          candidatesByFlow[source.flow_uuid].push({
            other_flow_uuid: target.flow_uuid,
            other_base_version: target.base_version,
            similarity: Number(similarity.toFixed(6)),
            other_name_en: target.names.primary_en,
            classification_group: classificationGroup,
          });
        }
      }
    }
  });

  Object.keys(candidatesByFlow).forEach((flowUuidValue) => {
    candidatesByFlow[flowUuidValue].sort(
      (left, right) =>
        right.similarity - left.similarity ||
        left.other_flow_uuid.localeCompare(right.other_flow_uuid),
    );
    candidatesByFlow[flowUuidValue] = candidatesByFlow[flowUuidValue].slice(0, 5);
  });

  return {
    pairs,
    candidatesByFlow,
  };
}

function parseLlmJsonOutput(output: string): JsonRecord | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? output.slice(start, end + 1) : output;

  try {
    const parsed = JSON.parse(candidate) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildLlmPrompt(batch: unknown[]): string {
  return [
    '请对以下 flow 摘要进行 LCI 复审，重点关注：',
    '1) flow property 与 quantitative reference 是否合理/一致；',
    '2) 同类别高相似度 flow 的重复/近重复风险；',
    '3) 名称、分类、typeOfDataSet 的语义一致性与明显异常。',
    '',
    '规则：',
    '- 只能依据输入摘要中的证据；',
    '- 若证据不足，必须明确写证据不足；',
    '- 对每条问题给出 flow_uuid；',
    '- 输出必须是 JSON 对象。',
    '',
    '输出格式：{findings:[{flow_uuid, severity, fixability, evidence, action}]}。',
    '',
    `输入摘要:\n${JSON.stringify(batch, null, 2)}`,
  ].join('\n');
}

function normalizeLlmFinding(
  item: JsonRecord,
  summaryByUuid: Record<string, FlowSummary>,
  fallbackFlowUuid = '',
): FlowRuleFinding | null {
  const flowUuidValue = coerceText(item.flow_uuid) || fallbackFlowUuid;
  if (!flowUuidValue) {
    return null;
  }

  const severity = (() => {
    const value = coerceText(item.severity).toLowerCase();
    if (value === 'error' || value === 'warning' || value === 'info') {
      return value;
    }
    return 'warning';
  })();

  const evidence = item.evidence;
  return {
    flow_uuid: flowUuidValue,
    base_version: summaryByUuid[flowUuidValue]?.base_version ?? '',
    severity,
    fixability: coerceText(item.fixability) || 'review-needed',
    source: 'llm',
    ...(isRecord(evidence)
      ? { evidence }
      : evidence === undefined
        ? {}
        : { evidence: { text: coerceText(evidence) } }),
    ...(coerceText(item.action) || coerceText(item.suggestion) || coerceText(item.suggested_action)
      ? {
          action:
            coerceText(item.action) ||
            coerceText(item.suggestion) ||
            coerceText(item.suggested_action),
        }
      : {}),
  };
}

async function runOptionalLlmReview(
  summaries: FlowSummary[],
  options: {
    enableLlm: boolean;
    llmModel?: string;
    llmMaxFlows: number;
    llmBatchSize: number;
    env: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
    outDir: string;
    runId: string;
  },
): Promise<FlowQaLlmRunResult> {
  if (!options.enableLlm) {
    return {
      enabled: false,
      reason: 'disabled',
      batch_count: 0,
      reviewed_flow_count: 0,
      truncated: false,
      batch_results: [],
      llmFindings: [],
    };
  }

  let env = readLlmRuntimeEnv(options.env);
  if (options.llmModel) {
    env = {
      ...env,
      model: options.llmModel,
    } satisfies LlmRuntimeEnv;
  }

  const target = options.llmMaxFlows > 0 ? summaries.slice(0, options.llmMaxFlows) : summaries;
  const batchSize = Math.max(1, options.llmBatchSize);
  const batches: FlowSummary[][] = [];
  for (let index = 0; index < target.length; index += batchSize) {
    batches.push(target.slice(index, index + batchSize));
  }

  const summaryByUuid = Object.fromEntries(
    summaries.map((summary) => [summary.flow_uuid, summary]),
  );
  const batchResults: FlowQaLlmBatchResult[] = [];
  const llmFindings: FlowRuleFinding[] = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const llmPayload = batch.map((summary) => {
      const serializable = JSON.parse(JSON.stringify(summary)) as JsonRecord & {
        _name_fingerprint?: string;
      };
      delete serializable._name_fingerprint;
      return serializable;
    });

    try {
      const response = await invokeLlm({
        env,
        input: {
          prompt: '你是严谨的LCA flow复审助手。只基于输入证据判断，不得臆造。输出必须是JSON对象。',
          context: buildLlmPrompt(llmPayload),
        },
        fetchImpl: options.fetchImpl ?? (globalThis.fetch as FetchLike),
        timeoutMs: 45_000,
        cacheDir: path.join(options.outDir, '.llm-cache'),
        tracePath: path.join(options.outDir, 'llm-trace.jsonl'),
        module: 'flow-qa',
        stage: `semantic-review-${index + 1}`,
        runId: options.runId,
      });

      const parsed = parseLlmJsonOutput(response.output);
      if (!parsed) {
        batchResults.push({
          batch_index: index + 1,
          batch_size: batch.length,
          enabled: true,
          ok: false,
          reason: 'llm_non_json_output',
          raw_preview: response.output.slice(0, 500),
        });
        continue;
      }

      const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
      rawFindings
        .filter(isRecord)
        .map((item) =>
          normalizeLlmFinding(item, summaryByUuid, batch.length === 1 ? batch[0].flow_uuid : ''),
        )
        .filter((item): item is FlowRuleFinding => item !== null)
        .forEach((item) => {
          llmFindings.push(item);
        });

      batchResults.push({
        batch_index: index + 1,
        batch_size: batch.length,
        enabled: true,
        ok: true,
      });
    } catch (error) {
      batchResults.push({
        batch_index: index + 1,
        batch_size: batch.length,
        enabled: true,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const deduped: FlowRuleFinding[] = [];
  const seen = new Set<string>();
  llmFindings.forEach((finding) => {
    const key = JSON.stringify({
      flow_uuid: finding.flow_uuid,
      severity: finding.severity,
      fixability: finding.fixability,
      evidence: finding.evidence ?? {},
      action: finding.action ?? '',
    });
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(finding);
  });

  return {
    enabled: true,
    ok: batchResults.some((item) => item.ok),
    reason: batchResults.some((item) => item.ok) ? undefined : 'all_batches_failed',
    batch_count: batches.length,
    reviewed_flow_count: target.length,
    truncated: target.length < summaries.length,
    batch_results: batchResults,
    llmFindings: deduped,
  };
}

function severityCounts(rows: FlowRuleFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  rows.forEach((row) => {
    const key = row.severity;
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function ruleCounts(rows: FlowRuleFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  rows.forEach((row) => {
    const key = coerceText(row.rule_id);
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function methodologyRuleCounts(rows: FlowRuleFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  rows.forEach((row) => {
    const key = coerceText(row.methodology_rule_id);
    if (!key) {
      return;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function readJsonObject(filePath: string): JsonRecord {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed)) {
      throw new CliError(`Expected JSON object in flow file: ${filePath}`, {
        code: 'FLOW_QA_INVALID_FLOW_FILE',
        exitCode: 2,
      });
    }
    return parsed;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(`Invalid flow JSON file: ${filePath}`, {
      code: 'FLOW_QA_INVALID_FLOW_FILE',
      exitCode: 2,
      details: String(error),
    });
  }
}

function materializeRowsFile(
  rowsFile: string,
  outDir: string,
): { flowsDir: string; summaryPath: string } {
  const rows = loadRowsFromFile(rowsFile);
  const targetDir = path.join(outDir, 'qa-input', 'flows');
  mkdirSync(targetDir, { recursive: true });

  const byKey: Record<string, JsonRecord> = {};
  let duplicateCount = 0;
  rows.forEach((row, index) => {
    const record = extractFlowRecord(row);
    const flowId = record.id || `row-${index}`;
    const version = record.version;
    const key = `${flowId}@${version}`;
    if (key in byKey) {
      duplicateCount += 1;
    }
    byKey[key] = row;
  });

  const items: Array<{ flow_key: string; primary_name: string; file: string }> = [];
  Object.entries(byKey)
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, row]) => {
      const record = extractFlowRecord(row);
      const fileName = `${record.id || key.split('@', 1)[0]}__${record.version}.json`;
      const filePath = path.join(targetDir, fileName);
      writeJsonArtifact(filePath, {
        flowDataSet: flowDatasetFromRow(row),
      });
      items.push({
        flow_key: key,
        primary_name: record.name,
        file: filePath,
      });
    });

  const summaryPath = path.join(outDir, 'qa-input', 'materialization-summary.json');
  writeJsonArtifact(summaryPath, {
    source_rows_file: path.resolve(rowsFile),
    input_row_count: rows.length,
    materialized_flow_count: Object.keys(byKey).length,
    duplicate_input_rows_collapsed: duplicateCount,
    flows_dir: targetDir,
    items,
  });

  return {
    flowsDir: targetDir,
    summaryPath,
  };
}

function resolveReviewInput(options: RunFlowQaOptions): {
  inputMode: 'rows_file' | 'flows_dir' | 'run_root';
  effectiveFlowsDir: string;
  materializationSummaryPath: string | null;
  runId: string;
  reviewInputSummary: JsonRecord;
} {
  const declaredModes = [
    Boolean(options.rowsFile),
    Boolean(options.flowsDir),
    Boolean(options.runRoot),
  ].filter(Boolean);
  if (declaredModes.length !== 1) {
    throw new CliError('Flow QA requires exactly one of --rows-file, --flows-dir, or --run-root.', {
      code: 'FLOW_QA_INPUT_MODE_REQUIRED',
      exitCode: 2,
    });
  }

  if (options.rowsFile) {
    const materialized = materializeRowsFile(options.rowsFile, options.outDir);
    return {
      inputMode: 'rows_file',
      effectiveFlowsDir: materialized.flowsDir,
      materializationSummaryPath: materialized.summaryPath,
      runId: options.runId || path.parse(options.rowsFile).name,
      reviewInputSummary: {
        input_mode: 'rows_file',
        rows_file: path.resolve(options.rowsFile),
        flows_dir: '',
        run_root: '',
        materialized_flows_dir: materialized.flowsDir,
        effective_flows_dir: materialized.flowsDir,
      },
    };
  }

  if (options.flowsDir) {
    const resolved = path.resolve(options.flowsDir);
    return {
      inputMode: 'flows_dir',
      effectiveFlowsDir: resolved,
      materializationSummaryPath: null,
      runId: options.runId || path.basename(resolved),
      reviewInputSummary: {
        input_mode: 'flows_dir',
        rows_file: '',
        flows_dir: resolved,
        run_root: '',
        materialized_flows_dir: '',
        effective_flows_dir: resolved,
      },
    };
  }

  const runRoot = path.resolve(options.runRoot!);
  const candidates = [path.join(runRoot, 'cache', 'flows'), path.join(runRoot, 'exports', 'flows')];
  const effective = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  return {
    inputMode: 'run_root',
    effectiveFlowsDir: effective,
    materializationSummaryPath: null,
    runId: options.runId || path.basename(runRoot),
    reviewInputSummary: {
      input_mode: 'run_root',
      rows_file: '',
      flows_dir: '',
      run_root: runRoot,
      materialized_flows_dir: '',
      effective_flows_dir: effective,
    },
  };
}

function listFlowFiles(flowsDir: string): string[] {
  if (!existsSync(flowsDir) || !statSync(flowsDir).isDirectory()) {
    throw new CliError(`Flow QA directory not found: ${flowsDir}`, {
      code: 'FLOW_QA_DIR_NOT_FOUND',
      exitCode: 2,
    });
  }

  return readdirSync(flowsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => path.join(flowsDir, entry))
    .filter((entry) => statSync(entry).isFile())
    .sort((left, right) => left.localeCompare(right));
}

function stripInternalSummaryFields(summary: FlowSummary): JsonRecord {
  const serializable = JSON.parse(JSON.stringify(summary)) as JsonRecord & {
    _name_fingerprint?: string;
  };
  delete serializable._name_fingerprint;
  return serializable;
}

function renderZhReview(options: {
  runId: string;
  logicVersion: string;
  flowsDir: string;
  flowSummaries: JsonRecord[];
  ruleFindings: FlowRuleFinding[];
  llmFindings: FlowRuleFinding[];
  llmResult: FlowQaLlmResult;
  mergedFindings: FlowRuleFinding[];
  summary: FlowQaReport;
}): string {
  const lines = [
    '# flow_qa_zh\n',
    `- run_id: \`${options.runId}\`\n`,
    `- logic_version: \`${options.logicVersion}\`\n`,
    `- flows_dir: \`${options.flowsDir}\`\n`,
    `- flow count: \`${options.flowSummaries.length}\`\n`,
    '- with_reference_context: `false`\n',
    `- methodology_rule_source: \`${options.summary.methodology_rule_source}\`\n`,
    '\n## 基础统计\n',
    `- rule-based findings: **${options.ruleFindings.length}**\n`,
    `- LLM findings: **${options.llmFindings.length}**\n`,
    `- merged findings: **${options.mergedFindings.length}**\n`,
  ];

  if (options.mergedFindings.length) {
    lines.push('\n### Severity 统计\n');
    Object.entries(options.summary.severity_counts).forEach(([key, value]) => {
      lines.push(`- ${key}: ${value}\n`);
    });
  }

  lines.push(
    '\n## Flow 摘要（最多展示 100 条）\n',
    '|flow uuid|version|typeOfDataSet|name(en)|class leaf|flow property|规则信号数|相似候选数|\n',
    '|---|---|---|---|---|---|---:|---:|\n',
  );

  options.flowSummaries.slice(0, 100).forEach((row) => {
    const summary = row as FlowSummary;
    lines.push(
      `|${summary.flow_uuid.replace(/\|/gu, '/')}|${summary.base_version.replace(/\|/gu, '/')}|${summary.type_of_dataset.replace(/\|/gu, '/')}|${summary.names.primary_en.replace(/\|/gu, '/')}|${summary.classification.leaf.text.replace(/\|/gu, '/')}|${coerceText(summary.flow_property.referenced_short_name_en ?? summary.flow_property.referenced_uuid).replace(/\|/gu, '/')}|${summary.rule_signals.length}|${summary.similarity_candidates.length}|\n`,
    );
  });

  lines.push('\n## LLM 语义复审层\n');
  if (!options.llmResult.enabled) {
    lines.push(`- 未启用：\`${options.llmResult.reason ?? 'disabled'}\`\n`);
  } else if (!options.llmResult.ok) {
    lines.push(`- 调用失败：\`${options.llmResult.reason ?? 'unknown'}\`\n`);
  } else if (!options.llmFindings.length) {
    lines.push('- 未返回额外语义 findings。\n');
  } else {
    if (options.llmResult.truncated) {
      lines.push(
        `- 注意：LLM 仅复审前 \`${options.llmResult.reviewed_flow_count}\` 条（受 \`--llm-max-flows\` 限制）。\n`,
      );
    }
    lines.push('\n|flow uuid|severity|fixability|evidence|action|\n|---|---|---|---|---|\n');
    options.llmFindings.slice(0, 200).forEach((finding) => {
      lines.push(
        `|${finding.flow_uuid.replace(/\|/gu, '/')}|${finding.severity.replace(/\|/gu, '/')}|${coerceText(finding.fixability).replace(/\|/gu, '/')}|${JSON.stringify(finding.evidence ?? {}).replace(/\|/gu, '/')}|${coerceText(finding.action).replace(/\|/gu, '/')}|\n`,
      );
    });
  }

  lines.push(
    '\n## 说明\n',
    '- 当前 CLI 版本保持 local-first / artifact-first，不在 qa flow 阶段接入 MCP。\n',
    '- flow property / unitgroup 的额外本地 registry 丰富暂未接入 CLI，本轮 summary 中统一标记为 disabled。\n',
  );

  return lines.join('');
}

function renderEnReview(options: {
  runId: string;
  logicVersion: string;
  flowsDir: string;
  flowCount: number;
  ruleFindingCount: number;
  llmFindingCount: number;
  llmResult: FlowQaLlmResult;
  methodologyRuleSource: string;
}): string {
  const lines = [
    '# flow_qa_en\n',
    `- run_id: \`${options.runId}\`\n`,
    `- logic_version: \`${options.logicVersion}\`\n`,
    `- flows_dir: \`${options.flowsDir}\`\n`,
    `- flow count: \`${options.flowCount}\`\n`,
    '- with_reference_context: `false`\n',
    `- methodology_rule_source: \`${options.methodologyRuleSource}\`\n`,
    '\n## Summary\n',
    `- rule-based findings: **${options.ruleFindingCount}**\n`,
    `- llm findings: **${options.llmFindingCount}**\n`,
  ];

  if (!options.llmResult.enabled) {
    lines.push(`- LLM disabled: \`${options.llmResult.reason ?? 'disabled'}\`\n`);
  } else if (!options.llmResult.ok) {
    lines.push(`- LLM failed: \`${options.llmResult.reason ?? 'unknown'}\`\n`);
  } else if (options.llmResult.truncated) {
    lines.push(
      `- LLM reviewed only the first \`${options.llmResult.reviewed_flow_count}\` flows due to \`--llm-max-flows\`.\n`,
    );
  }

  return lines.join('');
}

function renderTimingReview(options: {
  runId: string;
  startTs?: string;
  endTs?: string;
  flowCount: number;
}): string {
  const lines = ['# flow_qa_timing\n', `- run_id: \`${options.runId}\`\n`];
  if (options.startTs) {
    lines.push(`- start: \`${options.startTs}\`\n`);
  }
  if (options.endTs) {
    lines.push(`- end: \`${options.endTs}\`\n`);
  }
  if (options.startTs && options.endTs) {
    const started = Date.parse(options.startTs);
    const ended = Date.parse(options.endTs);
    if (Number.isFinite(started) && Number.isFinite(ended)) {
      lines.push(`- total elapsed: **${((ended - started) / 60_000).toFixed(2)} min**\n`);
    }
  }
  lines.push(`- flow files reviewed: \`${options.flowCount}\`\n`);
  lines.push(
    '- major time consumers: flow JSON parsing, similarity grouping, optional LLM review batches.\n',
  );
  return lines.join('');
}

export async function runFlowQa(options: RunFlowQaOptions): Promise<FlowQaReport> {
  if (!options.outDir.trim()) {
    throw new CliError('Missing required --out-dir value.', {
      code: 'FLOW_QA_OUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }

  const outDir = path.resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });

  const resolvedInput = resolveReviewInput({
    ...options,
    outDir,
  });
  const flowFiles = listFlowFiles(resolvedInput.effectiveFlowsDir);
  if (!flowFiles.length) {
    throw new CliError(`No flow JSON files found in ${resolvedInput.effectiveFlowsDir}`, {
      code: 'FLOW_QA_NO_FLOW_FILES',
      exitCode: 2,
    });
  }

  const methodologyRuleSource = options.methodologyId?.trim() || 'built_in';
  const ruleFindings: FlowRuleFinding[] = [];
  const flowSummaries: FlowSummary[] = [];

  flowFiles.forEach((filePath) => {
    const doc = readJsonObject(filePath);
    const { summary, findings } = buildFlowSummaryAndRuleFindings(doc, methodologyRuleSource);
    summary.source_file = path.basename(filePath);
    flowSummaries.push(summary);
    ruleFindings.push(...findings);
  });

  const similarity = buildSimilarity(flowSummaries, options.similarityThreshold ?? 0.92);
  flowSummaries.forEach((summary) => {
    summary.similarity_candidates = similarity.candidatesByFlow[summary.flow_uuid] ?? [];
    if (!summary.similarity_candidates.length) {
      return;
    }

    ruleFindings.push(
      createRuleFinding(
        summary.flow_uuid,
        summary.base_version,
        'warning',
        'same_category_high_similarity',
        'Another flow in the same classification/flowProperty/unitgroup group is highly similar.',
        {
          fixability: 'review-needed',
          evidence: {
            candidates: summary.similarity_candidates.slice(0, 3),
          },
        },
      ),
    );
  });

  const llmRun = await runOptionalLlmReview(flowSummaries, {
    enableLlm: Boolean(options.enableLlm),
    llmModel: options.llmModel,
    llmMaxFlows: options.llmMaxFlows ?? 120,
    llmBatchSize: options.llmBatchSize ?? 20,
    env: options.env ?? process.env,
    fetchImpl: options.fetchImpl,
    outDir,
    runId: resolvedInput.runId,
  });

  const llmResult: FlowQaLlmResult = {
    enabled: llmRun.enabled,
    ...(llmRun.ok === undefined ? {} : { ok: llmRun.ok }),
    ...(llmRun.reason ? { reason: llmRun.reason } : {}),
    batch_count: llmRun.batch_count,
    reviewed_flow_count: llmRun.reviewed_flow_count,
    truncated: llmRun.truncated,
    batch_results: llmRun.batch_results,
  };
  const mergedFindings = [...ruleFindings, ...llmRun.llmFindings];
  const rulesetGate = flowRulesetGate(ruleFindings);
  const savedSummaries = flowSummaries.map((summary) => stripInternalSummaryFields(summary));
  const now = options.now ?? (() => new Date());

  const reviewInputSummaryPath = path.join(outDir, 'qa-input-summary.json');
  const ruleFindingsPath = path.join(outDir, 'rule_findings.jsonl');
  const llmFindingsPath = path.join(outDir, 'llm_findings.jsonl');
  const findingsPath = path.join(outDir, 'findings.jsonl');
  const rulesetGatePath = path.join(outDir, 'flow-qa-ruleset-gate.json');
  const flowSummariesPath = path.join(outDir, 'flow_summaries.jsonl');
  const similarityPairsPath = path.join(outDir, 'similarity_pairs.jsonl');
  const summaryPath = path.join(outDir, 'flow_qa_summary.json');
  const reviewZhPath = path.join(outDir, 'flow_qa_zh.md');
  const reviewEnPath = path.join(outDir, 'flow_qa_en.md');
  const timingPath = path.join(outDir, 'flow_qa_timing.md');
  const reportPath = path.join(outDir, 'flow_qa_report.json');

  writeJsonArtifact(reviewInputSummaryPath, resolvedInput.reviewInputSummary);
  writeJsonLinesArtifact(ruleFindingsPath, ruleFindings);
  writeJsonLinesArtifact(llmFindingsPath, llmRun.llmFindings);
  writeJsonLinesArtifact(findingsPath, mergedFindings);
  writeJsonArtifact(rulesetGatePath, rulesetGate);
  writeJsonLinesArtifact(flowSummariesPath, savedSummaries);
  writeJsonLinesArtifact(similarityPairsPath, similarity.pairs);

  const report: FlowQaReport = {
    schema_version: 1,
    generated_at_utc: now().toISOString(),
    status: 'completed_local_flow_qa',
    run_id: resolvedInput.runId,
    out_dir: outDir,
    rows_file: reportRowsFile(resolvedInput.reviewInputSummary.rows_file),
    input_mode: resolvedInput.inputMode,
    effective_flows_dir: resolvedInput.effectiveFlowsDir,
    logic_version: options.logicVersion?.trim() || 'flow-v1.0-cli',
    ruleset_id: rulesetGate.ruleset_id,
    ruleset_version: rulesetGate.ruleset_version,
    ruleset_source_version: rulesetGate.ruleset_source_version,
    ruleset_rule_ids: rulesetGate.ruleset_rule_ids,
    flow_count: flowSummaries.length,
    similarity_threshold: options.similarityThreshold ?? 0.92,
    methodology_rule_source: methodologyRuleSource,
    with_reference_context: false,
    reference_context_mode: 'disabled',
    rule_finding_count: ruleFindings.length,
    llm_finding_count: llmRun.llmFindings.length,
    finding_count: mergedFindings.length,
    blocker_count: rulesetGate.counts.blockers,
    severity_counts: severityCounts(mergedFindings),
    rule_counts: ruleCounts(ruleFindings),
    methodology_rule_counts: methodologyRuleCounts(ruleFindings),
    ruleset_gate: rulesetGate,
    llm: llmResult,
    files: {
      qa_input_summary: reviewInputSummaryPath,
      materialization_summary: resolvedInput.materializationSummaryPath,
      rule_findings: ruleFindingsPath,
      llm_findings: llmFindingsPath,
      findings: findingsPath,
      ruleset_gate: rulesetGatePath,
      flow_summaries: flowSummariesPath,
      similarity_pairs: similarityPairsPath,
      summary: summaryPath,
      qa_zh: reviewZhPath,
      qa_en: reviewEnPath,
      timing: timingPath,
      report: reportPath,
    },
  };

  writeJsonArtifact(summaryPath, {
    run_id: report.run_id,
    logic_version: report.logic_version,
    flow_count: report.flow_count,
    with_reference_context: report.with_reference_context,
    reference_context_mode: report.reference_context_mode,
    similarity_threshold: report.similarity_threshold,
    methodology_rule_source: report.methodology_rule_source,
    ruleset_id: report.ruleset_id,
    ruleset_version: report.ruleset_version,
    ruleset_source_version: report.ruleset_source_version,
    ruleset_rule_ids: report.ruleset_rule_ids,
    ruleset_gate: report.ruleset_gate,
    rule_finding_count: report.rule_finding_count,
    llm_finding_count: report.llm_finding_count,
    finding_count: report.finding_count,
    severity_counts: report.severity_counts,
    rule_counts: report.rule_counts,
    methodology_rule_counts: report.methodology_rule_counts,
    llm: report.llm,
  });
  writeTextArtifact(
    reviewZhPath,
    renderZhReview({
      runId: report.run_id,
      logicVersion: report.logic_version,
      flowsDir: report.effective_flows_dir,
      flowSummaries: savedSummaries,
      ruleFindings,
      llmFindings: llmRun.llmFindings,
      llmResult,
      mergedFindings,
      summary: report,
    }),
  );
  writeTextArtifact(
    reviewEnPath,
    renderEnReview({
      runId: report.run_id,
      logicVersion: report.logic_version,
      flowsDir: report.effective_flows_dir,
      flowCount: report.flow_count,
      ruleFindingCount: report.rule_finding_count,
      llmFindingCount: report.llm_finding_count,
      llmResult,
      methodologyRuleSource: report.methodology_rule_source,
    }),
  );
  writeTextArtifact(
    timingPath,
    renderTimingReview({
      runId: report.run_id,
      startTs: options.startTs,
      endTs: options.endTs,
      flowCount: report.flow_count,
    }),
  );
  writeJsonArtifact(reportPath, report);

  return report;
}

function reportRowsFile(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export const __testInternals = {
  applyMethodologyChecks,
  buildFlowSummaryAndRuleFindings,
  buildSimilarity,
  buildLlmPrompt,
  classificationLeaf,
  computeSimilarity,
  createRuleFinding,
  findUuidInNode,
  flowRoot,
  langTextForLang,
  listFlowFiles,
  materializeRowsFile,
  nameFingerprint,
  normalizeLlmFinding,
  parseLlmJsonOutput,
  readJsonObject,
  renderEnReview,
  renderTimingReview,
  renderZhReview,
  reportRowsFile,
  resolveReviewInput,
  runOptionalLlmReview,
  flowRulesetGate,
  methodologyRuleCounts,
  ruleCounts,
  severityCounts,
  walkStrings,
};
