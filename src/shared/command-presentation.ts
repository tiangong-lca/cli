import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePackageRoot } from '../lib/runtime/descriptor.js';

import type { CommandResult, CommandIO } from './command-result.js';

export function attachReplyTemplate(
  value: CommandResult,
  name:
    | 'query-result'
    | 'validation-result'
    | 'command-failed'
    | 'operation-completed'
    | 'operation-accepted'
    | 'outcome-unknown'
    | 'conflict-result'
    | 'preview-result'
    | 'partial-result'
    | 'decision-required',
  root = runtimePackageRoot(
    new URL(`../runtime${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url).href,
  ),
): void {
  const file = path.join(root, 'assets', 'reply-templates', `${name}.md`);
  if (existsSync(file)) value.replyTemplate = file;
  else
    value.warnings.push({
      code: 'REPLY_TEMPLATE_UNAVAILABLE',
      message: 'Reply template unavailable; use the actual result.',
    });
}

export function renderResult(value: CommandResult, json: boolean, exitCode: number): CommandIO {
  const lines = [value.summary];
  if (value.data.subject) lines.push(JSON.stringify(value.data.subject));
  for (const artifact of value.artifacts) lines.push(`${artifact.purpose}: ${artifact.path}`);
  for (const warning of value.warnings) lines.push(warning.message);
  for (const next of value.nextActions)
    lines.push(next.command ? `${next.description}: ${next.command}` : next.description);
  if (value.replyTemplate) lines.push(`Reply template: ${value.replyTemplate}`);
  return {
    exitCode,
    stdout: json ? `${JSON.stringify(value)}\n` : `${lines.join('\n')}\n`,
    stderr: '',
  };
}
