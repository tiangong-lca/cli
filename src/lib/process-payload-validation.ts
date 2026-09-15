import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import { sha256Json } from './dataset-maintenance-contract.js';
import {
  normalizeIssuePath,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';
import {
  collectProcessPlaceholderIssues,
  collectProcessRequiredFieldIssues,
} from './process-required-fields.js';

type JsonObject = Record<string, unknown>;

const PROCESS_SCHEMA_VALIDATOR =
  '@tiangong-lca/tidas-sdk/ProcessSchema+tiangong/process-authoring-required-fields';

export type ProcessPayloadValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type ProcessValidationLayers = {
  payload_sha256: string;
  schema: { ok: boolean; issues: ProcessPayloadValidationIssue[] };
  authoring: { ok: boolean; issues: ProcessPayloadValidationIssue[] };
  content: { ok: boolean; issues: ProcessPayloadValidationIssue[] };
};

export type ProcessPayloadValidationResult = { validation_layers?: ProcessValidationLayers } & (
  | {
      ok: true;
      validator: string;
      issue_count: 0;
      issues: [];
    }
  | {
      ok: false;
      validator: string;
      issue_count: number;
      issues: ProcessPayloadValidationIssue[];
    }
);

function getProcessSchema(): SafeParseSchema {
  const schema = (tidasSdk as { ProcessSchema?: SafeParseSchema }).ProcessSchema;
  if (!schema?.safeParse) {
    throw new Error(`${PROCESS_SCHEMA_VALIDATOR} is unavailable in the published CLI runtime.`);
  }
  return schema;
}

function getProcessFactory(
  sdk: { createProcess?: unknown } = tidasSdk,
): SdkValidationFactory | null {
  const createProcess = sdk.createProcess;
  return typeof createProcess === 'function' ? (createProcess as SdkValidationFactory) : null;
}

export function summarizeProcessPayloadValidation(result: ProcessPayloadValidationResult): string {
  if (result.ok) {
    return 'local process validation passed';
  }

  const preview = result.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return `local process validation failed with ${result.issue_count} issue(s)${preview ? ` (${preview})` : ''}`;
}

export function validateProcessPayload(
  payload: JsonObject,
  schema: SafeParseSchema = getProcessSchema(),
  createEntity: SdkValidationFactory | null = getProcessFactory(),
): ProcessPayloadValidationResult & { validation_layers: ProcessValidationLayers } {
  const payloadSha256 = sha256Json(payload);
  const outcome = validateSchemaWithDeepFallback(schema, structuredClone(payload), createEntity);
  const requiredFieldIssues = collectProcessRequiredFieldIssues(payload);
  const placeholderIssues = collectProcessPlaceholderIssues(payload);
  const schemaIssues = outcome.issues.map((issue) => ({
    path: normalizeIssuePath(issue.path),
    message: issue.message ?? 'Validation failed',
    code: issue.code ?? 'custom',
  }));
  const validationLayers: ProcessValidationLayers = {
    payload_sha256: payloadSha256,
    schema: { ok: outcome.success, issues: schemaIssues },
    authoring: { ok: requiredFieldIssues.length === 0, issues: requiredFieldIssues },
    content: { ok: placeholderIssues.length === 0, issues: placeholderIssues },
  };

  if (outcome.success && requiredFieldIssues.length === 0 && placeholderIssues.length === 0) {
    return {
      ok: true,
      validator: PROCESS_SCHEMA_VALIDATOR,
      issue_count: 0,
      issues: [],
      validation_layers: validationLayers,
    };
  }

  const issues = [...schemaIssues, ...requiredFieldIssues, ...placeholderIssues];

  return {
    ok: false,
    validator: PROCESS_SCHEMA_VALIDATOR,
    issue_count: issues.length,
    issues,
    validation_layers: validationLayers,
  };
}

export const __testInternals = {
  getProcessFactory,
};
