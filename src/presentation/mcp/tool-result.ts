import {
  ConcurrencyError,
  ConfigurationError,
  DecryptionError,
  NotFoundError,
  ReadOnlyModeError,
  RemoteAccessError,
  SuperProductivityMcpError,
  SyncFormatError,
  UnsafeOperationError,
  ValidationError,
  describeUnknownError,
} from '../../domain/errors.js';
import type { Logger } from '../../domain/ports.js';

/**
 * Turning results and failures into something a language model can act on.
 *
 * The governing idea: **an error is a message to the model, not to a log.** A
 * tool that fails with "Request failed" leaves the model to guess, and it will
 * usually guess "retry", which is wrong for most of these. Every failure here
 * says what happened, whether anything changed, and what to do differently —
 * so the model's next move is informed rather than superstitious.
 */

export interface McpToolResult {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/** Serialises a successful payload. */
export const ok = (payload: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

export interface FailureShape {
  readonly error: string;
  readonly code: string;
  /** Whether the same call could succeed if repeated. */
  readonly retryable: boolean;
  /** Whether the user's data was left untouched. */
  readonly dataUnchanged: boolean;
  readonly nextStep?: string;
  readonly details?: readonly string[];
}

export const failure = (shape: FailureShape): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(shape, null, 2) }],
  isError: true,
});

/**
 * Maps a thrown value to a model-readable failure.
 *
 * `dataUnchanged` is stated explicitly on every branch rather than inferred,
 * because it is the single fact a model most needs after a failed write and can
 * least afford to guess. Every path through this server that can fail mid-write
 * fails *before* the conditional PUT, so nothing partial is ever committed —
 * but the model has no way to know that unless it is told.
 */
export const toFailure = (error: unknown, logger: Logger): McpToolResult => {
  if (error instanceof ValidationError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: false,
      dataUnchanged: true,
      nextStep: 'Correct the arguments and call the tool again.',
      ...(error.details.length > 0 ? { details: error.details } : {}),
    });
  }

  if (error instanceof NotFoundError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: false,
      dataUnchanged: true,
      nextStep: `List the available ${error.entityType.toLowerCase()}s to find the right id.`,
    });
  }

  if (error instanceof ReadOnlyModeError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: false,
      dataUnchanged: true,
      nextStep:
        'Tell the user this server is read-only. Only they can change SP_MODE and restart it.',
    });
  }

  if (error instanceof ConcurrencyError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: true,
      dataUnchanged: true,
      nextStep:
        'Another device was writing at the same time. Wait a moment and try once more.',
    });
  }

  if (error instanceof UnsafeOperationError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: false,
      dataUnchanged: true,
      nextStep: error.remedy,
    });
  }

  if (error instanceof DecryptionError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: false,
      dataUnchanged: true,
      nextStep:
        'Ask the user to check SP_ENCRYPTION_PASSWORD against the password set in ' +
        "Super Productivity's sync settings.",
    });
  }

  if (error instanceof SyncFormatError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: false,
      dataUnchanged: true,
      nextStep:
        'The remote file is not in a shape this server can safely use. Ask the user ' +
        'to open Super Productivity and let it sync once. Do not retry.',
    });
  }

  if (error instanceof RemoteAccessError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: error.isRetryable,
      dataUnchanged: true,
      nextStep: error.isRetryable
        ? 'Nextcloud is unreachable or busy. Try again shortly.'
        : 'Ask the user to check the Nextcloud URL and credentials in their .env file.',
    });
  }

  if (error instanceof ConfigurationError) {
    return failure({
      error: error.message,
      code: error.code,
      retryable: false,
      dataUnchanged: true,
      nextStep: 'Ask the user to fix their .env file and restart the server.',
    });
  }

  // Anything unclassified is a bug here. Log it in full for the operator, and
  // tell the model plainly rather than inventing a diagnosis.
  logger.error('Unhandled error in a tool handler', {
    error: describeUnknownError(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return failure({
    error:
      error instanceof SuperProductivityMcpError
        ? error.message
        : `Unexpected internal error: ${describeUnknownError(error)}`,
    code: 'INTERNAL_ERROR',
    retryable: false,
    dataUnchanged: true,
    nextStep:
      'This is a bug in the server, not something the arguments can fix. Report it ' +
      'to the user rather than retrying.',
  });
};

/** Wraps a handler so no exception escapes into the MCP transport. */
export const guarded =
  <TArgs>(logger: Logger, handler: (args: TArgs) => Promise<McpToolResult>) =>
  async (args: TArgs): Promise<McpToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return toFailure(error, logger);
    }
  };
