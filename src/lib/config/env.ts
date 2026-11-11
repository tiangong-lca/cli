import { DEFAULT_OAUTH_REDIRECT_URI } from '../auth/oauth-loopback.js';
import { stripTrailingSlashes } from '../transport/url.js';

export type EnvSpec = {
  key: string;
  required: boolean;
  description: string;
  defaultValue?: string;
};

export type ResolvedEnv = {
  key: string;
  source: 'env' | 'default' | 'missing';
  value: string | null;
  present: boolean;
};

export const ENV_KEYS = {
  apiBaseUrl: 'TIANGONG_LCA_API_BASE_URL',
  authMode: 'TIANGONG_LCA_AUTH_MODE',
  oauthClientId: 'TIANGONG_LCA_OAUTH_CLIENT_ID',
  oauthRedirectUri: 'TIANGONG_LCA_OAUTH_REDIRECT_URI',
  accessToken: 'TIANGONG_LCA_ACCESS_TOKEN',
  region: 'TIANGONG_LCA_REGION',
  supabasePublishableKey: 'TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY',
  sessionFile: 'TIANGONG_LCA_SESSION_FILE',
  disableSessionCache: 'TIANGONG_LCA_DISABLE_SESSION_CACHE',
  forceReauth: 'TIANGONG_LCA_FORCE_REAUTH',
} as const;

const PRODUCTION_PROJECT_URL = 'https://qgzvkongdjqiiamzbbts.supabase.co';

// Public application configuration, not user credentials. Keep this as the one
// source used by auth, remote adapters, and doctor; Skills must not copy it.
export const OFFICIAL_PRODUCTION_PROFILE = Object.freeze({
  apiBaseUrl: `${PRODUCTION_PROJECT_URL}/functions/v1`,
  supabasePublishableKey: 'sb_publishable_EFWH4E61tpAtf82WQ37xTA_Fxa5OPyg',
  oauthClientId: '1837c6d3-3c9d-48e0-bbf7-b532b78f9f76',
  oauthRedirectUri: DEFAULT_OAUTH_REDIRECT_URI,
  region: 'us-east-1',
});

const PRODUCTION_ENV_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  [ENV_KEYS.apiBaseUrl]: OFFICIAL_PRODUCTION_PROFILE.apiBaseUrl,
  [ENV_KEYS.supabasePublishableKey]: OFFICIAL_PRODUCTION_PROFILE.supabasePublishableKey,
  [ENV_KEYS.oauthClientId]: OFFICIAL_PRODUCTION_PROFILE.oauthClientId,
  [ENV_KEYS.oauthRedirectUri]: OFFICIAL_PRODUCTION_PROFILE.oauthRedirectUri,
});

function runtimeToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isProductionBase(value: string): boolean {
  return [
    PRODUCTION_PROJECT_URL,
    `${PRODUCTION_PROJECT_URL}/functions/v1`,
    `${PRODUCTION_PROJECT_URL}/rest/v1`,
  ].includes(stripTrailingSlashes(value));
}

export function hasProductionProfileMismatch(env: NodeJS.ProcessEnv): boolean {
  const base = runtimeToken(env[ENV_KEYS.apiBaseUrl]);
  return Boolean(
    base &&
    !isProductionBase(base) &&
    (runtimeToken(env[ENV_KEYS.oauthClientId]).toLowerCase() ===
      OFFICIAL_PRODUCTION_PROFILE.oauthClientId ||
      runtimeToken(env[ENV_KEYS.supabasePublishableKey]) ===
        OFFICIAL_PRODUCTION_PROFILE.supabasePublishableKey),
  );
}

function productionDefaults(env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const mode = runtimeToken(env[ENV_KEYS.authMode]).toLowerCase();
  // A caller-supplied bearer must always have an explicit destination and key.
  if ((mode && mode !== 'oauth') || runtimeToken(env[ENV_KEYS.accessToken])) return {};

  const base = runtimeToken(env[ENV_KEYS.apiBaseUrl]);
  if (base && !isProductionBase(base)) return {};

  for (const key of [
    ENV_KEYS.supabasePublishableKey,
    ENV_KEYS.oauthClientId,
    ENV_KEYS.oauthRedirectUri,
  ]) {
    const configured = runtimeToken(env[key]);
    const value = key === ENV_KEYS.oauthClientId ? configured.toLowerCase() : configured;
    if (value && value !== PRODUCTION_ENV_DEFAULTS[key]) return {};
  }
  return PRODUCTION_ENV_DEFAULTS;
}

export function resolveProductionRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolved = { ...env };
  for (const [key, value] of Object.entries(productionDefaults(env))) {
    if (!runtimeToken(env[key])) resolved[key] = value;
  }
  return resolved;
}

export const ENV_SPECS: EnvSpec[] = [
  {
    key: ENV_KEYS.apiBaseUrl,
    required: true,
    description: 'Main TianGong LCA API / Edge Functions base URL',
  },
  {
    key: ENV_KEYS.region,
    required: false,
    description: 'Target TianGong LCA API region',
    defaultValue: OFFICIAL_PRODUCTION_PROFILE.region,
  },
  {
    key: ENV_KEYS.supabasePublishableKey,
    required: true,
    description: 'Supabase publishable key used to bootstrap and refresh user sessions',
  },
  {
    key: ENV_KEYS.sessionFile,
    required: false,
    description: 'Optional local path for the CLI session cache file',
  },
  {
    key: ENV_KEYS.disableSessionCache,
    required: false,
    description: 'Disable the persistent CLI session cache when set to true',
    defaultValue: 'false',
  },
  {
    key: ENV_KEYS.forceReauth,
    required: false,
    description: 'Ignore cached sessions and force a fresh login when set to true',
    defaultValue: 'false',
  },
  {
    key: ENV_KEYS.authMode,
    required: false,
    description: 'Optional explicit auth mode: oauth or access-token',
  },
  {
    key: ENV_KEYS.oauthClientId,
    required: false,
    description: 'Registered public Supabase OAuth client ID',
  },
  {
    key: ENV_KEYS.oauthRedirectUri,
    required: false,
    description: 'Exact registered CLI loopback OAuth redirect URI',
  },
  {
    key: ENV_KEYS.accessToken,
    required: false,
    description: 'Explicit short-lived actor access token for headless execution',
  },
];

export type DoctorCheck = {
  key: string;
  description: string;
  required: boolean;
  source: ResolvedEnv['source'];
  present: boolean;
  valuePreview: string | null;
};

export type DoctorReport = {
  ok: boolean;
  loadedDotEnv: boolean;
  dotEnvPath: string;
  dotEnvKeysLoaded: number;
  checks: DoctorCheck[];
};

export type RuntimeEnv = {
  apiBaseUrl: string | null;
  authMode: string | null;
  oauthClientId: string | null;
  oauthRedirectUri: string | null;
  accessToken: string | null;
  region: string;
  supabasePublishableKey: string | null;
  sessionFile: string | null;
  disableSessionCache: boolean;
  forceReauth: boolean;
};

function parseBooleanEnv(value: string | null): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

export function resolveEnv(spec: EnvSpec, env: NodeJS.ProcessEnv): ResolvedEnv {
  const envValue = env[spec.key];
  if (envValue && (!Object.hasOwn(PRODUCTION_ENV_DEFAULTS, spec.key) || runtimeToken(envValue))) {
    return {
      key: spec.key,
      source: 'env',
      value: envValue as string,
      present: true,
    };
  }

  const defaults = productionDefaults(env);
  const defaultValue =
    spec.defaultValue ?? (Object.hasOwn(defaults, spec.key) ? defaults[spec.key] : undefined);
  if (defaultValue !== undefined) {
    return {
      key: spec.key,
      source: 'default',
      value: defaultValue,
      present: true,
    };
  }

  return {
    key: spec.key,
    source: 'missing',
    value: null,
    present: false,
  };
}

export function readRuntimeEnv(env: NodeJS.ProcessEnv): RuntimeEnv {
  const apiBaseUrl = resolveEnv(ENV_SPECS[0], env).value;
  const region = resolveEnv(ENV_SPECS[1], env).value as string;
  const supabasePublishableKey = resolveEnv(ENV_SPECS[2], env).value;
  const sessionFile = resolveEnv(ENV_SPECS[3], env).value;
  const disableSessionCache = parseBooleanEnv(resolveEnv(ENV_SPECS[4], env).value);
  const forceReauth = parseBooleanEnv(resolveEnv(ENV_SPECS[5], env).value);
  const authMode = resolveEnv(ENV_SPECS[6], env).value;
  const oauthClientId = resolveEnv(ENV_SPECS[7], env).value;
  const oauthRedirectUri = resolveEnv(ENV_SPECS[8], env).value;
  const accessToken = resolveEnv(ENV_SPECS[9], env).value;

  return {
    apiBaseUrl,
    authMode,
    oauthClientId,
    oauthRedirectUri,
    accessToken,
    region,
    supabasePublishableKey,
    sessionFile,
    disableSessionCache,
    forceReauth,
  };
}

export function maskSecret(value: string | null): string | null {
  if (!value) {
    return value;
  }
  if (value.length <= 8) {
    return value;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function buildDoctorReport(
  env: NodeJS.ProcessEnv,
  dotEnvStatus: { loaded: boolean; path: string; count: number },
): DoctorReport {
  const checks = ENV_SPECS.map((spec) => {
    const resolved = resolveEnv(spec, env);
    return {
      key: spec.key,
      description: spec.description,
      required: spec.required,
      source: resolved.source,
      present: resolved.present,
      valuePreview:
        spec.key === ENV_KEYS.accessToken && resolved.value
          ? '[redacted]'
          : maskSecret(resolved.value),
    };
  });

  return {
    ok:
      !hasProductionProfileMismatch(env) &&
      checks.every((check) => !check.required || check.present) &&
      [ENV_KEYS.oauthClientId, ENV_KEYS.accessToken].some(
        (key) => checks.find((check) => check.key === key)?.present,
      ),
    loadedDotEnv: dotEnvStatus.loaded,
    dotEnvPath: dotEnvStatus.path,
    dotEnvKeysLoaded: dotEnvStatus.count,
    checks,
  };
}

export const __testInternals = {
  parseBooleanEnv,
};
