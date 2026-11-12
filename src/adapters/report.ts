import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ReportPort } from '../application/report.js';
import { renderResearchReport } from '../lib/report/render.js';
import { assertSeparateCommandFiles } from '../shared/command-files.js';
import { CommandInputError } from '../shared/command-result.js';

export const writeResearchReport: ReportPort = (report, output, force, input) => {
  assertSeparateCommandFiles(output, input);
  const destination = path.resolve(output);
  const html = renderResearchReport(report);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(temporary, html, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
    if (force) renameSync(temporary, destination);
    else linkSync(temporary, destination);
  } catch {
    throw new CommandInputError(
      'REPORT_OUTPUT_UNAVAILABLE',
      'Choose a writable new HTML path, or use --force to replace a separate report.',
      'environment',
    );
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path: destination, purpose: 'interactive_report_html', bytes: Buffer.byteLength(html) };
};
