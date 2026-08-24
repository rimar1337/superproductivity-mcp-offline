import { describe, expect, it } from 'vitest';
import {
  describeConfig,
  isWritable,
  loadConfig,
  SyncMode,
} from '../../../src/infrastructure/config/config.js';
import { parseDotenv } from '../../../src/infrastructure/config/dotenv.js';
import { ConfigurationError } from '../../../src/domain/errors.js';

const validEnv = {
  SP_NEXTCLOUD_URL: 'https://cloud.example.com',
  SP_NEXTCLOUD_USER: 'alice',
  SP_NEXTCLOUD_PASSWORD: 'app-password',
};

describe('parseDotenv', () => {
  it('reads a value beginning with $ literally', () => {
    // The bug this whole parser exists for. Nextcloud app passwords routinely
    // start with `$`, and `source .env` in a shell expands it to nothing —
    // producing an auth failure indistinguishable from a wrong password.
    const parsed = parseDotenv('nextcloud_password=$Nyd0DQjp20U8kBs6f2Y');
    expect(parsed['nextcloud_password']).toBe('$Nyd0DQjp20U8kBs6f2Y');
  });

  it('keeps everything after the first equals sign', () => {
    const parsed = parseDotenv('KEY=a=b=c');
    expect(parsed['KEY']).toBe('a=b=c');
  });

  it('strips matched surrounding quotes only', () => {
    const parsed = parseDotenv(['A="quoted"', "B='single'", 'C="unbalanced'].join('\n'));
    expect(parsed['A']).toBe('quoted');
    expect(parsed['B']).toBe('single');
    expect(parsed['C']).toBe('"unbalanced');
  });

  it('ignores comments, blank lines and lines with no assignment', () => {
    const parsed = parseDotenv(
      ['# a comment', '', 'not an assignment', 'A=1'].join('\n'),
    );
    expect(Object.keys(parsed)).toEqual(['A']);
  });

  it('accepts an export prefix', () => {
    expect(parseDotenv('export A=1')['A']).toBe('1');
  });

  it('handles CRLF line endings', () => {
    const parsed = parseDotenv('A=1\r\nB=2\r\n');
    expect(parsed).toEqual({ A: '1', B: '2' });
  });
});

describe('loadConfig', () => {
  it('accepts the canonical variable names', () => {
    const config = loadConfig(validEnv);
    expect(config.serverUrl).toBe('https://cloud.example.com');
    expect(config.userName).toBe('alice');
    expect(config.syncFolder).toBe('super-productivity');
    expect(config.mode).toBe(SyncMode.ReadWrite);
  });

  it('accepts the legacy lowercase names, so an existing .env keeps working', () => {
    const config = loadConfig({
      nextcloud_url: 'https://cloud.example.com',
      nextcloud_user: 'alice',
      nextcloud_password: 'secret',
    });
    expect(config.userName).toBe('alice');
  });

  it('prefers the canonical name when both are present', () => {
    const config = loadConfig({ ...validEnv, nextcloud_user: 'legacy' });
    expect(config.userName).toBe('alice');
  });

  it('names the variable the operator actually sets when one is missing', () => {
    // "userName is required" sends someone hunting through code; the env var
    // name sends them to the line they need to edit.
    expect(() => loadConfig({ SP_NEXTCLOUD_URL: 'https://x.example' })).toThrow(
      /SP_NEXTCLOUD_USER/,
    );
  });

  it('rejects a server URL with no scheme', () => {
    expect(() =>
      loadConfig({ ...validEnv, SP_NEXTCLOUD_URL: 'cloud.example.com' }),
    ).toThrow(/http/);
  });

  it('trims a trailing slash from the server URL', () => {
    expect(
      loadConfig({ ...validEnv, SP_NEXTCLOUD_URL: 'https://x.example/' }).serverUrl,
    ).toBe('https://x.example');
  });

  it('strips leading and trailing slashes from the folder', () => {
    expect(loadConfig({ ...validEnv, SP_SYNC_FOLDER: '/sp/' }).syncFolder).toBe('sp');
  });

  it('rejects an unknown mode', () => {
    expect(() => loadConfig({ ...validEnv, SP_MODE: 'write-only' })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a non-numeric cache TTL by name', () => {
    expect(() => loadConfig({ ...validEnv, SP_CACHE_TTL_SECONDS: 'soon' })).toThrow(
      /SP_CACHE_TTL_SECONDS/,
    );
  });

  it('converts the cache TTL from seconds to milliseconds', () => {
    expect(loadConfig({ ...validEnv, SP_CACHE_TTL_SECONDS: '30' }).cacheTtlMs).toBe(
      30_000,
    );
  });

  it('derives a client id that is stable for the same target', () => {
    // The client id is a permanent vector-clock key. One minted per restart
    // would add an entry per run and eventually evict real devices.
    const first = loadConfig(validEnv).clientId;
    const second = loadConfig(validEnv).clientId;
    expect(first).toBe(second);
    expect(first).toMatch(/^M_/);
  });

  it('derives a different client id for a different target', () => {
    const a = loadConfig(validEnv).clientId;
    const b = loadConfig({ ...validEnv, SP_NEXTCLOUD_USER: 'bob' }).clientId;
    expect(a).not.toBe(b);
  });

  it('accepts an explicit client id and rejects an unusable one', () => {
    expect(loadConfig({ ...validEnv, SP_CLIENT_ID: 'MY_SERVER_01' }).clientId).toBe(
      'MY_SERVER_01',
    );
    expect(() => loadConfig({ ...validEnv, SP_CLIENT_ID: 'short' })).toThrow(
      ConfigurationError,
    );
  });

  it('treats a blank value as absent', () => {
    expect(loadConfig({ ...validEnv, SP_SYNC_FOLDER: '   ' }).syncFolder).toBe(
      'super-productivity',
    );
  });
});

describe('isWritable', () => {
  it('follows the configured mode', () => {
    expect(isWritable(loadConfig(validEnv))).toBe(true);
    expect(isWritable(loadConfig({ ...validEnv, SP_MODE: 'read-only' }))).toBe(false);
  });
});

describe('describeConfig', () => {
  it('never includes a secret, even in part', () => {
    // This output goes to logs and to a diagnostics tool. A prefix of a
    // password in a bug report is a leaked password.
    const summary = describeConfig(
      loadConfig({ ...validEnv, SP_ENCRYPTION_PASSWORD: 'encryption-secret' }),
    );
    const serialised = JSON.stringify(summary);

    expect(serialised).not.toContain('app-password');
    expect(serialised).not.toContain('encryption-secret');
    expect(summary['isEncryptionConfigured']).toBe(true);
  });
});
