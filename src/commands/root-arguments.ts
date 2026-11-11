/** Normalize only outer options. Never move a wrapper flag across child argv's `--`. */
export function normalizeRootArguments(input: readonly string[]): string[] {
  const args = [...input];
  if (args[0] === '--' && args[1] !== '--') return args.slice(1);
  if (args[0] !== '--json' || args.length < 2) return args;
  const body = args.slice(1);
  const separator = body.indexOf('--');
  const at = separator < 0 ? body.length : separator;
  return [...body.slice(0, at), '--json', ...body.slice(at)];
}

/** Runtime/PCR never load a task's dotenv file, regardless of outer option position. */
export function usesTaskEnvironment(input: readonly string[]): boolean {
  const args = normalizeRootArguments(input);
  let index = 0;
  while (['--help', '-h', '--version', '-v'].includes(args[index] ?? '')) index++;
  if (args[index] === '--') index++;
  return !['runtime', 'pcr'].includes(args[index] ?? '');
}
