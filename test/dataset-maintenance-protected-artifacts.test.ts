import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensurePrivateArtifactDirectory,
  materializePrivateArtifactDirectoryAtomically,
  readProtectedJsonArtifact,
  readProtectedTextArtifact,
  writePrivateImmutableJson,
  writePrivateImmutableText,
} from '../src/lib/dataset-maintenance-protected-artifacts.js';
import { sha256Text } from '../src/lib/canonical-json-hash.js';

function withTempDirectory(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tiangong-protected-artifacts-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('protected artifacts are canonical, private, immutable, and readable', () => {
  withTempDirectory((root) => {
    const directory = ensurePrivateArtifactDirectory(path.join(root, 'nested'));
    if (process.platform !== 'win32') {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
    }

    const filePath = path.join(directory, 'evidence.json');
    const resolved = writePrivateImmutableJson(filePath, { z: 2, a: 1 });
    assert.equal(resolved, path.resolve(filePath));
    assert.equal(readFileSync(filePath, 'utf8'), '{"a":1,"z":2}\n');
    if (process.platform !== 'win32') {
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
    }

    assert.equal(writePrivateImmutableJson(filePath, { a: 1, z: 2 }), resolved);
    const artifact = readProtectedJsonArtifact({ filePath, label: 'Evidence' });
    assert.deepEqual(artifact.value, { a: 1, z: 2 });
    assert.equal(artifact.text, '{"a":1,"z":2}\n');
    assert.equal(artifact.file_sha256, sha256Text(artifact.text));

    assert.throws(
      () => writePrivateImmutableJson(filePath, { a: 1, z: 3 }),
      /Refusing to overwrite protected evidence/u,
    );
  });
});

test('protected text preserves every byte and cannot be replaced', () => {
  withTempDirectory((root) => {
    const filePath = path.join(root, 'approval.txt');
    const exactText = '批准执行\nsecond line  \n';
    writePrivateImmutableText(filePath, exactText);
    assert.equal(readFileSync(filePath, 'utf8'), exactText);
    assert.deepEqual(readProtectedTextArtifact(filePath), {
      resolved: path.resolve(filePath),
      text: exactText,
      file_sha256: sha256Text(exactText),
    });
    assert.equal(writePrivateImmutableText(filePath, exactText), path.resolve(filePath));
    assert.throws(
      () => writePrivateImmutableText(filePath, exactText.trim()),
      /Refusing to overwrite protected evidence/u,
    );
  });
});

test('protected JSON is parsed from the exact bytes that were hashed', () => {
  withTempDirectory((root) => {
    const filePath = path.join(root, 'invalid.json');
    writeFileSync(filePath, '{invalid', { mode: 0o600 });
    assert.throws(
      () => readProtectedJsonArtifact({ filePath, label: 'Invalid evidence' }),
      /Invalid evidence is not valid JSON/u,
    );
  });
});

test('protected artifacts reject invalid UTF-8 and compare immutable files as raw bytes', () => {
  withTempDirectory((root) => {
    const filePath = path.join(root, 'invalid-utf8.txt');
    writeFileSync(filePath, Buffer.from([0xff]), { mode: 0o600 });
    assert.throws(() => readProtectedTextArtifact(filePath), /not valid UTF-8/u);
    assert.throws(
      () => writePrivateImmutableText(filePath, '\ufffd'),
      /Refusing to overwrite protected evidence/u,
    );
  });
});

test('protected evidence directories appear only after the complete set is materialized', () => {
  withTempDirectory((root) => {
    const finalDirectory = path.join(root, 'freeze');
    const result = materializePrivateArtifactDirectoryAtomically(finalDirectory, (staging) => {
      writePrivateImmutableText(path.join(staging, 'first.txt'), 'first\n');
      writePrivateImmutableText(path.join(staging, 'manifest.json'), '{"complete":true}\n');
      assert.equal(path.resolve(staging) === path.resolve(finalDirectory), false);
      assert.equal(
        readdirSync(root).some((name) => name.startsWith('.freeze.staging-')),
        true,
      );
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(readdirSync(finalDirectory).sort(), ['first.txt', 'manifest.json']);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.freeze.staging-')),
      false,
    );
    assert.throws(
      () => materializePrivateArtifactDirectoryAtomically(finalDirectory, () => undefined),
      /already exists/u,
    );

    const failedDirectory = path.join(root, 'failed');
    assert.throws(
      () =>
        materializePrivateArtifactDirectoryAtomically(failedDirectory, (staging) => {
          writePrivateImmutableText(path.join(staging, 'partial.txt'), 'partial\n');
          throw new Error('stop');
        }),
      /stop/u,
    );
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.failed.staging-')),
      false,
    );

    const racedDirectory = path.join(root, 'raced');
    assert.throws(
      () =>
        materializePrivateArtifactDirectoryAtomically(racedDirectory, () => {
          ensurePrivateArtifactDirectory(racedDirectory);
        }),
      /appeared during materialization/u,
    );
    assert.equal(
      readdirSync(root).some((name) => name.startsWith('.raced.staging-')),
      false,
    );
  });
});
