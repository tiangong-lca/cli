import { buildLifecyclemodelBundlePlan } from '../lib/model/bundle-save.js';
import type { DatasetCommandTransport } from '../lib/dataset/command.js';
import { buildSupabaseAuthHeaders } from '../lib/transport/supabase-client.js';
import { ServiceRejectedError, serviceRejection } from '../application/service-rejection.js';
import { postJson } from '../lib/transport/http.js';
import { CommandInputError } from '../shared/command-result.js';
import { isObject, type JsonObject } from '../application/dataset-types.js';

// Bundle is the service's transaction boundary, not a separate CLI operation.
// No generated Process mutation or create-to-update fallback is permitted here.
export async function writeModelDraft(
  transport: DatasetCommandTransport,
  id: string,
  version: string,
  content: JsonObject,
  beforeDispatch: () => void,
  action: 'create' | 'save',
  previousGraph?: JsonObject,
): Promise<JsonObject> {
  const plan = buildLifecyclemodelBundlePlan({
    id,
    version,
    payload: content,
    mode: action === 'create' ? 'create' : 'update',
    ...(previousGraph
      ? {
          metadata: {
            json_tg: {
              ...previousGraph,
              xflow: buildLifecyclemodelBundlePlan({
                id,
                version,
                payload: content,
                mode: 'update',
              }).parent.jsonTg.xflow,
            },
          },
        }
      : {}),
  });
  beforeDispatch();
  const response = await postJson({
    url: `${transport.functionsBaseUrl}/save_lifecycle_model_bundle`,
    headers: {
      ...buildSupabaseAuthHeaders(transport.publishableKey, transport.accessToken),
      'Content-Type': 'application/json',
    },
    body: plan,
    timeoutMs: transport.timeoutMs,
    fetchImpl: transport.fetchImpl,
  });
  const rejection = serviceRejection(response);
  if (rejection) throw new ServiceRejectedError(rejection);
  if (
    !isObject(response) ||
    response.ok !== true ||
    response.modelId !== id ||
    response.version !== version
  )
    throw new CommandInputError(
      'MODEL_RESPONSE_INVALID',
      'Model service did not acknowledge the exact write identity.',
    );
  return response;
}
