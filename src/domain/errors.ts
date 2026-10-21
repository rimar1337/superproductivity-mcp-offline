/**
 * The error taxonomy for the whole server.
 *
 * Every failure this system can produce is one of these, and the split is by
 * *what the caller should do about it*, not by which layer threw:
 *
 * - {@link ConfigurationError}  — the operator must fix `.env`. Never retry.
 * - {@link RemoteAccessError}   — the network or Nextcloud said no. Some retry.
 * - {@link SyncFormatError}     — the remote file is not what we can safely
 *                                 read or write. Never retry, never overwrite.
 * - {@link ConcurrencyError}    — someone else wrote first. Always retry.
 * - {@link NotFoundError}       — the requested entity does not exist.
 * - {@link ValidationError}     — the caller's input is wrong.
 * - {@link UnsafeOperationError} — we *could* do it, but doing it could lose
 *                                 the user's data, so we refuse.
 *
 * `isRetryable` is what the repository's retry loop keys off, so it lives on
 * the base class rather than in a lookup table that could drift from the types.
 */
export abstract class SuperProductivityMcpError extends Error {
  /** Machine-readable discriminator, surfaced to MCP clients. */
  abstract readonly code: string;

  /** Whether re-running the identical request could plausibly succeed. */
  readonly isRetryable: boolean = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    // Restores the prototype chain across the ES5 target downlevelling that
    // `extends Error` is famous for breaking, so `instanceof` stays reliable.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Missing or malformed configuration. The operator must intervene. */
export class ConfigurationError extends SuperProductivityMcpError {
  readonly code = 'CONFIGURATION_ERROR';
}

/**
 * The remote store could not be reached, or answered with an error.
 *
 * `status` is the HTTP status when there was one; its absence means the request
 * never got a reply (DNS, TLS, connection refused, timeout).
 */
export class RemoteAccessError extends SuperProductivityMcpError {
  readonly code: string = 'REMOTE_ACCESS_ERROR';
  override readonly isRetryable: boolean;
  readonly status: number | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; status?: number; isRetryable?: boolean },
  ) {
    super(message, options);
    this.status = options?.status;
    this.isRetryable =
      options?.isRetryable ??
      // No status at all means a transport failure, which is worth one more
      // try. With a status, only 5xx / 429 / 408 are worth repeating; a 401 or
      // 404 will answer identically forever.
      (options?.status === undefined
        ? true
        : options.status >= 500 || options.status === 429 || options.status === 408);
  }
}

/** The requested remote file does not exist. */
export class RemoteFileNotFoundError extends RemoteAccessError {
  override readonly code = 'REMOTE_FILE_NOT_FOUND';

  constructor(path: string, options?: { cause?: unknown }) {
    super(`Remote file not found: ${path}`, {
      ...options,
      status: 404,
      isRetryable: false,
    });
  }
}

/**
 * The remote sync file could not be decoded, or is a shape this version cannot
 * safely write to.
 *
 * This is deliberately fatal for writes. A sync file we do not fully understand
 * is a sync file we must not overwrite.
 */
export class SyncFormatError extends SuperProductivityMcpError {
  readonly code: string = 'SYNC_FORMAT_ERROR';
}

/** The sync file is encrypted and we have no key, or the key is wrong. */
export class DecryptionError extends SyncFormatError {
  override readonly code = 'DECRYPTION_ERROR';
}

/**
 * Another client wrote to the sync file between our read and our write.
 *
 * Always retryable, and the retry is not a blind repeat: the caller re-reads
 * the current remote state and re-applies its *intent* on top, so the other
 * client's changes survive.
 */
export class ConcurrencyError extends SuperProductivityMcpError {
  readonly code = 'CONCURRENCY_ERROR';
  override readonly isRetryable = true;
}

/** A referenced entity does not exist in the current state. */
export class NotFoundError extends SuperProductivityMcpError {
  readonly code = 'NOT_FOUND';
  readonly entityType: string;
  readonly entityId: string;

  constructor(entityType: string, entityId: string) {
    super(`${entityType} not found: ${entityId}`);
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

/** The caller supplied input that cannot be acted on. */
export class ValidationError extends SuperProductivityMcpError {
  readonly code = 'VALIDATION_ERROR';
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.details = details;
  }
}

/**
 * The operation is understood and possible, but performing it could destroy
 * data this server is not in a position to reconstruct.
 *
 * The canonical case is split-format compaction: rewriting the snapshot
 * requires replaying *every* operation type Super Productivity can emit, and we
 * faithfully model only the subset we ourselves produce. Rather than replay
 * them approximately and write the result as authoritative, we stop and tell
 * the user to open Super Productivity once.
 */
export class UnsafeOperationError extends SuperProductivityMcpError {
  readonly code = 'UNSAFE_OPERATION';
  readonly remedy: string;

  constructor(message: string, remedy: string) {
    super(message);
    this.remedy = remedy;
  }
}

/** Writes are disabled by configuration (`SP_MODE=read-only`). */
export class ReadOnlyModeError extends SuperProductivityMcpError {
  readonly code = 'READ_ONLY_MODE';

  constructor(attemptedOperation: string) {
    super(
      `Refusing "${attemptedOperation}": this server is running in read-only mode. ` +
        'Set SP_MODE=read-write to enable modifications.',
    );
  }
}

/** Calendar writes are disabled by configuration (`CALENDAR_MODE=read-only`). */
export class CalendarReadOnlyError extends SuperProductivityMcpError {
  readonly code = 'READ_ONLY_MODE';

  constructor(attemptedOperation: string) {
    super(
      `Refusing "${attemptedOperation}": calendar writes are disabled. ` +
        'Set CALENDAR_MODE=read-write to enable calendar modifications.',
    );
  }
}

/**
 * Narrows an unknown thrown value for logging and error mapping.
 *
 * Exists because `useUnknownInCatchVariables` is on, and every catch site would
 * otherwise repeat the same three-line dance.
 */
export const describeUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};
