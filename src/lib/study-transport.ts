import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withBatchRunLock } from '../batch.js';
import { AUTH_IDENTITY_MAX_TIMEOUT_MS, fetchCurrentUser } from './auth-identity-receipt.js';
import { loadStudyCodec } from './study-codec.js';
import { CliError } from './errors.js';
import type { FetchLike, ResponseLike } from './http.js';
import {
  buildSupabaseAuthHeaders,
  deriveSupabaseProjectBaseUrl,
  requireSupabaseRestRuntime,
  type SupabaseRestRuntime,
} from './supabase-client.js';
import {
  resolveSupabaseUserSession,
  type ResolvedSupabaseUserSession,
} from './supabase-session.js';
import {
  assertStudyBinding,
  persistStudyIntent,
  readStudyIntent,
  type StudyActorBinding,
} from './study-intent.js';
import {
  assertStudySafe,
  parseStudyResponse,
  prepareStudyRequest,
  STUDY_ARTIFACT_LIMIT,
  STUDY_RESPONSE_LIMIT,
  studyDigest,
  studyFailure,
  studyJson,
  studyObject,
  type StudyObject,
  type StudyRequest,
  type StudyApiVersion,
  studyApiVersion,
} from './study-protocol.js';

export type StudyRequestOptions = {
  apiVersion?: StudyApiVersion;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  stateDir?: string;
  recoverFile?: string;
  outputPath?: string;
  force?: boolean;
};
export type StudyCommandReport = {
  schemaVersion: 'tiangong.cli.study.v1';
  operation: string;
  requestId: string;
  apiSchema: StudyRequest['schemaVersion'];
  data: StudyObject;
  intentFile?: string;
  output?: { path: string; byteSize: number; sha256: string };
};

function endpointFor(base: string): { endpoint: string; project: string } {
  let url: URL;
  try {
    const original = new URL(base);
    if (original.username || original.password || original.search || original.hash)
      studyFailure('STUDY_DESTINATION_INVALID');
    url = new URL(deriveSupabaseProjectBaseUrl(base));
  } catch {
    return studyFailure('STUDY_DESTINATION_INVALID');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
  )
    studyFailure('STUDY_DESTINATION_INVALID');
  return { project: url.origin, endpoint: `${url.origin}/functions/v1/app_lca_study` };
}

function clientBinding(
  token: string,
  actorId: string,
  expectedClientId: string | null,
): string | null {
  // The exact token has already passed the live Auth lookup. This public claim
  // is only a recovery-scope binding, never local authentication or a grant.
  let claims: unknown;
  try {
    claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as unknown;
  } catch {
    studyFailure('STUDY_SESSION_BINDING_INVALID');
  }
  if (
    !studyObject(claims) ||
    claims.sub !== actorId ||
    !(
      claims.client_id === undefined ||
      (typeof claims.client_id === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(claims.client_id))
    )
  )
    studyFailure('STUDY_SESSION_BINDING_INVALID');
  const clientId = typeof claims.client_id === 'string' ? claims.client_id : null;
  if (expectedClientId !== null && clientId !== expectedClientId)
    studyFailure('STUDY_SESSION_BINDING_INVALID');
  return clientId;
}

async function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) studyFailure('DEADLINE_EXCEEDED');
  let listener: () => void = () => {};
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        listener = () =>
          reject(new CliError('Study deadline expired.', { code: 'DEADLINE_EXCEEDED' }));
        signal.addEventListener('abort', listener, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

async function readBody(
  response: ResponseLike,
  signal: AbortSignal,
  maximum: number,
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum))
    studyFailure('PAYLOAD_TOO_LARGE');
  let bytes: Uint8Array;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await abortable(() => reader.read(), signal);
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maximum) studyFailure('PAYLOAD_TOO_LARGE');
        chunks.push(item.value);
      }
      bytes = Buffer.concat(chunks, size);
    } catch (error) {
      const cancellation = reader.cancel();
      await abortable(() => cancellation, signal).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  } else {
    bytes = Buffer.from(await abortable(() => response.text(), signal), 'utf8');
    if (bytes.byteLength > maximum) studyFailure('PAYLOAD_TOO_LARGE');
  }
  return bytes;
}

async function readResponse(response: ResponseLike, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json'))
    studyFailure('STUDY_RESPONSE_INVALID');
  const bytes = await readBody(response, signal, STUDY_RESPONSE_LIMIT);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return studyFailure('STUDY_RESPONSE_INVALID');
  }
}

export function verifyStudyArtifact(
  request: StudyRequest,
  data: StudyObject,
  secrets: string[],
): { bytes: Buffer; sha256: string } {
  if (
    data.studyId !== request.studyId ||
    studyJson(data.artifactRef) !== studyJson(request.artifactRef) ||
    data.encoding !== 'base64' ||
    typeof data.bytes !== 'string' ||
    !studyObject(request.artifactRef)
  )
    studyFailure('STUDY_ARTIFACT_BINDING');
  const ref = request.artifactRef;
  const publicKinds =
    request.schemaVersion === 'lca.study-api.v2'
      ? ['modelInput', 'runResult']
      : ['lca.study-api.v5', 'lca.study-api.v6'].includes(request.schemaVersion)
        ? request.operation === 'artifact.read'
          ? request.schemaVersion === 'lca.study-api.v6'
            ? [
                'methodAssessmentFacts',
                'methodEvidence',
                'reportContent',
                'modelInput',
                'runResult',
              ]
            : ['analysisFacts', 'reportContent']
          : ['reportExportBundle']
        : [
            'analysisFacts',
            'reportContent',
            'reportProjection',
            'renderResources',
            'reportExportBundle',
          ];
  if (!publicKinds.includes(String(ref.type))) studyFailure('DISCLOSURE_DENIED');
  if (
    !Number.isSafeInteger(ref.byteSize) ||
    (ref.byteSize as number) < 0 ||
    (ref.byteSize as number) > STUDY_ARTIFACT_LIMIT ||
    typeof ref.contentHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(ref.contentHash)
  )
    studyFailure('PAYLOAD_TOO_LARGE');
  const bytes = Buffer.from(data.bytes, 'base64');
  if (secrets.some((secret) => secret.length > 0 && bytes.includes(Buffer.from(secret))))
    studyFailure('STUDY_PRIVATE_PAYLOAD');
  if (
    bytes.toString('base64') !== data.bytes ||
    bytes.byteLength !== ref.byteSize ||
    studyDigest(bytes) !== ref.contentHash
  )
    studyFailure('STUDY_ARTIFACT_INTEGRITY');
  return { bytes, sha256: ref.contentHash };
}

function artifactOutput(
  request: StudyRequest,
  data: StudyObject,
  outputPath: string,
  force: boolean,
  secrets: string[],
): StudyCommandReport['output'] {
  const { bytes, sha256 } = verifyStudyArtifact(request, data, secrets);
  const absolute = path.resolve(outputPath);
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  try {
    mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
    if (force) renameSync(temporary, absolute);
    else linkSync(temporary, absolute);
  } catch {
    studyFailure('STUDY_OUTPUT_WRITE_FAILED');
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
  return { path: absolute, byteSize: bytes.byteLength, sha256 };
}

/** Shared boundary around the existing session and current-user owners. */
export function createStudyAuthFetch(
  project: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
): FetchLike {
  return async (url, init) => {
    if (new URL(url).origin !== project) return studyFailure('STUDY_DESTINATION_INVALID');
    const response = await abortable(
      () =>
        fetchImpl(url, {
          ...init,
          redirect: 'error',
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      signal,
    );
    const bytes = await readBody(response, signal, 64 * 1024);
    const headers = new Headers();
    for (const name of ['content-type', 'retry-after']) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return new Response([204, 205, 304].includes(response.status) ? null : (bytes as BodyInit), {
      status: response.status,
      headers,
    });
  };
}

type VerifiedStudyActor = { session: ResolvedSupabaseUserSession; binding: StudyActorBinding };

async function resolveVerifiedStudyActor(
  runtime: SupabaseRestRuntime,
  destination: { project: string; endpoint: string },
  fetchImpl: FetchLike,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<VerifiedStudyActor> {
  const authFetch = createStudyAuthFetch(destination.project, signal, fetchImpl);
  const session = await abortable(
    () => resolveSupabaseUserSession({ runtime, fetchImpl: authFetch, timeoutMs }),
    signal,
  );
  const actor = await abortable(
    () =>
      fetchCurrentUser({
        projectBaseUrl: destination.project,
        publishableKey: runtime.publishableKey,
        accessToken: session.accessToken,
        timeoutMs,
        fetchImpl: authFetch,
      }),
    signal,
  );
  return {
    session,
    binding: {
      endpoint: destination.endpoint,
      actorId: actor.userId,
      clientId: clientBinding(session.accessToken, actor.userId, runtime.oauthClientId),
    },
  };
}

export type LoopbackAuthSelection = Readonly<{ runtime: SupabaseRestRuntime; origin: string }>;
/** Selected before I/O. Nonlocal configuration keeps the canonical production doctor path. */
export function selectLoopbackAuthDiagnostic(env: NodeJS.ProcessEnv): LoopbackAuthSelection | null {
  const configured = env.TIANGONG_LCA_API_BASE_URL?.trim();
  if (!configured) return null;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    return null;
  const runtime = requireSupabaseRestRuntime(env, { allowProductionDefaults: false });
  const origin = endpointFor(runtime.apiBaseUrl).project;
  if (runtime.authMode === 'oauth' && !env.TIANGONG_LCA_OAUTH_REDIRECT_URI?.trim())
    studyFailure('AUTH_LOOPBACK_CALLBACK_REQUIRED');
  return Object.freeze({ runtime: Object.freeze(runtime), origin });
}

/** A current local diagnostic, never a canonical project/production identity receipt. */
export async function runLoopbackAuthDiagnostic(
  selection: LoopbackAuthSelection,
  options: { fetchImpl: FetchLike; timeoutMs?: number },
): Promise<StudyObject> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUTH_IDENTITY_MAX_TIMEOUT_MS)
    studyFailure('INVALID_ARGS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { binding } = await resolveVerifiedStudyActor(
      selection.runtime,
      { project: selection.origin, endpoint: `${selection.origin}/functions/v1/app_lca_study` },
      options.fetchImpl,
      timeoutMs,
      controller.signal,
    );
    return {
      schemaVersion: 'tiangong.cli-loopback-identity.v1',
      origin: selection.origin,
      actorId: binding.actorId,
      clientId: binding.clientId,
      callbackUri: selection.runtime.oauthRedirectUri,
      authMethod: selection.runtime.authMode,
      onlineVerified: true,
    };
  } catch {
    return studyFailure('AUTH_LOOPBACK_DIAGNOSTIC_FAILED');
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** One selected actor/session, one bounded transport; no automatic mutation retry. */
export async function runStudyRequest(
  operation: string,
  input: unknown,
  options: StudyRequestOptions,
): Promise<StudyCommandReport> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    studyFailure('INVALID_ARGS');
  const recovered = options.recoverFile
    ? readStudyIntent(path.resolve(options.recoverFile))
    : undefined;
  const version = recovered
    ? studyApiVersion(recovered.request.schemaVersion)
    : (options.apiVersion ?? 'v2');
  if (recovered && options.apiVersion !== undefined && options.apiVersion !== version)
    studyFailure('STUDY_RECOVERY_BINDING_MISMATCH');
  let request = prepareStudyRequest(operation, input, version);
  if (recovered) {
    if (studyJson(request) !== studyJson(recovered.request)) studyFailure('STUDY_INTENT_INVALID');
    request = recovered.request;
  }
  const runtime = requireSupabaseRestRuntime(options.env);
  const destination = endpointFor(runtime.apiBaseUrl);
  const codec = await loadStudyCodec(options.env, version);
  try {
    if ((version === 'v3' || version === 'v5') && request.operation === 'analysis.request') {
      const hash = await codec.analysisConfigHash!(request.config);
      if (request.configHash !== undefined && request.configHash !== hash)
        studyFailure('REFERENCE_MISMATCH');
      request.configHash = hash;
    }
    if (version === 'v6' && request.operation === 'method.assessment.request') {
      const hash = await codec.methodConfigHash!(request.config);
      if (request.configHash !== undefined && request.configHash !== hash)
        studyFailure('REFERENCE_MISMATCH');
      request.configHash = hash;
    }
    request = codec.parseRequest(request) as StudyRequest;
  } catch (error) {
    if (error instanceof CliError) throw error;
    return studyFailure('INVALID_REQUEST');
  }
  if (recovered && recovered.binding.endpoint !== destination.endpoint)
    studyFailure('STUDY_RECOVERY_BINDING_MISMATCH');
  if (
    request.operation === 'artifact.read' ||
    ['export.download', 'share.download'].includes(request.operation)
  ) {
    if (!options.outputPath) studyFailure('STUDY_OUTPUT_REQUIRED');
    if (!options.force && existsSync(options.outputPath)) studyFailure('STUDY_OUTPUT_EXISTS');
  } else if (options.outputPath !== undefined) studyFailure('INVALID_ARGS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let intentFile = options.recoverFile ? path.resolve(options.recoverFile) : undefined;
  try {
    const { session, binding } = await resolveVerifiedStudyActor(
      runtime,
      destination,
      options.fetchImpl,
      timeoutMs,
      controller.signal,
    );
    if (recovered) assertStudyBinding(recovered.binding, binding);
    const secrets = [session.accessToken, session.refreshToken].filter(Boolean);
    assertStudySafe(request, secrets);
    const dispatch = async (selected: StudyRequest): Promise<StudyObject> => {
      const reply = await abortable(
        () =>
          options.fetchImpl(destination.endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              ...buildSupabaseAuthHeaders(runtime.publishableKey, session.accessToken),
              'Content-Type': 'application/json',
              'x-study-schema': selected.schemaVersion,
            },
            body: studyJson(selected),
          }),
        controller.signal,
      );
      const value = await readResponse(reply, controller.signal);
      assertStudySafe(value, secrets);
      const data = parseStudyResponse(value, selected, reply.status, codec);
      if (version === 'v6') {
        try {
          await codec.validateResponseContentForRequest!(selected, value);
        } catch {
          studyFailure('STUDY_RESPONSE_SELECTION');
        }
      }
      return data;
    };
    if (request.operation !== 'capability.read') {
      const capabilities = await dispatch(prepareStudyRequest('capability.read', {}, version));
      if (
        (capabilities.runtimeEnabled !== true && version !== 'v5' && version !== 'v6') ||
        !(capabilities.operations as string[]).includes(request.operation)
      )
        studyFailure('CAPABILITY_UNAVAILABLE');
      if (
        version === 'v2' &&
        request.profileId !== undefined &&
        !(capabilities.profiles as StudyObject[]).some(
          (profile) =>
            profile.profileId === request.profileId &&
            studyJson(profile.calculationContractRef) === studyJson(request.calculationContractRef),
        )
      )
        studyFailure('CAPABILITY_UNAVAILABLE');
      if (
        (version === 'v3' || version === 'v5') &&
        request.operation === 'analysis.request' &&
        request.profileId !== undefined &&
        !(capabilities.analysisProfiles as string[]).includes(String(request.profileId))
      )
        studyFailure('CAPABILITY_UNAVAILABLE');
      if (
        (version === 'v3' || version === 'v5') &&
        request.templateId !== undefined &&
        !(capabilities.reportTemplates as string[]).includes(String(request.templateId))
      )
        studyFailure('CAPABILITY_UNAVAILABLE');
      if (version === 'v6') {
        for (const [field, admitted] of [
          ['templateId', 'reportTemplates'],
          [
            'profileId',
            request.operation === 'method.assessment.request'
              ? 'methodProfiles'
              : 'finalizationProfiles',
          ],
        ] as const) {
          if (
            request[field] !== undefined &&
            !(capabilities[admitted] as string[]).includes(String(request[field]))
          )
            studyFailure('CAPABILITY_UNAVAILABLE');
        }
      }
      if (
        version === 'v4' ||
        (version === 'v5' && request.operation !== 'analysis.request') ||
        (version === 'v6' && request.operation !== 'method.assessment.request')
      ) {
        for (const [field, admitted] of [
          ['profileId', 'finalizationProfiles'],
          ['reviewClass', 'reviewClasses'],
          ['disclosurePolicyId', 'disclosurePolicies'],
        ] as const) {
          if (
            request[field] !== undefined &&
            !(capabilities[admitted] as string[]).includes(String(request[field]))
          )
            studyFailure('CAPABILITY_UNAVAILABLE');
        }
      }
    }
    if (codec.operationMetadata[request.operation].kind === 'mutation' && !recovered)
      intentFile = persistStudyIntent(request, binding, options.env, options.stateDir);
    const execute = async (): Promise<StudyCommandReport> => {
      const data = await dispatch(request);
      if ((version === 'v4' || version === 'v5' || version === 'v6') && studyObject(data.value)) {
        if (
          [
            'comment.append',
            'review.record',
            'review.delegation.issue',
            'report.finalize',
          ].includes(request.operation) &&
          data.value.actorId !== binding.actorId
        )
          studyFailure('STUDY_RESPONSE_ACTOR_BINDING');
        if (
          ['comment.append', 'review.record'].includes(request.operation) &&
          data.value.clientId !== binding.clientId
        )
          studyFailure('STUDY_RESPONSE_ACTOR_BINDING');
        if (request.operation === 'share.create' && data.value.issuerId !== binding.actorId)
          studyFailure('STUDY_RESPONSE_ACTOR_BINDING');
      }
      if (
        request.operation === 'artifact.read' ||
        ['export.download', 'share.download'].includes(request.operation)
      ) {
        const record = (
          request.operation === 'export.download' ? data.export : data.share
        ) as StudyObject;
        const selected =
          request.operation === 'artifact.read'
            ? request
            : { ...request, studyId: record.studyId, artifactRef: record.bundleRef };
        const payload =
          request.operation === 'artifact.read'
            ? data
            : {
                studyId: record.studyId,
                artifactRef: record.bundleRef,
                encoding: data.encoding,
                bytes: data.bytes,
              };
        const output = artifactOutput(
          selected,
          payload,
          options.outputPath as string,
          options.force ?? false,
          secrets,
        );
        return {
          schemaVersion: 'tiangong.cli.study.v1',
          operation: request.operation,
          requestId: request.requestId,
          apiSchema: request.schemaVersion,
          data:
            request.operation === 'artifact.read'
              ? { type: 'artifact', studyId: data.studyId, artifactRef: data.artifactRef }
              : {
                  type: data.type,
                  [request.operation === 'export.download' ? 'export' : 'share']: record,
                },
          output,
        };
      }
      return {
        schemaVersion: 'tiangong.cli.study.v1',
        operation: request.operation,
        requestId: request.requestId,
        apiSchema: request.schemaVersion,
        data,
        ...(intentFile ? { intentFile } : {}),
      };
    };
    return intentFile
      ? await withBatchRunLock(
          {
            runPath: path.dirname(intentFile),
            identity: { binding, requestHash: studyDigest(studyJson(request)) },
            reason: 'study-request-dispatch',
            timeoutMs,
          },
          execute,
        )
      : await execute();
  } catch (error) {
    if (
      !intentFile &&
      error instanceof CliError &&
      studyObject(error.details) &&
      typeof error.details.intentFile === 'string'
    )
      intentFile = error.details.intentFile;
    const code =
      error instanceof CliError
        ? error.code
        : controller.signal.aborted
          ? 'DEADLINE_EXCEEDED'
          : 'STUDY_TRANSPORT_UNKNOWN';
    return studyFailure(code, {
      operation: request.operation,
      requestId: request.requestId,
      apiSchema: request.schemaVersion,
      ...(intentFile
        ? { intentFile, recovery: 'study request recover --intent-file <saved-intent-file>' }
        : {}),
    });
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
