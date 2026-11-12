import { isObject, type JsonObject } from './dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';

export type ProcessResultRequest = {
  id: string;
  version: string;
  resultId?: string;
  kind: 'overview' | 'lci' | 'lcia';
  maxItems: number;
};
export type ResultQueryPort = (request: JsonObject) => Promise<JsonObject>;
/** Only a service-confirmed read-context change permits restarting the complete read. */
export class ResultReadChanged extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const version = /^\d{2}\.\d{2}\.\d{3}$/u;
export function resultProblem(code: string, message: string): never {
  throw new CommandInputError(code, message, 'precondition');
}
function valid(condition: unknown): asserts condition {
  if (!condition)
    resultProblem(
      'RESULT_RESPONSE_INVALID',
      'The result service returned incomplete or inconsistent data. Retry the read.',
    );
}
function record(value: unknown): JsonObject {
  valid(isObject(value));
  return value;
}
function exact(value: unknown): JsonObject {
  const item = record(value);
  valid(typeof item.uuid === 'string' && uuid.test(item.uuid));
  valid(typeof item.version === 'string' && version.test(item.version));
  return item;
}
export function processResultRequest(input: JsonObject): ProcessResultRequest {
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    typeof input.version !== 'string' ||
    !version.test(input.version)
  )
    throw new CommandInputError(
      'PROCESS_RESULT_SOURCE_INVALID',
      'Provide --id with a Process UUID and --version with an exact 00.00.000 version.',
    );
  if (
    input.resultId !== undefined &&
    (typeof input.resultId !== 'string' || !uuid.test(input.resultId))
  )
    throw new CommandInputError(
      'PROCESS_RESULT_SELECTION_INVALID',
      '--result-id must be a Result UUID returned by results.',
    );
  const kind = input.kind ?? 'overview';
  if (kind !== 'overview' && kind !== 'lci' && kind !== 'lcia')
    throw new CommandInputError(
      'PROCESS_RESULT_KIND_INVALID',
      '--kind must be overview, lci or lcia.',
    );
  const maxItems = input.maxItems ?? 100000;
  if (
    typeof maxItems !== 'number' ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 2000000
  )
    throw new CommandInputError(
      'PROCESS_RESULT_BUDGET_INVALID',
      '--max-items must be an integer from 1 to 2000000 (default 100000).',
    );
  return {
    id: input.id,
    version: input.version,
    resultId: input.resultId as string | undefined,
    kind,
    maxItems,
  };
}
async function selections(input: ProcessResultRequest, query: ResultQueryPort) {
  let publication: JsonObject | null = null;
  let afterKey: string | undefined;
  const results: JsonObject[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const data = await query({
      mode: 'source_results',
      sourceId: input.id,
      sourceVersion: input.version,
      limit: 100,
      ...(publication ? { publicationId: publication.publicationId } : {}),
      ...(afterKey ? { afterKey } : {}),
    });
    valid(Array.isArray(data.results) && data.results.length <= 100);
    if (data.publication === null) {
      valid(!publication && data.results.length === 0 && data.nextResultKey === null);
      return { publication: null, results };
    }
    const current = record(data.publication);
    valid(typeof current.publicationId === 'string' && uuid.test(current.publicationId));
    valid(!publication || publication.publicationId === current.publicationId);
    publication = current;
    for (const raw of data.results) {
      const row = exact(raw);
      const key = `${row.uuid}@${row.version}`;
      valid(
        !seen.has(key) &&
          row.relationKind === 'direct' &&
          typeof row.lciAvailable === 'boolean' &&
          typeof row.lciaAvailable === 'boolean',
      );
      seen.add(key);
      results.push(row);
    }
    if (data.nextResultKey === null) return { publication, results };
    valid(
      typeof data.nextResultKey === 'string' &&
        data.nextResultKey.length <= 128 &&
        data.nextResultKey !== afterKey &&
        data.results.length > 0,
    );
    afterKey = data.nextResultKey;
  }
  return resultProblem(
    'RESULT_SELECTION_LIMIT',
    'Too many result candidates. Narrow the source selection before reading.',
  );
}
function reference(value: unknown, selected: JsonObject) {
  const row = exact(value);
  valid(
    row.uuid === selected.uuid && row.version === selected.version && row.relationKind === 'direct',
  );
  const ref = record(row.quantitativeReference);
  valid(
    typeof ref.value === 'number' &&
      Number.isFinite(ref.value) &&
      ref.value !== 0 &&
      ref.amountField === 'resultingAmount',
  );
  inventoryKey(ref);
  return row;
}
function inventoryKey(value: JsonObject) {
  valid(
    typeof value.flowId === 'string' &&
      uuid.test(value.flowId) &&
      typeof value.flowVersion === 'string' &&
      version.test(value.flowVersion),
  );
  valid(value.direction === 'Input' || value.direction === 'Output');
  const unit = record(value.unit);
  for (const field of ['flowPropertyId', 'unitGroupId'])
    valid(typeof unit[field] === 'string' && uuid.test(unit[field]));
  for (const field of ['flowPropertyVersion', 'unitGroupVersion'])
    valid(typeof unit[field] === 'string' && version.test(unit[field]));
  valid(
    typeof unit.internalId === 'string' && typeof unit.name === 'string' && unit.name.length > 0,
  );
}
async function readOnce(
  input: ProcessResultRequest,
  list: boolean,
  query: ResultQueryPort,
): Promise<JsonObject> {
  const found = await selections(input, query);
  const source = { id: input.id, version: input.version };
  if (list) return { source, ...found, complete: true };
  const candidates = found.results.filter((row) => !input.resultId || row.uuid === input.resultId);
  if (!found.publication || candidates.length === 0)
    return resultProblem(
      'PROCESS_RESULT_UNAVAILABLE',
      'No published result is available for this Process version and selection. Use results to inspect available candidates.',
    );
  if (candidates.length !== 1)
    return resultProblem(
      'PROCESS_RESULT_AMBIGUOUS',
      'Several results match this Process. Use results, then select one with --result-id.',
    );
  const selected = candidates[0]!;
  if (
    (input.kind === 'lci' && !selected.lciAvailable) ||
    (input.kind === 'lcia' && !selected.lciaAvailable)
  )
    return resultProblem(
      'PROCESS_RESULT_LAYER_UNAVAILABLE',
      `This result does not provide ${input.kind.toUpperCase()}.`,
    );
  let runtimeRevision: string | undefined;
  let result: JsonObject | undefined;
  const read = async (selection: JsonObject) => {
    const envelope = await query({
      mode: 'final_query',
      resultId: selected.uuid,
      resultVersion: selected.version,
      publicationId: found.publication!.publicationId,
      ...(runtimeRevision ? { runtimeRevision } : {}),
      query: selection,
    });
    valid(
      envelope.schemaVersion === 'result.query.response.v2' &&
        envelope.publicationId === found.publication!.publicationId,
    );
    const identity = exact(envelope.result);
    valid(identity.uuid === selected.uuid && identity.version === selected.version);
    valid(typeof envelope.runtimeRevision === 'string' && uuid.test(envelope.runtimeRevision));
    valid(!runtimeRevision || envelope.runtimeRevision === runtimeRevision);
    runtimeRevision = envelope.runtimeRevision;
    const data = record(envelope.data);
    if (data.status === 'preparing')
      return resultProblem(
        'RESULT_PREPARING',
        'The result is being prepared for reading. Retry shortly; no calculation was started.',
      );
    const current = reference(data.result, selected);
    valid(!result || JSON.stringify(result) === JSON.stringify(current));
    result = current;
    return data;
  };
  let data: JsonObject;
  if (input.kind !== 'lci') {
    data = await read({ kind: input.kind });
    if (input.kind === 'overview')
      valid(typeof data.lciAvailable === 'boolean' && typeof data.lciaAvailable === 'boolean');
    else {
      valid(Array.isArray(data.impacts) && data.impacts.length <= 4096);
      for (const raw of data.impacts) {
        const row = record(raw);
        const method = record(row.method);
        valid(
          typeof row.amount === 'number' &&
            Number.isFinite(row.amount) &&
            typeof method.id === 'string' &&
            uuid.test(method.id) &&
            typeof method.version === 'string' &&
            version.test(method.version) &&
            typeof method.unit === 'string',
        );
      }
    }
  } else {
    const items: JsonObject[] = [];
    const cursors = new Set<string>();
    const keys = new Set<string>();
    let cursor: string | undefined;
    let total: number | undefined;
    // Sparse scanning can return an empty page with a continuation, so item count is not a page limit.
    for (;;) {
      if (cursors.size >= 2000)
        return resultProblem(
          'RESULT_PAGE_LIMIT',
          'Result reading exceeded the page budget. No partial inventory was accepted.',
        );
      const page = await read({ kind: 'lci', limit: 1000, ...(cursor ? { cursor } : {}) });
      valid(
        Number.isSafeInteger(page.nonzeroCount) &&
          Number(page.nonzeroCount) >= 0 &&
          Array.isArray(page.items) &&
          page.items.length <= 1000,
      );
      valid(total === undefined || total === page.nonzeroCount);
      total = page.nonzeroCount as number;
      if (total > input.maxItems)
        return resultProblem(
          'RESULT_ITEM_LIMIT',
          `The inventory has ${total} items. Increase --max-items to read it completely.`,
        );
      for (const raw of page.items) {
        const row = record(raw);
        inventoryKey(record(row.key));
        valid(typeof row.amount === 'number' && Number.isFinite(row.amount));
        const key = record(row.key);
        const unit = record(key.unit);
        const identity = JSON.stringify([
          key.flowId,
          key.flowVersion,
          key.direction,
          key.location,
          key.functionType,
          unit.flowPropertyId,
          unit.flowPropertyVersion,
          unit.unitGroupId,
          unit.unitGroupVersion,
          unit.internalId,
        ]);
        valid(!keys.has(identity));
        keys.add(identity);
        items.push(row);
      }
      valid(items.length <= total);
      if (page.nextCursor === null) break;
      valid(
        typeof page.nextCursor === 'string' &&
          page.nextCursor.length > 0 &&
          page.nextCursor.length <= 4096 &&
          !cursors.has(page.nextCursor),
      );
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
    valid(items.length === total);
    data = { result, items, nonzeroCount: total };
  }
  return {
    schemaVersion: 1,
    source,
    publication: found.publication,
    result: selected,
    kind: input.kind,
    data,
    complete: true,
  };
}
export async function readProcessResults(
  request: JsonObject,
  list: boolean,
  query: ResultQueryPort,
): Promise<JsonObject> {
  const input = processResultRequest(request);
  try {
    return await readOnce(input, list, query);
  } catch (error) {
    if (!(error instanceof ResultReadChanged)) throw error;
  }
  try {
    return await readOnce(input, list, query);
  } catch (error) {
    if (error instanceof ResultReadChanged)
      return resultProblem(
        'RESULT_CHANGED_DURING_READ',
        'Published results changed repeatedly during reading. Retry later; no mixed or partial inventory was accepted.',
      );
    throw error;
  }
}
