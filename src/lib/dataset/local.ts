import { isRecord, firstNonEmpty, datasetRoot } from './json.js';
export { isRecord, cloneJson, trimToken, firstNonEmpty, datasetRoot } from './json.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CliError } from '../../shared/errors.js';
import { readJsonInput } from '../platform/io.js';

export type JsonObject = Record<string, unknown>;

export type DatasetKind =
  'contact' | 'flow' | 'flowproperty' | 'lifecyclemodel' | 'process' | 'source' | 'unitgroup';

export type DatasetRowInput = {
  index: number;
  row: JsonObject;
  payload: JsonObject;
  kind: DatasetKind | null;
  id: string | null;
  version: string | null;
};

function readJsonLinesInput(inputPath: string): JsonObject[] {
  const resolved = path.resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new CliError(`Input file not found: ${resolved}`, {
      code: 'INPUT_NOT_FOUND',
      exitCode: 2,
    });
  }

  return readFileSync(resolved, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new CliError(`Input file contains invalid JSONL at line ${index + 1}: ${resolved}`, {
          code: 'INPUT_INVALID_JSONL',
          exitCode: 2,
          details: String(error),
        });
      }
      if (!isRecord(parsed)) {
        throw new CliError(
          `Expected JSON object rows in JSONL input: ${resolved} (line ${index + 1})`,
          {
            code: 'INPUT_INVALID_JSONL_ROW',
            exitCode: 2,
          },
        );
      }
      return parsed;
    });
}

function normalizeStructuredRows(value: unknown, inputPath: string): JsonObject[] {
  const rows = isRecord(value) && Array.isArray(value.rows) ? value.rows : value;
  const normalizedRows = Array.isArray(rows) ? rows : [rows];
  return normalizedRows.map((row, index) => {
    if (!isRecord(row)) {
      throw new CliError(
        `Expected JSON object rows in dataset input: ${inputPath} (index ${index})`,
        {
          code: 'DATASET_INPUT_INVALID_ROW',
          exitCode: 2,
        },
      );
    }
    return row;
  });
}

export function readDatasetRowsInput(inputPath: string, rawInput?: unknown): JsonObject[] {
  if (!inputPath) {
    throw new CliError('Missing required --input value.', {
      code: 'DATASET_INPUT_REQUIRED',
      exitCode: 2,
    });
  }

  if (rawInput !== undefined) {
    return normalizeStructuredRows(rawInput, inputPath);
  }

  const resolved = path.resolve(inputPath);
  return resolved.toLowerCase().endsWith('.jsonl')
    ? readJsonLinesInput(resolved)
    : normalizeStructuredRows(readJsonInput(resolved), resolved);
}

export function detectDatasetKind(value: JsonObject): DatasetKind | null {
  const payload = unwrapDatasetPayload(value);
  if (isRecord(payload.contactDataSet)) {
    return 'contact';
  }
  if (isRecord(payload.flowDataSet)) {
    return 'flow';
  }
  if (isRecord(payload.flowPropertyDataSet)) {
    return 'flowproperty';
  }
  if (isRecord(payload.processDataSet)) {
    return 'process';
  }
  if (isRecord(payload.lifeCycleModelDataSet)) {
    return 'lifecyclemodel';
  }
  if (isRecord(payload.sourceDataSet)) {
    return 'source';
  }
  if (isRecord(payload.unitGroupDataSet)) {
    return 'unitgroup';
  }
  if (isRecord(value.contact)) {
    return 'contact';
  }
  if (isRecord(value.flow)) {
    return 'flow';
  }
  if (isRecord(value.flowproperty)) {
    return 'flowproperty';
  }
  if (isRecord(value.process)) {
    return 'process';
  }
  if (isRecord(value.lifecyclemodel)) {
    return 'lifecyclemodel';
  }
  if (isRecord(value.source)) {
    return 'source';
  }
  if (isRecord(value.unitgroup)) {
    return 'unitgroup';
  }
  return null;
}

export function unwrapDatasetPayload(row: JsonObject): JsonObject {
  for (const key of ['json_ordered', 'jsonOrdered', 'json', 'payload'] as const) {
    if (isRecord(row[key])) {
      return row[key];
    }
  }
  if (isRecord(row.flow)) {
    return row.flow;
  }
  if (isRecord(row.process)) {
    return row.process;
  }
  if (isRecord(row.lifecyclemodel)) {
    return row.lifecyclemodel;
  }
  if (isRecord(row.contact)) {
    return row.contact;
  }
  if (isRecord(row.source)) {
    return row.source;
  }
  if (isRecord(row.unitgroup)) {
    return row.unitgroup;
  }
  if (isRecord(row.flowproperty)) {
    return row.flowproperty;
  }
  return row;
}

function genericIdentity(
  payload: JsonObject,
  kind: DatasetKind,
  informationKey: string,
): { id: string | null; version: string | null } {
  const root = datasetRoot(payload, kind);
  const information = isRecord(root[informationKey]) ? root[informationKey] : {};
  const dataSetInformation = isRecord(information.dataSetInformation)
    ? information.dataSetInformation
    : {};
  const administrativeInformation = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  return {
    id: firstNonEmpty(dataSetInformation['common:UUID']),
    version: firstNonEmpty(publicationAndOwnership['common:dataSetVersion']),
  };
}

function flowIdentity(payload: JsonObject): { id: string | null; version: string | null } {
  const root = datasetRoot(payload, 'flow');
  const information = isRecord(root.flowInformation) ? root.flowInformation : {};
  const dataSetInformation = isRecord(information.dataSetInformation)
    ? information.dataSetInformation
    : {};
  const administrativeInformation = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  return {
    id: firstNonEmpty(dataSetInformation['common:UUID']),
    version: firstNonEmpty(publicationAndOwnership['common:dataSetVersion']),
  };
}

function processIdentity(payload: JsonObject): { id: string | null; version: string | null } {
  const root = datasetRoot(payload, 'process');
  const information = isRecord(root.processInformation) ? root.processInformation : {};
  const dataSetInformation = isRecord(information.dataSetInformation)
    ? information.dataSetInformation
    : {};
  const administrativeInformation = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  return {
    id: firstNonEmpty(dataSetInformation['common:UUID']),
    version: firstNonEmpty(publicationAndOwnership['common:dataSetVersion']),
  };
}

function lifecyclemodelIdentity(payload: JsonObject): {
  id: string | null;
  version: string | null;
} {
  const root = datasetRoot(payload, 'lifecyclemodel');
  const information = isRecord(root.lifeCycleModelInformation)
    ? root.lifeCycleModelInformation
    : {};
  const dataSetInformation = isRecord(information.dataSetInformation)
    ? information.dataSetInformation
    : {};
  const administrativeInformation = isRecord(root.administrativeInformation)
    ? root.administrativeInformation
    : {};
  const publicationAndOwnership = isRecord(administrativeInformation.publicationAndOwnership)
    ? administrativeInformation.publicationAndOwnership
    : {};
  return {
    id: firstNonEmpty(dataSetInformation['common:UUID']),
    version: firstNonEmpty(publicationAndOwnership['common:dataSetVersion']),
  };
}

export function datasetIdentity(
  row: JsonObject,
  payload: JsonObject,
  kind: DatasetKind | null,
): { id: string | null; version: string | null } {
  if (kind === 'contact') {
    const identity = genericIdentity(payload, 'contact', 'contactInformation');
    return {
      id: firstNonEmpty(row.id, identity.id),
      version: firstNonEmpty(row.version, identity.version),
    };
  }
  if (kind === 'flow') {
    const identity = flowIdentity(payload);
    return {
      id: firstNonEmpty(row.id, identity.id),
      version: firstNonEmpty(row.version, identity.version),
    };
  }
  if (kind === 'flowproperty') {
    const identity = genericIdentity(payload, 'flowproperty', 'flowPropertiesInformation');
    return {
      id: firstNonEmpty(row.id, identity.id),
      version: firstNonEmpty(row.version, identity.version),
    };
  }
  if (kind === 'process') {
    const identity = processIdentity(payload);
    return {
      id: firstNonEmpty(row.id, identity.id),
      version: firstNonEmpty(row.version, identity.version),
    };
  }
  if (kind === 'lifecyclemodel') {
    const identity = lifecyclemodelIdentity(payload);
    return {
      id: firstNonEmpty(row.id, identity.id),
      version: firstNonEmpty(row.version, identity.version),
    };
  }
  if (kind === 'source') {
    const identity = genericIdentity(payload, 'source', 'sourceInformation');
    return {
      id: firstNonEmpty(row.id, identity.id),
      version: firstNonEmpty(row.version, identity.version),
    };
  }
  if (kind === 'unitgroup') {
    const identity = genericIdentity(payload, 'unitgroup', 'unitGroupInformation');
    return {
      id: firstNonEmpty(row.id, identity.id),
      version: firstNonEmpty(row.version, identity.version),
    };
  }
  return {
    id: firstNonEmpty(row.id),
    version: firstNonEmpty(row.version),
  };
}

export function materializeDatasetRows(inputPath: string, rawInput?: unknown): DatasetRowInput[] {
  return readDatasetRowsInput(inputPath, rawInput).map((row, index) => {
    const payload = unwrapDatasetPayload(row);
    const kind = detectDatasetKind(row);
    const identity = datasetIdentity(row, payload, kind);
    return {
      index,
      row,
      payload,
      kind,
      id: identity.id,
      version: identity.version,
    };
  });
}
