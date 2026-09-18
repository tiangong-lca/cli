import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  type SafeParseIssue,
  type SafeParseSchema,
  type SdkValidationFactory,
  validateSchemaWithDeepFallback,
} from './tidas-sdk-validation.js';
import { withOptionalReviewReportReference } from './tidas-review-report-optionality.js';
import { TIDAS_LANGUAGE_CODE_SET } from './tidas-languages.js';

type JsonObject = Record<string, unknown>;

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationIssue = {
  issue_code: string;
  severity: ValidationSeverity;
  category: string;
  file_path: string;
  message: string;
  location: string;
  context: Record<string, unknown>;
};

type ValidationSummary = {
  issue_count: number;
  error_count: number;
  warning_count: number;
  info_count: number;
};

type CategoryValidationReport = {
  category: string;
  ok: boolean;
  summary: ValidationSummary;
  issues: ValidationIssue[];
};

export type PackageValidationReport = {
  input_dir: string;
  ok: boolean;
  summary: ValidationSummary & { category_count: number };
  categories: CategoryValidationReport[];
  issues: ValidationIssue[];
};

type SupportedCategory =
  | 'contacts'
  | 'flowproperties'
  | 'flows'
  | 'lciamethods'
  | 'lifecyclemodels'
  | 'processes'
  | 'sources'
  | 'unitgroups';

type TidasSdkPublicModule = {
  ContactSchema?: SafeParseSchema;
  FlowPropertySchema?: SafeParseSchema;
  FlowSchema?: SafeParseSchema;
  LCIAMethodSchema?: SafeParseSchema;
  LifeCycleModelSchema?: SafeParseSchema;
  ProcessSchema?: SafeParseSchema;
  SourceSchema?: SafeParseSchema;
  UnitGroupSchema?: SafeParseSchema;
  createContact?: SdkValidationFactory;
  createFlowProperty?: SdkValidationFactory;
  createFlow?: SdkValidationFactory;
  createLCIAMethod?: SdkValidationFactory;
  createLifeCycleModel?: SdkValidationFactory;
  createProcess?: SdkValidationFactory;
  createSource?: SdkValidationFactory;
  createUnitGroup?: SdkValidationFactory;
};

const SUPPORTED_CATEGORIES: SupportedCategory[] = [
  'contacts',
  'flowproperties',
  'flows',
  'lciamethods',
  'lifecyclemodels',
  'processes',
  'sources',
  'unitgroups',
];

const CATEGORY_SCHEMA_EXPORTS: Record<SupportedCategory, keyof TidasSdkPublicModule> = {
  contacts: 'ContactSchema',
  flowproperties: 'FlowPropertySchema',
  flows: 'FlowSchema',
  lciamethods: 'LCIAMethodSchema',
  lifecyclemodels: 'LifeCycleModelSchema',
  processes: 'ProcessSchema',
  sources: 'SourceSchema',
  unitgroups: 'UnitGroupSchema',
};

const CATEGORY_FACTORY_EXPORTS: Record<SupportedCategory, keyof TidasSdkPublicModule> = {
  contacts: 'createContact',
  flowproperties: 'createFlowProperty',
  flows: 'createFlow',
  lciamethods: 'createLCIAMethod',
  lifecyclemodels: 'createLifeCycleModel',
  processes: 'createProcess',
  sources: 'createSource',
  unitgroups: 'createUnitGroup',
};

const CHINESE_CHARACTER_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;

function summarizeIssues(issues: ValidationIssue[]): ValidationSummary {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const infoCount = issues.filter((issue) => issue.severity === 'info').length;

  return {
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
  };
}

function buildCategoryReport(
  category: string,
  issues: ValidationIssue[],
): CategoryValidationReport {
  return {
    category,
    ok: issues.length === 0,
    summary: summarizeIssues(issues),
    issues,
  };
}

function buildPackageReport(
  inputDir: string,
  categoryReports: CategoryValidationReport[],
): PackageValidationReport {
  const issues = categoryReports.flatMap((report) => report.issues);
  const summary = summarizeIssues(issues);

  return {
    input_dir: inputDir,
    ok: issues.length === 0,
    summary: {
      category_count: categoryReports.length,
      ...summary,
    },
    categories: categoryReports,
    issues,
  };
}

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function toLocation(pathParts: Array<string | number> | undefined): string {
  if (!Array.isArray(pathParts) || pathParts.length === 0) {
    return '<root>';
  }
  return pathParts.join('/');
}

function createInvalidJsonIssue(
  category: string,
  filePath: string,
  error: unknown,
): ValidationIssue {
  return {
    issue_code: 'invalid_json',
    severity: 'error',
    category,
    file_path: filePath,
    location: '<root>',
    message: `Invalid JSON: ${
      error instanceof Error ? error.name : 'Error'
    }: ${error instanceof Error ? error.message : String(error)}`,
    context: {},
  };
}

function createValidationErrorIssue(
  category: string,
  filePath: string,
  error: unknown,
): ValidationIssue {
  return {
    issue_code: 'validation_error',
    severity: 'error',
    category,
    file_path: filePath,
    location: '<root>',
    message: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
    context: {},
  };
}

function createSchemaIssue(
  category: string,
  filePath: string,
  issue: SafeParseIssue,
): ValidationIssue {
  const location = toLocation(issue.path);
  return {
    issue_code: 'schema_error',
    severity: 'error',
    category,
    file_path: filePath,
    location,
    message: `Schema Error at ${location}: ${issue.message ?? 'Validation failed'}`,
    context: {
      validator: issue.code ?? 'custom',
    },
  };
}

function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const deduped: ValidationIssue[] = [];

  for (const issue of issues) {
    const key = `${issue.issue_code}|${issue.file_path}|${issue.location}|${issue.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(issue);
  }

  return deduped;
}

function makeIssue(
  category: string,
  filePath: string,
  location: string,
  message: string,
  issueCode = 'schema_error',
): ValidationIssue {
  return {
    issue_code: issueCode,
    severity: 'error',
    category,
    file_path: filePath,
    location,
    message,
    context: {},
  };
}

export function validateElementaryFlowsClassificationHierarchy(
  classItems: Array<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];

  classItems.forEach((item, index) => {
    const level = Number(item['@level']);
    if (level !== index) {
      errors.push(
        `Elementary flow classification level sorting error: at index ${index}, expected level ${index}, got ${level}`,
      );
    }
  });

  for (let index = 1; index < classItems.length; index += 1) {
    const parentId = String(classItems[index - 1]?.['@catId'] ?? '');
    const childId = String(classItems[index]?.['@catId'] ?? '');
    if (!childId.startsWith(parentId)) {
      errors.push(
        `Elementary flow classification code error: child code '${childId}' does not start with parent code '${parentId}'`,
      );
    }
  }

  return errors;
}

export function validateProductFlowsClassificationHierarchy(
  classItems: Array<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];

  classItems.forEach((item, index) => {
    const level = Number(item['@level']);
    if (level !== index) {
      errors.push(
        `Product flow classification level sorting error: at index ${index}, expected level ${index}, got ${level}`,
      );
    }
  });

  for (let index = 1; index < classItems.length; index += 1) {
    const parentId = String(classItems[index - 1]?.['@classId'] ?? '');
    const childId = String(classItems[index]?.['@classId'] ?? '');
    if (!childId.startsWith(parentId)) {
      errors.push(
        `Product flow classification code error: child code '${childId}' does not start with parent code '${parentId}'`,
      );
    }
  }

  return errors;
}

export function validateProcessesClassificationHierarchy(
  classItems: Array<Record<string, unknown>>,
): string[] {
  const errors: string[] = [];
  const level0ToLevel1Mapping: Record<string, string[]> = {
    A: ['01', '02', '03'],
    B: ['05', '06', '07', '08', '09'],
    C: Array.from({ length: 24 }, (_, index) => String(index + 10).padStart(2, '0')),
    D: ['35'],
    E: ['36', '37', '38', '39'],
    F: ['41', '42', '43'],
    G: ['46', '47'],
    H: ['49', '50', '51', '52', '53'],
    I: ['55', '56'],
    J: ['58', '59', '60'],
    K: ['61', '62', '63'],
    L: ['64', '65', '66'],
    M: ['68'],
    N: ['69', '70', '71', '72', '73', '74', '75'],
    O: ['77', '78', '79', '80', '81', '82'],
    P: ['84'],
    Q: ['85'],
    R: ['86', '87', '88'],
    S: ['90', '91', '92', '93'],
    T: ['94', '95', '96'],
    U: ['97', '98'],
    V: ['99'],
  };

  classItems.forEach((item, index) => {
    const level = Number(item['@level']);
    if (level !== index) {
      errors.push(
        `Processes classification level sorting error: at index ${index}, expected level ${index}, got ${level}`,
      );
    }
  });

  for (let index = 1; index < classItems.length; index += 1) {
    const parent = classItems[index - 1] ?? {};
    const child = classItems[index] ?? {};
    const parentLevel = Number(parent['@level']);
    const childLevel = Number(child['@level']);
    const parentId = String(parent['@classId'] ?? '');
    const childId = String(child['@classId'] ?? '');

    if (parentLevel === 0 && childLevel === 1) {
      const validCodes = level0ToLevel1Mapping[parentId] ?? [];
      if (!validCodes.includes(childId)) {
        errors.push(
          `Processes classification code error: level 1 code '${childId}' does not correspond to level 0 code '${parentId}'`,
        );
      }
      continue;
    }

    if (!childId.startsWith(parentId)) {
      errors.push(
        `Processes classification code error: child code '${childId}' does not start with parent code '${parentId}'`,
      );
    }
  }

  return errors;
}

function validateSourcesClassificationHierarchy(
  classItems: Array<Record<string, unknown>> | Record<string, unknown> | undefined,
): string[] {
  const normalizedItems = ensureArray(classItems);
  const errors: string[] = [];

  normalizedItems.forEach((item, index) => {
    const level = Number(item['@level']);
    if (!Number.isFinite(level)) {
      errors.push(
        `Sources classification level parsing error: missing or invalid '@level' at index ${index}`,
      );
      return;
    }
    if (level !== index) {
      errors.push(
        `Sources classification level sorting error: at index ${index}, expected level ${index}, got ${level}`,
      );
    }
  });

  for (let index = 1; index < normalizedItems.length; index += 1) {
    const parentId = normalizedItems[index - 1]?.['@classId'];
    const childId = normalizedItems[index]?.['@classId'];
    if (typeof parentId !== 'string' || typeof childId !== 'string') {
      errors.push(
        `Sources classification code error: missing '@classId' for parent index ${index - 1} or child index ${index}`,
      );
      continue;
    }
    if (!childId.startsWith(parentId)) {
      errors.push(
        `Sources classification code error: child code '${childId}' does not start with parent code '${parentId}'`,
      );
    }
  }

  return errors;
}

function validateLocalizedTextLanguageConstraints(node: unknown, currentPath = ''): string[] {
  const errors: string[] = [];
  const currentNode = asRecord(node);

  if (currentNode) {
    const language = currentNode['@xml:lang'];
    const text = currentNode['#text'];
    const location = currentPath || '<root>';

    if (typeof language === 'string') {
      if (!TIDAS_LANGUAGE_CODE_SET.has(language)) {
        errors.push(
          `Localized text error at ${location}: @xml:lang '${language}' is not a TIDAS Languages enumeration value`,
        );
      }
    }

    if (typeof language === 'string' && typeof text === 'string') {
      const hasChinese = CHINESE_CHARACTER_RE.test(text);

      if (language === 'zh' && !hasChinese) {
        errors.push(
          `Localized text error at ${location}: @xml:lang '${language}' must include at least one Chinese character`,
        );
      }

      if (language === 'en' && hasChinese) {
        errors.push(
          `Localized text error at ${location}: @xml:lang '${language}' must not contain Chinese characters`,
        );
      }
    }

    for (const [key, value] of Object.entries(currentNode)) {
      const childPath = currentPath ? `${currentPath}/${key}` : key;
      errors.push(...validateLocalizedTextLanguageConstraints(value, childPath));
    }
    return errors;
  }

  if (Array.isArray(node)) {
    node.forEach((value, index) => {
      const childPath = currentPath ? `${currentPath}/${index}` : String(index);
      errors.push(...validateLocalizedTextLanguageConstraints(value, childPath));
    });
  }

  return errors;
}

function collectFlowClassificationStructureIssues(
  items: unknown,
  category: string,
  filePath: string,
  locationBase: string,
  requiredIdKey: '@classId' | '@catId',
): ValidationIssue[] {
  if (!Array.isArray(items)) {
    return [];
  }

  const issues: ValidationIssue[] = [];

  items.forEach((item, index) => {
    const record = asRecord(item);
    if (!record) {
      return;
    }

    for (const fieldName of ['@level', requiredIdKey, '#text'] as const) {
      if (record[fieldName] !== undefined) {
        continue;
      }

      issues.push(
        makeIssue(
          category,
          filePath,
          `${locationBase}/${index}`,
          `Schema Error at ${locationBase}/${index}: '${fieldName}' is a required property`,
        ),
      );
    }
  });

  return issues;
}

function extractLocalizedTextLocation(message: string): string {
  if (!message.startsWith('Localized text error at ') || !message.includes(':')) {
    return '<root>';
  }

  const location = message.slice('Localized text error at '.length).split(':', 1)[0];
  return location.length > 0 ? location : '<root>';
}

function collectLocalizedTextIssues(
  jsonItem: unknown,
  category: string,
  filePath: string,
): ValidationIssue[] {
  return validateLocalizedTextLanguageConstraints(jsonItem).map((message) => {
    return makeIssue(
      category,
      filePath,
      extractLocalizedTextLocation(message),
      message,
      message.includes('is not a TIDAS Languages enumeration value')
        ? 'localized_text_language_not_in_tidas_enum'
        : 'localized_text_language_error',
    );
  });
}

function collectFlowSchemaGapIssues(
  jsonItem: unknown,
  category: string,
  filePath: string,
): ValidationIssue[] {
  if (category !== 'flows') {
    return [];
  }

  const flowDataSet = asRecord(asRecord(jsonItem)?.flowDataSet);
  const modellingAndValidation = asRecord(flowDataSet?.modellingAndValidation);
  const lciMethod = asRecord(modellingAndValidation?.LCIMethod);
  const dataSetType = lciMethod?.typeOfDataSet;
  const dataSetInformation = asRecord(asRecord(flowDataSet?.flowInformation)?.dataSetInformation);
  const classificationInformation = asRecord(dataSetInformation?.classificationInformation);

  if (dataSetType === 'Product flow') {
    const classes = asRecord(classificationInformation?.['common:classification'])?.[
      'common:class'
    ];
    return collectFlowClassificationStructureIssues(
      classes,
      category,
      filePath,
      'flowDataSet/flowInformation/dataSetInformation/classificationInformation/common:classification/common:class',
      '@classId',
    );
  }

  if (dataSetType === 'Elementary flow') {
    const categories = asRecord(
      classificationInformation?.['common:elementaryFlowCategorization'],
    )?.['common:category'];

    return collectFlowClassificationStructureIssues(
      categories,
      category,
      filePath,
      'flowDataSet/flowInformation/dataSetInformation/classificationInformation/common:elementaryFlowCategorization/common:category',
      '@catId',
    );
  }

  return [];
}

export function collectClassificationIssues(
  jsonItem: unknown,
  category: string,
  filePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const root = asRecord(jsonItem);

  try {
    if (category === 'flows') {
      const flowDataSet = asRecord(root?.flowDataSet);
      const dataSetType = asRecord(asRecord(flowDataSet?.modellingAndValidation)?.LCIMethod)?.[
        'typeOfDataSet'
      ];

      if (dataSetType === 'Product flow' || dataSetType === 'Waste flow') {
        const items = asRecord(
          asRecord(
            asRecord(asRecord(flowDataSet?.flowInformation)?.dataSetInformation)
              ?.classificationInformation,
          )?.['common:classification'],
        )?.['common:class'];

        if (Array.isArray(items)) {
          issues.push(
            ...validateProductFlowsClassificationHierarchy(
              items.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))),
            ).map((message) =>
              makeIssue(category, filePath, '<root>', message, 'classification_hierarchy_error'),
            ),
          );
        }
      } else if (dataSetType === 'Elementary flow') {
        const items = asRecord(
          asRecord(
            asRecord(asRecord(flowDataSet?.flowInformation)?.dataSetInformation)
              ?.classificationInformation,
          )?.['common:elementaryFlowCategorization'],
        )?.['common:category'];

        if (Array.isArray(items)) {
          issues.push(
            ...validateElementaryFlowsClassificationHierarchy(
              items.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))),
            ).map((message) =>
              makeIssue(category, filePath, '<root>', message, 'classification_hierarchy_error'),
            ),
          );
        }
      }
    } else if (category === 'processes') {
      const items = asRecord(
        asRecord(asRecord(asRecord(root?.processDataSet)?.processInformation)?.dataSetInformation)
          ?.classificationInformation,
      )?.['common:classification'];

      const classes = asRecord(items)?.['common:class'];
      if (Array.isArray(classes)) {
        issues.push(
          ...validateProcessesClassificationHierarchy(
            classes.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))),
          ).map((message) =>
            makeIssue(category, filePath, '<root>', message, 'classification_hierarchy_error'),
          ),
        );
      }
    } else if (category === 'lifecyclemodels') {
      const items = asRecord(
        asRecord(asRecord(root?.lifecycleModelDataSet)?.lifecycleModelInformation)
          ?.dataSetInformation,
      )?.classificationInformation;

      const classes = asRecord(asRecord(items)?.['common:classification'])?.['common:class'];
      if (Array.isArray(classes)) {
        issues.push(
          ...validateProcessesClassificationHierarchy(
            classes.filter((item): item is Record<string, unknown> => Boolean(asRecord(item))),
          ).map((message) =>
            makeIssue(category, filePath, '<root>', message, 'classification_hierarchy_error'),
          ),
        );
      }
    } else if (category === 'sources') {
      const classes = asRecord(
        asRecord(asRecord(asRecord(root?.sourceDataSet)?.sourceInformation)?.dataSetInformation)
          ?.classificationInformation,
      );
      issues.push(
        ...validateSourcesClassificationHierarchy(
          asRecord(asRecord(classes)?.['common:classification'])?.['common:class'] as
            Array<Record<string, unknown>> | Record<string, unknown> | undefined,
        ).map((message) =>
          makeIssue(category, filePath, '<root>', message, 'classification_hierarchy_error'),
        ),
      );
    }
  } catch {
    return issues;
  }

  return issues;
}

function collectSchemaIssues(
  schema: SafeParseSchema,
  jsonItem: unknown,
  category: SupportedCategory,
  filePath: string,
  createEntity: SdkValidationFactory | null = null,
): ValidationIssue[] {
  try {
    const result = validateSchemaWithDeepFallback(schema, jsonItem, createEntity);
    if (result.success) {
      return [];
    }

    const rawIssues = result.issues;
    if (rawIssues.length === 0) {
      return [createValidationErrorIssue(category, filePath, 'Schema validation failed')];
    }

    return rawIssues.map((issue) => createSchemaIssue(category, filePath, issue));
  } catch (error) {
    return [createValidationErrorIssue(category, filePath, error)];
  }
}

function categoryValidate(
  jsonFilePath: string,
  category: SupportedCategory,
  schema: SafeParseSchema,
  createEntity: SdkValidationFactory | null = null,
  emitLogs = true,
): CategoryValidationReport {
  const issues: ValidationIssue[] = [];

  for (const fileName of readdirSync(jsonFilePath).sort()) {
    if (!fileName.endsWith('.json')) {
      continue;
    }

    const fullPath = path.join(jsonFilePath, fileName);
    let jsonItem: unknown;

    try {
      jsonItem = JSON.parse(readFileSync(fullPath, 'utf8')) as unknown;
    } catch (error) {
      issues.push(createInvalidJsonIssue(category, fullPath, error));
      continue;
    }

    const itemIssues = dedupeIssues([
      ...collectSchemaIssues(schema, jsonItem, category, fullPath, createEntity),
      ...collectFlowSchemaGapIssues(jsonItem, category, fullPath),
      ...collectLocalizedTextIssues(jsonItem, category, fullPath),
      ...collectClassificationIssues(jsonItem, category, fullPath),
    ]);

    issues.push(...itemIssues);

    if (!emitLogs) {
      continue;
    }

    if (itemIssues.length === 0) {
      console.info(`INFO: ${fullPath} PASSED.`);
      continue;
    }

    itemIssues.forEach((issue) => {
      console.error(`ERROR: ${fullPath} ${issue.message}`);
    });
  }

  return buildCategoryReport(category, issues);
}

function isSafeParseSchema(value: unknown): value is SafeParseSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    'safeParse' in value &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

function resolveCategorySchemas(
  moduleExports: TidasSdkPublicModule,
): Map<
  SupportedCategory,
  { schema: SafeParseSchema; createEntity: SdkValidationFactory | null }
> | null {
  const schemas = new Map<
    SupportedCategory,
    { schema: SafeParseSchema; createEntity: SdkValidationFactory | null }
  >();

  for (const category of SUPPORTED_CATEGORIES) {
    const exportName = CATEGORY_SCHEMA_EXPORTS[category];
    const schema = moduleExports[exportName];
    if (!isSafeParseSchema(schema)) {
      return null;
    }
    const factoryName = CATEGORY_FACTORY_EXPORTS[category];
    const createEntity = moduleExports[factoryName];
    schemas.set(category, {
      schema:
        category === 'processes'
          ? withOptionalReviewReportReference(schema, 'processes')
          : category === 'lciamethods'
            ? withOptionalReviewReportReference(schema, 'lciamethods')
            : schema,
      createEntity: typeof createEntity === 'function' ? createEntity : null,
    });
  }

  return schemas;
}

export function createTidasSdkPackageValidator(
  moduleExports: TidasSdkPublicModule,
  location: string,
): {
  location: string;
  validatePackageDir: (inputDir: string, emitLogs?: boolean) => PackageValidationReport;
} | null {
  const schemas = resolveCategorySchemas(moduleExports);
  if (!schemas) {
    return null;
  }

  return {
    location,
    validatePackageDir(inputDir: string, emitLogs = false): PackageValidationReport {
      const categoryReports = SUPPORTED_CATEGORIES.flatMap((category) => {
        const categoryDir = path.join(inputDir, category);
        const validator = schemas.get(category);
        if (!validator || !existsSync(categoryDir)) {
          return [];
        }

        return [
          categoryValidate(
            categoryDir,
            category,
            validator.schema,
            validator.createEntity,
            emitLogs,
          ),
        ];
      });

      return buildPackageReport(inputDir, categoryReports);
    },
  };
}

export const __testInternals = {
  summarizeIssues,
  buildCategoryReport,
  buildPackageReport,
  asRecord,
  ensureArray,
  toLocation,
  createInvalidJsonIssue,
  createValidationErrorIssue,
  createSchemaIssue,
  dedupeIssues,
  makeIssue,
  validateElementaryFlowsClassificationHierarchy,
  validateProductFlowsClassificationHierarchy,
  validateProcessesClassificationHierarchy,
  validateSourcesClassificationHierarchy,
  validateLocalizedTextLanguageConstraints,
  collectFlowClassificationStructureIssues,
  extractLocalizedTextLocation,
  collectLocalizedTextIssues,
  collectFlowSchemaGapIssues,
  collectClassificationIssues,
  collectSchemaIssues,
  categoryValidate,
  CATEGORY_FACTORY_EXPORTS,
  resolveCategorySchemas,
};
