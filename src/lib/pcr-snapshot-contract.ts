import { createHash } from 'node:crypto';
import { CliError } from '../shared/errors.js';

export const PCR_PIN_SCHEMA = 'tiangong-lca.pcr-snapshot-lock.v1';
export const PCR_RELEASE_ORIGIN = 'https://github.com/tiangong-lca/pcr/releases/download/';
export const PCR_METADATA_LIMIT = 1024 * 1024;
export const PCR_DATABASE_LIMIT = 512 * 1024 * 1024;
export const LEGACY_SOURCE = 'dc0638e2814c7108a6e4dea6d701c02824b3658d';
export const LEGACY_FINGERPRINT =
  'sha256:79e28dac12e712c30cc77e1cb0a86f3ed63a06e10a1fb22602213456ef906090';
export const AUDITED_HISTORICAL_CONTENT = {
  version: '0.3.1',
  source_commit: '4226d2ab97d53682c967dd29a2a04d97debfc15e',
  source_fingerprint: 'sha256:3f267da4e67ccb0be0b900d4416be11ebaaddb9e60f2f6390f9c85f2e0a893de',
  source_sha256: 'sha256:c7b77787ca883ed4169bbda356b538232a34489ddefd132c7b0fd30eff846ae3',
  release_sha256: '18ff3a7d8ecb39e72a4642747b0fc2af5d0f4c9e25a54a80d7c7f0e144c5f5b9',
  database: {
    bytes: 40386560,
    sha256: 'a2ddd7717f8df3651100c4f08cb97a65e6c8fa2a5b2699f25560b92b4e7a85de',
  },
  sidecar: {
    bytes: 918,
    sha256: '6a3771c6b6a77090494ef2d4f52fec8fa3baf20e735c8ff88b1e4280df5c3a58',
  },
} as const;
export type ReaderProfile = {
  version: string;
  libraryFormats: number[];
  projectionContracts: string[];
  commandProtocol: number;
};
export type SnapshotCompatibility = {
  schema: 1;
  libraryFormat: number;
  projectionContracts: string[];
  minimumReaderVersion: string;
  commandProtocol: number;
};
export type FileProof = { bytes: number; sha256: string };
export type SnapshotIdentity = {
  version: string;
  source_commit: string;
  source_sha256: string;
  format_version: 1;
  database: FileProof;
};
export type SnapshotPin = SnapshotIdentity & {
  schema: typeof PCR_PIN_SCHEMA;
  sidecar: FileProof;
  release: null | { url: string; sha256: string; source_fingerprint: string };
  selection: 'latest-compatible' | 'explicit-version' | 'explicit-library' | 'offline-cache';
  compatibility: SnapshotCompatibility;
};
export function pcrError(code: string, message: string): never {
  throw new CliError(message, { code: `PCR_SNAPSHOT_${code}`, exitCode: 2 });
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    pcrError('INVALID', 'Expected a PCR metadata object.');
  return value as Record<string, unknown>;
}
export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    pcrError('INVALID', 'Expected a lowercase SHA-256.');
  return value;
}
export function prefixedSha(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('sha256:'))
    pcrError('INVALID', 'Expected sha256:<64 lowercase hex digits>.');
  return `sha256:${sha(value.slice(7))}`;
}
export function stableVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(value) ||
    value.split('.').some((part) => !Number.isSafeInteger(Number(part)))
  )
    pcrError('INVALID', 'Expected an exact stable PCR version.');
  return value;
}
export function compareVersions(a: string, b: string): number {
  const left = stableVersion(a).split('.').map(Number),
    right = stableVersion(b).split('.').map(Number);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}
export function proof(value: unknown, maximum: number): FileProof {
  const data = object(value);
  if (
    typeof data.bytes !== 'number' ||
    !Number.isSafeInteger(data.bytes) ||
    data.bytes < 1 ||
    data.bytes > maximum
  )
    pcrError('LIMIT', 'PCR artifact size is outside the supported budget.');
  return { bytes: data.bytes, sha256: sha(data.sha256) };
}
export function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    pcrError('INVALID', 'PCR metadata must be complete UTF-8 JSON.');
  }
}
export function snapshotIdentity(value: unknown): SnapshotIdentity {
  const data = object(value),
    snapshot = object(data.snapshot);
  if (data.kind !== 'tiangong-pcr-library') pcrError('INVALID', 'Unknown PCR snapshot kind.');
  if (data.format_version !== 1)
    pcrError('INCOMPATIBLE', 'This CLI supports PCR snapshot format 1 only.');
  if (JSON.stringify(snapshot.available_languages) !== '["en-US"]')
    pcrError('INCOMPATIBLE', 'This CLI supports English PCR snapshots only.');
  if (typeof snapshot.source_commit !== 'string' || !/^[a-f0-9]{40}$/u.test(snapshot.source_commit))
    pcrError('INVALID', 'PCR source commit must be exact.');
  const indexes = object(data.index_sha256);
  for (const name of ['records', 'aliases', 'coverage', 'files']) prefixedSha(indexes[name]);
  return {
    version: stableVersion(snapshot.content_version),
    source_commit: snapshot.source_commit,
    source_sha256: prefixedSha(snapshot.source_sha256),
    format_version: 1,
    database: proof(
      { bytes: data.bytes, sha256: prefixedSha(data.sha256).slice(7) },
      PCR_DATABASE_LIMIT,
    ),
  };
}
export function releaseUrl(version: string, filename: string): string {
  return `${PCR_RELEASE_ORIGIN}v${stableVersion(version)}/${filename}`;
}
export function cacheKey(pin: SnapshotPin): string {
  return digest(Buffer.from(JSON.stringify({ ...pin, selection: null })));
}
export function parsePin(value: unknown): SnapshotPin {
  const data = object(value);
  if (
    Object.keys(data).sort().join(',') !==
      'compatibility,database,format_version,release,schema,selection,sidecar,source_commit,source_sha256,version' ||
    data.schema !== PCR_PIN_SCHEMA ||
    data.format_version !== 1 ||
    !['latest-compatible', 'explicit-version', 'explicit-library', 'offline-cache'].includes(
      String(data.selection),
    )
  )
    pcrError('PIN_INVALID', 'Invalid immutable PCR task pin.');
  if (typeof data.source_commit !== 'string' || !/^[a-f0-9]{40}$/u.test(data.source_commit))
    pcrError('PIN_INVALID', 'Invalid pinned PCR source commit.');
  const version = stableVersion(data.version);
  let release: SnapshotPin['release'] = null;
  if (data.release !== null) {
    const selected = object(data.release);
    if (
      Object.keys(selected).sort().join(',') !== 'sha256,source_fingerprint,url' ||
      selected.url !== releaseUrl(version, 'release.json')
    )
      pcrError('PIN_INVALID', 'PCR release pin must name the canonical exact release.');
    release = {
      url: selected.url,
      sha256: sha(selected.sha256),
      source_fingerprint: prefixedSha(selected.source_fingerprint),
    };
  }
  return {
    schema: PCR_PIN_SCHEMA,
    version,
    source_commit: data.source_commit,
    source_sha256: prefixedSha(data.source_sha256),
    format_version: 1,
    database: proof(data.database, PCR_DATABASE_LIMIT),
    sidecar: proof(data.sidecar, PCR_METADATA_LIMIT),
    release,
    selection: data.selection as SnapshotPin['selection'],
    compatibility: parseCompatibility(data.compatibility),
  };
}
export function parseCompatibility(value: unknown): SnapshotCompatibility {
  const data = object(value);
  if (
    Object.keys(data).sort().join(',') !==
      'commandProtocol,libraryFormat,minimumReaderVersion,projectionContracts,schema' ||
    data.schema !== 1 ||
    typeof data.libraryFormat !== 'number' ||
    !Number.isSafeInteger(data.libraryFormat) ||
    data.libraryFormat < 1 ||
    typeof data.commandProtocol !== 'number' ||
    !Number.isSafeInteger(data.commandProtocol) ||
    data.commandProtocol < 1 ||
    !Array.isArray(data.projectionContracts) ||
    data.projectionContracts.length < 1 ||
    data.projectionContracts.length > 16 ||
    data.projectionContracts.some(
      (item) => typeof item !== 'string' || !/^[1-9][0-9]*$/u.test(item),
    ) ||
    new Set(data.projectionContracts).size !== data.projectionContracts.length
  )
    pcrError('INCOMPATIBLE', 'Unknown or malformed PCR compatibility contract.');
  return {
    schema: 1,
    libraryFormat: data.libraryFormat,
    projectionContracts: data.projectionContracts as string[],
    minimumReaderVersion: stableVersion(data.minimumReaderVersion),
    commandProtocol: data.commandProtocol,
  };
}
export const LEGACY_COMPATIBILITY: SnapshotCompatibility = {
  schema: 1,
  libraryFormat: 1,
  projectionContracts: ['1', '2'],
  minimumReaderVersion: '0.4.1',
  commandProtocol: 1,
};
export const HISTORICAL_CONTENT_COMPATIBILITY: SnapshotCompatibility = {
  ...LEGACY_COMPATIBILITY,
  projectionContracts: ['1'],
};
export function isAuditedHistoricalContent(
  identity: SnapshotIdentity,
  sidecar: FileProof,
): boolean {
  return (
    identity.version === AUDITED_HISTORICAL_CONTENT.version &&
    identity.source_commit === AUDITED_HISTORICAL_CONTENT.source_commit &&
    identity.source_sha256 === AUDITED_HISTORICAL_CONTENT.source_sha256 &&
    JSON.stringify(identity.database) === JSON.stringify(AUDITED_HISTORICAL_CONTENT.database) &&
    JSON.stringify(sidecar) === JSON.stringify(AUDITED_HISTORICAL_CONTENT.sidecar)
  );
}
export const BASELINE_READER: ReaderProfile = {
  version: '0.4.1',
  libraryFormats: [1],
  projectionContracts: ['1', '2'],
  commandProtocol: 1,
};
export function compatibleReader(
  compatibility: SnapshotCompatibility,
  reader: ReaderProfile,
): boolean {
  return (
    reader.libraryFormats.includes(compatibility.libraryFormat) &&
    compatibility.projectionContracts.every((item) => reader.projectionContracts.includes(item)) &&
    reader.commandProtocol === compatibility.commandProtocol &&
    compareVersions(reader.version, compatibility.minimumReaderVersion) >= 0
  );
}
