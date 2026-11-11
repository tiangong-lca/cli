import * as sdk from '@tiangong-lca/tidas-sdk';
import {
  datasetKinds,
  requireContent,
  type DatasetType,
  type JsonObject,
  type DatasetPorts,
} from '../application/dataset-types.js';
import { readDatasetContract } from '../lib/dataset/contract.js';
import { runDatasetValidate } from '../lib/dataset/validate.js';
import {
  validateSchemaWithDeepFallback,
  type SafeParseSchema,
  type SdkValidationFactory,
} from '../lib/validation/tidas-sdk-validation.js';

const schemas = {
  flow: 'Flow',
  process: 'Process',
  model: 'LifeCycleModel',
  source: 'Source',
  contact: 'Contact',
  flowproperty: 'FlowProperty',
  unitgroup: 'UnitGroup',
  lciamethod: 'LCIAMethod',
} as const;
export const datasetContract: DatasetPorts['contract'] = async (type, include) => {
  const loaded = await readDatasetContract(datasetKinds[type], include.join(','));
  const pack = loaded.pack;
  return {
    source: loaded.source,
    manifest: pack.manifest,
    components: {
      schema: pack.schemaText ?? null,
      methodology: pack.methodologyText ?? null,
      ruleset: pack.runtimeRuleset ?? null,
    },
    unavailable: include.filter(
      (key) =>
        ({
          schema: pack.schemaText,
          methodology: pack.methodologyText,
          ruleset: pack.runtimeRuleset,
        })[key as 'schema'] == null,
    ),
  };
};
export const datasetValidation: DatasetPorts['validate'] = async (
  type: DatasetType,
  content: JsonObject,
  checks: string[],
) => {
  requireContent(type, content);
  if (checks.includes('business') && type !== 'lciamethod') {
    const report = await runDatasetValidate({
      inputPath: '<content>',
      type: datasetKinds[type],
      rawInput: content,
    });
    const row = report.rows[0]!;
    return {
      ...row,
      status:
        row.allocation_semantics?.status === 'unresolved'
          ? 'incomplete'
          : row.status === 'valid'
            ? 'passed'
            : 'failed',
      checks,
      notChecked: ['remote_references'],
    };
  }
  const exports = sdk as unknown as Record<string, unknown>;
  const parsed = validateSchemaWithDeepFallback(
    exports[`${schemas[type]}Schema`] as SafeParseSchema,
    structuredClone(content),
    exports[`create${schemas[type]}`] as SdkValidationFactory,
  );
  return {
    status: parsed.success ? 'passed' : 'failed',
    validator: `@tiangong-lca/tidas-sdk/${schemas[type]}Schema`,
    checks,
    issues: parsed.success ? [] : parsed.issues,
    notChecked: ['business', 'remote_references'],
  };
};
