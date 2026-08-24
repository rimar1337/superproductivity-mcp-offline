/**
 * Vector clocks — the causality layer this server has to speak correctly to be
 * accepted as a peer rather than treated as corruption.
 *
 * A vector clock maps each client id to a counter. `{A: 5, B: 3}` means "this
 * state includes A's first 5 operations and B's first 3". Comparing two clocks
 * answers "did this client already know about that change?" without trusting
 * wall-clock time, which drifts between a phone, a laptop and this server.
 *
 * This is a faithful port of `packages/sync-core/src/vector-clock.ts` in
 * Super Productivity. The algorithms must agree exactly: a disagreement does
 * not show up as an error, it shows up as the desktop app deciding our
 * perfectly good write is a conflict — or worse, silently winning over it.
 *
 * @see https://github.com/johannesjo/super-productivity/blob/master/docs/sync-and-op-log/vector-clocks.md
 */

export type VectorClock = Record<string, number>;

export const VectorClockComparison = {
  EQUAL: 'EQUAL',
  LESS_THAN: 'LESS_THAN',
  GREATER_THAN: 'GREATER_THAN',
  CONCURRENT: 'CONCURRENT',
} as const;

export type VectorClockComparison =
  (typeof VectorClockComparison)[keyof typeof VectorClockComparison];

/**
 * Upstream's cap on clock entries. Reaching it needs 21+ distinct client ids,
 * so in practice it never fires for one person's devices — but the constant has
 * to match, because a clock we prune differently is a clock upstream reads
 * differently.
 */
export const MAX_VECTOR_CLOCK_SIZE = 20;

/**
 * Guard against counter overflow. Upstream throws rather than wrapping, because
 * a wrapped counter reads as "this client went backwards in time" and poisons
 * every subsequent comparison.
 */
const MAX_SAFE_CLOCK_VALUE = Number.MAX_SAFE_INTEGER - 1_000_000;

/**
 * Compares two clocks. Missing keys count as a genuine zero.
 *
 * `CONCURRENT` is the interesting answer: neither side saw the other, which is
 * a real conflict rather than an ordering.
 */
export const compareVectorClocks = (
  a: VectorClock,
  b: VectorClock,
): VectorClockComparison => {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let aGreater = false;
  let bGreater = false;

  for (const key of allKeys) {
    const aVal = a[key] ?? 0;
    const bVal = b[key] ?? 0;
    if (aVal > bVal) {
      aGreater = true;
    }
    if (bVal > aVal) {
      bGreater = true;
    }
    if (aGreater && bGreater) {
      return VectorClockComparison.CONCURRENT;
    }
  }

  if (aGreater) {
    return VectorClockComparison.GREATER_THAN;
  }
  if (bGreater) {
    return VectorClockComparison.LESS_THAN;
  }
  return VectorClockComparison.EQUAL;
};

/** Per-key maximum of both clocks: a new clock that dominates each input. */
export const mergeVectorClocks = (a: VectorClock, b: VectorClock): VectorClock => {
  const merged: VectorClock = { ...a };
  for (const [key, value] of Object.entries(b)) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return merged;
};

/**
 * Returns a copy of `clock` with `clientId`'s counter advanced by one.
 *
 * This is what makes a write causally *newer* than everything it was derived
 * from, which is precisely what earns it a `GREATER_THAN` — and therefore an
 * acceptance — on every other client.
 */
export const incrementVectorClock = (
  clock: VectorClock,
  clientId: string,
): VectorClock => {
  const current = clock[clientId] ?? 0;
  if (current >= MAX_SAFE_CLOCK_VALUE) {
    throw new RangeError(
      `Vector clock overflow for client "${clientId}". ` +
        'Recovery requires a full re-import from Super Productivity.',
    );
  }
  return { ...clock, [clientId]: current + 1 };
};

/**
 * Caps a clock at {@link MAX_VECTOR_CLOCK_SIZE}, always keeping
 * `preserveClientIds` and then the highest counters.
 *
 * Order matters and is not cosmetic: dropping a client id is permanent, because
 * nothing ever re-invents an absent entry.
 */
export const limitVectorClockSize = (
  clock: VectorClock,
  preserveClientIds: readonly string[] = [],
): VectorClock => {
  const entries = Object.entries(clock);
  if (entries.length <= MAX_VECTOR_CLOCK_SIZE) {
    return clock;
  }

  const result: VectorClock = {};
  for (const clientId of preserveClientIds) {
    if (Object.keys(result).length >= MAX_VECTOR_CLOCK_SIZE) {
      break;
    }
    const value = clock[clientId];
    if (value !== undefined) {
      result[clientId] = value;
    }
  }

  const remaining = entries
    .filter(([clientId]) => !Object.prototype.hasOwnProperty.call(result, clientId))
    .sort(([, left], [, right]) => right - left);

  for (const [clientId, value] of remaining) {
    if (Object.keys(result).length >= MAX_VECTOR_CLOCK_SIZE) {
      break;
    }
    result[clientId] = value;
  }

  return result;
};

/** True when `clock` has no entries — an uninitialised or reset state. */
export const isEmptyVectorClock = (clock: VectorClock): boolean =>
  Object.keys(clock).length === 0;
