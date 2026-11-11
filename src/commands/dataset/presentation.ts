import { isObject, type JsonObject } from '../../application/dataset-types.js';
import { contentDigest } from '../../application/dataset-content.js';

export function validationSummary(report: JsonObject): JsonObject {
  const summary = { ...report };
  for (const name of ['issues', 'checks', 'blockers'])
    if (Array.isArray(summary[name])) summary[name] = summary[name].slice(0, 5);
  if (isObject(report.validation_layers))
    summary.validation_layers = Object.fromEntries(
      Object.entries(report.validation_layers).map(([name, layer]) => [
        name,
        isObject(layer) ? { status: layer.status, issue_count: layer.issue_count } : layer,
      ]),
    );
  if (isObject(report.references)) summary.references = validationSummary(report.references);
  if (isObject(report.local)) summary.local = validationSummary(report.local);
  return summary;
}
export function artifactSummary(data: JsonObject): JsonObject {
  const summary = { ...data };
  for (const name of ['content', 'bundle', 'projection', 'graphs']) {
    if (Object.hasOwn(summary, name)) {
      summary[`${name}Digest`] = contentDigest(summary[name]);
      delete summary[name];
    }
  }
  for (const name of [
    'changes',
    'units',
    'references',
    'files',
    'inputBindings',
    'findings',
    'groups',
  ]) {
    const entries = summary[name];
    if (Array.isArray(entries) && entries.length > 5) {
      summary[`${name}Count`] = entries.length;
      summary[name] = entries.slice(0, 5);
    }
  }
  return summary;
}
