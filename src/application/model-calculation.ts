import {
  object,
  text,
  isObject,
  datasetWrappers,
  type DatasetType,
  type JsonObject,
} from './dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';

export type CalculationDataset = 'process' | 'flow' | 'flowproperty' | 'unitgroup';
export type CalculationReference = { type: CalculationDataset; id: string; version: string };
const infos = {
  model: 'lifeCycleModelInformation',
  process: 'processInformation',
  flow: 'flowInformation',
  flowproperty: 'flowPropertiesInformation',
  unitgroup: 'unitGroupInformation',
};
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const field = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), v);
export function calculationIdentity(content: JsonObject) {
  const types = Object.keys(infos) as (keyof typeof infos)[];
  const found = types.filter((type) => isObject(content[datasetWrappers[type]]));
  if (found.length !== 1)
    throw new CommandInputError(
      'CALCULATION_DATASET_INVALID',
      'Supply one canonical Model, Process, Flow, FlowProperty or UnitGroup document.',
    );
  const type = found[0]!;
  const root = content[datasetWrappers[type]];
  return {
    type,
    id: text(field(root, infos[type], 'dataSetInformation', 'common:UUID'), 'dataset UUID'),
    version: text(
      field(root, 'administrativeInformation', 'publicationAndOwnership', 'common:dataSetVersion'),
      'dataset version',
    ),
  };
}
function reference(type: CalculationDataset, value: unknown): CalculationReference {
  const ref = object(value, `${type} reference`);
  const version = text(ref['@version'], `${type} reference version`);
  if (version === 'latest')
    throw new CommandInputError(
      'EXACT_VERSION_REQUIRED',
      'Calculation references require exact versions.',
    );
  return { type, id: text(ref['@refObjectId'], `${type} reference UUID`), version };
}
export function numericalReferences(
  type: DatasetType,
  content: JsonObject,
): CalculationReference[] {
  const root = content[datasetWrappers[type]];
  if (type === 'model')
    return list(field(root, infos.model, 'technology', 'processes', 'processInstance')).map((v) =>
      reference('process', field(v, 'referenceToProcess')),
    );
  if (type === 'process')
    return list(field(root, 'exchanges', 'exchange')).map((v) =>
      reference('flow', field(v, 'referenceToFlowDataSet')),
    );
  if (type === 'flow') {
    const pivot = field(
      root,
      infos.flow,
      'quantitativeReference',
      'referenceToReferenceFlowProperty',
    );
    const selected = list(field(root, 'flowProperties', 'flowProperty')).filter(
      (v) => String(field(v, '@dataSetInternalID')) === String(pivot),
    );
    if (pivot === undefined || selected.length !== 1)
      throw new CommandInputError(
        'CALCULATION_REFERENCE_PROPERTY',
        'Flow must select one reference FlowProperty by internal ID.',
      );
    return [reference('flowproperty', field(selected[0], 'referenceToFlowPropertyDataSet'))];
  }
  if (type === 'flowproperty')
    return [
      reference(
        'unitgroup',
        field(root, infos.flowproperty, 'quantitativeReference', 'referenceToReferenceUnitGroup'),
      ),
    ];
  return [];
}
const key = (r: { type: string; id: string; version: string }) =>
  JSON.stringify([r.type, r.id, r.version]);
export type ModelPreparationPorts = {
  load(selection: JsonObject): Promise<JsonObject>;
  read(ref: CalculationReference): Promise<JsonObject>;
};
export async function prepareModel(
  request: JsonObject,
  ports: ModelPreparationPorts,
): Promise<JsonObject> {
  const allowed = [
    'model',
    'datasets',
    'backgrounds',
    'methods',
    'amount',
    'cutoffs',
    'limits',
    'allowRemoteLookup',
  ];
  if (Object.keys(request).some((k) => !allowed.includes(k)))
    throw new CommandInputError(
      'CALCULATION_OPTION_UNKNOWN',
      'Unknown calculation preparation field. Inspect prepare --help.',
    );
  if (request.allowRemoteLookup !== undefined && typeof request.allowRemoteLookup !== 'boolean')
    throw new CommandInputError('CALCULATION_REMOTE_SETTING', 'allowRemoteLookup must be boolean.');
  const entries = (v: unknown, label: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v))
      throw new CommandInputError('CALCULATION_ARRAY_REQUIRED', `${label} must be an array.`);
    return v;
  };
  const methods = entries(request.methods, 'methods').map((v) => {
    const r = object(v, 'method');
    return { id: text(r.id, 'method.id'), version: text(r.version, 'method.version') };
  });
  if (
    !methods.length ||
    new Set(methods.map((m) => m.id)).size !== methods.length ||
    methods.some((m) => m.version === 'latest')
  )
    throw new CommandInputError(
      'CALCULATION_METHODS_INVALID',
      'Select distinct LCIA methods with exact versions.',
    );
  const amount = request.amount ?? 1;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0)
    throw new CommandInputError(
      'CALCULATION_AMOUNT_INVALID',
      'amount must be finite and positive.',
    );
  const limits = request.limits === undefined ? {} : object(request.limits, 'limits');
  const maxDocuments = limits.maxDocuments ?? 512;
  if (!Number.isSafeInteger(maxDocuments) || Number(maxDocuments) < 1)
    throw new CommandInputError(
      'CALCULATION_DOCUMENT_LIMIT',
      'maxDocuments must be a positive safe integer.',
    );
  const model = await ports.load(object(request.model, 'model'));
  if (calculationIdentity(model).type !== 'model')
    throw new CommandInputError(
      'CALCULATION_MODEL_REQUIRED',
      'model must select a canonical Model.',
    );
  const documents = new Map<string, JsonObject>();
  for (const value of entries(request.datasets, 'datasets')) {
    const doc = await ports.load(object(value, 'dataset selection'));
    const identity = calculationIdentity(doc);
    if (identity.type === 'model' || documents.has(key(identity)))
      throw new CommandInputError(
        'CALCULATION_DUPLICATE_DATASET',
        'Provide each supporting dataset identity once, without additional Models.',
      );
    documents.set(key(identity), doc);
    if (documents.size + 1 > Number(maxDocuments))
      throw new CommandInputError(
        'CALCULATION_DOCUMENT_LIMIT',
        'Input exceeds maxDocuments. Increase the explicit resource budget if appropriate.',
      );
  }
  const backgrounds: JsonObject[] = [];
  const backgroundSources = new Set<string>();
  for (const value of entries(request.backgrounds, 'backgrounds')) {
    const bg = await ports.load(object(value, 'background selection'));
    if (bg.schemaVersion !== 1 || bg.kind !== 'lci' || bg.complete !== true)
      throw new CommandInputError(
        'CALCULATION_BACKGROUND_INCOMPLETE',
        'Use a complete get-result --kind lci artifact.',
      );
    const source = object(bg.source, 'background source');
    const id = key({
      type: 'process',
      id: text(source.id, 'background source.id'),
      version: text(source.version, 'background source.version'),
    });
    if (backgroundSources.has(id))
      throw new CommandInputError(
        'CALCULATION_BACKGROUND_DUPLICATE',
        'Select one inventory per background Process.',
      );
    backgroundSources.add(id);
    backgrounds.push(bg);
  }
  const pending = numericalReferences('model', model);
  const modelProcesses = new Set(pending.map(key));
  if ([...backgroundSources].some((k) => !modelProcesses.has(k)))
    throw new CommandInputError(
      'CALCULATION_BACKGROUND_UNUSED',
      'Every background must be an explicit Process instance in the Model.',
    );
  const used = new Map<string, JsonObject>();
  for (let index = 0; index < pending.length; index++) {
    const ref = pending[index]!;
    const id = key(ref);
    if (used.has(id)) continue;
    if (used.size + 2 > Number(maxDocuments))
      throw new CommandInputError(
        'CALCULATION_DOCUMENT_LIMIT',
        'Resolved dependencies exceed maxDocuments.',
      );
    let doc = documents.get(id);
    if (!doc) {
      if (request.allowRemoteLookup !== true)
        throw new CommandInputError(
          'CALCULATION_DEPENDENCY_MISSING',
          `Missing ${ref.type} ${ref.id}@${ref.version}. Supply its content/file or explicitly enable allowRemoteLookup.`,
        );
      doc = await ports.read(ref);
      if (key(calculationIdentity(doc)) !== id)
        throw new CommandInputError(
          'CALCULATION_DEPENDENCY_MISMATCH',
          'Remote dependency did not match its exact requested identity.',
        );
    }
    used.set(id, doc);
    // Aggregated backgrounds replace the Process inventory; do not expand their original exchanges.
    if (!backgroundSources.has(id)) pending.push(...numericalReferences(ref.type, doc));
  }
  return {
    schemaVersion: 'lca.model-input.v1',
    model,
    datasets: [...used.values()],
    backgrounds,
    methods,
    amount,
    cutoffs: entries(request.cutoffs, 'cutoffs'),
    limits,
  };
}
