import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildPrefix,
  clearKeyCache,
  decodeSyncFile,
  encodeSyncFile,
  parsePrefix,
} from '../../../src/infrastructure/codec/sync-file-codec.js';
import { DecryptionError, SyncFormatError } from '../../../src/domain/errors.js';

/**
 * The fixture is a real sync file — same envelope, same 344-operation log, same
 * schema version — with every title, note and identifier replaced by synthetic
 * text. Testing the codec against a hand-written blob would prove only that it
 * round-trips its own output.
 */
const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/sync-data.sample.json', import.meta.url)),
  'utf8',
);

const PASSWORD = 'correct horse battery staple';

describe('parsePrefix', () => {
  it('reads the real file as plaintext, uncompressed, model version 2', () => {
    expect(parsePrefix(FIXTURE)).toMatchObject({
      isCompressed: false,
      isEncrypted: false,
      modelVersion: 2,
    });
  });

  it.each([
    ['pf_2__{}', { isCompressed: false, isEncrypted: false, modelVersion: 2 }],
    ['pf_C2__x', { isCompressed: true, isEncrypted: false, modelVersion: 2 }],
    ['pf_E2__x', { isCompressed: false, isEncrypted: true, modelVersion: 2 }],
    ['pf_CE3__x', { isCompressed: true, isEncrypted: true, modelVersion: 3 }],
  ])('decodes the flags in %s', (raw, expected) => {
    expect(parsePrefix(raw)).toMatchObject(expected);
  });

  it('rejects a body with no prefix instead of guessing', () => {
    // A partial upload or an HTML error page must not be parsed as state.
    expect(() => parsePrefix('{"version":2}')).toThrow(SyncFormatError);
  });

  it('does not leak file contents into the error message', () => {
    // Sync files are the user's entire task history; errors get logged.
    const secret = 'pf_'.padEnd(400, 'S');
    let message = '';
    try {
      parsePrefix(secret.replace('pf_', 'zz_'));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('SSSSSSSSSSSSSSSSSSSSS');
  });
});

describe('buildPrefix', () => {
  it.each([
    [{ compress: false, encrypt: false, modelVersion: 2 }, 'pf_2__'],
    [{ compress: true, encrypt: false, modelVersion: 2 }, 'pf_C2__'],
    [{ compress: false, encrypt: true, modelVersion: 2 }, 'pf_E2__'],
    [{ compress: true, encrypt: true, modelVersion: 3 }, 'pf_CE3__'],
  ])('builds %o as %s', (options, expected) => {
    expect(buildPrefix(options)).toBe(expected);
  });
});

describe('decodeSyncFile', () => {
  it('decodes the real sync file', async () => {
    const decoded = await decodeSyncFile<Record<string, unknown>>(FIXTURE, {
      expectEncrypted: false,
    });
    expect(decoded.data['version']).toBe(2);
    expect(decoded.data['schemaVersion']).toBe(4);
    expect(Array.isArray(decoded.data['recentOps'])).toBe(true);
  });

  it('rejects a plaintext file when encryption is expected locally', async () => {
    // GHSA-vrc7-775g-ggqc: the E flag sits outside the authenticated envelope,
    // so anyone who can write to the remote can strip it and serve their own
    // plaintext. Local intent has to win over the remote's self-declaration.
    await expect(
      decodeSyncFile(FIXTURE, { expectEncrypted: true, encryptionPassword: PASSWORD }),
    ).rejects.toThrow(DecryptionError);
  });

  it('reports a missing password rather than failing obscurely', async () => {
    const encrypted = await encodeSyncFile(
      { version: 2 },
      { modelVersion: 2, compress: false, encryptionPassword: PASSWORD },
    );
    await expect(decodeSyncFile(encrypted, { expectEncrypted: false })).rejects.toThrow(
      /no encryption password is configured/,
    );
  });

  it('rejects malformed JSON', async () => {
    await expect(
      decodeSyncFile('pf_2__not json', { expectEncrypted: false }),
    ).rejects.toThrow(SyncFormatError);
  });

  it('rejects a corrupt compressed payload', async () => {
    await expect(
      decodeSyncFile('pf_C2__bm90Z3ppcA==', { expectEncrypted: false }),
    ).rejects.toThrow(SyncFormatError);
  });
});

describe('round trips', () => {
  it('reproduces the original bytes for the plaintext path', async () => {
    // Byte identity, not just structural equality: the whole design rests on
    // rewriting this file in a shape the desktop app reads back unchanged.
    const decoded = await decodeSyncFile<Record<string, unknown>>(FIXTURE, {
      expectEncrypted: false,
    });
    const reEncoded = await encodeSyncFile(decoded.data, {
      modelVersion: 2,
      compress: false,
    });
    expect(reEncoded).toBe(FIXTURE);
  });

  it('survives compression', async () => {
    const decoded = await decodeSyncFile<Record<string, unknown>>(FIXTURE, {
      expectEncrypted: false,
    });
    const compressed = await encodeSyncFile(decoded.data, {
      modelVersion: 2,
      compress: true,
    });
    expect(compressed.startsWith('pf_C2__')).toBe(true);
    expect(compressed.length).toBeLessThan(FIXTURE.length);

    const back = await decodeSyncFile<Record<string, unknown>>(compressed, {
      expectEncrypted: false,
    });
    expect(back.data).toEqual(decoded.data);
  });

  it('survives encryption and compression together', async () => {
    const decoded = await decodeSyncFile<Record<string, unknown>>(FIXTURE, {
      expectEncrypted: false,
    });
    const sealed = await encodeSyncFile(decoded.data, {
      modelVersion: 2,
      compress: true,
      encryptionPassword: PASSWORD,
    });
    expect(sealed.startsWith('pf_CE2__')).toBe(true);

    const back = await decodeSyncFile<Record<string, unknown>>(sealed, {
      expectEncrypted: true,
      encryptionPassword: PASSWORD,
    });
    expect(back.data).toEqual(decoded.data);
  });

  it('uses a fresh salt and IV on every encryption', async () => {
    // Reusing an IV under one key breaks GCM outright, so neither may be
    // derived from the payload or the password.
    const first = await encodeSyncFile(
      { a: 1 },
      { modelVersion: 2, compress: false, encryptionPassword: PASSWORD },
    );
    const second = await encodeSyncFile(
      { a: 1 },
      { modelVersion: 2, compress: false, encryptionPassword: PASSWORD },
    );
    expect(first).not.toBe(second);
  });

  it('refuses a wrong password rather than returning garbage', async () => {
    const sealed = await encodeSyncFile(
      { a: 1 },
      { modelVersion: 2, compress: false, encryptionPassword: PASSWORD },
    );
    await expect(
      decodeSyncFile(sealed, { expectEncrypted: true, encryptionPassword: 'wrong' }),
    ).rejects.toThrow(DecryptionError);
  });

  it('detects tampering with the ciphertext', async () => {
    // AES-GCM is authenticated; a flipped byte must fail, not decode wrongly.
    const sealed = await encodeSyncFile(
      { a: 1 },
      { modelVersion: 2, compress: false, encryptionPassword: PASSWORD },
    );
    const body = Buffer.from(sealed.slice('pf_E2__'.length), 'base64');
    const last = body.length - 1;
    body[last] = (body[last] ?? 0) ^ 0xff;
    const tampered = `pf_E2__${body.toString('base64')}`;

    await expect(
      decodeSyncFile(tampered, { expectEncrypted: true, encryptionPassword: PASSWORD }),
    ).rejects.toThrow(DecryptionError);
  });

  it('rejects a payload too short to be an envelope', async () => {
    await expect(
      decodeSyncFile('pf_E2__QUJD', {
        expectEncrypted: true,
        encryptionPassword: PASSWORD,
      }),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('key cache', () => {
  it('can be cleared without breaking subsequent decryption', async () => {
    const sealed = await encodeSyncFile(
      { a: 1 },
      { modelVersion: 2, compress: false, encryptionPassword: PASSWORD },
    );
    clearKeyCache();
    const back = await decodeSyncFile<{ a: number }>(sealed, {
      expectEncrypted: true,
      encryptionPassword: PASSWORD,
    });
    expect(back.data.a).toBe(1);
  });
});
