import { listEntities } from '../../domain/model/entity-state.js';
import { NotFoundError } from '../../domain/errors.js';
import { getProject, getTag } from '../../domain/reducers/shared.js';
import {
  addProject,
  updateProject,
  type AddProjectInput,
  type UpdateProjectChanges,
} from '../../domain/reducers/project.js';
import {
  addTag,
  updateTag,
  type AddTagInput,
  type UpdateTagChanges,
} from '../../domain/reducers/tag.js';
import {
  buildOverview,
  toProjectView,
  toTagView,
  type Overview,
  type ProjectView,
  type TagView,
} from '../read-models.js';
import type { Clock } from '../../domain/ports.js';
import type { Workspace } from '../workspace.js';

/**
 * Projects, tags, and the overview that ties them together.
 *
 * Grouped in one service because they are the *organising* structures a caller
 * reaches for together — "what projects do I have, and what is in them" is one
 * question, not three.
 */
export class OrganiserService {
  constructor(
    private readonly workspace: Workspace,
    private readonly clock: Clock,
  ) {}

  async overview(): Promise<Overview> {
    const view = await this.workspace.read();
    return buildOverview(view.state, this.#context());
  }

  async listProjects(
    options: { includeArchived?: boolean } = {},
  ): Promise<ProjectView[]> {
    const view = await this.workspace.read();
    return listEntities(view.state.project)
      .filter((project) => options.includeArchived === true || !project.isArchived)
      .map((project) => toProjectView(project, view.state));
  }

  async createProject(
    input: AddProjectInput,
  ): Promise<{ project: ProjectView; syncVersion: number }> {
    const outcome = await this.workspace.mutate('create_project', (state, ctx) =>
      addProject(state, input, ctx),
    );
    const view = await this.workspace.read();
    const project = getProject(view.state, outcome.result.project.id);
    /* c8 ignore next 3 -- the project was just created in this same state. */
    if (project === undefined) {
      throw new NotFoundError('Project', outcome.result.project.id);
    }
    return {
      project: toProjectView(project, view.state),
      syncVersion: outcome.commit.syncVersion,
    };
  }

  async updateProject(
    projectId: string,
    changes: UpdateProjectChanges,
  ): Promise<{ project: ProjectView; syncVersion: number }> {
    const outcome = await this.workspace.mutate('update_project', (state, ctx) =>
      updateProject(state, projectId, changes, ctx),
    );
    const view = await this.workspace.read();
    const project = getProject(view.state, projectId);
    /* c8 ignore next 3 -- the project was just updated in this same state. */
    if (project === undefined) {
      throw new NotFoundError('Project', projectId);
    }
    return {
      project: toProjectView(project, view.state),
      syncVersion: outcome.commit.syncVersion,
    };
  }

  async listTags(): Promise<TagView[]> {
    const view = await this.workspace.read();
    return listEntities(view.state.tag).map(toTagView);
  }

  async createTag(input: AddTagInput): Promise<{ tag: TagView; syncVersion: number }> {
    const outcome = await this.workspace.mutate('create_tag', (state, ctx) =>
      addTag(state, input, ctx),
    );
    return {
      tag: toTagView(outcome.result.tag),
      syncVersion: outcome.commit.syncVersion,
    };
  }

  async updateTag(
    tagId: string,
    changes: UpdateTagChanges,
  ): Promise<{ tag: TagView; syncVersion: number }> {
    const outcome = await this.workspace.mutate('update_tag', (state, ctx) =>
      updateTag(state, tagId, changes, ctx),
    );
    const view = await this.workspace.read();
    const tag = getTag(view.state, tagId);
    /* c8 ignore next 3 -- the tag was just updated in this same state. */
    if (tag === undefined) {
      throw new NotFoundError('Tag', tagId);
    }
    return { tag: toTagView(tag), syncVersion: outcome.commit.syncVersion };
  }

  #context(): { today: string; now: number } {
    return { today: this.clock.today(), now: this.clock.now() };
  }
}
