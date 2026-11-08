import { loadModelInput } from './model-input.js';
import { stageModelProcesses } from './model-process-inputs.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { object, text, type DatasetPorts } from '../application/dataset-types.js';
import { CommandInputError } from '../shared/command-result.js';
import { runLifecyclemodelGraph } from '../lib/lifecyclemodel-graph.js';
import { runLifecyclemodelBuildResultingProcess } from '../lib/lifecyclemodel-resulting-process.js';
import { uploadSourceAttachments } from './source-attachments.js';
import { runProcessScopeStatistics } from '../lib/process-scope-statistics.js';
import type { FetchLike } from '../lib/http.js';

export function datasetOperations(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): DatasetPorts['local'] {
  return async (type, action, request, inputPath) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tiangong-dataset-'));
    const input = path.join(directory, 'input.json');
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    try {
      if (type === 'model' && action === 'graph') {
        const selected = await loadModelInput(request, inputPath, env, fetchImpl);
        writeFileSync(input, JSON.stringify(selected.content));
        const report = await runLifecyclemodelGraph({
          inputPath: input,
          rawInput: selected.content,
          outDir: directory,
          format: 'json',
          checkConnections: true,
        });
        return {
          status: report.status,
          sourceContext: selected.sourceContext,
          counts: report.counts,
          findings: report.findings,
          graphs: report.models.map((model) => read(model.files.graph_json!)),
        };
      }
      if (type === 'model' && action === 'build-resulting-process') {
        const source = object(request.source_model, 'source_model');
        const sources = object(request.process_sources, 'process_sources');
        if (request.publish !== undefined)
          throw new CommandInputError(
            'PUBLISH_UNSUPPORTED',
            'Model result generation does not accept publish intent.',
          );
        const selected = await loadModelInput(
          {
            ...(source.json_ordered !== undefined ? { content: source.json_ordered } : {}),
            ...(source.json_ordered_path !== undefined ? { file: source.json_ordered_path } : {}),
            ...(source.remote !== undefined ? { remote: source.remote } : {}),
          },
          inputPath,
          env,
          fetchImpl,
        );
        const processes = await stageModelProcesses(
          sources,
          selected.content,
          inputPath,
          directory,
          env,
          fetchImpl,
        );
        const normalized = {
          ...request,
          source_model: { ...source, json_ordered: selected.content, json_ordered_path: null },
          process_sources: {
            process_json_files: processes.files,
            process_json_dirs: [],
            process_catalog_path: null,
            run_dirs: [],
            allow_remote_lookup: false,
          },
          publish: {
            intent: 'prepare_only',
            prepare_process_payloads: true,
            prepare_relation_payloads: false,
          },
        };
        writeFileSync(input, JSON.stringify(normalized));
        const report = await runLifecyclemodelBuildResultingProcess({
          inputPath: input,
          outDir: directory,
          env,
          fetchImpl,
        });
        return {
          status: report.status,
          qualification: report.qualification,
          sourceContext: selected.sourceContext,
          projectedProcessCount: report.projected_process_count,
          inputBindings: processes.bindings,
          projection: processes.sanitize(read(report.files.projection_report)),
          bundle: processes.sanitize(read(report.files.process_projection_bundle)),
        };
      }
      if (type === 'source' && action === 'upload-attachments') {
        return uploadSourceAttachments(request, inputPath, env, fetchImpl);
      }
      if (type === 'process' && action === 'statistics') {
        const scope = text(request.scope, 'scope');
        if (
          !['visible', 'current-user'].includes(scope) ||
          !Array.isArray(request.stateCodes) ||
          !request.stateCodes.length ||
          request.stateCodes.some((code) => !Number.isSafeInteger(code))
        )
          throw new CommandInputError(
            'SCOPE_INVALID',
            'statistics requires scope visible/current-user and explicit integer stateCodes.',
          );
        const report = await runProcessScopeStatistics({
          env,
          fetchImpl,
          outDir: directory,
          scope: scope as 'visible',
          stateCodes: request.stateCodes as number[],
        });
        return { ...report, files: undefined, out_dir: undefined };
      }
      throw new CommandInputError(
        'CAPABILITY_UNSUPPORTED',
        'This operation has no supported adapter.',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
