export type CommandResult = {
  schemaVersion: 1;
  operation: string;
  status: 'completed' | 'failed';
  outcome: string;
  summary: string;
  data: Record<string, unknown>;
  context: Record<string, unknown>;
  completeness: Record<string, unknown>;
  artifacts: Array<{ path: string; purpose: string; bytes: number }>;
  warnings: Array<{ code: string; message: string }>;
  error: null | { category: string; code: string; message: string };
  nextActions: Array<{ description: string; command?: string }>;
  replyTemplate: string | null;
};

export type CommandIO = { exitCode: number; stdout: string; stderr: string };

export class CommandInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function result(operation: string): CommandResult {
  return {
    schemaVersion: 1,
    operation,
    status: 'completed',
    outcome: 'completed',
    summary: '',
    data: {},
    context: {},
    completeness: {},
    artifacts: [],
    warnings: [],
    error: null,
    nextActions: [],
    replyTemplate: null,
  };
}
