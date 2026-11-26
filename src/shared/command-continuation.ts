import path from 'node:path';

/** Recommended commands target POSIX sh or PowerShell on Windows. Never interpolate cmd.exe. */
export function shellArgument(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export function inputContinuation(file: string) {
  return file === '-' ? null : `--input ${shellArgument(path.resolve(file))}`;
}

export function queryContinuation(
  type: string,
  action: string,
  binding: Record<string, unknown>,
  cursor: unknown,
) {
  const flags = Object.entries(binding)
    .filter(([key, entry]) => !['type', 'action'].includes(key) && entry !== undefined)
    .map(([key, entry]) => `--${key} ${shellArgument(String(entry))}`)
    .join(' ');
  return `tiangong-lca dataset ${type} ${action} ${flags} --cursor ${shellArgument(String(cursor))} --json`;
}
