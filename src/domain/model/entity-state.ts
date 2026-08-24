/**
 * Super Productivity persists every collection as an NgRx `EntityState`: an
 * ordered `ids` array plus an `entities` lookup. Order is meaningful (it is the
 * user's manual ordering), so it is never derived from the lookup.
 *
 * These helpers are the *only* place that shape is manipulated. Doing it inline
 * is how `ids` and `entities` drift apart, which Super Productivity reports as a
 * corrupt database and "repairs" by duplicating tasks.
 */
export interface EntityState<T> {
  ids: string[];
  entities: Record<string, T>;
}

export const emptyEntityState = <T>(): EntityState<T> => ({ ids: [], entities: {} });

/**
 * Reads an entity, or `undefined` when absent.
 *
 * Deliberately tolerant of an id present in `ids` but missing from `entities`:
 * that inconsistency exists in real sync files and must not throw on a read.
 */
export const getEntity = <T>(state: EntityState<T>, id: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(state.entities, id)
    ? state.entities[id]
    : undefined;

/** All entities in `ids` order, skipping ids with no matching entity. */
export const listEntities = <T>(state: EntityState<T>): T[] => {
  const result: T[] = [];
  for (const id of state.ids) {
    const entity = getEntity(state, id);
    if (entity !== undefined) {
      result.push(entity);
    }
  }
  return result;
};

/**
 * Adds one entity. Mirrors NgRx `addOne`: an id that already exists is a no-op,
 * which matters during operation replay where the same op can arrive twice.
 *
 * Generic over the *slice*, not just the entity, so sibling fields that live
 * alongside `ids`/`entities` — `currentTaskId`, `selectedTaskId`,
 * `isDataLoaded`, and anything a future release adds — are carried through
 * rather than dropped. A helper that returned a bare `{ ids, entities }` would
 * quietly delete the user's currently-running timer on every task insert.
 */
export const addOne = <T, TSlice extends EntityState<T>>(
  state: TSlice,
  id: string,
  entity: T,
  position: 'top' | 'bottom' = 'bottom',
): TSlice => {
  if (Object.prototype.hasOwnProperty.call(state.entities, id)) {
    return state;
  }
  return {
    ...state,
    ids: position === 'bottom' ? [...state.ids, id] : [id, ...state.ids],
    entities: { ...state.entities, [id]: entity },
  };
};

/**
 * Shallow-merges `changes` into an existing entity. Mirrors NgRx `updateOne`:
 * updating an absent id is a no-op rather than an insert.
 *
 * The merge is a spread, so every field this codebase does not model — future
 * Super Productivity fields, plugin data, issue-integration metadata — survives
 * the round trip untouched.
 */
export const updateOne = <T extends object, TSlice extends EntityState<T>>(
  state: TSlice,
  id: string,
  changes: Partial<T>,
): TSlice => {
  const existing = getEntity(state, id);
  if (existing === undefined) {
    return state;
  }
  return {
    ...state,
    entities: { ...state.entities, [id]: { ...existing, ...changes } },
  };
};

/** Applies {@link updateOne} for each entry, in order. */
export const updateMany = <T extends object, TSlice extends EntityState<T>>(
  state: TSlice,
  updates: readonly { id: string; changes: Partial<T> }[],
): TSlice =>
  updates.reduce<TSlice>(
    (acc, update) => updateOne<T, TSlice>(acc, update.id, update.changes),
    state,
  );

/** Removes entities, dropping them from both `ids` and `entities`. */
export const removeMany = <T, TSlice extends EntityState<T>>(
  state: TSlice,
  ids: readonly string[],
): TSlice => {
  const toRemove = new Set(ids);
  if (toRemove.size === 0) {
    return state;
  }
  const entities: Record<string, T> = {};
  for (const [key, value] of Object.entries(state.entities)) {
    if (!toRemove.has(key)) {
      entities[key] = value;
    }
  }
  return { ...state, ids: state.ids.filter((id) => !toRemove.has(id)), entities };
};

/** Removes duplicates while preserving first-seen order. */
export const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** Inserts `id` into an ordered list, at either end, without duplicating it. */
export const addIdToList = (
  list: readonly string[],
  id: string,
  toBottom: boolean,
): string[] => unique(toBottom ? [...list, id] : [id, ...list]);

/** Drops every id in `idsToRemove` from an ordered list. */
export const removeIdsFromList = (
  list: readonly string[],
  idsToRemove: readonly string[],
): string[] => {
  const toRemove = new Set(idsToRemove);
  return list.filter((id) => !toRemove.has(id));
};
