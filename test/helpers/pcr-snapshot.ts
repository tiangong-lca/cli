import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  digest,
  LEGACY_SOURCE,
  LEGACY_FINGERPRINT,
  LEGACY_COMPATIBILITY,
} from '../../src/lib/pcr/contract.js';
import type { FetchLike } from '../../src/lib/transport/http.js';
export function snapshotFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-snapshot-test-'));
  const task = path.join(base, 'task'),
    cache = path.join(base, 'cache'),
    local = path.join(base, 'local'),
    tool = path.join(base, 'tool');
  fs.mkdirSync(local);
  fs.mkdirSync(tool);
  const database = Buffer.from('Test snapshot transport bytes.');
  const sidecar = {
    kind: 'tiangong-pcr-library',
    format_version: 1,
    snapshot: {
      available_languages: ['en-US'],
      content_version: '0.4.1',
      source_commit: LEGACY_SOURCE,
      source_sha256: 'sha256:' + '1'.repeat(64),
    },
    bytes: database.length,
    sha256: 'sha256:' + digest(database),
    index_sha256: Object.fromEntries(
      ['records', 'aliases', 'coverage', 'files'].map((name) => [name, 'sha256:' + '2'.repeat(64)]),
    ),
  };
  const sidecarBytes = Buffer.from(JSON.stringify(sidecar));
  fs.writeFileSync(path.join(local, 'library.sqlite'), database);
  fs.writeFileSync(path.join(local, 'library.sqlite.json'), sidecarBytes);
  const release = {
    schema: 1,
    kind: 'pcr-product-release',
    identity: {
      schema: 1,
      version: '0.4.1',
      tag: 'v0.4.1',
      sourceCommit: LEGACY_SOURCE,
      sourceFingerprint: LEGACY_FINGERPRINT,
    },
    artifacts: [
      { filename: 'library.sqlite', bytes: database.length, sha256: digest(database) },
      { filename: 'library.sqlite.json', bytes: sidecarBytes.length, sha256: digest(sidecarBytes) },
    ],
  };
  const manifest = {
    name: '@tiangong-lca/pcr',
    version: '0.4.1',
    type: 'module',
    gitHead: LEGACY_SOURCE,
    bin: { 'tiangong-pcr': 'entry.js' },
    dependencies: {},
  };
  fs.writeFileSync(path.join(tool, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(tool, 'product-release.json'), JSON.stringify(release.identity));
  fs.writeFileSync(
    path.join(tool, 'entry.js'),
    'import fs from "node:fs"; const args=process.argv.slice(2); console.log(JSON.stringify(args[0]==="library"&&args[1]==="verify"?{tool_version:"0.4.1",...JSON.parse(fs.readFileSync(args[args.indexOf("--library")+1]+".json","utf8")),verified:true}:args));',
  );
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (new URL(url).origin === 'https://api.github.com')
      return new Response(
        JSON.stringify(
          url.includes('/tags/')
            ? {
                draft: false,
                prerelease: false,
                published_at: '2026-10-01T00:00:00Z',
                tag_name: 'v0.4.1',
              }
            : [
                {
                  draft: false,
                  prerelease: false,
                  published_at: '2026-10-01T00:00:00Z',
                  tag_name: 'v0.4.1',
                },
              ],
        ),
      );
    if (url.endsWith('/release.json')) return new Response(JSON.stringify(release));
    if (url.endsWith('/library.sqlite.json')) return new Response(sidecarBytes);
    return new Response(database);
  };
  return {
    base,
    task,
    cache,
    local,
    tool,
    database,
    sidecar,
    sidecarBytes,
    release,
    manifest,
    calls,
    fetchImpl,
    options: { taskDir: task, cacheDir: cache, fetchImpl },
    localOptions: {
      taskDir: task,
      cacheDir: cache,
      library: path.join(local, 'library.sqlite'),
      librarySha256: 'sha256:' + digest(database),
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
    compatibility: LEGACY_COMPATIBILITY,
  };
}
