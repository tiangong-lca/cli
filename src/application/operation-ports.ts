export type MutationJournal = {
  path: string;
  read(): Record<string, unknown> | null;
  write(value: Record<string, unknown>, replace?: boolean): void;
};
