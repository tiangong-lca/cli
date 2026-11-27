import { spawn } from 'node:child_process';

const isPrimary = process.argv.includes('--primary');

function runStep(label, args, { buffer = false } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('pnpm', args, {
      stdio: buffer ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      env: process.env,
    });
    let output = '';
    if (buffer) {
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
    }
    child.once('error', reject);
    child.once('close', (code) => {
      const durationMs = Date.now() - startedAt;
      if (buffer && output) {
        process.stdout.write(`\n--- [${label}] (${durationMs}ms) ---\n${output}\n`);
      }
      if (code !== 0) {
        reject(new Error(`${label} failed with exit code ${String(code)} after ${durationMs}ms`));
        return;
      }
      resolve(durationMs);
    });
  });
}

async function main() {
  if (isPrimary) {
    await runStep('verify:tidas-public-rules', ['run', 'verify:tidas-public-rules']);
    await runStep('lint', ['run', 'lint']);
  } else {
    await runStep('typecheck', ['run', 'typecheck']);
  }
  await runStep('peers:check', ['run', 'peers:check']);

  // test:package runs inside an isolated temp directory while entrypoints + coverage
  // operate on the repository dist/ and coverage/ outputs. Run both lanes concurrently
  // on POSIX runners; run sequentially on Windows so heavy NTFS/CPU contention does not
  // push test:package past its 300s per-test timeout.
  const runCoverageLane = async () => {
    await runStep('test:entrypoints', ['run', 'test:entrypoints']);
    await runStep('test:coverage', ['run', 'test:coverage']);
    await runStep('test:coverage:assert-full', ['run', 'test:coverage:assert-full']);
  };
  if (process.platform === 'win32') {
    await runStep('test:package', ['run', 'test:package']);
    await runCoverageLane();
  } else {
    await Promise.all([
      runStep('test:package', ['run', 'test:package'], { buffer: true }),
      runCoverageLane(),
    ]);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
