import { addOne } from '../model/entity-state.js';
import { type AppState, type Tag, TODAY_TAG_ID } from '../model/app-state.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { EMITTED_ACTION_CODE } from '../sync/action-codes.js';
import { EntityType, type MutationResult, OpType } from '../sync/operation.js';
import type { ReducerContext } from './context.js';
import { getTag, updateTags } from './shared.js';
import {
  defaultAdvancedConfig,
  DEFAULT_PRIMARY_COLOR,
  defaultTheme,
} from './defaults.js';

export interface AddTagInput {
  readonly title: string;
  /** Hex colour, e.g. `#ef5350`. */
  readonly color?: string;
  readonly icon?: string;
}

export interface TagMutationResult extends MutationResult<AppState> {
  readonly tag: Tag;
}

/** Creates a tag. */
export const addTag = (
  state: AppState,
  input: AddTagInput,
  ctx: ReducerContext,
): TagMutationResult => {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new ValidationError('Tag title must not be empty.');
  }

  const duplicate = state.tag.ids
    .map((id) => getTag(state, id))
    .find((tag) => tag?.title.toLowerCase() === title.toLowerCase());
  if (duplicate !== undefined) {
    throw new ValidationError(
      `A tag named "${duplicate.title}" already exists (id ${duplicate.id}).`,
      ['Reuse the existing tag, or pick a different title.'],
    );
  }

  const id = ctx.ids.entityId();
  const color = input.color ?? DEFAULT_PRIMARY_COLOR;
  const tag: Tag = {
    id,
    title,
    taskIds: [],
    created: ctx.now,
    color,
    icon: input.icon ?? null,
    theme: defaultTheme(color),
    advancedCfg: defaultAdvancedConfig(),
  };

  const next: AppState = { ...state, tag: addOne(state.tag, id, tag) };
  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.tagAdd,
    opType: OpType.Create,
    entityType: EntityType.Tag,
    entityId: id,
    actionPayload: { tag },
  });

  return { state: next, operations: [operation], tag };
};

export interface UpdateTagChanges {
  readonly title?: string;
  readonly color?: string;
  readonly icon?: string;
}

/**
 * Patches a tag.
 *
 * Refuses to touch `TODAY`. It is a virtual tag whose membership Super
 * Productivity derives from task due dates; editing it here would write a
 * concrete tag over a computed one.
 */
export const updateTag = (
  state: AppState,
  tagId: string,
  changes: UpdateTagChanges,
  ctx: ReducerContext,
): TagMutationResult => {
  if (tagId === TODAY_TAG_ID) {
    throw new ValidationError(
      'The "Today" tag is virtual and cannot be edited. Its membership follows task due dates.',
    );
  }

  const current = getTag(state, tagId);
  if (current === undefined) {
    throw new NotFoundError('Tag', tagId);
  }

  const applied: Partial<Tag> = {};
  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (title.length === 0) {
      throw new ValidationError('Tag title must not be empty.');
    }
    applied.title = title;
  }
  if (changes.color !== undefined) {
    applied.color = changes.color;
    applied.theme = defaultTheme(changes.color);
  }
  if (changes.icon !== undefined) {
    applied.icon = changes.icon;
  }

  if (Object.keys(applied).length === 0) {
    throw new ValidationError('No tag fields to update.');
  }

  const next = updateTags(state, [{ id: tagId, changes: applied }]);
  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.tagUpdate,
    opType: OpType.Update,
    entityType: EntityType.Tag,
    entityId: tagId,
    actionPayload: { tag: { id: tagId, changes: applied } },
  });

  const updated = getTag(next, tagId);
  /* c8 ignore next 3 -- unreachable: patching cannot remove an existing tag. */
  if (updated === undefined) {
    throw new NotFoundError('Tag', tagId);
  }
  return { state: next, operations: [operation], tag: updated };
};
