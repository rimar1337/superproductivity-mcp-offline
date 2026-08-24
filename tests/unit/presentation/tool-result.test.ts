import { describe, expect, it } from 'vitest';
import {
  ConcurrencyError,
  ConfigurationError,
  DecryptionError,
  NotFoundError,
  ReadOnlyModeError,
  RemoteAccessError,
  SyncFormatError,
  UnsafeOperationError,
  ValidationError,
} from '../../../src/domain/errors.js';
import { guarded, ok, toFailure } from '../../../src/presentation/mcp/tool-result.js';
import { silentLogger } from '../../support/fakes.js';

/**
 * Error mapping is a user-facing feature here, not plumbing.
 *
 * A model that reads "request failed" will guess "retry", and that guess is
 * wrong for most failures this server can produce. Every branch therefore
 * states two things the model cannot infer: whether the data changed, and
 * whether repeating the call could help.
 */

const body = (result: { content: { text: string }[] }): Record<string, unknown> =>
  JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

const logger = silentLogger();

describe('ok', () => {
  it('serialises a payload as readable JSON', () => {
    const result = ok({ hello: 'world' });
    expect(result.isError).toBeUndefined();
    expect(body(result)['hello']).toBe('world');
  });
});

describe('toFailure', () => {
  it.each([
    [new ValidationError('bad input'), 'VALIDATION_ERROR', false],
    [new NotFoundError('Task', 't1'), 'NOT_FOUND', false],
    [new ReadOnlyModeError('create_task'), 'READ_ONLY_MODE', false],
    [new ConcurrencyError('lost the race'), 'CONCURRENCY_ERROR', true],
    [new UnsafeOperationError('cannot', 'do this instead'), 'UNSAFE_OPERATION', false],
    [new DecryptionError('wrong key'), 'DECRYPTION_ERROR', false],
    [new SyncFormatError('bad file'), 'SYNC_FORMAT_ERROR', false],
    [new ConfigurationError('missing url'), 'CONFIGURATION_ERROR', false],
  ])('maps %s to a coded, actionable failure', (error, code, retryable) => {
    const result = toFailure(error, logger);
    const shape = body(result);

    expect(result.isError).toBe(true);
    expect(shape['code']).toBe(code);
    expect(shape['retryable']).toBe(retryable);
    // Every failure path in this server stops before the conditional write.
    expect(shape['dataUnchanged']).toBe(true);
    expect(String(shape['nextStep'] ?? '')).not.toBe('');
  });

  it('passes a validation error’s details through', () => {
    const result = toFailure(new ValidationError('nope', ['try this instead']), logger);
    expect(body(result)['details']).toEqual(['try this instead']);
  });

  it('carries the remedy from an unsafe operation', () => {
    const result = toFailure(
      new UnsafeOperationError('log is full', 'Open the app and let it sync.'),
      logger,
    );
    expect(body(result)['nextStep']).toBe('Open the app and let it sync.');
  });

  it('distinguishes a retryable remote failure from a permanent one', () => {
    const transient = body(
      toFailure(new RemoteAccessError('busy', { status: 503 }), logger),
    );
    expect(transient['retryable']).toBe(true);
    expect(String(transient['nextStep'])).toContain('Try again');

    const permanent = body(
      toFailure(new RemoteAccessError('nope', { status: 401 }), logger),
    );
    expect(permanent['retryable']).toBe(false);
    expect(String(permanent['nextStep'])).toContain('credentials');
  });

  it('tells the model not to retry an unclassified failure', () => {
    // An unknown error is a bug here; retrying it just burns turns.
    const shape = body(toFailure(new Error('kaboom'), logger));
    expect(shape['code']).toBe('INTERNAL_ERROR');
    expect(shape['retryable']).toBe(false);
    expect(String(shape['nextStep'])).toContain('bug in the server');
  });

  it('handles a thrown non-Error without losing the message', () => {
    expect(String(body(toFailure('a bare string', logger))['error'])).toContain(
      'a bare string',
    );
  });
});

describe('guarded', () => {
  it('passes a successful result through untouched', async () => {
    const handler = guarded(logger, () => Promise.resolve(ok({ done: true })));
    expect(body(await handler(undefined))['done']).toBe(true);
  });

  it('converts a thrown error instead of letting it reach the transport', async () => {
    // An exception escaping into the MCP transport is a dropped connection.
    const handler = guarded(logger, () =>
      Promise.reject(new NotFoundError('Task', 'missing')),
    );
    const result = await handler(undefined);
    expect(result.isError).toBe(true);
    expect(body(result)['code']).toBe('NOT_FOUND');
  });
});
