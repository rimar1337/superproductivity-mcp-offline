import { createHash } from 'node:crypto';
import { ConcurrencyError, RemoteFileNotFoundError } from '../../src/domain/errors.js';
import type {
  FileMetadata,
  FileStore,
  StoredFile,
  WritePrecondition,
} from '../../src/domain/ports.js';

/**
 * An in-memory {@link FileStore} with real conditional-write semantics.
 *
 * This is what makes the integration suite worth running. It is not a stub that
 * records calls: it evaluates `If-Match` and `If-None-Match` exactly as a WebDAV
 * server does, so the retry loop, the lost-update protection and the backup
 * ordering are all exercised for real — deterministically, offline, in
 * milliseconds.
 *
 * The hooks below exist to reproduce the situations that are otherwise almost
 * impossible to stage: another device writing in the gap between our read and
 * our write, a server that offers no usable ETag, a backup write that fails.
 */
export class InMemoryFileStore implements FileStore {
  readonly #files = new Map<string, string>();
  readonly #directories = new Set<string>();

  /** Every call, in order. Lets a test assert *when* the backup was written. */
  readonly calls: { method: string; path: string }[] = [];

  /** Runs before each write, so a test can simulate a concurrent device. */
  beforeWrite: ((path: string) => void | Promise<void>) | null = null;

  /** When true, writes return no validator, as some WebDAV servers do. */
  omitRevisions = false;

  /** Paths whose writes should fail, to exercise degraded-but-safe behaviour. */
  readonly failWritesFor = new Set<string>();

  seed(path: string, content: string): void {
    this.#files.set(path, content);
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  contents(path: string): string | undefined {
    return this.#files.get(path);
  }

  get fileCount(): number {
    return this.#files.size;
  }

  revisionOf(path: string): string | null {
    const content = this.#files.get(path);
    return content === undefined ? null : etagFor(content);
  }

  read(path: string): Promise<StoredFile> {
    this.calls.push({ method: 'read', path });
    const content = this.#files.get(path);
    if (content === undefined) {
      return Promise.reject(new RemoteFileNotFoundError(path));
    }
    return Promise.resolve({
      content,
      rev: this.omitRevisions ? null : etagFor(content),
    });
  }

  stat(path: string): Promise<FileMetadata | null> {
    this.calls.push({ method: 'stat', path });
    const content = this.#files.get(path);
    if (content === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      name: path.split('/').pop() ?? path,
      path,
      size: Buffer.byteLength(content),
      lastModified: null,
      rev: this.omitRevisions ? null : etagFor(content),
      isDirectory: false,
    });
  }

  list(): Promise<FileMetadata[]> {
    this.calls.push({ method: 'list', path: '' });
    return Promise.all([...this.#files.keys()].map((path) => this.stat(path))).then(
      (entries) => entries.filter((entry): entry is FileMetadata => entry !== null),
    );
  }

  async write(
    path: string,
    content: string,
    precondition: WritePrecondition,
  ): Promise<{ rev: string | null }> {
    this.calls.push({ method: 'write', path });

    // Runs *before* the precondition is evaluated, which is exactly where a
    // real concurrent write lands: after our read, before our write commits.
    await this.beforeWrite?.(path);

    if (this.failWritesFor.has(path)) {
      throw new Error(`Simulated write failure for ${path}`);
    }

    const existing = this.#files.get(path);

    if (precondition.kind === 'create' && existing !== undefined) {
      throw new ConcurrencyError(`${path} already exists.`);
    }
    if (precondition.kind === 'match') {
      if (existing === undefined) {
        throw new ConcurrencyError(`${path} no longer exists.`);
      }
      if (etagFor(existing) !== precondition.rev) {
        throw new ConcurrencyError(`${path} changed since it was read.`);
      }
    }

    this.#files.set(path, content);
    return { rev: this.omitRevisions ? null : etagFor(content) };
  }

  delete(path: string): Promise<void> {
    this.calls.push({ method: 'delete', path });
    this.#files.delete(path);
    return Promise.resolve();
  }

  ensureDirectory(path: string): Promise<void> {
    this.calls.push({ method: 'ensureDirectory', path });
    this.#directories.add(path);
    return Promise.resolve();
  }
}

/** Content-addressed ETag, quoted like a real strong validator. */
const etagFor = (content: string): string =>
  `"${createHash('sha1').update(content).digest('hex')}"`;
