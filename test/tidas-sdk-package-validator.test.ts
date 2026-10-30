import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __testInternals,
  createTidasSdkPackageValidator,
} from '../src/lib/tidas-sdk-package-validator.js';

type SafeParseIssue = {
  code?: string;
  message?: string;
  path?: Array<string | number>;
};

type SafeParseResult =
  | {
      success: true;
    }
  | {
      success: false;
      error?: {
        issues?: SafeParseIssue[];
      };
    };

type SchemaExportName =
  | 'ContactSchema'
  | 'FlowPropertySchema'
  | 'FlowSchema'
  | 'LCIAMethodSchema'
  | 'LifeCycleModelSchema'
  | 'ProcessSchema'
  | 'SourceSchema'
  | 'UnitGroupSchema';

type SafeParseImpl = (value: unknown) => SafeParseResult;

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, 'utf8');
}

function makeSchemas(overrides: Partial<Record<SchemaExportName, SafeParseImpl>> = {}) {
  const success: SafeParseImpl = () => ({ success: true });
  return {
    ContactSchema: { safeParse: overrides.ContactSchema ?? success },
    FlowPropertySchema: { safeParse: overrides.FlowPropertySchema ?? success },
    FlowSchema: { safeParse: overrides.FlowSchema ?? success },
    LCIAMethodSchema: { safeParse: overrides.LCIAMethodSchema ?? success },
    LifeCycleModelSchema: { safeParse: overrides.LifeCycleModelSchema ?? success },
    ProcessSchema: { safeParse: overrides.ProcessSchema ?? success },
    SourceSchema: { safeParse: overrides.SourceSchema ?? success },
    UnitGroupSchema: { safeParse: overrides.UnitGroupSchema ?? success },
  };
}

test('createTidasSdkPackageValidator resolves complete schema exports and rejects incomplete ones', () => {
  const schemas = makeSchemas();
  const resolved = __testInternals.resolveCategorySchemas(schemas);
  assert.ok(resolved instanceof Map);
  assert.equal(resolved?.size, 8);
  assert.equal(resolved?.get('contacts')?.schema, schemas.ContactSchema);
  assert.equal(resolved?.get('contacts')?.createEntity, null);
  const resolvedWithFactory = __testInternals.resolveCategorySchemas({
    ...schemas,
    createContact: () => ({}),
  });
  assert.equal(typeof resolvedWithFactory?.get('contacts')?.createEntity, 'function');
  assert.equal(
    createTidasSdkPackageValidator(schemas, '@tiangong-lca/tidas-sdk')?.location,
    '@tiangong-lca/tidas-sdk',
  );

  assert.equal(
    createTidasSdkPackageValidator(
      {
        ...schemas,
        FlowSchema: undefined,
      },
      '@tiangong-lca/tidas-sdk',
    ),
    null,
  );
  assert.equal(
    __testInternals.resolveCategorySchemas({
      ...schemas,
      SourceSchema: {} as never,
    }),
    null,
  );
});

test('package validation checks structured names alongside successful SDK schemas and preserves synonyms', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-package-names-'));
  const definitions = [
    ['flows', 'flowDataSet', 'flowInformation', 'flowProperties'],
    ['processes', 'processDataSet', 'processInformation', 'functionalUnitFlowProperties'],
    [
      'lifecyclemodels',
      'lifeCycleModelDataSet',
      'lifeCycleModelInformation',
      'functionalUnitFlowProperties',
    ],
  ] as const;
  try {
    const validator = createTidasSdkPackageValidator(makeSchemas(), 'test-sdk');
    assert.ok(validator);
    for (const [category, rootKey, infoKey, fourthField] of definitions) {
      writeJson(path.join(dir, category, 'bad.json'), {
        [rootKey]: {
          [infoKey]: {
            dataSetInformation: {
              name: {
                [fourthField]: [
                  { '@xml:lang': 'en', '#text': 'Capacity, specified' },
                  { '@xml:lang': 'zh', '#text': '额定容量；储能' },
                ],
              },
            },
          },
        },
      });
      writeJson(path.join(dir, category, 'good.json'), {
        [rootKey]: {
          [infoKey]: {
            dataSetInformation: {
              name: { baseName: { '@xml:lang': 'en', '#text': 'Battery, storage' } },
              'common:synonyms': { '@xml:lang': 'en', '#text': 'Battery; accumulator' },
            },
          },
        },
      });
    }
    const report = validator.validatePackageDir(dir);
    assert.equal(report.ok, false);
    assert.equal(report.issues.length, 3);
    for (const issue of report.issues) {
      assert.equal(issue.issue_code, 'dataset_name_semicolon');
      assert.equal(issue.severity, 'error');
      assert.match(issue.file_path, /bad\.json$/u);
      assert.match(
        issue.location,
        /name\/(flowProperties|functionalUnitFlowProperties)\/1\/#text$/u,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validator helper utilities normalize issues and locations consistently', () => {
  const issue = __testInternals.makeIssue('flows', '/tmp/flow.json', '<root>', 'Broken flow');
  const warningIssue = {
    ...issue,
    issue_code: 'warning_issue',
    severity: 'warning' as const,
  };
  const infoIssue = {
    ...issue,
    issue_code: 'info_issue',
    severity: 'info' as const,
  };

  assert.deepEqual(__testInternals.buildCategoryReport('flows', [issue, warningIssue, infoIssue]), {
    category: 'flows',
    ok: false,
    summary: {
      issue_count: 3,
      error_count: 1,
      warning_count: 1,
      info_count: 1,
    },
    issues: [issue, warningIssue, infoIssue],
  });

  assert.deepEqual(
    __testInternals.buildPackageReport('/tmp/pkg', [
      __testInternals.buildCategoryReport('flows', [issue]),
      __testInternals.buildCategoryReport('sources', []),
    ]),
    {
      input_dir: '/tmp/pkg',
      ok: false,
      summary: {
        category_count: 2,
        issue_count: 1,
        error_count: 1,
        warning_count: 0,
        info_count: 0,
      },
      categories: [
        __testInternals.buildCategoryReport('flows', [issue]),
        __testInternals.buildCategoryReport('sources', []),
      ],
      issues: [issue],
    },
  );

  assert.deepEqual(__testInternals.asRecord({ ok: true }), { ok: true });
  assert.equal(__testInternals.asRecord(null), null);
  assert.equal(__testInternals.asRecord([]), null);
  assert.deepEqual(__testInternals.ensureArray(['x']), ['x']);
  assert.deepEqual(__testInternals.ensureArray('x'), ['x']);
  assert.deepEqual(__testInternals.ensureArray(undefined), []);
  assert.equal(__testInternals.toLocation(['a', 0, 'b']), 'a/0/b');
  assert.equal(__testInternals.toLocation(undefined), '<root>');

  assert.match(
    __testInternals.createInvalidJsonIssue('contacts', '/tmp/a.json', new SyntaxError('bad json'))
      .message,
    /SyntaxError: bad json/u,
  );
  assert.match(
    __testInternals.createInvalidJsonIssue('contacts', '/tmp/a.json', 'broken').message,
    /Invalid JSON: Error: broken/u,
  );
  assert.match(
    __testInternals.createValidationErrorIssue(
      'flows',
      '/tmp/flow.json',
      new Error('schema exploded'),
    ).message,
    /schema exploded/u,
  );
  assert.match(
    __testInternals.createValidationErrorIssue('flows', '/tmp/flow.json', 'schema failed').message,
    /schema failed/u,
  );

  assert.deepEqual(
    __testInternals.createSchemaIssue('flows', '/tmp/flow.json', {
      code: 'too_small',
      message: 'Too short',
      path: ['flowDataSet', 'name', 0],
    }),
    {
      issue_code: 'schema_error',
      severity: 'error',
      category: 'flows',
      file_path: '/tmp/flow.json',
      location: 'flowDataSet/name/0',
      message: 'Schema Error at flowDataSet/name/0: Too short',
      context: {
        validator: 'too_small',
      },
    },
  );
  assert.deepEqual(__testInternals.createSchemaIssue('flows', '/tmp/flow.json', {}), {
    issue_code: 'schema_error',
    severity: 'error',
    category: 'flows',
    file_path: '/tmp/flow.json',
    location: '<root>',
    message: 'Schema Error at <root>: Validation failed',
    context: {
      validator: 'custom',
    },
  });

  assert.deepEqual(
    __testInternals.dedupeIssues([
      issue,
      issue,
      {
        ...issue,
        message: 'Different message',
      },
    ]),
    [
      issue,
      {
        ...issue,
        message: 'Different message',
      },
    ],
  );
});

test('classification and localized text helpers surface hierarchy and language violations', () => {
  assert.deepEqual(
    __testInternals.validateElementaryFlowsClassificationHierarchy([
      {
        '@level': 0,
        '@catId': 'AA',
      },
      {
        '@level': 2,
        '@catId': 'ZZ',
      },
    ]),
    [
      'Elementary flow classification level sorting error: at index 1, expected level 1, got 2',
      "Elementary flow classification code error: child code 'ZZ' does not start with parent code 'AA'",
    ],
  );
  assert.deepEqual(
    __testInternals.validateElementaryFlowsClassificationHierarchy([
      {
        '@level': 0,
      },
      {
        '@level': 1,
        '@catId': 'BB',
      },
    ]),
    [],
  );
  assert.deepEqual(
    __testInternals.validateElementaryFlowsClassificationHierarchy([
      {
        '@level': 0,
        '@catId': 'AA',
      },
      {
        '@level': 1,
      },
    ]),
    [
      "Elementary flow classification code error: child code '' does not start with parent code 'AA'",
    ],
  );

  assert.deepEqual(
    __testInternals.validateProductFlowsClassificationHierarchy([
      {
        '@level': 0,
        '@classId': '11',
      },
      {
        '@level': 2,
        '@classId': '99',
      },
    ]),
    [
      'Product flow classification level sorting error: at index 1, expected level 1, got 2',
      "Product flow classification code error: child code '99' does not start with parent code '11'",
    ],
  );
  assert.deepEqual(
    __testInternals.validateProductFlowsClassificationHierarchy([
      {
        '@level': 0,
      },
      {
        '@level': 1,
        '@classId': 'BB',
      },
    ]),
    [],
  );
  assert.deepEqual(
    __testInternals.validateProductFlowsClassificationHierarchy([
      {
        '@level': 0,
        '@classId': 'AA',
      },
      {
        '@level': 1,
      },
    ]),
    ["Product flow classification code error: child code '' does not start with parent code 'AA'"],
  );

  assert.deepEqual(
    __testInternals.validateProcessesClassificationHierarchy([
      {
        '@level': 0,
        '@classId': 'A',
      },
      {
        '@level': 1,
        '@classId': '99',
      },
      {
        '@level': 3,
        '@classId': '77',
      },
    ]),
    [
      'Processes classification level sorting error: at index 2, expected level 2, got 3',
      "Processes classification code error: level 1 code '99' does not correspond to level 0 code 'A'",
      "Processes classification code error: child code '77' does not start with parent code '99'",
    ],
  );
  assert.deepEqual(
    __testInternals.validateProcessesClassificationHierarchy([
      {
        '@level': 0,
        '@classId': 'ZZ',
      },
      {
        '@level': 1,
        '@classId': '01',
      },
    ]),
    [
      "Processes classification code error: level 1 code '01' does not correspond to level 0 code 'ZZ'",
    ],
  );
  assert.deepEqual(
    __testInternals.validateProcessesClassificationHierarchy(
      Object.assign([], {
        1: {
          '@level': 1,
          '@classId': '01',
        },
        length: 2,
      }) as Array<Record<string, unknown>>,
    ),
    [],
  );
  assert.deepEqual(
    __testInternals.validateProcessesClassificationHierarchy(
      Object.assign(
        [
          {
            '@level': 0,
            '@classId': 'A',
          },
        ],
        { length: 2 },
      ) as Array<Record<string, unknown>>,
    ),
    ["Processes classification code error: child code '' does not start with parent code 'A'"],
  );

  assert.deepEqual(__testInternals.validateSourcesClassificationHierarchy(undefined), []);
  assert.deepEqual(
    __testInternals.validateSourcesClassificationHierarchy({
      '@level': 'bad',
    }),
    ["Sources classification level parsing error: missing or invalid '@level' at index 0"],
  );
  assert.deepEqual(
    __testInternals.validateSourcesClassificationHierarchy([
      {
        '@level': 0,
        '@classId': 'AA',
      },
      {
        '@level': 1,
      },
      {
        '@level': 2,
        '@classId': 'ZZ',
      },
    ]),
    [
      "Sources classification code error: missing '@classId' for parent index 0 or child index 1",
      "Sources classification code error: missing '@classId' for parent index 1 or child index 2",
    ],
  );
  assert.deepEqual(
    __testInternals.validateSourcesClassificationHierarchy([
      {
        '@level': 0,
        '@classId': 'AA',
      },
      {
        '@level': 1,
        '@classId': 'ZZ',
      },
    ]),
    ["Sources classification code error: child code 'ZZ' does not start with parent code 'AA'"],
  );
  assert.deepEqual(
    __testInternals.validateSourcesClassificationHierarchy([
      {
        '@level': 1,
        '@classId': 'AA',
      },
    ]),
    ['Sources classification level sorting error: at index 0, expected level 0, got 1'],
  );

  assert.deepEqual(
    __testInternals.validateLocalizedTextLanguageConstraints({
      title: [
        {
          '@xml:lang': 'zh',
          '#text': 'English only',
        },
        {
          '@xml:lang': 'en',
          '#text': '中文',
        },
      ],
      nested: {
        description: {
          '@xml:lang': 'zh-CN',
          '#text': '中文说明',
        },
      },
    }),
    [
      "Localized text error at title/0: @xml:lang 'zh' must include at least one Chinese character",
      "Localized text error at title/1: @xml:lang 'en' must not contain Chinese characters",
      "Localized text error at nested/description: @xml:lang 'zh-CN' is not a TIDAS Languages enumeration value",
    ],
  );
  assert.deepEqual(__testInternals.validateLocalizedTextLanguageConstraints([]), []);
  assert.deepEqual(
    __testInternals.validateLocalizedTextLanguageConstraints([
      {
        '@xml:lang': 'zh',
        '#text': 'English only',
      },
    ]),
    ["Localized text error at 0: @xml:lang 'zh' must include at least one Chinese character"],
  );
});

test('collection helpers derive schema gaps, localized text issues, hierarchy issues, and safe-parse failures', () => {
  assert.deepEqual(
    __testInternals.collectFlowClassificationStructureIssues(
      undefined,
      'flows',
      '/tmp/flow.json',
      'flow/classification',
      '@classId',
    ),
    [],
  );

  assert.deepEqual(
    __testInternals
      .collectFlowClassificationStructureIssues(
        [
          1,
          {
            '@level': 0,
          },
        ],
        'flows',
        '/tmp/flow.json',
        'flow/classification',
        '@classId',
      )
      .map((issue: { message: string }) => issue.message),
    [
      "Schema Error at flow/classification/1: '@classId' is a required property",
      "Schema Error at flow/classification/1: '#text' is a required property",
    ],
  );

  assert.deepEqual(
    __testInternals.collectLocalizedTextIssues(
      {
        title: {
          '@xml:lang': 'en-US',
          '#text': 'English',
        },
      },
      'flows',
      '/tmp/flow.json',
    ),
    [
      {
        issue_code: 'localized_text_language_not_in_tidas_enum',
        severity: 'error',
        category: 'flows',
        file_path: '/tmp/flow.json',
        location: 'title',
        message:
          "Localized text error at title: @xml:lang 'en-US' is not a TIDAS Languages enumeration value",
        context: {},
      },
    ],
  );
  assert.deepEqual(
    __testInternals.collectLocalizedTextIssues(
      {
        title: {
          '@xml:lang': 'en',
          '#text': '中文',
        },
      },
      'flows',
      '/tmp/flow.json',
    ),
    [
      {
        issue_code: 'localized_text_language_error',
        severity: 'error',
        category: 'flows',
        file_path: '/tmp/flow.json',
        location: 'title',
        message:
          "Localized text error at title: @xml:lang 'en' must not contain Chinese characters",
        context: {},
      },
    ],
  );
  assert.equal(
    __testInternals.extractLocalizedTextLocation('Localized text error at title/0: broken'),
    'title/0',
  );
  assert.equal(
    __testInternals.extractLocalizedTextLocation('Localized text error at : broken'),
    '<root>',
  );
  assert.equal(__testInternals.extractLocalizedTextLocation('unexpected message'), '<root>');

  assert.deepEqual(
    __testInternals.collectFlowSchemaGapIssues({}, 'contacts', '/tmp/contact.json'),
    [],
  );
  assert.deepEqual(
    __testInternals
      .collectFlowSchemaGapIssues(
        {
          flowDataSet: {
            modellingAndValidation: {
              LCIMethod: {
                typeOfDataSet: 'Product flow',
              },
            },
            flowInformation: {
              dataSetInformation: {
                classificationInformation: {
                  'common:classification': {
                    'common:class': [
                      {
                        '@level': 0,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        'flows',
        '/tmp/product.json',
      )
      .map((issue: { message: string }) => issue.message),
    [
      "Schema Error at flowDataSet/flowInformation/dataSetInformation/classificationInformation/common:classification/common:class/0: '@classId' is a required property",
      "Schema Error at flowDataSet/flowInformation/dataSetInformation/classificationInformation/common:classification/common:class/0: '#text' is a required property",
    ],
  );
  assert.deepEqual(
    __testInternals
      .collectFlowSchemaGapIssues(
        {
          flowDataSet: {
            modellingAndValidation: {
              LCIMethod: {
                typeOfDataSet: 'Elementary flow',
              },
            },
            flowInformation: {
              dataSetInformation: {
                classificationInformation: {
                  'common:elementaryFlowCategorization': {
                    'common:category': [
                      {
                        '@level': 0,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        'flows',
        '/tmp/elementary.json',
      )
      .map((issue: { message: string }) => issue.message),
    [
      "Schema Error at flowDataSet/flowInformation/dataSetInformation/classificationInformation/common:elementaryFlowCategorization/common:category/0: '@catId' is a required property",
      "Schema Error at flowDataSet/flowInformation/dataSetInformation/classificationInformation/common:elementaryFlowCategorization/common:category/0: '#text' is a required property",
    ],
  );

  assert.equal(
    __testInternals.collectClassificationIssues(
      {
        flowDataSet: {
          modellingAndValidation: {
            LCIMethod: {
              typeOfDataSet: 'Product flow',
            },
          },
          flowInformation: {
            dataSetInformation: {
              classificationInformation: {
                'common:classification': {
                  'common:class': [
                    {
                      '@level': 0,
                      '@classId': 'AA',
                    },
                    {
                      '@level': 2,
                      '@classId': 'ZZ',
                    },
                  ],
                },
              },
            },
          },
        },
      },
      'flows',
      '/tmp/product-classification.json',
    ).length,
    2,
  );
  assert.equal(
    __testInternals.collectClassificationIssues(
      {
        flowDataSet: {
          modellingAndValidation: {
            LCIMethod: {
              typeOfDataSet: 'Elementary flow',
            },
          },
          flowInformation: {
            dataSetInformation: {
              classificationInformation: {
                'common:elementaryFlowCategorization': {
                  'common:category': [
                    {
                      '@level': 0,
                      '@catId': 'AA',
                    },
                    {
                      '@level': 2,
                      '@catId': 'ZZ',
                    },
                  ],
                },
              },
            },
          },
        },
      },
      'flows',
      '/tmp/elementary-classification.json',
    ).length,
    2,
  );
  assert.equal(
    __testInternals.collectClassificationIssues(
      {
        processDataSet: {
          processInformation: {
            dataSetInformation: {
              classificationInformation: {
                'common:classification': {
                  'common:class': [
                    {
                      '@level': 0,
                      '@classId': 'A',
                    },
                    {
                      '@level': 1,
                      '@classId': '99',
                    },
                    {
                      '@level': 3,
                      '@classId': '77',
                    },
                  ],
                },
              },
            },
          },
        },
      },
      'processes',
      '/tmp/process-classification.json',
    ).length,
    3,
  );
  assert.equal(
    __testInternals.collectClassificationIssues(
      {
        lifecycleModelDataSet: {
          lifecycleModelInformation: {
            dataSetInformation: {
              classificationInformation: {
                'common:classification': {
                  'common:class': [
                    {
                      '@level': 0,
                      '@classId': 'A',
                    },
                    {
                      '@level': 1,
                      '@classId': '99',
                    },
                  ],
                },
              },
            },
          },
        },
      },
      'lifecyclemodels',
      '/tmp/lifecycle-classification.json',
    ).length,
    1,
  );
  assert.equal(
    __testInternals.collectClassificationIssues(
      {
        sourceDataSet: {
          sourceInformation: {
            dataSetInformation: {
              classificationInformation: {
                'common:classification': {
                  'common:class': {
                    '@level': 'bad',
                  },
                },
              },
            },
          },
        },
      },
      'sources',
      '/tmp/source-classification.json',
    ).length,
    1,
  );
  assert.deepEqual(
    __testInternals.collectClassificationIssues(
      new Proxy(
        {},
        {
          get() {
            throw new Error('explode during traversal');
          },
        },
      ),
      'flows',
      '/tmp/exploded.json',
    ),
    [],
  );

  assert.deepEqual(
    __testInternals.collectSchemaIssues(
      {
        safeParse: () => ({ success: true }),
      },
      {
        ok: true,
      },
      'flows',
      '/tmp/ok.json',
    ),
    [],
  );
  assert.deepEqual(
    __testInternals.collectSchemaIssues(
      {
        safeParse: () => ({
          success: false,
          error: {
            issues: [
              {
                code: 'missing',
                message: 'Missing name',
                path: ['flowDataSet', 'name'],
              },
            ],
          },
        }),
      },
      {},
      'flows',
      '/tmp/schema.json',
    ),
    [
      {
        issue_code: 'schema_error',
        severity: 'error',
        category: 'flows',
        file_path: '/tmp/schema.json',
        location: 'flowDataSet/name',
        message: 'Schema Error at flowDataSet/name: Missing name',
        context: {
          validator: 'missing',
        },
      },
    ],
  );
  assert.equal(
    __testInternals.collectSchemaIssues(
      {
        safeParse: () => ({
          success: false,
          error: {
            issues: [],
          },
        }),
      },
      {},
      'flows',
      '/tmp/empty.json',
    )[0]?.issue_code,
    'validation_error',
  );
  assert.deepEqual(
    __testInternals.collectSchemaIssues(
      {
        safeParse: () => ({
          success: false,
          error: {
            issues: [{ code: 'fast', message: 'Fast issue', path: ['fast'] }],
          },
        }),
      },
      {},
      'flows',
      '/tmp/deep.json',
      (_value: unknown, config?: { deepValidation?: boolean }) => ({
        validateEnhanced: () =>
          config?.deepValidation
            ? {
                success: false,
                error: {
                  issues: [{ code: 'deep', message: 'Deep issue', path: ['deep'] }],
                },
              }
            : {
                success: false,
                error: {
                  issues: [{ code: 'shallow', message: 'Shallow issue', path: ['shallow'] }],
                },
              },
      }),
    ),
    [
      {
        issue_code: 'schema_error',
        severity: 'error',
        category: 'flows',
        file_path: '/tmp/deep.json',
        location: 'deep',
        message: 'Schema Error at deep: Deep issue',
        context: {
          validator: 'deep',
        },
      },
    ],
  );
  assert.equal(
    __testInternals.collectSchemaIssues(
      {
        safeParse: () => ({
          success: false,
        }),
      },
      {},
      'flows',
      '/tmp/no-issues.json',
    )[0]?.issue_code,
    'validation_error',
  );
  assert.equal(
    __testInternals.collectSchemaIssues(
      {
        safeParse: () => {
          throw new Error('schema exploded');
        },
      },
      {},
      'flows',
      '/tmp/throw.json',
    )[0]?.issue_code,
    'validation_error',
  );
});

test('categoryValidate logs pass and failure cases while deduping repeated schema issues', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-tidas-validator-category-'));
  const flowsDir = path.join(dir, 'flows');
  const infoLogs: string[] = [];
  const errorLogs: string[] = [];
  const originalInfo = console.info;
  const originalError = console.error;

  writeText(path.join(flowsDir, 'invalid.json'), '{invalid-json');
  writeJson(path.join(flowsDir, 'passed.json'), { kind: 'pass' });
  writeJson(path.join(flowsDir, 'schema.json'), { kind: 'schema' });
  writeJson(path.join(flowsDir, 'empty.json'), { kind: 'empty' });
  writeJson(path.join(flowsDir, 'throw.json'), { kind: 'throw' });
  writeText(path.join(flowsDir, 'notes.md'), '# ignored');

  console.info = (...args: unknown[]) => {
    infoLogs.push(args.join(' '));
  };
  console.error = (...args: unknown[]) => {
    errorLogs.push(args.join(' '));
  };

  try {
    const report = __testInternals.categoryValidate(
      flowsDir,
      'flows',
      {
        safeParse(value: unknown): SafeParseResult {
          const kind = (value as { kind?: string }).kind;
          if (kind === 'schema') {
            return {
              success: false,
              error: {
                issues: [
                  {
                    code: 'dup',
                    message: 'Duplicate schema issue',
                    path: ['dup'],
                  },
                  {
                    code: 'dup',
                    message: 'Duplicate schema issue',
                    path: ['dup'],
                  },
                ],
              },
            };
          }
          if (kind === 'empty') {
            return {
              success: false,
              error: {
                issues: [],
              },
            };
          }
          if (kind === 'throw') {
            throw new Error('schema crashed');
          }
          return {
            success: true,
          };
        },
      },
      null,
      true,
    );

    assert.equal(report.category, 'flows');
    assert.equal(report.ok, false);
    assert.equal(report.summary.issue_count, 4);
    assert.equal(report.summary.error_count, 4);
    assert.deepEqual(
      report.issues.map((issue: { issue_code: string }) => issue.issue_code).sort(),
      ['invalid_json', 'schema_error', 'validation_error', 'validation_error'],
    );
    assert.equal(infoLogs.length, 1);
    assert.match(infoLogs[0] as string, /passed\.json PASSED/u);
    assert.equal(errorLogs.length, 3);
    assert.match(errorLogs.join('\n'), /Duplicate schema issue/u);
    assert.match(errorLogs.join('\n'), /Schema validation failed/u);
    assert.match(errorLogs.join('\n'), /schema crashed/u);
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validatePackageDir aggregates only existing category directories and defaults to emitLogs=false', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-tidas-validator-package-'));

  try {
    writeJson(path.join(dir, 'contacts', 'contact.json'), { contactDataSet: {} });
    writeJson(path.join(dir, 'sources', 'source.json'), { sourceDataSet: {} });

    const validator = createTidasSdkPackageValidator(makeSchemas(), '@tiangong-lca/tidas-sdk');
    const report = validator?.validatePackageDir(dir);

    assert.equal(validator?.location, '@tiangong-lca/tidas-sdk');
    assert.deepEqual(report, {
      input_dir: dir,
      ok: true,
      summary: {
        category_count: 2,
        issue_count: 0,
        error_count: 0,
        warning_count: 0,
        info_count: 0,
      },
      categories: [
        {
          category: 'contacts',
          ok: true,
          summary: {
            issue_count: 0,
            error_count: 0,
            warning_count: 0,
            info_count: 0,
          },
          issues: [],
        },
        {
          category: 'sources',
          ok: true,
          summary: {
            issue_count: 0,
            error_count: 0,
            warning_count: 0,
            info_count: 0,
          },
          issues: [],
        },
      ],
      issues: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
