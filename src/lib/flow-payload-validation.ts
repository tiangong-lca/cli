import { collectDatasetNameIssues } from './dataset-name-validation.js';
import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import {
  normalizeIssuePath,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';

type JsonObject = Record<string, unknown>;

export const FLOW_SCHEMA_VALIDATOR = '@tiangong-lca/tidas-sdk/FlowSchema';

export type FlowPayloadValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type FlowPayloadValidationResult =
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
      issues: FlowPayloadValidationIssue[];
    };

function getFlowSchema(
  sdk: { FlowSchema?: SafeParseSchema } = tidasSdk as { FlowSchema?: SafeParseSchema },
): SafeParseSchema {
  const schema = sdk.FlowSchema;
  if (!schema?.safeParse) {
    throw new Error(`${FLOW_SCHEMA_VALIDATOR} is unavailable in the published CLI runtime.`);
  }
  return schema;
}

function getFlowFactory(sdk: { createFlow?: unknown } = tidasSdk): SdkValidationFactory | null {
  const createFlow = sdk.createFlow;
  return typeof createFlow === 'function' ? (createFlow as SdkValidationFactory) : null;
}

export function summarizeFlowPayloadValidation(result: FlowPayloadValidationResult): string {
  if (result.ok) {
    return 'local FlowSchema validation passed';
  }

  const preview = result.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return `local FlowSchema validation failed with ${result.issue_count} issue(s)${preview ? ` (${preview})` : ''}`;
}

export function validateFlowPayload(
  payload: JsonObject,
  schema: SafeParseSchema = getFlowSchema(),
  createEntity: SdkValidationFactory | null = getFlowFactory(),
): FlowPayloadValidationResult {
  const nameIssues = collectDatasetNameIssues(payload, 'flow');
  const outcome = validateSchemaWithDeepFallback(schema, payload, createEntity);
  if (outcome.success && nameIssues.length === 0) {
    return {
      ok: true,
      validator: FLOW_SCHEMA_VALIDATOR,
      issue_count: 0,
      issues: [],
    };
  }

  const issues = [
    ...outcome.issues.map((issue) => ({
      path: normalizeIssuePath(issue.path),
      message: issue.message ?? 'Validation failed',
      code: issue.code ?? 'custom',
    })),
    ...nameIssues,
  ];

  return {
    ok: false,
    validator: FLOW_SCHEMA_VALIDATOR,
    issue_count: issues.length,
    issues,
  };
}

export const __testInternals = {
  getFlowSchema,
  getFlowFactory,
};
