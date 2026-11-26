type Manifest = { command: string; [key: string]: unknown };
function lines(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => lines(entry, prefix));
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) =>
      lines(item, prefix ? `${prefix}.${key}` : key),
    );
  return [`  ${prefix ? `${prefix}: ` : ''}${String(value)}`];
}
/** Human projection of the same factual manifest used by machine help. */
export function renderCommandHelp(manifest: Manifest): string {
  const sections: Array<[string, unknown]> = [
    ['Actions', manifest.implementedActions ?? manifest.actions],
    ['Unavailable actions', manifest.unavailableActions],
    [
      'Options',
      Array.isArray(manifest.options)
        ? manifest.options.map((name: string) => (name.startsWith('-') ? name : `--${name}`))
        : manifest.options,
    ],
    ['Input', manifest.request ?? manifest.input],
    ['Defaults', manifest.defaults],
    ['Effects', manifest.effects],
    ['Limits', manifest.limitations],
    ['Results', manifest.result],
    ['Errors', manifest.errors],
    ['Recovery', manifest.recovery],
    ['Examples', manifest.examples],
  ];
  return (
    `Usage: tiangong-lca ${manifest.command} [options]\n\n` +
    sections
      .filter(
        ([, value]) =>
          value !== undefined &&
          value !== null &&
          (typeof value !== 'object' || Object.keys(value).length > 0),
      )
      .map(([title, value]) => `${title}:\n${lines(value).join('\n')}`)
      .join('\n\n') +
    '\n'
  );
}
