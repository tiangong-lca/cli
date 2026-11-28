import type { CommandErrorCategory } from '../shared/command-error-categories.js';

export type MutationDiagnostic = {
  category: CommandErrorCategory;
  code: string;
  httpStatus?: number;
  message: string;
};

export type MutationEvidence = {
  stage: 'preflight' | 'dispatch' | 'readback';
  acknowledged: boolean;
  acknowledgement?: Record<string, unknown>;
  diagnostic?: MutationDiagnostic;
  readback: { available: boolean; contentMatchesIntent: boolean };
};

export type MutationJournal = {
  path: string;
  read(): Record<string, unknown> | null;
  write(value: Record<string, unknown>, replace?: boolean): void;
  findTargetRecord?(states: readonly string[]): {
    path: string;
    record: Record<string, unknown>;
  } | null;
};
