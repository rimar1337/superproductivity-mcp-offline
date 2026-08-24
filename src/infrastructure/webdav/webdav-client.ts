import {
  ConcurrencyError,
  RemoteAccessError,
  RemoteFileNotFoundError,
  describeUnknownError,
} from '../../domain/errors.js';
import type {
  FileMetadata,
  FileStore,
  Logger,
  StoredFile,
  WritePrecondition,
} from '../../domain/ports.js';
import { parsePropfind } from './propfind-parser.js';

/**
 * A WebDAV client scoped to one folder, implementing {@link FileStore}.
 *
 * Two things here are not generic WebDAV and exist specifically to be a safe
 * peer to Super Productivity:
 *
 * **Strong validators only.** Conditional writes ride on `If-Match`, and a weak
 * or malformed ETag cannot safely drive one. Nextcloud publishes its canonical
 * validator as `OC-ETag`, precisely because reverse proxies rewrite `ETag`, so
 * that header is preferred and anything not matching RFC 7232's strong syntax
 * is discarded rather than sent back and hoped for.
 *
 * **No silent credential forwarding.** Redirects are followed manually. A
 * same-host `http:` → `https:` upgrade is honoured, because that is the common
 * self-hosted setup and the redirect strictly improves security. Anything else
 * — a different host, a downgrade — is refused rather than followed, because
 * `fetch` would happily replay HTTP Basic credentials at the new destination.
 */

export interface WebdavClientOptions {
  /** DAV root, e.g. `https://cloud.example.com/remote.php/dav/files/alice/`. */
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  /** Folder within the DAV root that holds the sync files. */
  readonly folder: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** RFC 7232 strong entity-tag: a quoted string with no weak `W/` marker. */
const STRONG_ETAG = /^"[\x21\x23-\x7E\x80-\xFF]*"$/;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export class WebdavClient implements FileStore {
  readonly #username: string;
  readonly #password: string;
  readonly #folder: string;
  readonly #logger: Logger;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  /** Mutable: a same-host HTTPS upgrade is learned once and then reused. */
  #baseUrl: string;

  constructor(options: WebdavClientOptions) {
    this.#baseUrl = ensureTrailingSlash(options.baseUrl);
    this.#username = options.username;
    this.#password = options.password;
    this.#folder = trimSlashes(options.folder);
    this.#logger = options.logger.child({ component: 'webdav' });
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** The DAV root actually in use, after any learned HTTPS upgrade. */
  get effectiveBaseUrl(): string {
    return this.#baseUrl;
  }

  async read(path: string): Promise<StoredFile> {
    const response = await this.#request('GET', path);
    if (response.status === 404) {
      throw new RemoteFileNotFoundError(this.#resolve(path));
    }
    this.#assertOk(response, 'read', path);
    return { content: await response.text(), rev: readStrongEtag(response.headers) };
  }

  async stat(path: string): Promise<FileMetadata | null> {
    const entries = await this.#propfind(path, '0');
    return entries[0] ?? null;
  }

  async list(path = ''): Promise<FileMetadata[]> {
    const entries = await this.#propfind(path, '1');
    // Depth 1 includes the collection itself; callers want its children.
    // Compared on the decoded pathname because servers return hrefs
    // percent-encoded, absolute or relative, and with or without a trailing
    // slash — none of which changes which resource is meant.
    const self = normalisePath(new URL(this.#resolve(path)).pathname);
    return entries.filter((entry) => normalisePath(entry.path) !== self);
  }

  async write(
    path: string,
    content: string,
    precondition: WritePrecondition,
  ): Promise<{ rev: string | null }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };
    if (precondition.kind === 'match') {
      headers['If-Match'] = precondition.rev;
    } else if (precondition.kind === 'create') {
      headers['If-None-Match'] = '*';
    }

    const response = await this.#request('PUT', path, {
      headers,
      body: content,
      // A conditional write must not be retried blindly. The precondition is
      // evaluated server-side, so a retry after an ambiguous failure could
      // apply the write twice against a rev that has since moved on.
      retry: precondition.kind === 'overwrite',
    });

    if (response.status === 412 || response.status === 409) {
      throw new ConcurrencyError(
        precondition.kind === 'create'
          ? `${this.#resolve(path)} already exists.`
          : `${this.#resolve(path)} changed since it was read; another device wrote first.`,
      );
    }
    this.#assertOk(response, 'write', path);

    const rev = readStrongEtag(response.headers);
    if (rev !== null) {
      return { rev };
    }
    // Some servers omit a validator on PUT. One extra PROPFIND is far cheaper
    // than the alternative: a subsequent write with no precondition to check.
    const meta = await this.stat(path);
    return { rev: meta?.rev ?? null };
  }

  async delete(path: string): Promise<void> {
    const response = await this.#request('DELETE', path);
    if (response.status === 404) {
      return;
    }
    this.#assertOk(response, 'delete', path);
  }

  async ensureDirectory(path: string): Promise<void> {
    const response = await this.#request('MKCOL', path);
    // 405 is "already a collection", which is success for an idempotent ensure.
    if (response.status === 405) {
      return;
    }
    this.#assertOk(response, 'create directory', path);
  }

  async #propfind(path: string, depth: '0' | '1'): Promise<FileMetadata[]> {
    const response = await this.#request('PROPFIND', path, {
      headers: { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
    if (response.status === 404) {
      return [];
    }
    this.#assertOk(response, 'list', path);
    return parsePropfind(await response.text());
  }

  #resolve(path: string): string {
    const relative = trimSlashes(path);
    const segments = [this.#folder, relative]
      .filter((segment) => segment.length > 0)
      .join('/');
    return new URL(
      segments.split('/').map(encodeURIComponent).join('/'),
      this.#baseUrl,
    ).toString();
  }

  async #request(
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      body?: string;
      retry?: boolean;
    } = {},
  ): Promise<Response> {
    const url = this.#resolve(path);
    const attempts = options.retry === false ? 1 : this.#maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#sendOnce(method, url, options.headers, options.body);
      } catch (error) {
        lastError = error;
        const isRetryable =
          error instanceof RemoteAccessError && error.isRetryable && attempt < attempts;
        if (!isRetryable) {
          throw error;
        }
        const backoffMs = 250 * 2 ** (attempt - 1);
        this.#logger.warn('Retrying WebDAV request', {
          method,
          attempt,
          backoffMs,
          reason: describeUnknownError(error),
        });
        await sleep(backoffMs);
      }
    }
    /* c8 ignore next -- the loop either returns or throws. */
    throw lastError;
  }

  async #sendOnce(
    method: string,
    url: string,
    headers: Record<string, string> | undefined,
    body: string | undefined,
  ): Promise<Response> {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Authorization', this.#basicAuth());
    // Nextcloud serves an HTML login page to browser-ish requests otherwise.
    requestHeaders.set('User-Agent', 'superproductivity-mcp');

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new RemoteAccessError(
        `Could not reach ${new URL(url).origin}: ${describeUnknownError(error)}`,
        { cause: error },
      );
    }

    if (isRedirect(response.status)) {
      return this.#followUpgrade(response, method, url, headers, body);
    }

    if (response.status === 401 || response.status === 403) {
      throw new RemoteAccessError(
        `Nextcloud rejected the credentials (HTTP ${response.status}). ` +
          'Check SP_NEXTCLOUD_USER and SP_NEXTCLOUD_PASSWORD. If two-factor ' +
          'authentication is on, you must use an app password rather than your ' +
          'login password.',
        { status: response.status },
      );
    }

    return response;
  }

  /**
   * Follows a redirect only when it is a same-host upgrade to HTTPS.
   *
   * Self-hosted Nextcloud commonly answers `http://` with a 307 to `https://`,
   * and honouring that keeps the server working when someone puts the plain URL
   * in `.env`. Every other redirect is refused: `fetch` would replay the HTTP
   * Basic credentials at the new destination, which is a credential leak if the
   * destination is not the host the operator configured.
   */
  async #followUpgrade(
    response: Response,
    method: string,
    url: string,
    headers: Record<string, string> | undefined,
    body: string | undefined,
  ): Promise<Response> {
    const location = response.headers.get('location');
    if (location === null) {
      throw new RemoteAccessError(
        `Server returned HTTP ${response.status} with no Location header.`,
        { status: response.status, isRetryable: false },
      );
    }

    const from = new URL(url);
    const to = new URL(location, url);
    const isSameHostHttpsUpgrade =
      to.hostname === from.hostname &&
      from.protocol === 'http:' &&
      to.protocol === 'https:';

    if (!isSameHostHttpsUpgrade) {
      throw new RemoteAccessError(
        `Refusing to follow a redirect from ${from.origin} to ${to.origin}: ` +
          'it would send your Nextcloud credentials to a different destination. ' +
          'Set SP_NEXTCLOUD_URL to the final URL instead.',
        { status: response.status, isRetryable: false },
      );
    }

    // Learn the upgrade so the rest of the session skips the extra round trip.
    if (this.#baseUrl.startsWith('http://')) {
      this.#baseUrl = `https://${this.#baseUrl.slice('http://'.length)}`;
      this.#logger.info('Upgraded to HTTPS after a server redirect', {
        baseUrl: this.#baseUrl,
      });
    }

    return this.#sendOnce(method, to.toString(), headers, body);
  }

  #basicAuth(): string {
    const encoded = Buffer.from(`${this.#username}:${this.#password}`).toString('base64');
    return `Basic ${encoded}`;
  }

  #assertOk(response: Response, action: string, path: string): void {
    if (response.ok) {
      return;
    }
    throw new RemoteAccessError(
      `Failed to ${action} ${this.#resolve(path)}: HTTP ${response.status} ${response.statusText}`,
      { status: response.status },
    );
  }
}

/**
 * Reads a validator usable in `If-Match`.
 *
 * `OC-ETag` wins because Nextcloud publishes it as the canonical value that
 * survives reverse proxies rewriting the plain `ETag`. Weak or malformed values
 * are dropped: sending one back produces a precondition the server evaluates
 * differently than we intend, which is worse than having no precondition and
 * knowing it.
 */
export const readStrongEtag = (headers: Headers): string | null => {
  for (const header of ['oc-etag', 'etag']) {
    const value = headers.get(header)?.trim();
    if (value !== undefined && value !== '' && STRONG_ETAG.test(value)) {
      return value;
    }
  }
  return null;
};

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:getlastmodified/>
    <d:getcontentlength/>
    <d:getetag/>
    <d:resourcetype/>
    <oc:getetag/>
  </d:prop>
</d:propfind>`;

const isRedirect = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

const ensureTrailingSlash = (url: string): string =>
  url.endsWith('/') ? url : `${url}/`;

const trimSlashes = (value: string): string => value.replace(/^\/+|\/+$/g, '');

/** Decoded, slash-trimmed path, so two spellings of one resource compare equal. */
const normalisePath = (value: string): string => {
  try {
    return trimSlashes(decodeURIComponent(value));
  } catch {
    /* c8 ignore next -- malformed percent-encoding: compare the raw form. */
    return trimSlashes(value);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the Nextcloud DAV root from a server URL and username.
 *
 * Mirrors `NextcloudProvider.buildBaseUrl` upstream, so a folder configured in
 * the desktop app resolves to the same place here.
 */
export const buildNextcloudBaseUrl = (serverUrl: string, userName: string): string => {
  const trimmed = serverUrl.trim().replace(/\/+$/, '');
  return `${trimmed}/remote.php/dav/files/${encodeURIComponent(userName.trim())}/`;
};
