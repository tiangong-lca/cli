import type { FetchLike } from '../transport/http.js';
import { distributionUrl } from '../runtime/manifest-values.js';
import {
  PCR_METADATA_LIMIT,
  PCR_DATABASE_LIMIT,
  PCR_PIN_SCHEMA,
  LEGACY_SOURCE,
  LEGACY_FINGERPRINT,
  LEGACY_COMPATIBILITY,
  AUDITED_HISTORICAL_CONTENT,
  HISTORICAL_CONTENT_COMPATIBILITY,
  BASELINE_READER,
  parseCompatibility,
  compatibleReader,
  pcrError,
  object,
  digest,
  parseJson,
  proof,
  prefixedSha,
  stableVersion,
  compareVersions,
  releaseUrl,
  snapshotIdentity,
  type SnapshotPin,
  type ReaderProfile,
} from './contract.js';

const API = 'https://api.github.com/repos/tiangong-lca/pcr/releases';
export async function metadataBytes(
  url: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<Buffer> {
  const abort = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  let target = url;
  for (let redirects = 0; ; redirects++) {
    const response = await fetchImpl(target, {
      method: 'GET',
      redirect: 'manual',
      signal: abort,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 5 || url.startsWith(API))
        pcrError('REDIRECT', 'PCR metadata exceeded its redirect contract.');
      target = distributionUrl(new URL(location, target).href, true);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      pcrError('HTTP', 'PCR publisher did not return complete metadata.');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        abort.throwIfAborted();
        const next = await reader.read();
        if (next.done) return Buffer.concat(chunks);
        count += next.value.byteLength;
        if (count > PCR_METADATA_LIMIT) pcrError('LIMIT', 'PCR metadata exceeds 1 MiB.');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
function publishedVersion(value: unknown): string | null {
  const release = object(value);
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.published_at !== 'string' ||
    !Number.isFinite(Date.parse(release.published_at)) ||
    typeof release.tag_name !== 'string' ||
    !/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(release.tag_name)
  )
    return null;
  return stableVersion(release.tag_name.slice(1));
}
export async function publishedVersions(
  fetchImpl: FetchLike,
  explicit?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (explicit !== undefined) {
    const version = stableVersion(explicit);
    if (
      publishedVersion(
        parseJson(await metadataBytes(`${API}/tags/v${version}`, fetchImpl, signal)),
      ) !== version
    )
      pcrError('UNPUBLISHED', 'The selected PCR version is not a stable published release.');
    return [version];
  }
  const versions = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const data = parseJson(
      await metadataBytes(`${API}?per_page=100&page=${page}`, fetchImpl, signal),
    );
    if (!Array.isArray(data) || data.length > 100)
      pcrError('INVALID', 'Invalid bounded PCR release listing.');
    for (const release of data) {
      const version = publishedVersion(release);
      if (version !== null) versions.add(version);
    }
    if (data.length < 100) return [...versions].sort((a, b) => compareVersions(b, a));
  }
  pcrError(
    'DISCOVERY_INCOMPLETE',
    'PCR release discovery exceeded 1000 releases; choose an exact version.',
  );
}
export async function selectPublishedSnapshot(
  fetchImpl: FetchLike,
  explicit?: string,
  signal?: AbortSignal,
  reader: ReaderProfile = BASELINE_READER,
): Promise<{ pin: SnapshotPin; sidecar: Buffer; release: Buffer }> {
  const versions = await publishedVersions(fetchImpl, explicit, signal);
  for (const version of versions) {
    const url = releaseUrl(version, 'release.json'),
      releaseBytes = await metadataBytes(url, fetchImpl, signal);
    const release = object(parseJson(releaseBytes));
    if (release.schema !== 1 || release.kind !== 'pcr-product-release') {
      if (explicit !== undefined)
        pcrError('INCOMPATIBLE', 'Unsupported PCR product release schema.');
      continue;
    }
    const identity = object(release.identity);
    if (
      identity.schema !== 1 ||
      identity.version !== version ||
      identity.tag !== `v${version}` ||
      typeof identity.sourceCommit !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(identity.sourceCommit)
    )
      pcrError('INVALID', 'PCR release identity differs from the published version.');
    const sourceFingerprint = prefixedSha(identity.sourceFingerprint);
    if (release.compatibility !== undefined) {
      const schema = object(release.compatibility).schema;
      if (typeof schema !== 'number' || !Number.isSafeInteger(schema) || schema < 1)
        pcrError('INVALID', 'PCR compatibility schema must be a positive safe integer.');
      if (schema !== 1) {
        if (explicit !== undefined)
          pcrError('INCOMPATIBLE', 'Unsupported PCR release compatibility schema.');
        continue;
      }
    }
    const historical =
      version === AUDITED_HISTORICAL_CONTENT.version &&
      identity.sourceCommit === AUDITED_HISTORICAL_CONTENT.source_commit &&
      sourceFingerprint === AUDITED_HISTORICAL_CONTENT.source_fingerprint &&
      digest(releaseBytes) === AUDITED_HISTORICAL_CONTENT.release_sha256;
    const compatibility =
      release.compatibility === undefined
        ? version === '0.4.1' &&
          identity.sourceCommit === LEGACY_SOURCE &&
          sourceFingerprint === LEGACY_FINGERPRINT
          ? LEGACY_COMPATIBILITY
          : historical
            ? HISTORICAL_CONTENT_COMPATIBILITY
            : null
        : parseCompatibility(release.compatibility);
    if (
      compatibility === null ||
      compatibility.libraryFormat !== 1 ||
      !compatibleReader(compatibility, reader)
    ) {
      if (explicit !== undefined)
        pcrError('INCOMPATIBLE', 'PCR content is incompatible with the selected reader.');
      continue;
    }
    if (!Array.isArray(release.artifacts))
      pcrError('INVALID', 'PCR release has no artifact proofs.');
    const artifacts = release.artifacts;
    const proofs = (name: string, limit: number) => {
      const matches = artifacts.filter((entry: unknown) => object(entry).filename === name);
      if (matches.length !== 1)
        pcrError('INVALID', 'PCR release must bind each selected artifact exactly once.');
      return proof(matches[0], limit);
    };
    const database = proofs('library.sqlite', PCR_DATABASE_LIMIT),
      sidecarProof = proofs('library.sqlite.json', PCR_METADATA_LIMIT);
    const sidecar = await metadataBytes(
      releaseUrl(version, 'library.sqlite.json'),
      fetchImpl,
      signal,
    );
    if (sidecar.length !== sidecarProof.bytes || digest(sidecar) !== sidecarProof.sha256)
      pcrError('INTEGRITY', 'PCR sidecar differs from the sealed release artifact.');
    const sidecarJson = object(parseJson(sidecar));
    if (sidecarJson.format_version !== compatibility.libraryFormat)
      pcrError('INTEGRITY', 'PCR snapshot format differs from its release compatibility contract.');
    const snapshot = snapshotIdentity(sidecarJson);

    if (
      snapshot.version !== version ||
      snapshot.source_commit !== identity.sourceCommit ||
      JSON.stringify(snapshot.database) !== JSON.stringify(database)
    )
      pcrError('INTEGRITY', 'PCR snapshot identity differs from the sealed release.');
    return {
      pin: {
        schema: PCR_PIN_SCHEMA,
        ...snapshot,
        sidecar: sidecarProof,
        release: { url, sha256: digest(releaseBytes), source_fingerprint: sourceFingerprint },
        selection: explicit === undefined ? 'latest-compatible' : 'explicit-version',
        compatibility,
      },
      sidecar,
      release: releaseBytes,
    };
  }
  pcrError('INCOMPATIBLE', 'No supported published PCR snapshot is available.');
}
