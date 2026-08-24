/**
 * The boundary between decisions and I/O.
 *
 * Everything below the application layer talks to these interfaces, never to a
 * concrete WebDAV client, `Date.now()` or `crypto`. That is not architectural
 * decoration — it is what lets the integration suite run the *entire* sync
 * engine, including the conditional-write retry logic, against an in-memory
 * store with a frozen clock and deterministic ids, at unit-test speed and with
 * no network.
 */

/** A file plus the revision it was read at. */
export interface StoredFile {
  readonly content: string;
  /** Strong ETag. `null` when the server offered no usable validator. */
  readonly rev: string | null;
}

/** Metadata from a listing or existence check. */
export interface FileMetadata {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly lastModified: Date | null;
  readonly rev: string | null;
  readonly isDirectory: boolean;
}

/**
 * How a write should guard against clobbering a concurrent one.
 *
 * - `{ kind: 'create' }`   — the file must not exist (`If-None-Match: *`).
 * - `{ kind: 'match' }`    — the file must still be at `rev` (`If-Match`).
 * - `{ kind: 'overwrite' }` — unconditional. Reserved for backup copies and
 *   scratch files; never used on a primary sync file, because an unconditional
 *   write is exactly the thing that silently destroys another device's changes.
 */
export type WritePrecondition =
  | { readonly kind: 'create' }
  | { readonly kind: 'match'; readonly rev: string }
  | { readonly kind: 'overwrite' };

/**
 * A remote file store, scoped to one folder.
 *
 * Implementations must translate a failed precondition into a
 * {@link import('./errors.js').ConcurrencyError} and a missing file into a
 * {@link import('./errors.js').RemoteFileNotFoundError}, so callers never
 * inspect HTTP status codes.
 */
export interface FileStore {
  read(path: string): Promise<StoredFile>;
  /** Returns metadata, or `null` when the file does not exist. */
  stat(path: string): Promise<FileMetadata | null>;
  list(path?: string): Promise<FileMetadata[]>;
  write(
    path: string,
    content: string,
    precondition: WritePrecondition,
  ): Promise<{ rev: string | null }>;
  delete(path: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
}

/** Wall-clock time, injectable so tests can freeze it. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Local date as `YYYY-MM-DD`, which is how Super Productivity keys days. */
  today(): string;
}

/** Identifier minting, injectable so tests get deterministic ids. */
export interface IdGenerator {
  /** A 21-character nanoid, matching the ids Super Productivity mints. */
  entityId(): string;
  /** A UUID v7 — time-ordered, so the op log sorts by id. */
  operationId(): string;
}

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Structured logging.
 *
 * Implementations must write to stderr, never stdout: an MCP stdio server
 * speaks JSON-RPC on stdout, and one stray log line there corrupts the stream
 * and drops the connection.
 */
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}
