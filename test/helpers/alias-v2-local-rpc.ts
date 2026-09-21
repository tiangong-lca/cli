// The bounded local-RPC transport for the alias v2 end-to-end driver.
//
// The CLI builds its real request bodies (the reviewed 12-key preflight, the three gate calls, the
// five-key admission, the request-id read) against the Supabase-shaped synthetic environment; this
// adapter answers the auth endpoints from a disclosed synthetic session fixture and performs every
// data-api RPC by calling the REAL PostgreSQL function with its actual named signature through the
// local stack's psql, returning the function's JSON verbatim. It rejects any other path and any
// argument key set it does not know, and it never reshapes a server reply.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ResponseLike } from '../../src/lib/http.js';
import type { FetchLike } from '../../src/lib/http.js';
import { ALIAS_V2_GATE_NAMES } from '../../src/lib/dataset-alias-v2-status.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './supabase-auth.js';

export type AliasV2InteropReady = {
  ready: boolean;
  container: string;
  sql_user?: string;
  sql_database?: string;
  actor: { user_id: string; email: string };
  project_ref: string;
  environment?: string;
  /** The CLI-produced plan/freeze/approval directory the stack was seeded for. */
  artifacts_dir: string;
  /** The seeded execution's deterministic request id. */
  request_id: string;
  /** The sealed artefact paths, when the marker names them itself. */
  artifacts?: { plan?: string; freeze?: string; approval?: string };
  /**
   * Optional test-only containment wrappers: reviewed RPC name -> the schema-qualified function the
   * database owner installed for it. The wrapper must take the same named arguments and return the
   * real function's reply verbatim; anything else is refused.
   */
  rpc_aliases?: Record<string, string>;
  /** A COMMITTING SQL script (path) that runs the queued execute and completes every child. */
  complete_script?: string;
  /** The lifecycle stages the database owner has prepared on this stack. */
  scenarios: string[];
  plan_sha256?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOKEN = /^[A-Za-z0-9._:-]{1,4096}$/u;

/** One monotonic evidence counter per process, shared by every adapter. */
let evidenceSequence = 0;

/**
 * Reads the interop-ready marker the database owner publishes. Anything that is not a complete,
 * ready document — absent, mid-update, malformed, or explicitly not ready — simply means the shared
 * stack is not ours to exercise, so the driver stays skipped rather than failing.
 */
export function readAliasV2InteropReady(path: string): AliasV2InteropReady | null {
  if (!existsSync(path)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<AliasV2InteropReady>;
  if (
    candidate.ready !== true ||
    typeof candidate.container !== 'string' ||
    typeof candidate.artifacts_dir !== 'string' ||
    typeof candidate.request_id !== 'string' ||
    typeof candidate.project_ref !== 'string' ||
    candidate.actor === undefined ||
    typeof candidate.actor.user_id !== 'string' ||
    typeof candidate.actor.email !== 'string' ||
    !Array.isArray(candidate.scenarios)
  ) {
    return null;
  }
  return candidate as AliasV2InteropReady;
}

export type AliasV2LocalRpcOptions = {
  container: string;
  actor: { user_id: string; email: string };
  sqlUser?: string;
  sqlDatabase?: string;
  projectRef: string;
  /** Reviewed RPC name -> the schema-qualified function the owner installed for containment. */
  rpcAliases?: Record<string, string>;
  /**
   * Opt-in qualification evidence directory: every unmodified RPC request/reply, every executed SQL
   * script and its output, and (via the campaign) the run artefacts are retained there. Absent by
   * default, so routine runs keep their ordinary cleanup.
   */
  evidenceDir?: string;
};

export type AliasV2RpcCall = {
  name: string;
  args: Record<string, unknown>;
  /** The function's reply text, exactly as the server returned it. */
  reply?: string;
};

export type AliasV2LocalRpcAdapter = {
  fetchImpl: FetchLike;
  calls: AliasV2RpcCall[];
  /** Runs one committed SQL script from the host against the same stack. */
  runSql: (sql: string, variables?: Record<string, string>) => string;
  /** The directory every request/reply/script was retained in, when evidence retention is on. */
  evidenceDir: string | null;
};

function jsonResponse(value: unknown, status = 200): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The CLI's synthetic environment: the sealed project's Supabase-shaped base URL, so the run's own
 * context resolution sees the sealed project and actor; every data-api call is answered by the
 * adapter below, never by the network.
 */
export function aliasV2LocalRpcEnv(projectRef: string): NodeJS.ProcessEnv {
  return buildSupabaseTestEnv({
    TIANGONG_LCA_API_BASE_URL: `https://${projectRef}.supabase.co/functions/v1`,
  });
}

/**
 * The bounded transport: auth is the disclosed synthetic session; the four approved v2 RPCs are
 * executed for real with their exact named arguments; anything else is rejected.
 */
export function aliasV2LocalRpcAdapter(options: AliasV2LocalRpcOptions): AliasV2LocalRpcAdapter {
  const calls: AliasV2RpcCall[] = [];
  const sqlUser = options.sqlUser ?? 'supabase_admin';
  const sqlDatabase = options.sqlDatabase ?? 'postgres';
  // Opt-in qualification evidence: every executed script and its output, numbered in call order.
  const evidenceDir = options.evidenceDir ?? null;
  if (evidenceDir !== null) {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  }
  const retain = (label: string, text: string): void => {
    if (evidenceDir === null) {
      return;
    }
    // One monotonic counter across every adapter in the process, so per-adapter counters can never
    // overwrite an earlier adapter's evidence.
    evidenceSequence += 1;
    const name = `${String(evidenceSequence).padStart(4, '0')}-${label}`;
    writeFileSync(path.join(evidenceDir, name), text, { mode: 0o600 });
  };
  const runSql = (sql: string, variables: Record<string, string> = {}, label = 'sql'): string => {
    const variableArgs = Object.entries(variables).flatMap(([name, value]) => [
      '-v',
      `${name}=${value}`,
    ]);
    const result = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        options.container,
        'psql',
        '-U',
        sqlUser,
        '-d',
        sqlDatabase,
        '-tA',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        ...variableArgs,
        '-f',
        '-',
      ],
      { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    retain(`${label}-script.sql`, sql);
    if (result.status !== 0) {
      retain(`${label}-stderr.txt`, String(result.stderr));
      throw new Error(`local psql failed: ${String(result.stderr).slice(0, 500)}`);
    }
    retain(`${label}-stdout.txt`, String(result.stdout));
    // The function's JSON is the single meaningful line; anything else is a psql artefact.
    const lines = String(result.stdout)
      .split('\n')
      .filter((line) => line.trim() !== '');
    return lines[lines.length - 1] ?? '';
  };
  // The request's actor context, applied silently so the RPC's own result is the only output.
  const asActor = (): string =>
    [
      `do $ctx$ begin`,
      `perform set_config('request.jwt.claim.role', 'authenticated', false);`,
      `perform set_config('request.jwt.claim.sub', ${sqlLiteral(options.actor.user_id)}, false);`,
      `perform set_config('request.jwt.claim.email', ${sqlLiteral(options.actor.email)}, false);`,
      `end $ctx$;`,
    ].join('\n');

  const QUALIFIED = /^(api|util)\.[a-z0-9_]+$/u;
  /** The function this reviewed RPC is executed through: its own name, or the owner's wrapper. */
  const targetFor = (name: string): string => {
    const alias = options.rpcAliases?.[name];
    if (alias === undefined) {
      return `api.${name}`;
    }
    if (!QUALIFIED.test(alias)) {
      throw new Error(`the marker's rpc alias for ${name} is not a schema-qualified function`);
    }
    return alias;
  };
  const rpc = (name: string, args: Record<string, unknown>): string => {
    const call: AliasV2RpcCall = { name, args };
    calls.push(call);
    const target = targetFor(name);
    if (name === 'cmd_dataset_alias_execution_preflight_v2_guarded') {
      const request = args['p_request'];
      if (Object.keys(args).length !== 1 || request === undefined) {
        throw new Error(`preflight arguments must be exactly {p_request}`);
      }
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      return runSql(
        `${asActor()}\nselect ${target}(convert_from(decode('${encoded}','base64'),'UTF8')::jsonb);`,
        {},
        `${name}-request`,
      );
    }
    if (name === 'cmd_dataset_alias_execution_admit_v2_guarded') {
      const request = args['p_request'];
      if (Object.keys(args).length !== 1 || request === undefined) {
        throw new Error(`admit arguments must be exactly {p_request}`);
      }
      const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
      return runSql(
        `${asActor()}\nselect ${target}(convert_from(decode('${encoded}','base64'),'UTF8')::jsonb);`,
        {},
        `${name}-request`,
      );
    }
    if (name === 'cmd_dataset_alias_execution_gate_v2_guarded') {
      const requestId = args['p_request_id'];
      const token = args['p_preflight_token'];
      const gateName = args['p_gate_name'];
      if (
        Object.keys(args).length !== 3 ||
        typeof requestId !== 'string' ||
        !UUID.test(requestId) ||
        typeof token !== 'string' ||
        !TOKEN.test(token) ||
        typeof gateName !== 'string' ||
        !(ALIAS_V2_GATE_NAMES as readonly string[]).includes(gateName)
      ) {
        throw new Error(`gate arguments must be exactly the reviewed three`);
      }
      return runSql(
        `${asActor()}\nselect ${target}('${requestId}'::uuid, ${sqlLiteral(token)}, ${sqlLiteral(gateName)});`,
        {},
        `${name}-request`,
      );
    }
    if (name === 'cmd_dataset_alias_execution_read_v2') {
      const requestId = args['p_request_id'];
      if (
        Object.keys(args).length !== 1 ||
        typeof requestId !== 'string' ||
        !UUID.test(requestId)
      ) {
        throw new Error(`read arguments must be exactly {p_request_id}`);
      }
      return runSql(`${asActor()}\nselect ${target}('${requestId}'::uuid);`, {}, `${name}-request`);
    }
    throw new Error(`the adapter refuses an unapproved RPC: ${name}`);
  };

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({
        userId: options.actor.user_id,
        email: options.actor.email,
      });
    }
    const match = /\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/u.exec(url);
    if (match === null || init?.body === undefined || typeof init.body !== 'string') {
      throw new Error(`the adapter refuses an unexpected request: ${url}`);
    }
    const name = match[1] as string;
    // The exact wire body the CLI sent, retained before anything else touches it.
    retain(`${name}-wire-request.json`, init.body);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const text = rpc(name, body);
    const recorded = calls[calls.length - 1] as AliasV2RpcCall;
    recorded.reply = text;
    retain(`${name}-function-reply.json`, text);
    return jsonResponse(JSON.parse(text));
  }) as FetchLike;

  return { fetchImpl, calls, runSql, evidenceDir };
}
