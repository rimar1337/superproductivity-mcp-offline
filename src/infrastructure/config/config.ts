import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { ConfigurationError } from '../../domain/errors.js';
import type { LogLevel } from '../../domain/ports.js';

/**
 * Configuration, resolved once at startup and never re-read.
 *
 * Two decisions worth stating:
 *
 * **Legacy variable names are accepted.** Someone who already has
 * `nextcloud_user` / `nextcloud_password` in a `.env` should not have to rename
 * anything to try this server. The canonical `SP_*` names win when both exist.
 *
 * **`.env` is parsed here, not sourced.** A password beginning with `$` — which
 * app passwords routinely do — is destroyed by `source .env` in a shell, and
 * the resulting failure looks like wrong credentials rather than like a parsing
 * bug. Values are read literally, exactly as `dotenv` would.
 */

export const SyncMode = {
  ReadOnly: 'read-only',
  ReadWrite: 'read-write',
} as const;

export type SyncMode = (typeof SyncMode)[keyof typeof SyncMode];

export const Transport = {
  Stdio: 'stdio',
  Http: 'http',
} as const;

export type Transport = (typeof Transport)[keyof typeof Transport];

/** Global default for how the process exposes itself over HTTP. */
const DEFAULT_PORT = 8787;

const trimmedString = z.string().trim().min(1);

const configSchema = z.object({
  serverUrl: trimmedString
    .refine((value) => /^https?:\/\//i.test(value), {
      message: 'must start with http:// or https://',
    })
    .transform((value) => value.replace(/\/+$/, '')),
  userName: trimmedString,
  password: z.string().min(1),
  loginName: trimmedString.optional(),
  syncFolder: trimmedString.transform((value) => value.replace(/^\/+|\/+$/g, '')),
  encryptionPassword: z.string().min(1).optional(),
  mode: z.enum([SyncMode.ReadOnly, SyncMode.ReadWrite]),
  clientId: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{10,64}$/,
      'must be 10-64 characters of letters, digits, underscore or hyphen',
    ),
  cacheTtlMs: z.number().int().min(0).max(600_000),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']),
  requestTimeoutMs: z.number().int().min(1_000).max(300_000),
  transport: z.enum([Transport.Stdio, Transport.Http]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  /**
   * Bearer token protecting every HTTP request. Immutable once set: if it is
   * present it must be used, and if it is absent the server refuses to start
   * over HTTP — an unauthenticated MCP endpoint is an unauthenticated write
   * endpoint, and there is no valid reason to expose one.
   */
  authToken: z.string().min(1).optional(),
  /** CalDAV calendar server, e.g. the Nextcloud DAV root. Optional. */
  caldavUrl: z.string().url().optional(),
  caldavUsername: z.string().min(1).optional(),
  caldavPassword: z.string().min(1).optional(),
  /**
   * Calendar hrefs to expose for reading. May be absolute
   * (`/remote.php/dav/calendars/alice/personal/`) or bare display names when a
   * single home exists. Optional: when unset the server derives calendars from
   * the user's Super Productivity CalDAV issue-provider config.
   */
  calendarIds: z.array(z.string().min(1)).optional(),
  /** The one calendar writes land in. Mutually exclusive with nothing. */
  calendarWriteId: z.string().min(1).optional(),
  calendarMode: z.enum([SyncMode.ReadOnly, SyncMode.ReadWrite]),
});

export type AppConfig = z.infer<typeof configSchema> & { readonly logLevel: LogLevel };

/** Canonical variable name, then the legacy spellings we still accept. */
const ENV_ALIASES = {
  serverUrl: ['SP_NEXTCLOUD_URL', 'NEXTCLOUD_URL', 'nextcloud_url'],
  userName: ['SP_NEXTCLOUD_USER', 'NEXTCLOUD_USER', 'nextcloud_user'],
  password: [
    'SP_NEXTCLOUD_PASSWORD',
    'NEXTCLOUD_PASSWORD',
    'nextcloud_password',
    'nextcloud_pass',
  ],
  loginName: ['SP_NEXTCLOUD_LOGIN_NAME', 'nextcloud_login_name'],
  syncFolder: ['SP_SYNC_FOLDER', 'nextcloud_sync_folder'],
  encryptionPassword: ['SP_ENCRYPTION_PASSWORD', 'sp_encryption_password'],
  mode: ['SP_MODE'],
  clientId: ['SP_CLIENT_ID'],
  cacheTtlSeconds: ['SP_CACHE_TTL_SECONDS'],
  logLevel: ['SP_LOG_LEVEL'],
  requestTimeoutMs: ['SP_REQUEST_TIMEOUT_MS'],
  transport: ['MCP_TRANSPORT', 'SP_TRANSPORT'],
  host: ['MCP_HOST', 'SP_HOST'],
  port: ['MCP_PORT', 'SP_PORT'],
  authToken: ['MCP_AUTH_TOKEN', 'SP_AUTH_TOKEN'],
  caldavUrl: ['CALDAV_URL', 'SP_CALDAV_URL'],
  caldavUsername: ['CALDAV_USER', 'SP_CALDAV_USER'],
  caldavPassword: ['CALDAV_PASSWORD', 'SP_CALDAV_PASSWORD'],
  calendarIds: ['CALDAV_CALENDARS', 'SP_CALDAV_CALENDARS'],
  calendarWriteId: ['CALDAV_WRITE_CALENDAR', 'SP_CALDAV_WRITE_CALENDAR'],
  calendarMode: ['CALENDAR_MODE', 'SP_CALENDAR_MODE'],
} as const;

export type EnvSource = Record<string, string | undefined>;

const pick = (env: EnvSource, aliases: readonly string[]): string | undefined => {
  for (const alias of aliases) {
    const value = env[alias];
    if (value !== undefined && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
};

const parseNumber = (
  raw: string | undefined,
  fallback: number,
  label: string,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigurationError(`${label} must be a number, got "${raw}".`);
  }
  return parsed;
};

/**
 * Parses a comma-separated list, dropping blanks and duplicates.
 *
 * Returns `undefined` rather than an empty array when nothing usable was given:
 * "the operator wrote `CALDAV_CALENDARS=`" and "the operator did not configure
 * calendars at all" should take the same discovery path, not one of them
 * silently exposing zero calendars.
 */
const parseCommaList = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const items = [
    ...new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ];
  return items.length === 0 ? undefined : items;
};

export const loadConfig = (env: EnvSource = process.env): AppConfig => {
  const candidate = {
    serverUrl: pick(env, ENV_ALIASES.serverUrl),
    userName: pick(env, ENV_ALIASES.userName),
    password: pick(env, ENV_ALIASES.password),
    loginName: pick(env, ENV_ALIASES.loginName),
    syncFolder: pick(env, ENV_ALIASES.syncFolder) ?? 'super-productivity',
    encryptionPassword: pick(env, ENV_ALIASES.encryptionPassword),
    mode: pick(env, ENV_ALIASES.mode) ?? SyncMode.ReadOnly,
    clientId: pick(env, ENV_ALIASES.clientId) ?? deriveClientId(env),
    cacheTtlMs:
      parseNumber(pick(env, ENV_ALIASES.cacheTtlSeconds), 20, 'SP_CACHE_TTL_SECONDS') *
      1000,
    logLevel: pick(env, ENV_ALIASES.logLevel) ?? 'info',
    requestTimeoutMs: parseNumber(
      pick(env, ENV_ALIASES.requestTimeoutMs),
      30_000,
      'SP_REQUEST_TIMEOUT_MS',
    ),
    transport: pick(env, ENV_ALIASES.transport) ?? Transport.Stdio,
    host: pick(env, ENV_ALIASES.host) ?? '127.0.0.1',
    port: parseNumber(pick(env, ENV_ALIASES.port), DEFAULT_PORT, 'MCP_PORT'),
    authToken: pick(env, ENV_ALIASES.authToken),
    caldavUrl: pick(env, ENV_ALIASES.caldavUrl),
    caldavUsername: pick(env, ENV_ALIASES.caldavUsername),
    caldavPassword: pick(env, ENV_ALIASES.caldavPassword),
    calendarIds: parseCommaList(pick(env, ENV_ALIASES.calendarIds)),
    calendarWriteId: pick(env, ENV_ALIASES.calendarWriteId),
    calendarMode: pick(env, ENV_ALIASES.calendarMode) ?? SyncMode.ReadOnly,
  };

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    throw new ConfigurationError(
      'Configuration is invalid. Copy .env.example to .env and fill it in.\n' +
        result.error.issues
          .map((issue) => `  - ${describeField(issue.path[0])}: ${issue.message}`)
          .join('\n'),
    );
  }
  return result.data;
};

/** Maps a schema field back to the variable name the operator actually sets. */
const describeField = (field: PropertyKey | undefined): string => {
  const key = String(field ?? '');
  const aliases = (ENV_ALIASES as Record<string, readonly string[]>)[key];
  return aliases?.[0] ?? key;
};

/**
 * Derives a stable client id when the operator did not pick one.
 *
 * Stability matters more than uniqueness-in-the-abstract: the client id is a
 * permanent key in Super Productivity's vector clock, and a server that minted
 * a fresh one on every restart would add an entry per run and eventually push
 * real devices out of the 20-entry clock. Hashing the machine and DAV target
 * gives the same id across restarts and a different one per install.
 *
 * The `M_` prefix follows the platform-letter convention upstream uses
 * (B/E/A/I for browser, Electron, Android, iOS) without colliding with any of
 * them, so this server is identifiable in a vector clock at a glance.
 */
const deriveClientId = (env: EnvSource): string => {
  const material = [
    hostname(),
    pick(env, ENV_ALIASES.serverUrl) ?? '',
    pick(env, ENV_ALIASES.userName) ?? '',
    pick(env, ENV_ALIASES.syncFolder) ?? '',
  ].join('|');
  const digest = createHash('sha256').update(material).digest('base64url');
  return `M_${digest.slice(0, 10)}`;
};

/** True when writes are permitted. */
export const isWritable = (config: AppConfig): boolean =>
  config.mode === SyncMode.ReadWrite;

/**
 * A redacted view, safe to log or return from a diagnostics tool.
 *
 * Secrets are reported as booleans. Printing even a prefix of a password is
 * how credentials end up in a bug report.
 */
export const describeConfig = (
  config: AppConfig,
): Record<string, string | number | boolean> => ({
  serverUrl: config.serverUrl,
  userName: config.userName,
  syncFolder: config.syncFolder,
  mode: config.mode,
  clientId: config.clientId,
  isEncryptionConfigured: config.encryptionPassword !== undefined,
  cacheTtlMs: config.cacheTtlMs,
  logLevel: config.logLevel,
  transport: config.transport,
  host: config.host,
  port: config.port,
  isAuthTokenConfigured: config.authToken !== undefined,
  calendarMode: config.calendarMode,
  isCaldavConfigured: config.caldavUrl !== undefined,
  isCaldavPasswordConfigured: config.caldavPassword !== undefined,
  calendarIds: config.calendarIds?.join(', ') ?? '',
});
