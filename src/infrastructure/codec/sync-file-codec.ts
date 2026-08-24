import { gunzipSync, gzipSync } from 'node:zlib';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import { DecryptionError, SyncFormatError } from '../../domain/errors.js';

/**
 * The wire codec for Super Productivity sync files.
 *
 * A sync file is a short prefix followed by a payload, and the prefix declares
 * how that payload was produced:
 *
 * ```
 * pf_[C][E]<modelVersion>__<payload>
 *     │  └── encrypted
 *     └───── compressed
 * ```
 *
 * The pipeline is **JSON → gzip → encrypt** on write and the exact reverse on
 * read. That order is transcribed from upstream's
 * `encrypt-and-compress-handler.service.ts`, not assumed: compressing after
 * encrypting would produce a file the desktop app cannot open, and the failure
 * would look like corruption rather than like a bug here.
 *
 * @see https://github.com/johannesjo/super-productivity/blob/master/packages/sync-core/src/sync-file-prefix.ts
 */

const PREFIX = 'pf_';
const END_SEPARATOR = '__';
const PREFIX_PATTERN = /^pf_(C)?(E)?(\d+(?:\.\d+)?)__/;

/** AES-GCM envelope geometry. A frozen cross-platform contract. */
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

/**
 * Argon2id parameters.
 *
 * Upstream pins these as a cross-platform contract — the Android reminder
 * worker re-implements the same KDF in Kotlin — so they are not tunable here.
 * Changing any of them yields a different key and an undecryptable file.
 */
const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 3,
  /** KiB. 64 MB. */
  memorySize: 65_536,
} as const;

/** Legacy PBKDF2 parameters, kept only to read files written by old clients. */
const LEGACY_PBKDF2 = {
  iterations: 1000,
  digest: 'sha256',
} as const;

const MIN_ARGON2_BYTES = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
const MIN_LEGACY_BYTES = IV_LENGTH + AUTH_TAG_LENGTH;

export interface DecodedSyncFile<T> {
  readonly data: T;
  readonly modelVersion: number;
  readonly wasCompressed: boolean;
  readonly wasEncrypted: boolean;
}

export interface EncodeOptions {
  readonly modelVersion: number;
  readonly compress: boolean;
  /** Passphrase. Its presence is what turns encryption on. */
  readonly encryptionPassword?: string | undefined;
}

/** Builds the prefix for a given combination of transforms. */
export const buildPrefix = (options: {
  compress: boolean;
  encrypt: boolean;
  modelVersion: number;
}): string =>
  `${PREFIX}${options.compress ? 'C' : ''}${options.encrypt ? 'E' : ''}` +
  `${options.modelVersion}${END_SEPARATOR}`;

export interface ParsedPrefix {
  readonly isCompressed: boolean;
  readonly isEncrypted: boolean;
  readonly modelVersion: number;
  readonly payload: string;
}

/**
 * Splits a raw sync file into its declared transforms and payload.
 *
 * Throws rather than guessing. A body without the prefix is not a sync file,
 * and treating it as one is how a partial upload or an HTML error page gets
 * parsed as state.
 */
export const parsePrefix = (raw: string): ParsedPrefix => {
  const match = PREFIX_PATTERN.exec(raw);
  if (match === null) {
    throw new SyncFormatError(
      `Not a Super Productivity sync file: expected it to start with "${PREFIX}" ` +
        `(got ${raw.length} bytes starting with ${JSON.stringify(raw.slice(0, 12))}).`,
    );
  }
  const modelVersion = Number.parseFloat(match[3] ?? '');
  if (!Number.isFinite(modelVersion)) {
    throw new SyncFormatError(`Invalid sync file model version: ${match[3] ?? ''}`);
  }
  return {
    isCompressed: match[1] === 'C',
    isEncrypted: match[2] === 'E',
    modelVersion,
    payload: raw.slice(match[0].length),
  };
};

/** Serialises, optionally compresses and encrypts, and prefixes. */
export const encodeSyncFile = async (
  data: unknown,
  options: EncodeOptions,
): Promise<string> => {
  const encrypt = options.encryptionPassword !== undefined;
  const prefix = buildPrefix({
    compress: options.compress,
    encrypt,
    modelVersion: options.modelVersion,
  });

  let payload = JSON.stringify(data);
  if (options.compress) {
    payload = gzipSync(Buffer.from(payload, 'utf8')).toString('base64');
  }
  if (options.encryptionPassword !== undefined) {
    payload = await encryptPayload(payload, options.encryptionPassword);
  }
  return prefix + payload;
};

export interface DecodeOptions {
  /** Passphrase, when the operator configured one. */
  readonly encryptionPassword?: string | undefined;
  /**
   * Whether encryption is *expected* locally.
   *
   * When true, a plaintext file is rejected outright. The `E` flag lives
   * outside the authenticated envelope, so anyone who can write to the remote
   * can strip it and serve attacker-authored plaintext; deciding whether to
   * decrypt from that flag alone would accept the substitution silently. Local
   * intent wins over the remote's self-declaration.
   *
   * @see GHSA-vrc7-775g-ggqc
   */
  readonly expectEncrypted: boolean;
}

/** Reverses {@link encodeSyncFile}. */
export const decodeSyncFile = async <T>(
  raw: string,
  options: DecodeOptions,
): Promise<DecodedSyncFile<T>> => {
  const { isCompressed, isEncrypted, modelVersion, payload } = parsePrefix(raw);

  if (options.expectEncrypted && !isEncrypted) {
    throw new DecryptionError(
      'The remote sync file is plaintext but this server is configured to expect ' +
        'encryption. Refusing to read it: an attacker who can write to the remote ' +
        'can strip the encryption flag and substitute their own data. ' +
        'If you genuinely turned encryption off in Super Productivity, clear ' +
        'SP_ENCRYPTION_PASSWORD.',
    );
  }

  let body = payload;

  if (isEncrypted) {
    if (options.encryptionPassword === undefined || options.encryptionPassword === '') {
      throw new DecryptionError(
        'The remote sync file is encrypted but no encryption password is configured. ' +
          'Set SP_ENCRYPTION_PASSWORD to the same password you entered in ' +
          "Super Productivity's sync settings.",
      );
    }
    body = await decryptPayload(body, options.encryptionPassword);
  }

  if (isCompressed) {
    try {
      body = gunzipSync(Buffer.from(body, 'base64')).toString('utf8');
    } catch (error) {
      throw new SyncFormatError('Failed to decompress the sync file.', { cause: error });
    }
  }

  let data: T;
  try {
    data = JSON.parse(body) as T;
  } catch (error) {
    throw new SyncFormatError('The sync file payload is not valid JSON.', {
      cause: error,
    });
  }

  return { data, modelVersion, wasCompressed: isCompressed, wasEncrypted: isEncrypted };
};

// ─── encryption ──────────────────────────────────────────────────────────────

/**
 * Encrypts with a fresh random salt and IV.
 *
 * Both are random per call and both travel in the envelope. Reusing an IV under
 * one key is the classic way to break GCM outright, so they are never derived
 * from anything.
 */
const encryptPayload = async (plaintext: string, password: string): Promise<string> => {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveArgon2Key(password, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  // Node exposes the auth tag separately; WebCrypto appends it. Appending here
  // is what makes the two interoperable.
  return Buffer.concat([salt, iv, ciphertext, cipher.getAuthTag()]).toString('base64');
};

/**
 * Decrypts, handling both the current Argon2id envelope and the legacy PBKDF2
 * one.
 *
 * The two are told apart by length, which cannot be exact: a long legacy
 * ciphertext can exceed the Argon2 minimum. Upstream resolves that by trying
 * Argon2 first and falling back to legacy on failure, and that fallback is part
 * of the wire-format contract rather than defensive padding — dropping it makes
 * old files permanently unreadable.
 */
const decryptPayload = async (encoded: string, password: string): Promise<string> => {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(encoded, 'base64');
  } catch (error) {
    throw new DecryptionError('Encrypted payload is not valid base64.', { cause: error });
  }

  if (buffer.length < MIN_LEGACY_BYTES) {
    throw new DecryptionError('Encrypted payload is too short to be valid.');
  }

  if (buffer.length >= MIN_ARGON2_BYTES) {
    try {
      return await decryptArgon2(buffer, password);
    } catch {
      // Fall through to legacy; see the doc comment.
    }
  }

  try {
    return decryptLegacy(buffer, password);
  } catch (error) {
    throw new DecryptionError(
      'Could not decrypt the sync file. The encryption password is most likely wrong — ' +
        'it must match the one set in Super Productivity exactly.',
      { cause: error },
    );
  }
};

const decryptArgon2 = async (buffer: Buffer, password: string): Promise<string> => {
  const salt = buffer.subarray(0, SALT_LENGTH);
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const rest = buffer.subarray(SALT_LENGTH + IV_LENGTH);
  const key = await deriveArgon2Key(password, salt);
  return decryptGcm(key, iv, rest);
};

const decryptLegacy = (buffer: Buffer, password: string): string => {
  const iv = buffer.subarray(0, IV_LENGTH);
  const rest = buffer.subarray(IV_LENGTH);
  // Upstream uses the password as its own salt here. That is cryptographically
  // weak and upstream says so; it is reproduced only to read old files.
  const key = pbkdf2Sync(
    password,
    password,
    LEGACY_PBKDF2.iterations,
    KEY_LENGTH,
    LEGACY_PBKDF2.digest,
  );
  return decryptGcm(key, iv, rest);
};

const decryptGcm = (key: Buffer, iv: Buffer, ciphertextWithTag: Buffer): string => {
  const tagStart = ciphertextWithTag.length - AUTH_TAG_LENGTH;
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(ciphertextWithTag.subarray(tagStart));
  return Buffer.concat([
    decipher.update(ciphertextWithTag.subarray(0, tagStart)),
    decipher.final(),
  ]).toString('utf8');
};

/**
 * Argon2id key derivation, cached per (password, salt).
 *
 * The cache is not micro-optimisation: these parameters cost 64 MB and
 * hundreds of milliseconds per derivation, and every read *and* the write that
 * follows it use the same salt. Without the cache an encrypted round trip pays
 * for that twice on every single tool call.
 */
const keyCache = new Map<string, Buffer>();
const KEY_CACHE_LIMIT = 8;

const deriveArgon2Key = async (password: string, salt: Uint8Array): Promise<Buffer> => {
  const cacheKey = `${password}:${Buffer.from(salt).toString('base64')}`;
  const cached = keyCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const derived = await argon2id({
    password,
    salt,
    hashLength: KEY_LENGTH,
    parallelism: ARGON2_PARAMS.parallelism,
    iterations: ARGON2_PARAMS.iterations,
    memorySize: ARGON2_PARAMS.memorySize,
    outputType: 'binary',
  });

  const key = Buffer.from(derived);
  if (keyCache.size >= KEY_CACHE_LIMIT) {
    const oldest = keyCache.keys().next();
    if (!oldest.done) {
      keyCache.delete(oldest.value);
    }
  }
  keyCache.set(cacheKey, key);
  return key;
};

/** Drops every cached key. Used by tests and on shutdown. */
export const clearKeyCache = (): void => {
  keyCache.clear();
};
