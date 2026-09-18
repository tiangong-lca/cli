import * as tidasSdk from '@tiangong-lca/tidas-sdk';
import {
  normalizeIssuePath,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';
import { withOptionalReviewReportReference } from './tidas-review-report-optionality.js';
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

export type ProcessPayloadValidationResult =
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
    };

function getProcessSchema(): SafeParseSchema {
  const schema = (tidasSdk as { ProcessSchema?: SafeParseSchema }).ProcessSchema;
  if (!schema?.safeParse) {
    throw new Error(`${PROCESS_SCHEMA_VALIDATOR} is unavailable in the published CLI runtime.`);
  }
  return withOptionalReviewReportReference(schema, 'processes');
}

function getProcessFactory(
  sdk: { createProcess?: unknown } = tidasSdk,
): SdkValidationFactory | null {
  const createProcess = sdk.createProcess;
  return typeof createProcess === 'function' ? (createProcess as SdkValidationFactory) : null;
}

export function summarizeProcessPayloadValidation(result: ProcessPayloadValidationResult): string {
  if (result.ok) {
    return 'local ProcessSchema validation passed';
  }

  const preview = result.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return `local ProcessSchema validation failed with ${result.issue_count} issue(s)${preview ? ` (${preview})` : ''}`;
}

export function validateProcessPayload(
  payload: JsonObject,
  schema: SafeParseSchema = getProcessSchema(),
  createEntity: SdkValidationFactory | null = getProcessFactory(),
): ProcessPayloadValidationResult {
  const outcome = validateSchemaWithDeepFallback(schema, payload, createEntity);
  const requiredFieldIssues = collectProcessRequiredFieldIssues(payload);
  const placeholderIssues = collectProcessPlaceholderIssues(payload);

  if (outcome.success && requiredFieldIssues.length === 0 && placeholderIssues.length === 0) {
    return {
      ok: true,
      validator: PROCESS_SCHEMA_VALIDATOR,
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
    ...requiredFieldIssues,
    ...placeholderIssues,
  ];

  return {
    ok: false,
    validator: PROCESS_SCHEMA_VALIDATOR,
    issue_count: issues.length,
    issues,
  };
}

export const __testInternals = {
  getProcessFactory,
};
