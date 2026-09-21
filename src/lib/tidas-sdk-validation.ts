export type SafeParseIssue = {
  code?: string;
  message?: string;
  path?: Array<string | number>;
  errors?: SafeParseIssue[][];
};

export type SafeParseResult =
  | {
      success: true;
      data?: unknown;
    }
  | {
      success: false;
      error?: {
        issues?: SafeParseIssue[];
      };
    };

export type SafeParseSchema = {
  safeParse: (value: unknown) => SafeParseResult;
};

export type EntityValidationConfig = {
  mode: 'strict';
  throwOnError: false;
  deepValidation: boolean;
};

export type SdkValidationEntity = {
  validateEnhanced?: () => unknown;
  validate?: () => unknown;
};

export type SdkValidationFactory = (
  data?: unknown,
  validationConfig?: EntityValidationConfig,
) => SdkValidationEntity | unknown;

export type SchemaValidationOutcome =
  | {
      success: true;
      issues: [];
      result: SafeParseResult;
    }
  | {
      success: false;
      issues: SafeParseIssue[];
      result: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIssueLike(value: unknown): value is SafeParseIssue {
  return isRecord(value);
}

function issueArray(value: unknown): SafeParseIssue[] {
  return Array.isArray(value) ? value.filter(isIssueLike) : [];
}

export function validationSucceeded(result: unknown): boolean {
  return isRecord(result) && result.success === true;
}

export function validationIssues(result: unknown): SafeParseIssue[] {
  if (!isRecord(result)) {
    return [];
  }

  const error = isRecord(result.error) ? result.error : null;
  const errorIssues = issueArray(error?.issues);
  if (errorIssues.length > 0) {
    return errorIssues;
  }

  return issueArray(result.validationIssues);
}

export function normalizeIssuePath(
  pathParts: Array<string | number> | undefined,
  separator = '.',
): string {
  if (!Array.isArray(pathParts) || pathParts.length === 0) {
    return '<root>';
  }
  return pathParts.map((part) => String(part)).join(separator);
}

export function runEntityValidation(entity: unknown): unknown | null {
  if (!isRecord(entity)) {
    return null;
  }

  if (typeof entity.validateEnhanced === 'function') {
    return entity.validateEnhanced();
  }

  if (typeof entity.validate === 'function') {
    return entity.validate();
  }

  return null;
}

export function validateEntityWithDeepFallback(
  payload: unknown,
  createEntity: SdkValidationFactory,
): unknown | null {
  const fastEntity = createEntity(payload, {
    mode: 'strict',
    throwOnError: false,
    deepValidation: false,
  });
  const fastResult = runEntityValidation(fastEntity);
  if (validationSucceeded(fastResult)) {
    return fastResult;
  }

  const deepEntity = createEntity(payload, {
    mode: 'strict',
    throwOnError: false,
    deepValidation: true,
  });
  return runEntityValidation(deepEntity) ?? fastResult;
}

export function validateSchemaWithDeepFallback(
  schema: SafeParseSchema,
  payload: unknown,
  createEntity?: SdkValidationFactory | null,
): SchemaValidationOutcome {
  const fastResult = schema.safeParse(payload);
  if (fastResult.success) {
    return {
      success: true,
      issues: [],
      result: fastResult,
    };
  }

  const fastIssues = validationIssues(fastResult);

  if (!createEntity) {
    return {
      success: false,
      issues: fastIssues,
      result: fastResult,
    };
  }

  try {
    const deepResult = validateEntityWithDeepFallback(payload, createEntity);
    const deepIssues = validationIssues(deepResult);
    if (!validationSucceeded(deepResult) && (deepIssues.length > 0 || fastIssues.length === 0)) {
      return {
        success: false,
        issues: deepIssues,
        result: deepResult,
      };
    }
  } catch {
    // Keep the existing schema error path if SDK entity validation itself fails.
  }

  return {
    success: false,
    issues: fastIssues,
    result: fastResult,
  };
}
