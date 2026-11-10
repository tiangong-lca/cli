import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeRemoteCommand, getRemoteCommandHelp } from '../src/lib/transport/remote.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

function makeInputFile(content: string): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-remote-'));
  const filePath = path.join(dir, 'input.json');
  writeFileSync(filePath, content, 'utf8');
  return { dir, filePath };
}

test('getRemoteCommandHelp returns command-specific help text', () => {
  assert.match(getRemoteCommandHelp('admin:embedding-run'), /admin embedding-run/u);
});

test('executeRemoteCommand supports dry run and masks authorization', async () => {
  const { dir, filePath } = makeInputFile('{"query":"demo"}');
  try {
    const output = await executeRemoteCommand({
      commandKey: 'admin:embedding-run',
      inputPath: filePath,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1/',
        TIANGONG_LCA_REGION: 'us-east-1',
      }),
      timeoutMs: 50,
      dryRun: true,
      compactJson: false,
      fetchImpl: async () => {
        throw new Error('should not be called');
      },
    });

    assert.match(output, /embedding_ft/u);
    assert.match(output, /Bearer \*\*\*\*/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeRemoteCommand posts JSON and omits region for embedding command', async () => {
  const { dir, filePath } = makeInputFile('[{"jobId":1}]');
  try {
    let observedHeaders: Record<string, string | undefined> = {};
    let observedUrl = '';
    const output = await executeRemoteCommand({
      commandKey: 'admin:embedding-run',
      inputPath: filePath,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.com/functions/v1',
        TIANGONG_LCA_REGION: 'us-east-1',
      }),
      timeoutMs: 50,
      dryRun: false,
      compactJson: true,
      fetchImpl: async (input, init) => {
        if (isSupabaseAuthTokenUrl(String(input))) {
          return makeSupabaseAuthResponse();
        }

        observedUrl = input;
        observedHeaders = { ...(init?.headers as Record<string, string> | undefined) };
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => 'application/json',
          },
          text: async () => '{"completedJobs":1}',
        };
      },
    });

    assert.equal(output, '{"completedJobs":1}\n');
    assert.equal(observedUrl, 'https://example.com/functions/v1/embedding_ft');
    assert.equal(observedHeaders.Authorization, 'Bearer access-token');
    assert.equal(observedHeaders['x-region'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeRemoteCommand validates required API config and unsupported commands', async () => {
  const { dir, filePath } = makeInputFile('{"query":"demo"}');
  try {
    await assert.rejects(
      () =>
        executeRemoteCommand({
          commandKey: 'admin:embedding-run',
          inputPath: filePath,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: '',
            TIANGONG_LCA_REGION: 'us-east-1',
          }),
          timeoutMs: 50,
          dryRun: false,
          compactJson: false,
          fetchImpl: async () => {
            throw new Error('unreachable');
          },
        }),
      /Missing Supabase REST runtime env: TIANGONG_LCA_API_BASE_URL/u,
    );

    await assert.rejects(
      () =>
        executeRemoteCommand({
          commandKey: 'admin:embedding-run',
          inputPath: filePath,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://example.com',
            TIANGONG_LCA_AUTH_MODE: 'access-token',
            TIANGONG_LCA_ACCESS_TOKEN: '',
            TIANGONG_LCA_REGION: 'us-east-1',
          }),
          timeoutMs: 50,
          dryRun: false,
          compactJson: false,
          fetchImpl: async () => {
            throw new Error('unreachable');
          },
        }),
      /Access-token auth mode requires TIANGONG_LCA_ACCESS_TOKEN/u,
    );

    await assert.rejects(
      () =>
        executeRemoteCommand({
          commandKey: 'search:unknown' as never,
          inputPath: filePath,
          env: buildSupabaseTestEnv({
            TIANGONG_LCA_API_BASE_URL: 'https://example.com',
            TIANGONG_LCA_REGION: 'us-east-1',
          }),
          timeoutMs: 50,
          dryRun: false,
          compactJson: false,
          fetchImpl: async () => {
            throw new Error('unreachable');
          },
        }),
      /Unsupported remote command/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
