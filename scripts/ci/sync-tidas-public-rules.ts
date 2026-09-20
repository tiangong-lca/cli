import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT_ROOT = path.join(REPOSITORY_ROOT, 'assets/tidas-public-rules');
const EXPECTED_COMMIT = 'd4cb089c753ffd20b173db2e56fb553a364f48f4';
const EXPECTED_INDEX_SHA = 'd8f1e90777fe0c675d1e24cbd7f1141ee776d3ebda9d8b24c91f714779540dec';
const EXPECTED_SCHEMA_SHA = '552a8c5fb87300dbe4ff5021d3d09a2b2d369999e887c223bc5c9738a99549f5';
const FILES = ['public-rules.v1.json', 'public-rules.v1.schema.json'] as const;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const verify = process.argv.includes('--verify-bundled');
const sourceRootArgument = argument('--source-root');

const source = {
  schema_version: 'tidas.public-rules-source.v1',
  repository: 'https://github.com/tiangong-lca/tidas-spec.git',
  commit: EXPECTED_COMMIT,
  rules_version: '2026.09.20',
  status: 'released',
  index_sha256: EXPECTED_INDEX_SHA,
  schema_sha256: EXPECTED_SCHEMA_SHA,
};
const sourceText = `${JSON.stringify(source, null, 2)}\n`;

if (verify) {
  const bundledBytes = FILES.map((name) => readFileSync(path.join(OUTPUT_ROOT, name)));
  if (
    sha256(bundledBytes[0]) !== EXPECTED_INDEX_SHA ||
    sha256(bundledBytes[1]) !== EXPECTED_SCHEMA_SHA
  ) {
    throw new Error('Bundled public-rule bytes do not match the pinned digests.');
  }
  if (readFileSync(path.join(OUTPUT_ROOT, 'public-rules.source.v1.json'), 'utf8') !== sourceText) {
    throw new Error('Bundled public-rule source identity is stale.');
  }
  if (sourceRootArgument) {
    const sourceRulesRoot = path.join(path.resolve(sourceRootArgument), 'assets/tidas/rules');
    for (const [index, name] of FILES.entries()) {
      if (!readFileSync(path.join(sourceRulesRoot, name)).equals(bundledBytes[index])) {
        throw new Error(`Bundled ${name} differs from the pinned tidas-spec source.`);
      }
    }
  }
  process.stdout.write(`Verified CLI public rules against tidas-spec ${EXPECTED_COMMIT}.\n`);
} else {
  const sourceRulesRoot = path.join(
    path.resolve(sourceRootArgument ?? path.join(REPOSITORY_ROOT, '..', 'tidas-spec')),
    'assets/tidas/rules',
  );
  const sourceBytes = FILES.map((name) => readFileSync(path.join(sourceRulesRoot, name)));
  if (
    sha256(sourceBytes[0]) !== EXPECTED_INDEX_SHA ||
    sha256(sourceBytes[1]) !== EXPECTED_SCHEMA_SHA
  ) {
    throw new Error(`tidas-spec public-rule bytes do not match pinned commit ${EXPECTED_COMMIT}.`);
  }
  for (const [index, name] of FILES.entries()) {
    writeFileSync(path.join(OUTPUT_ROOT, name), sourceBytes[index]);
  }
  writeFileSync(path.join(OUTPUT_ROOT, 'public-rules.source.v1.json'), sourceText);
  process.stdout.write(`Synchronized CLI public rules from tidas-spec ${EXPECTED_COMMIT}.\n`);
}
