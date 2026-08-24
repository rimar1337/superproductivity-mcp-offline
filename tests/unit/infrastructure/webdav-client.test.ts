import { describe, expect, it, vi } from 'vitest';
import {
  buildNextcloudBaseUrl,
  WebdavClient,
} from '../../../src/infrastructure/webdav/webdav-client.js';
import {
  ConcurrencyError,
  RemoteAccessError,
  RemoteFileNotFoundError,
} from '../../../src/domain/errors.js';
import { silentLogger } from '../../support/fakes.js';

/**
 * The WebDAV client, driven by a scripted `fetch`.
 *
 * The interesting behaviour here is not "does it send a GET" — it is what the
 * client refuses to do: forward credentials to an unexpected host, echo back a
 * weak validator, or retry a conditional write.
 */

interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

const scriptedFetch = (
  responses: ScriptedResponse[],
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } => {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  const fetchImpl = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const scripted = responses[Math.min(index, responses.length - 1)];
    index += 1;
    /* c8 ignore next 3 -- a test that scripts no responses is a broken test. */
    if (scripted === undefined) {
      throw new Error('No scripted response');
    }
    // 204/205/304 must be constructed with a null body, or the Response
    // constructor throws before the client ever sees the status.
    const isBodyless = [204, 205, 304].includes(scripted.status);
    return Promise.resolve(
      new Response(isBodyless ? null : (scripted.body ?? ''), {
        status: scripted.status,
        headers: scripted.headers ?? {},
      }),
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
};

const makeClient = (
  responses: ScriptedResponse[],
  overrides: { baseUrl?: string } = {},
): ReturnType<typeof scriptedFetch> & { client: WebdavClient } => {
  const scripted = scriptedFetch(responses);
  const client = new WebdavClient({
    baseUrl: overrides.baseUrl ?? 'https://cloud.example.com/remote.php/dav/files/alice/',
    username: 'alice',
    password: 'secret',
    folder: 'super-productivity',
    logger: silentLogger(),
    fetchImpl: scripted.fetchImpl,
    maxRetries: 0,
  });
  return { ...scripted, client };
};

describe('buildNextcloudBaseUrl', () => {
  it('builds the DAV root the desktop app uses', async () => {
    expect(buildNextcloudBaseUrl('https://cloud.example.com', 'alice')).toBe(
      'https://cloud.example.com/remote.php/dav/files/alice/',
    );
  });

  it('tolerates a trailing slash and encodes the username', () => {
    expect(buildNextcloudBaseUrl('https://cloud.example.com/', 'a b')).toBe(
      'https://cloud.example.com/remote.php/dav/files/a%20b/',
    );
  });
});

describe('reading', () => {
  it('sends Basic auth and returns the strong validator', async () => {
    const { client, calls } = makeClient([
      { status: 200, headers: { etag: '"abc"' }, body: 'contents' },
    ]);

    const file = await client.read('sync-data.json');

    expect(file.content).toBe('contents');
    expect(file.rev).toBe('"abc"');
    const auth = new Headers(calls[0]?.init.headers).get('authorization');
    expect(auth).toBe(`Basic ${Buffer.from('alice:secret').toString('base64')}`);
  });

  it('prefers OC-ETag, which survives proxies rewriting ETag', async () => {
    const { client } = makeClient([
      {
        status: 200,
        headers: { etag: '"proxy-rewrote-this"', 'oc-etag': '"canonical"' },
      },
    ]);
    expect((await client.read('sync-data.json')).rev).toBe('"canonical"');
  });

  it('discards a weak validator rather than sending it back in If-Match', async () => {
    // A weak tag in If-Match produces a precondition the server evaluates
    // differently than we intend — worse than having none and knowing it.
    const { client } = makeClient([{ status: 200, headers: { etag: 'W/"weak"' } }]);
    expect((await client.read('sync-data.json')).rev).toBeNull();
  });

  it('reports a missing file distinctly from any other failure', async () => {
    const { client } = makeClient([{ status: 404 }]);
    await expect(client.read('sync-data.json')).rejects.toThrow(RemoteFileNotFoundError);
  });

  it('explains a 401 in terms of what the operator should check', async () => {
    const { client } = makeClient([{ status: 401 }]);
    await expect(client.read('sync-data.json')).rejects.toThrow(/app password/);
  });

  it('marks a 5xx retryable and a 403 not', async () => {
    const server = makeClient([{ status: 503 }]);
    await server.client.read('x').catch((error: unknown) => {
      expect((error as RemoteAccessError).isRetryable).toBe(true);
    });

    const forbidden = makeClient([{ status: 403 }]);
    await forbidden.client.read('x').catch((error: unknown) => {
      expect((error as RemoteAccessError).isRetryable).toBe(false);
    });
  });

  it('wraps a transport failure as retryable', async () => {
    const client = new WebdavClient({
      baseUrl: 'https://cloud.example.com/remote.php/dav/files/alice/',
      username: 'alice',
      password: 'secret',
      folder: 'sp',
      logger: silentLogger(),
      maxRetries: 0,
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(client.read('sync-data.json')).rejects.toThrow(RemoteAccessError);
  });
});

describe('redirects', () => {
  it('follows a same-host upgrade to HTTPS and remembers it', async () => {
    // Self-hosted instances routinely 307 from http to https; refusing would
    // break the common setup, and the upgrade strictly improves security.
    const { client, calls } = makeClient(
      [
        {
          status: 307,
          headers: {
            location:
              'https://cloud.example.com/remote.php/dav/files/alice/sp/sync-data.json',
          },
        },
        { status: 200, headers: { etag: '"ok"' }, body: 'data' },
        { status: 200, headers: { etag: '"ok"' }, body: 'data' },
      ],
      { baseUrl: 'http://cloud.example.com/remote.php/dav/files/alice/' },
    );

    await client.read('sync-data.json');
    expect(client.effectiveBaseUrl.startsWith('https://')).toBe(true);

    // The learned upgrade means the next request skips the redirect entirely.
    const before = calls.length;
    await client.read('sync-data.json');
    expect(calls.length - before).toBe(1);
    expect(calls.at(-1)?.url.startsWith('https://')).toBe(true);
  });

  it('refuses a redirect to another host rather than forwarding credentials', async () => {
    // `fetch` would happily replay HTTP Basic credentials at the new
    // destination. This is the single most damaging thing it could do silently.
    const { client } = makeClient([
      { status: 302, headers: { location: 'https://attacker.example/collect' } },
    ]);

    await expect(client.read('sync-data.json')).rejects.toThrow(/different destination/);
  });

  it('refuses a downgrade from HTTPS to HTTP', async () => {
    const { client } = makeClient([
      {
        status: 307,
        headers: { location: 'http://cloud.example.com/remote.php/dav/files/alice/x' },
      },
    ]);
    await expect(client.read('sync-data.json')).rejects.toThrow(/different destination/);
  });

  it('reports a redirect with no Location instead of hanging', async () => {
    const { client } = makeClient([{ status: 307 }]);
    await expect(client.read('sync-data.json')).rejects.toThrow(/no Location/);
  });
});

describe('writing', () => {
  it('sends If-Match for a match precondition', async () => {
    const { client, calls } = makeClient([{ status: 204, headers: { etag: '"new"' } }]);

    const result = await client.write('sync-data.json', 'body', {
      kind: 'match',
      rev: '"old"',
    });

    expect(new Headers(calls[0]?.init.headers).get('if-match')).toBe('"old"');
    expect(result.rev).toBe('"new"');
  });

  it('sends If-None-Match for a create precondition', async () => {
    const { client, calls } = makeClient([{ status: 201, headers: { etag: '"new"' } }]);
    await client.write('new.json', 'body', { kind: 'create' });
    expect(new Headers(calls[0]?.init.headers).get('if-none-match')).toBe('*');
  });

  it('sends no precondition for an explicit overwrite', async () => {
    const { client, calls } = makeClient([{ status: 204, headers: { etag: '"new"' } }]);
    await client.write('backup.json', 'body', { kind: 'overwrite' });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('if-match')).toBeNull();
    expect(headers.get('if-none-match')).toBeNull();
  });

  it('translates 412 into a concurrency failure', async () => {
    const { client } = makeClient([{ status: 412 }]);
    await expect(
      client.write('sync-data.json', 'body', { kind: 'match', rev: '"old"' }),
    ).rejects.toThrow(ConcurrencyError);
  });

  it('translates a failed create into a concurrency failure', async () => {
    const { client } = makeClient([{ status: 412 }]);
    await expect(
      client.write('sync-data.json', 'body', { kind: 'create' }),
    ).rejects.toThrow(/already exists/);
  });

  it('never retries a conditional write', async () => {
    // The precondition is evaluated server-side, so a retry after an ambiguous
    // failure could apply the write against a revision that has since moved.
    const scripted = scriptedFetch([{ status: 503 }, { status: 204 }]);
    const client = new WebdavClient({
      baseUrl: 'https://cloud.example.com/remote.php/dav/files/alice/',
      username: 'alice',
      password: 'secret',
      folder: 'sp',
      logger: silentLogger(),
      fetchImpl: scripted.fetchImpl,
      maxRetries: 3,
    });

    await expect(
      client.write('sync-data.json', 'body', { kind: 'match', rev: '"old"' }),
    ).rejects.toThrow(RemoteAccessError);
    expect(scripted.calls).toHaveLength(1);
  });

  it('falls back to PROPFIND when the server returns no validator on PUT', async () => {
    const { client, calls } = makeClient([
      { status: 204 },
      {
        status: 207,
        body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/remote.php/dav/files/alice/super-productivity/sync-data.json</d:href>
          <d:propstat><d:prop><d:getetag>&quot;from-propfind&quot;</d:getetag></d:prop></d:propstat>
          </d:response></d:multistatus>`,
      },
    ]);

    const result = await client.write('sync-data.json', 'body', { kind: 'overwrite' });
    expect(result.rev).toBe('"from-propfind"');
    expect(calls[1]?.init.method).toBe('PROPFIND');
  });
});

describe('directories', () => {
  it('treats an existing collection as success', async () => {
    // MKCOL on an existing collection answers 405; for an idempotent "ensure"
    // that is the desired outcome, not a failure.
    const { client } = makeClient([{ status: 405 }]);
    await expect(client.ensureDirectory('')).resolves.toBeUndefined();
  });

  it('treats deleting a missing file as success', async () => {
    const { client } = makeClient([{ status: 404 }]);
    await expect(client.delete('gone.json')).resolves.toBeUndefined();
  });

  it('excludes the collection itself from a listing', async () => {
    const { client } = makeClient([
      {
        status: 207,
        body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/remote.php/dav/files/alice/super-productivity/</d:href>
            <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
          </d:response>
          <d:response><d:href>/remote.php/dav/files/alice/super-productivity/sync-data.json</d:href>
            <d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength></d:prop></d:propstat>
          </d:response>
        </d:multistatus>`,
      },
    ]);

    const entries = await client.list();
    expect(entries.map((entry) => entry.name)).toEqual(['sync-data.json']);
  });

  it('returns null for a stat on a missing path', async () => {
    const { client } = makeClient([{ status: 404 }]);
    expect(await client.stat('nope.json')).toBeNull();
  });
});
