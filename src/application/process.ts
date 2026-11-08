import { CommandInputError, result } from '../shared/command-result.js';
import type { ProcessPayloadValidationResult } from '../lib/process-payload-validation.js';

export type ProcessDocument = {
  id: string;
  version: string;
  modifiedAt: string | null;
  stateCode: number | null;
  content: Record<string, unknown>;
  environment: string;
};

export type ProcessPorts = {
  get(id: string, version: string): Promise<ProcessDocument | null>;
  validate(content: Record<string, unknown>): ProcessPayloadValidationResult;
  now(): string;
};

export async function getProcess(id: string, version: string, ports: ProcessPorts) {
  const value = result('dataset process get');
  value.context = {
    effectiveInput: { id, version },
    defaultedInputs: {},
    observation: { source: 'remote', time: ports.now() },
  };
  const document = await ports.get(id, version);
  if (!document) {
    value.status = 'failed';
    value.outcome = 'not_found_or_not_visible';
    value.summary = 'The requested Process version was not found or is not visible.';
    value.error = {
      category: 'not_found_or_not_visible',
      code: 'PROCESS_NOT_FOUND',
      message: value.summary,
    };
    return value;
  }
  if (
    document.id !== id ||
    !document.version ||
    (version !== 'latest' && document.version !== version)
  ) {
    throw new Error('Process adapter returned a different identity.');
  }
  const subject = {
    type: 'process',
    id: document.id,
    version: document.version,
    modifiedAt: document.modifiedAt,
    stateCode: document.stateCode,
  };
  value.outcome = 'process_read';
  value.summary = 'Process content read successfully.';
  value.data = { subject, content: document.content };
  value.context = {
    ...value.context,
    subjects: [subject],
    environment: document.environment,
    actor: { status: 'not_independently_verified' },
  };
  value.completeness = {
    scope: 'one_process_version',
    truncated: false,
    hasMore: false,
    nextCursor: null,
  };
  return value;
}

export function validateProcess(content: Record<string, unknown>, ports: ProcessPorts) {
  if (
    !content.processDataSet ||
    typeof content.processDataSet !== 'object' ||
    Array.isArray(content.processDataSet)
  ) {
    throw new CommandInputError(
      'PROCESS_CONTENT_REQUIRED',
      'Provide one canonical Process JSON object containing processDataSet.',
    );
  }
  const validation = ports.validate(content);
  const incomplete = validation.allocation_semantics?.status === 'unresolved';
  const status = validation.ok ? 'passed' : incomplete ? 'incomplete' : 'failed';
  const value = result('dataset process validate');
  value.outcome = `validation_${status}`;
  value.summary = `Local Process validation ${status}: ${validation.issue_count} finding(s). Remote references were not checked.`;
  value.data = { validation: { ...validation, status } };
  value.context = {
    environment: null,
    actor: null,
    observation: { source: 'local', time: ports.now() },
    effectiveInput: { checks: ['schema', 'business'] },
    defaultedInputs: {},
  };
  value.completeness = {
    scope: 'local_schema_and_business',
    notChecked: ['remote_references'],
    truncated: false,
  };
  return value;
}
