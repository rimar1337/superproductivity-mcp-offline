import { randomBytes, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Clock, IdGenerator, Logger, LogLevel } from '../../domain/ports.js';

/** Real wall-clock time. */
export const systemClock: Clock = {
  now: () => Date.now(),
  today: () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },
};

/**
 * Ids in exactly the shapes Super Productivity mints.
 *
 * Entities get a 21-character nanoid; operations get a UUID v7. The v7 part is
 * load-bearing rather than stylistic: operation ids are time-ordered, so the
 * log sorts chronologically by id alone, and a v4 id here would scatter our
 * operations through the ordering other clients rely on.
 */
export const systemIdGenerator: IdGenerator = {
  entityId: () => nanoid(),
  operationId: () => uuidV7(),
};

/**
 * UUID v7: 48-bit big-endian timestamp, 4-bit version, 74 bits of randomness.
 *
 * Hand-rolled because Node's `randomUUID` is v4-only. Falls back to it only if
 * the layout below could not be produced, which cannot currently happen but
 * keeps a bad id from ever being an unhandled crash.
 */
export const uuidV7 = (): string => {
  const timestamp = Date.now();
  const bytes = randomBytes(16);

  bytes.writeUIntBE(timestamp, 0, 6);
  // Version 7 in the high nibble of byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // RFC 4122 variant in the top two bits of byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');

  /* c8 ignore next 3 -- unreachable with a 16-byte buffer; a guard, not a path. */
  return uuid.length === 36 ? uuid : randomUUID();
};

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * A stderr-only structured logger.
 *
 * stdout is reserved absolutely: an MCP stdio server speaks JSON-RPC there, and
 * a single stray line corrupts the stream and drops the client connection. Every
 * write in this process goes to stderr for that reason.
 */
export const createLogger = (
  level: LogLevel,
  bindings: Record<string, unknown> = {},
): Logger => {
  const threshold = LEVEL_RANK[level];

  const emit = (
    severity: Exclude<LogLevel, 'silent'>,
    message: string,
    context?: Record<string, unknown>,
  ): void => {
    if (LEVEL_RANK[severity] > threshold) {
      return;
    }
    const entry = {
      time: new Date().toISOString(),
      level: severity,
      message,
      ...bindings,
      ...context,
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    error: (message, context): void => {
      emit('error', message, context);
    },
    warn: (message, context): void => {
      emit('warn', message, context);
    },
    info: (message, context): void => {
      emit('info', message, context);
    },
    debug: (message, context): void => {
      emit('debug', message, context);
    },
    child: (childBindings) => createLogger(level, { ...bindings, ...childBindings }),
  };
};
