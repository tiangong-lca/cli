import { CommandInputError } from '../shared/command-result.js';
import type { CommandResult } from '../shared/command-result.js';

export const datasetTypes = [
  'flow',
  'process',
  'model',
  'source',
  'contact',
  'flowproperty',
  'unitgroup',
  'lciamethod',
] as const;
export type DatasetType = (typeof datasetTypes)[number];
export type JsonObject = Record<string, unknown>;
export const datasetKinds = {
  flow: 'flow',
  process: 'process',
  model: 'lifecyclemodel',
  source: 'source',
  contact: 'contact',
  flowproperty: 'flowproperty',
  unitgroup: 'unitgroup',
  lciamethod: 'lciamethod',
} as const;
export const datasetTables = {
  flow: 'flows',
  process: 'processes',
  model: 'lifecyclemodels',
  source: 'sources',
  contact: 'contacts',
  flowproperty: 'flowproperties',
  unitgroup: 'unitgroups',
  lciamethod: 'lciamethods',
} as const;
export const datasetWrappers = {
  flow: 'flowDataSet',
  process: 'processDataSet',
  model: 'lifeCycleModelDataSet',
  source: 'sourceDataSet',
  contact: 'contactDataSet',
  flowproperty: 'flowPropertyDataSet',
  unitgroup: 'unitGroupDataSet',
  lciamethod: 'LCIAMethodDataSet',
} as const;
export const editableTypes: readonly DatasetType[] = [
  'flow',
  'process',
  'model',
  'source',
  'contact',
];
export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function object(value: unknown, label: string): JsonObject {
  if (!isObject(value))
    throw new CommandInputError('OBJECT_REQUIRED', `${label} must be a JSON object.`);
  return value;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new CommandInputError('VALUE_REQUIRED', `${label} must be a non-empty string.`);
  return value.trim();
}
export function requireContent(type: DatasetType, value: unknown): JsonObject {
  const content = object(value, 'content');
  object(content[datasetWrappers[type]], datasetWrappers[type]);
  return content;
}
export type DatasetRecord = {
  type: DatasetType;
  id: string;
  version: string;
  modifiedAt: string | null;
  stateCode: number | null;
  owner: string | null;
  content: JsonObject;
  modelGraph?: JsonObject;
};
export type DatasetQuery = {
  id?: string;
  version?: string;
  owner?: string;
  state?: number;
  limit: number;
  offset: number;
};
export type DatasetPage = { records: DatasetRecord[]; total: number | null; environment: string };
export type DatasetAction =
  | 'get'
  | 'list'
  | 'versions'
  | 'search'
  | 'contract'
  | 'list-references'
  | 'validate'
  | 'diff'
  | 'patch'
  | 'translations extract'
  | 'translations apply'
  | 'graph'
  | 'prepare'
  | 'calculate'
  | 'build-resulting-process'
  | 'aggregate'
  | 'create'
  | 'save'
  | 'delete'
  | 'statistics'
  | 'results'
  | 'get-result'
  | 'upload-attachments';
export type CanonicalDatasetAction = Exclude<DatasetAction, 'aggregate'>;
export type DatasetOperation = (
  | { type: 'model'; action: 'graph' | 'build-resulting-process' | 'prepare' | 'calculate' }
  | { type: 'source'; action: 'upload-attachments' }
  | { type: 'process'; action: 'statistics' | 'results' | 'get-result' }
) & { request: JsonObject; inputPath: string };

export type DatasetPorts = {
  read(type: DatasetType, query: DatasetQuery): Promise<DatasetPage>;
  contract(type: DatasetType, include: string[]): Promise<JsonObject>;
  validate(
    type: DatasetType,
    content: JsonObject,
    checks: string[],
    referenceDocuments?: JsonObject[],
  ): Promise<JsonObject>;
  search(
    type: DatasetType,
    query: string,
    limit: number,
    offset: number,
    state?: number,
    scope?: 'public' | 'current-user',
  ): Promise<JsonObject>;
  operations(operation: DatasetOperation): Promise<JsonObject>;
  mutate(
    type: DatasetType,
    action: 'create' | 'save' | 'delete',
    request: JsonObject,
    dryRun: boolean,
  ): Promise<CommandResult>;
  now(): string;
};
export function actionsFor(type: DatasetType): DatasetAction[] {
  if (type === 'lciamethod') return ['contract', 'validate'];
  const actions: DatasetAction[] = [
    'get',
    'list',
    'versions',
    'contract',
    'list-references',
    'validate',
  ];
  if (editableTypes.includes(type))
    actions.push(
      'search',
      'diff',
      'patch',
      'translations extract',
      'translations apply',
      'create',
      'save',
    );
  if (['flow', 'process', 'source', 'contact'].includes(type)) actions.push('delete');
  if (type === 'model')
    actions.push('graph', 'build-resulting-process', 'aggregate', 'prepare', 'calculate');
  if (type === 'process') actions.push('statistics', 'results', 'get-result');
  if (type === 'source') actions.push('upload-attachments');
  return actions;
}

export type ReviewRead = (input: {
  id?: string;
  role?: 'submitter' | 'reviewer';
  state?: number;
  limit: number;
  offset: number;
}) => Promise<{ records: JsonObject[]; total: number | null; environment: string; actor: string }>;
