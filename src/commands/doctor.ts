import { parseArgs } from 'node:util';
import type { DoctorReport } from '../lib/config/env.js';
import type { CliRuntimeDescriptor } from '../lib/runtime/types.js';
import { result, CommandInputError, type CommandIO } from '../shared/command-result.js';
import { attachReplyTemplate, renderResult } from '../shared/command-presentation.js';
import { writeCommandOutput } from '../shared/command-files.js';
import { commandFailure } from '../shared/command-errors.js';

type DoctorPorts = {
  local(): { report: DoctorReport; conflicts: string[]; target: string | null };
  runtime(): CliRuntimeDescriptor;
  online(timeoutMs: number): Promise<{
    environment: string;
    endpoint: string;
    httpStatus: number;
    passed: boolean;
    scope: string;
  }>;
};
export async function runDoctorCommand(args: string[], ports: DoctorPorts): Promise<CommandIO> {
  const value = result('doctor');
  const json = args.includes('--json');
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args,
        strict: true,
        allowPositionals: false,
        tokens: true,
        options: {
          help: { type: 'boolean', short: 'h' },
          json: { type: 'boolean' },
          online: { type: 'boolean' },
          'timeout-ms': { type: 'string' },
          output: { type: 'string' },
          force: { type: 'boolean' },
        },
      });
      const names = parsed
        .tokens!.filter((token) => token.kind === 'option')
        .map((token) => token.name);
      if (new Set(names).size !== names.length) throw new Error('duplicate');
    } catch {
      throw new CommandInputError(
        'ARGUMENTS_INVALID',
        'Unknown, duplicated or malformed doctor option. Inspect --help.',
      );
    }
    const flags = parsed.values;
    const helpManifest = {
      schemaVersion: 1,
      command: 'doctor',
      options: ['--online', '--timeout-ms 1..30000', '--output', '--force', '--json'],
      defaults: { online: false, timeoutMs: 5000 },
      effects:
        'Local inspection only by default. --online performs one bounded GET to the selected Supabase Auth health endpoint; no identity check, session refresh or business mutation.',
      result:
        'Configuration, conflicts, installed runtime summary, explicit unperformed checks, nextActions and replyTemplate. --output writes complete diagnostic observations.',
      next: 'auth doctor-auth for account diagnosis; runtime describe for full installed file identity.',
    };
    if (flags.help)
      return {
        exitCode: 0,
        stdout: json
          ? `${JSON.stringify(helpManifest)}\n`
          : 'Usage:\n  tiangong-lca doctor [--json] [--online] [--timeout-ms <1..30000>] [--output <file>] [--force]\n\nInspect local configuration and installed runtime without network access.\n--online adds one selected Auth health GET; this does not verify identity or business permissions.\n--output saves complete observations. Use --json for context, nextActions and replyTemplate.\n',
        stderr: '',
      };
    if (flags.force && !flags.output)
      throw new CommandInputError('OUTPUT_REQUIRED', '--force requires --output.');
    const timeoutMs = flags['timeout-ms'] === undefined ? 5000 : Number(flags['timeout-ms']);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30000 ||
      (!flags.online && flags['timeout-ms'] !== undefined)
    )
      throw new CommandInputError(
        'TIMEOUT_INVALID',
        '--timeout-ms requires --online and an integer from 1 to 30000.',
      );
    const local = ports.local();
    value.data = { configuration: local.report, conflicts: local.conflicts };
    value.context = {
      actor: { status: 'not_checked' },
      effectiveInput: { online: flags.online === true, timeoutMs: flags.online ? timeoutMs : null },
      defaultedInputs: flags.online && flags['timeout-ms'] === undefined ? { timeoutMs: 5000 } : {},
      observation: {
        source: 'local_only',
        time: new Date().toISOString(),
      },
    };
    try {
      value.context.environment = local.target ? new URL(local.target).origin : null;
    } catch {
      value.context.environment = null;
    }
    value.completeness = {
      notChecked: [
        'online_identity',
        'business_permissions',
        'data_api',
        'edge_business_functions',
        'worker',
        ...(!flags.online ? ['service_connections'] : []),
      ],
      scope: flags.online
        ? 'local_configuration_runtime_and_auth_health'
        : 'local_configuration_and_cli_runtime',
    };
    let runtime: CliRuntimeDescriptor | null = null;
    try {
      runtime = ports.runtime();
      value.data.runtime = {
        package: runtime.package,
        platform: runtime.platform,
        nodeVersion: runtime.node.version,
        contentDigest: runtime.content_sha256,
        assets: runtime.assets,
      };
    } catch {
      value.warnings.push({
        code: 'RUNTIME_CHECK_FAILED',
        message:
          'Installed runtime inspection failed; use runtime describe for the original diagnostic.',
      });
      value.status = 'failed';
    }
    if (!local.report.ok || local.conflicts.length) value.status = 'failed';
    if (flags.online) {
      if (!local.report.ok || local.conflicts.length)
        value.completeness.notChecked = [
          ...(value.completeness.notChecked as string[]),
          'service_connections',
        ];
      else {
        try {
          value.context.observation = {
            source: 'local_and_selected_health',
            time: new Date().toISOString(),
          };
          const probe = await ports.online(timeoutMs);
          value.data.connection = probe;
          value.context.environment = probe.environment;
          if (!probe.passed) value.status = 'failed';
        } catch {
          value.status = 'failed';
          value.data.connection = {
            passed: false,
            scope: 'supabase_auth_health',
            reason: 'connection_failed_or_timed_out',
          };
        }
      }
    }
    value.outcome = value.status === 'failed' ? 'diagnostics_failed' : 'diagnostics_completed';
    value.summary =
      value.status === 'failed'
        ? 'Environment diagnostics found failed or unavailable checks.'
        : 'Environment diagnostics completed within the reported scope.';
    if (value.status === 'failed')
      value.error = {
        category: 'environment',
        code: 'DOCTOR_CHECK_FAILED',
        message: value.summary,
      };
    value.nextActions = [
      {
        description: 'Inspect account authentication separately from service health.',
        command: 'tiangong-lca auth doctor-auth --json',
      },
      {
        description: 'Read complete installed runtime identity.',
        command: 'tiangong-lca runtime describe --json',
      },
    ];
    if (flags.output) {
      try {
        value.artifacts.push(
          writeCommandOutput(
            String(flags.output),
            { ...value.data, runtime },
            flags.force === true,
          ),
        );
      } catch {
        if (value.status === 'completed') value.status = 'partial';
        value.warnings.push({
          code: 'OUTPUT_UNAVAILABLE',
          message: 'Diagnostic observations preserved; output artifact could not be written.',
        });
      }
    }
    attachReplyTemplate(
      value,
      value.status === 'failed'
        ? 'command-failed'
        : value.status === 'partial'
          ? 'partial-result'
          : 'query-result',
    );
    const rendered = renderResult(value, json, value.status === 'completed' ? 0 : 1);
    if (!json)
      rendered.stdout = `${renderDoctorText(local.report)}${local.conflicts.length ? `Conflicts: ${local.conflicts.join(', ')}\n` : ''}${rendered.stdout}`;
    return rendered;
  } catch (error) {
    const failure = commandFailure(error, 'DOCTOR_OPERATION_FAILED');
    value.status = 'failed';
    value.outcome = 'operation_failed';
    value.summary = failure.message;
    value.error = { category: failure.category, code: failure.code, message: failure.message };
    value.nextActions = [
      {
        description: 'Inspect the diagnostic contract.',
        command: 'tiangong-lca doctor --help --json',
      },
    ];
    attachReplyTemplate(value, 'command-failed');
    return renderResult(value, json, failure.exitCode);
  }
}

function renderDoctorText(report: DoctorReport): string {
  const lines = [
    'TianGong CLI doctor',
    `  .env loaded: ${report.loadedDotEnv ? `yes (${report.dotEnvKeysLoaded} keys)` : 'no'}`,
    `  .env path:   ${report.dotEnvPath}`,
    '',
  ];
  for (const check of report.checks) {
    const status = check.present ? 'OK ' : 'MISS';
    lines.push(
      `  [${status}] ${check.key} (${check.source})${check.required ? ' [required]' : ''}`,
    );
  }
  if (!report.ok) {
    lines.push('', 'Missing required environment keys:');
    for (const check of report.checks)
      if (check.required && !check.present) lines.push(`  - ${check.key}`);
  }
  return `${lines.join('\n')}\n`;
}
