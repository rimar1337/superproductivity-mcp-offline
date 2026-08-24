import { describe, expect, it } from 'vitest';
import {
  compareVectorClocks,
  incrementVectorClock,
  isEmptyVectorClock,
  limitVectorClockSize,
  MAX_VECTOR_CLOCK_SIZE,
  mergeVectorClocks,
  VectorClockComparison,
} from '../../../src/domain/sync/vector-clock.js';

describe('compareVectorClocks', () => {
  it('reports EQUAL for identical clocks', () => {
    expect(compareVectorClocks({ A: 1, B: 2 }, { A: 1, B: 2 })).toBe(
      VectorClockComparison.EQUAL,
    );
  });

  it('treats a missing key as a genuine zero rather than as unknown', () => {
    // This is the rule that lets a brand-new client be recognised as behind
    // rather than as concurrent with everyone.
    expect(compareVectorClocks({ A: 1 }, {})).toBe(VectorClockComparison.GREATER_THAN);
    expect(compareVectorClocks({}, { A: 1 })).toBe(VectorClockComparison.LESS_THAN);
  });

  it('reports GREATER_THAN when one clock dominates', () => {
    expect(compareVectorClocks({ A: 3, B: 2 }, { A: 2, B: 2 })).toBe(
      VectorClockComparison.GREATER_THAN,
    );
  });

  it('reports CONCURRENT when each side saw something the other did not', () => {
    // The genuine-conflict case: A edited without seeing B, B without seeing A.
    expect(compareVectorClocks({ A: 2, B: 1 }, { A: 1, B: 2 })).toBe(
      VectorClockComparison.CONCURRENT,
    );
  });

  it('treats two empty clocks as equal', () => {
    expect(compareVectorClocks({}, {})).toBe(VectorClockComparison.EQUAL);
  });
});

describe('mergeVectorClocks', () => {
  it('takes the per-key maximum', () => {
    expect(mergeVectorClocks({ A: 3, B: 1 }, { B: 5, C: 2 })).toEqual({
      A: 3,
      B: 5,
      C: 2,
    });
  });

  it('produces a clock that dominates both inputs', () => {
    const a = { A: 2, B: 1 };
    const b = { A: 1, B: 2 };
    const merged = mergeVectorClocks(a, b);
    expect(compareVectorClocks(merged, a)).toBe(VectorClockComparison.GREATER_THAN);
    expect(compareVectorClocks(merged, b)).toBe(VectorClockComparison.GREATER_THAN);
  });

  it('does not mutate its inputs', () => {
    const a = { A: 1 };
    const b = { B: 1 };
    mergeVectorClocks(a, b);
    expect(a).toEqual({ A: 1 });
    expect(b).toEqual({ B: 1 });
  });
});

describe('incrementVectorClock', () => {
  it('starts an unseen client at one', () => {
    expect(incrementVectorClock({ A: 5 }, 'B')).toEqual({ A: 5, B: 1 });
  });

  it('produces a clock that strictly dominates the original', () => {
    // This is the whole point: it is what earns our write a GREATER_THAN, and
    // therefore an acceptance, on every other device.
    const before = { A: 5, B: 3 };
    const after = incrementVectorClock(before, 'B');
    expect(compareVectorClocks(after, before)).toBe(VectorClockComparison.GREATER_THAN);
  });

  it('throws rather than wrapping near the safe-integer ceiling', () => {
    // A wrapped counter reads as the client travelling backwards in time and
    // poisons every later comparison, so failing loudly is the safe answer.
    expect(() => incrementVectorClock({ A: Number.MAX_SAFE_INTEGER }, 'A')).toThrow(
      RangeError,
    );
  });
});

describe('limitVectorClockSize', () => {
  const oversized = Object.fromEntries(
    Array.from({ length: MAX_VECTOR_CLOCK_SIZE + 5 }, (_, i) => [`C${i}`, i]),
  );

  it('leaves a clock at or under the cap untouched', () => {
    const small = { A: 1, B: 2 };
    expect(limitVectorClockSize(small)).toBe(small);
  });

  it('caps an oversized clock at the maximum', () => {
    expect(Object.keys(limitVectorClockSize(oversized))).toHaveLength(
      MAX_VECTOR_CLOCK_SIZE,
    );
  });

  it('keeps preserved clients even when their counters are lowest', () => {
    // Dropping a client id is permanent — nothing ever re-invents an absent
    // entry — so the preserve set has to win over the counter ranking.
    const result = limitVectorClockSize(oversized, ['C0']);
    expect(result['C0']).toBe(0);
  });

  it('fills the remaining slots with the highest counters', () => {
    const result = limitVectorClockSize(oversized, []);
    const highest = MAX_VECTOR_CLOCK_SIZE + 4;
    expect(result[`C${highest}`]).toBe(highest);
    expect(result['C0']).toBeUndefined();
  });

  it('ignores preserved ids that are not in the clock', () => {
    const result = limitVectorClockSize(oversized, ['nonexistent']);
    expect(Object.keys(result)).toHaveLength(MAX_VECTOR_CLOCK_SIZE);
    expect(result['nonexistent']).toBeUndefined();
  });
});

describe('isEmptyVectorClock', () => {
  it('distinguishes an empty clock from a populated one', () => {
    expect(isEmptyVectorClock({})).toBe(true);
    expect(isEmptyVectorClock({ A: 0 })).toBe(false);
  });
});
