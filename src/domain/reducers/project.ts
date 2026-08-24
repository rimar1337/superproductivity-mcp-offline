import { addOne } from '../model/entity-state.js';
import type { AppState, Project } from '../model/app-state.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { EMITTED_ACTION_CODE } from '../sync/action-codes.js';
import { EntityType, type MutationResult, OpType } from '../sync/operation.js';
import type { ReducerContext } from './context.js';
import { getProject, updateProject as patchProject } from './shared.js';
import { defaultAdvancedConfig, defaultTheme } from './defaults.js';

export interface AddProjectInput {
  readonly title: string;
  /** Hex colour for the project theme, e.g. `#26c6da`. */
  readonly color?: string;
  readonly icon?: string;
  readonly isEnableBacklog?: boolean;
}

export interface ProjectMutationResult extends MutationResult<AppState> {
  readonly project: Project;
}

/**
 * Creates a project.
 *
 * Emits two operations, not one, because that is what a single "new project"
 * gesture emits in Super Productivity: `PA` creates the entity, and `MP`
 * appends it to the sidebar's menu tree. Emitting only `PA` produces a project
 * that exists but never appears in the sidebar on the user's other devices —
 * the kind of half-created state that reads as a bug in Super Productivity
 * rather than in this server.
 */
export const addProject = (
  state: AppState,
  input: AddProjectInput,
  ctx: ReducerContext,
): ProjectMutationResult => {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new ValidationError('Project title must not be empty.');
  }

  const id = ctx.ids.entityId();
  const project: Project = {
    id,
    title,
    taskIds: [],
    backlogTaskIds: [],
    noteIds: [],
    isArchived: false,
    isHiddenFromMenu: false,
    isEnableBacklog: input.isEnableBacklog ?? false,
    isDone: false,
    doneOn: null,
    icon: input.icon ?? null,
    theme: defaultTheme(input.color),
    advancedCfg: defaultAdvancedConfig(),
  };

  const next: AppState = { ...state, project: addOne(state.project, id, project) };
  const menuTree = readProjectTree(next);
  const nextTree = [...menuTree, { k: 'p', id, projectId: id }];

  const withMenu: AppState = {
    ...next,
    menuTree: {
      ...(typeof next['menuTree'] === 'object' && next['menuTree'] !== null
        ? next['menuTree']
        : {}),
      projectTree: nextTree,
    },
  };

  const createOp = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.projectAdd,
    opType: OpType.Create,
    entityType: EntityType.Project,
    entityId: id,
    actionPayload: { project },
  });

  const menuOp = ctx.operations.create({
    actionCode: 'MP',
    opType: OpType.Update,
    entityType: EntityType.MenuTree,
    entityId: 'projectTree',
    actionPayload: { tree: nextTree },
  });

  return { state: withMenu, operations: [createOp, menuOp], project };
};

export interface UpdateProjectChanges {
  readonly title?: string;
  readonly isArchived?: boolean;
  readonly isHiddenFromMenu?: boolean;
  readonly isEnableBacklog?: boolean;
}

/** Patches a project. */
export const updateProject = (
  state: AppState,
  projectId: string,
  changes: UpdateProjectChanges,
  ctx: ReducerContext,
): ProjectMutationResult => {
  const current = getProject(state, projectId);
  if (current === undefined) {
    throw new NotFoundError('Project', projectId);
  }

  const applied: Partial<Project> = {};
  if (changes.title !== undefined) {
    const title = changes.title.trim();
    if (title.length === 0) {
      throw new ValidationError('Project title must not be empty.');
    }
    applied.title = title;
  }
  if (changes.isArchived !== undefined) {
    applied.isArchived = changes.isArchived;
  }
  if (changes.isHiddenFromMenu !== undefined) {
    applied.isHiddenFromMenu = changes.isHiddenFromMenu;
  }
  if (changes.isEnableBacklog !== undefined) {
    applied.isEnableBacklog = changes.isEnableBacklog;
  }

  if (Object.keys(applied).length === 0) {
    throw new ValidationError('No project fields to update.');
  }

  const next = patchProject(state, projectId, applied);
  const operation = ctx.operations.create({
    actionCode: EMITTED_ACTION_CODE.projectUpdate,
    opType: OpType.Update,
    entityType: EntityType.Project,
    entityId: projectId,
    actionPayload: { project: { id: projectId, changes: applied } },
  });

  const updated = getProject(next, projectId);
  /* c8 ignore next 3 -- unreachable: patching cannot remove an existing project. */
  if (updated === undefined) {
    throw new NotFoundError('Project', projectId);
  }
  return { state: next, operations: [operation], project: updated };
};

/**
 * Reads the sidebar's project tree, tolerating its absence.
 *
 * Real sync files contain projects that are not in the tree at all, so the tree
 * is treated as ordering hints rather than as the authoritative project list.
 */
const readProjectTree = (
  state: AppState,
): { k: string; id: string; projectId: string }[] => {
  const menuTree = state['menuTree'];
  if (typeof menuTree !== 'object' || menuTree === null) {
    return [];
  }
  const tree = (menuTree as Record<string, unknown>)['projectTree'];
  return Array.isArray(tree)
    ? (tree as { k: string; id: string; projectId: string }[])
    : [];
};
