import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCliPackageVersion } from '../src/lib/platform/package-version.js';

test('loadCliPackageVersion resolves package.json relative to source modules', () => {
  const version = loadCliPackageVersion('file:///repo/src/cli.ts', (url) => {
    assert.equal(url.href, 'file:///repo/package.json');
    return JSON.stringify({ version: '1.2.3' });
  });

  assert.equal(version, '1.2.3');
});

test('loadCliPackageVersion falls back to the dist-relative package.json candidate', () => {
  const version = loadCliPackageVersion('file:///repo/dist/src/cli.js', (url) => {
    if (url.href === 'file:///repo/dist/package.json') {
      throw new Error('missing dist package');
    }

    assert.equal(url.href, 'file:///repo/package.json');
    return JSON.stringify({ version: '2.3.4' });
  });

  assert.equal(version, '2.3.4');
});

test('loadCliPackageVersion rejects empty or missing versions after exhausting candidates', () => {
  assert.throws(
    () =>
      loadCliPackageVersion('file:///repo/src/cli.ts', (url) => {
        if (url.href === 'file:///repo/package.json') {
          return JSON.stringify({ version: '' });
        }

        throw new Error(`unexpected candidate: ${url.href}`);
      }),
    /Could not resolve CLI package version from package\.json\./u,
  );
});
