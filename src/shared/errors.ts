export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(message: string, options?: { code?: string; exitCode?: number; details?: unknown }) {
    super(message);
    this.name = 'CliError';
    this.code = options?.code ?? 'CLI_ERROR';
    this.exitCode = options?.exitCode ?? 1;
    this.details = options?.details;
  }
}

export type ErrorPayload = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  if (error instanceof Error) {
    return {
      error: {
        code: 'UNEXPECTED_ERROR',
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: 'UNKNOWN_THROWN_VALUE',
      message: String(error),
    },
  };
}
