import { describe, expect, it } from 'vitest';
import { addProject, updateProject } from '../../../src/domain/reducers/project.js';
import { addTag, updateTag } from '../../../src/domain/reducers/tag.js';
import { NotFoundError, ValidationError } from '../../../src/domain/errors.js';
import { makeContext, makeProject, makeState, makeTag } from '../../support/fakes.js';

describe('addProject', () => {
  it('emits both operations a "new project" gesture emits upstream', () => {
    // PA alone creates a project that never appears in the sidebar on the
    // user's other devices — a half-created state that reads as a bug in
    // Super Productivity rather than in this server.
    const { operations } = addProject(makeState(), { title: 'Kitchen' }, makeContext());
    expect(operations.map((op) => op.a)).toEqual(['PA', 'MP']);
  });

  it('appends the project to the sidebar tree', () => {
    const { state, project } = addProject(
      makeState(),
      { title: 'Kitchen' },
      makeContext(),
    );
    const tree = (state['menuTree'] as { projectTree: { projectId: string }[] })
      .projectTree;
    expect(tree).toEqual([{ k: 'p', id: project.id, projectId: project.id }]);
  });

  it('preserves an existing tree rather than replacing it', () => {
    const base = makeState({
      extraSlices: {
        menuTree: {
          projectTree: [{ k: 'p', id: 'existing', projectId: 'existing' }],
          tagTree: [{ k: 't', id: 'EM_IMPORTANT' }],
        },
      },
    });
    const { state } = addProject(base, { title: 'Second' }, makeContext());
    const menuTree = state['menuTree'] as {
      projectTree: unknown[];
      tagTree: unknown[];
    };
    expect(menuTree.projectTree).toHaveLength(2);
    expect(menuTree.tagTree).toHaveLength(1);
  });

  it('ships a complete entity, so the app never reads an undefined field', () => {
    // The desktop app reads advancedCfg and theme without guarding; a project
    // missing them throws when the user opens the worklog export dialog.
    const { project } = addProject(makeState(), { title: 'Kitchen' }, makeContext());
    expect(project.advancedCfg).toMatchObject({
      worklogExportSettings: expect.anything(),
    });
    expect(project.theme).toMatchObject({ primary: expect.any(String) });
    expect(project.taskIds).toEqual([]);
    expect(project.backlogTaskIds).toEqual([]);
  });

  it('applies a requested colour to the theme', () => {
    const { project } = addProject(
      makeState(),
      { title: 'Kitchen', color: '#ff0000' },
      makeContext(),
    );
    expect((project.theme as { primary: string }).primary).toBe('#ff0000');
  });

  it('rejects an empty title', () => {
    expect(() => addProject(makeState(), { title: '  ' }, makeContext())).toThrow(
      ValidationError,
    );
  });
});

describe('updateProject', () => {
  const base = () =>
    makeState({ projects: [makeProject({ id: 'p1', title: 'Before' })] });

  it('sends only the changed fields', () => {
    const { operations, project } = updateProject(
      base(),
      'p1',
      { title: 'After' },
      makeContext(),
    );
    expect(project.title).toBe('After');
    expect(operations[0]?.p.actionPayload).toEqual({
      project: { id: 'p1', changes: { title: 'After' } },
    });
  });

  it('archives without deleting anything', () => {
    const withTasks = makeState({
      projects: [makeProject({ id: 'p1', title: 'P', taskIds: ['t1'] })],
    });
    const { project } = updateProject(
      withTasks,
      'p1',
      { isArchived: true },
      makeContext(),
    );
    expect(project.isArchived).toBe(true);
    expect(project.taskIds).toEqual(['t1']);
  });

  it('rejects an unknown project', () => {
    expect(() => updateProject(base(), 'nope', { title: 'x' }, makeContext())).toThrow(
      NotFoundError,
    );
  });

  it('rejects an empty change set rather than emitting a no-op operation', () => {
    expect(() => updateProject(base(), 'p1', {}, makeContext())).toThrow(ValidationError);
  });

  it('rejects an empty title', () => {
    expect(() => updateProject(base(), 'p1', { title: ' ' }, makeContext())).toThrow(
      ValidationError,
    );
  });
});

describe('addTag', () => {
  it('creates a complete tag entity', () => {
    const { tag, operations } = addTag(
      makeState(),
      { title: 'Errands', color: '#ef5350' },
      makeContext(),
    );
    expect(operations[0]?.a).toBe('GA');
    expect(tag.title).toBe('Errands');
    expect(tag.color).toBe('#ef5350');
    expect((tag.theme as { primary: string }).primary).toBe('#ef5350');
    expect(tag.advancedCfg).toBeDefined();
  });

  it('refuses a duplicate name regardless of case', () => {
    // Two tags that read identically are worse than one: neither the user nor
    // a model can tell which is which afterwards.
    const base = makeState({
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'g1', title: 'Errands' }),
      ],
    });
    expect(() => addTag(base, { title: 'errands' }, makeContext())).toThrow(
      ValidationError,
    );
  });

  it('rejects an empty title', () => {
    expect(() => addTag(makeState(), { title: '' }, makeContext())).toThrow(
      ValidationError,
    );
  });
});

describe('updateTag', () => {
  const base = () =>
    makeState({
      tags: [
        makeTag({ id: 'TODAY', title: 'Today' }),
        makeTag({ id: 'g1', title: 'Before' }),
      ],
    });

  it('renames a tag', () => {
    const { tag, operations } = updateTag(
      base(),
      'g1',
      { title: 'After' },
      makeContext(),
    );
    expect(tag.title).toBe('After');
    expect(operations[0]?.a).toBe('GU');
  });

  it('rebuilds the theme when the colour changes', () => {
    const { tag } = updateTag(base(), 'g1', { color: '#00ff00' }, makeContext());
    expect(tag.color).toBe('#00ff00');
    expect((tag.theme as { primary: string }).primary).toBe('#00ff00');
  });

  it('refuses to edit the virtual Today tag', () => {
    // Its membership is computed from due dates; writing a concrete tag over a
    // computed one would make the two disagree.
    expect(() => updateTag(base(), 'TODAY', { title: 'Hoy' }, makeContext())).toThrow(
      ValidationError,
    );
  });

  it('rejects an unknown tag', () => {
    expect(() => updateTag(base(), 'nope', { title: 'x' }, makeContext())).toThrow(
      NotFoundError,
    );
  });

  it('rejects an empty change set', () => {
    expect(() => updateTag(base(), 'g1', {}, makeContext())).toThrow(ValidationError);
  });
});
