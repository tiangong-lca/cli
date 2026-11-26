export type SafeParseIssue = {
  code?: string;
  message?: string;
  path?: Array<string | number>;
  errors?: SafeParseIssue[][];
  params?: Record<string, unknown>;
};

export const DUPLICATE_LANGUAGE_ENTRY = 'duplicate_language_entry';

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

export function isDuplicateLanguageIssue(issue: SafeParseIssue): boolean {
  return (
    issue.code === DUPLICATE_LANGUAGE_ENTRY ||
    (issue.code === 'custom' && issue.params?.validationCode === DUPLICATE_LANGUAGE_ENTRY)
  );
}

function collectDuplicateLanguageIssues(
  issues: SafeParseIssue[],
  parent: Array<string | number> = [],
  duplicates = new Map<string, SafeParseIssue>(),
): Map<string, SafeParseIssue> {
  for (const issue of issues) {
    const path = [...parent, ...(issue.path ?? [])];
    if (isDuplicateLanguageIssue(issue)) {
      duplicates.set(JSON.stringify(path), { ...issue, path, code: DUPLICATE_LANGUAGE_ENTRY });
    }
    // The paths inside a Zod union are relative to its enclosing issue.
    if (issue.errors) collectDuplicateLanguageIssues(issue.errors.flat(), path, duplicates);
  }
  return duplicates;
}

export function validationSucceeded(result: unknown): boolean {
  return isRecord(result) && result.success === true;
}

export function validationIssues(result: unknown): SafeParseIssue[] {
  if (!isRecord(result)) {
    return [];
  }

  const error = isRecord(result.error) ? result.error : null;
  const rawIssues = issueArray(error?.issues);
  const issues = rawIssues.length > 0 ? rawIssues : issueArray(result.validationIssues);
  const duplicates = collectDuplicateLanguageIssues(issues);
  const otherIssues = issues.filter(
    (issue) =>
      !isDuplicateLanguageIssue(issue) &&
      !(
        issue.params?.jsonSchemaKeyword === 'uniqueItems' &&
        duplicates.has(JSON.stringify([...(issue.path ?? []), '@xml:lang']))
      ),
  );
  return [
    ...otherIssues.map((issue) =>
      issue.params?.validationCode === 'process_exchange_amount_conflict'
        ? { ...issue, code: 'process_exchange_amount_conflict' }
        : issue,
    ),
    ...duplicates.values(),
  ];
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
  const hasIndexedFastIssue = fastIssues.some((issue) =>
    issue.path?.some((part) => typeof part === 'number'),
  );

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
    if (
      !hasIndexedFastIssue &&
      !validationSucceeded(deepResult) &&
      (deepIssues.length > 0 || fastIssues.length === 0)
    ) {
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
