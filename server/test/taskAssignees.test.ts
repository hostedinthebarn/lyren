// API tests for task assignees (docs/design/task-assignees.md): assigning on create, update and bulk; who can be
// assigned (members, admins and owners, never a viewer or someone outside the space); a member who leaves or
// becomes a viewer keeps their tasks; the filter; the activity entry; reassigning a former member's tasks; and the
// archive round trip.

import { describe, expect, it } from 'vitest';
import type { ActivityData, PeopleReassignedDTO, TaskDTO, TaskQueryResult } from '@shared/types';
import type { ActivityRow } from '../src/services/rows';
import { createTestContext } from './helpers';
import { downloadArchive, importArchive } from './support/archive';
import { insertProject } from './services.fixtures';

async function setup() {
  const ctx = createTestContext();
  const owner = await ctx.signedIn();
  const bob = await ctx.addUser({ email: 'bob@example.com', displayName: 'Bob' });
  const ann = await ctx.addUser({ email: 'ann@example.com', displayName: 'Ann', role: 'admin' });
  const viewer = await ctx.addUser({ email: 'viewer@example.com', displayName: 'Vic', role: 'viewer' });
  const outsider = await ctx.addUser({ email: 'out@example.com', displayName: 'Out', spaceId: null });
  // The owner's next request syncs the mirror with the members just added.
  expect((await owner.client.get('/api/bootstrap')).status).toBe(200);
  const project = insertProject(ctx.db, 'ALP', { name: 'Alpha' });
  const create = (body: Record<string, unknown>, client = owner.client) =>
    client.post<TaskDTO>('/api/tasks', { projectId: project, title: 'Task', ...body });
  const patch = (id: number, body: Record<string, unknown>, client = owner.client) => client.patch<TaskDTO>(`/api/tasks/${id}`, body);
  const query = async (filter: Record<string, unknown>): Promise<number[]> =>
    (await owner.client.post<TaskQueryResult>('/api/tasks/query', { filter })).body.tasks.map((t) => t.id);
  const changes = (taskId: number) =>
    ctx.db
      .all<ActivityRow>("SELECT * FROM activity WHERE task_id = :taskId AND action = 'task.updated' ORDER BY id", { taskId })
      .map((r) => (JSON.parse(r.data) as ActivityData).changes);
  return { ctx, owner, bob, ann, viewer, outsider, project, create, patch, query, changes };
}

describe('assigning', () => {
  it('assigns on create and update, unassigns with null, and records each change by name', async () => {
    const t = await setup();
    const created = await t.create({ assigneeId: t.bob.user.id });
    expect(created.status).toBe(201);
    expect(created.body.assigneeId).toBe(t.bob.user.id);

    const toAnn = await t.patch(created.body.id, { assigneeId: t.ann.user.id });
    expect(toAnn.status).toBe(200);
    expect(toAnn.body.assigneeId).toBe(t.ann.user.id);
    const cleared = await t.patch(created.body.id, { assigneeId: null });
    expect(cleared.body.assigneeId).toBeNull();

    expect(t.changes(created.body.id)).toEqual([
      [{ field: 'assignee', from: t.bob.user.id, to: t.ann.user.id, fromLabel: 'Bob', toLabel: 'Ann' }],
      [{ field: 'assignee', from: t.ann.user.id, to: null, fromLabel: 'Ann', toLabel: null }],
    ]);
  });

  it('a task starts unassigned, and assigning the same person again changes nothing', async () => {
    const t = await setup();
    const task = (await t.create({})).body;
    expect(task.assigneeId).toBeNull();
    await t.patch(task.id, { assigneeId: t.bob.user.id });
    const again = await t.patch(task.id, { assigneeId: t.bob.user.id });
    expect(again.body.updatedAt).toBe((await t.owner.client.get<TaskDTO>(`/api/tasks/${task.id}`)).body.updatedAt);
    expect(t.changes(task.id)).toHaveLength(1);
  });

  it('members, admins and owners can be assigned; a viewer, an outsider and an unknown id cannot', async () => {
    const t = await setup();
    for (const id of [t.owner.user.id, t.ann.user.id, t.bob.user.id]) {
      expect((await t.create({ assigneeId: id })).status).toBe(201);
    }
    const viewer = await t.create({ assigneeId: t.viewer.user.id });
    expect(viewer.status).toBe(400);
    expect((viewer.body as any).error.details).toEqual([{ path: 'assigneeId', message: "Vic is a viewer, and a viewer can't be assigned a task" }]);
    for (const id of [t.outsider.user.id, 9999]) {
      const res = await t.create({ assigneeId: id });
      expect(res.status).toBe(400);
      expect((res.body as any).error.details).toEqual([{ path: 'assigneeId', message: `User ${id} is not a member of this space` }]);
    }
    const task = (await t.create({})).body;
    expect((await t.patch(task.id, { assigneeId: t.viewer.user.id })).status).toBe(400);
    expect((await t.owner.client.get<TaskDTO>(`/api/tasks/${task.id}`)).body.assigneeId).toBeNull();
  });

  it('a viewer cannot assign anyone (task writes need member)', async () => {
    const t = await setup();
    const task = (await t.create({})).body;
    expect((await t.patch(task.id, { assigneeId: t.bob.user.id }, t.viewer.client)).status).toBe(403);
  });

  it('bulk updates assign many tasks at once, and refuse a viewer for all of them', async () => {
    const t = await setup();
    const a = (await t.create({ title: 'A' })).body;
    const b = (await t.create({ title: 'B' })).body;
    const res = await t.owner.client.post<{ tasks: TaskDTO[] }>('/api/tasks/bulk', { ids: [a.id, b.id], patch: { assigneeId: t.bob.user.id } });
    expect(res.status).toBe(200);
    expect(res.body.tasks.map((x) => x.assigneeId)).toEqual([t.bob.user.id, t.bob.user.id]);
    const refused = await t.owner.client.post<any>('/api/tasks/bulk', { ids: [a.id, b.id], patch: { assigneeId: t.viewer.user.id } });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].path).toBe('patch.assigneeId');
    expect((await t.owner.client.get<TaskDTO>(`/api/tasks/${a.id}`)).body.assigneeId).toBe(t.bob.user.id);
  });
});

describe('when the assignee leaves or becomes a viewer', () => {
  it('their tasks stay assigned to them, other edits still work, and they cannot be assigned anew', async () => {
    const t = await setup();
    const kept = (await t.create({ assigneeId: t.bob.user.id })).body;
    const demoted = (await t.create({ assigneeId: t.ann.user.id })).body;
    expect((await t.owner.client.delete(`/api/spaces/${t.owner.spaceId}/members/${t.bob.user.id}`)).status).toBe(200);
    expect((await t.owner.client.patch(`/api/spaces/${t.owner.spaceId}/members/${t.ann.user.id}`, { role: 'viewer' })).status).toBe(200);
    expect((await t.owner.client.get('/api/bootstrap')).status).toBe(200);

    expect((await t.owner.client.get<TaskDTO>(`/api/tasks/${kept.id}`)).body.assigneeId).toBe(t.bob.user.id);
    const edited = await t.patch(kept.id, { title: 'Renamed', assigneeId: t.bob.user.id });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: 'Renamed', assigneeId: t.bob.user.id });
    expect((await t.patch(demoted.id, { priority: 2 })).body.assigneeId).toBe(t.ann.user.id);

    expect((await t.create({ assigneeId: t.bob.user.id })).status).toBe(400);
    expect((await t.create({ assigneeId: t.ann.user.id })).status).toBe(400);
  });

  it("reassigning a former member moves their assigned tasks to a member, but never to a viewer", async () => {
    const t = await setup();
    const task = (await t.create({ assigneeId: t.bob.user.id })).body;
    expect((await t.owner.client.delete(`/api/spaces/${t.owner.spaceId}/members/${t.bob.user.id}`)).status).toBe(200);
    expect((await t.owner.client.get('/api/bootstrap')).status).toBe(200);

    const toViewer = await t.owner.client.post<PeopleReassignedDTO>(`/api/people/${t.bob.user.id}/reassign`, { toUserId: t.viewer.user.id });
    expect(toViewer.status).toBe(200);
    expect(toViewer.body.counts.assigned).toBe(0);
    expect((await t.owner.client.get<TaskDTO>(`/api/tasks/${task.id}`)).body.assigneeId).toBe(t.bob.user.id);

    const toAnn = await t.owner.client.post<PeopleReassignedDTO>(`/api/people/${t.bob.user.id}/reassign`, { toUserId: t.ann.user.id });
    expect(toAnn.body.counts.assigned).toBe(1);
    expect((await t.owner.client.get<TaskDTO>(`/api/tasks/${task.id}`)).body.assigneeId).toBe(t.ann.user.id);
  });
});

describe('the filter', () => {
  it('assigneeIds matches the people listed, and null the unassigned tasks', async () => {
    const t = await setup();
    const bobs = (await t.create({ assigneeId: t.bob.user.id })).body.id;
    const anns = (await t.create({ assigneeId: t.ann.user.id })).body.id;
    const nobodys = (await t.create({})).body.id;
    expect(await t.query({ assigneeIds: [t.bob.user.id] })).toEqual([bobs]);
    expect((await t.query({ assigneeIds: [t.bob.user.id, t.ann.user.id] })).sort()).toEqual([bobs, anns].sort());
    expect(await t.query({ assigneeIds: [null] })).toEqual([nobodys]);
    expect((await t.query({ assigneeIds: [null, t.ann.user.id] })).sort()).toEqual([anns, nobodys].sort());
    expect((await t.query({ assigneeIds: [] })).length).toBe(3);
  });
});

describe('the archive', () => {
  it('carries the assignee, and an import keeps it only for someone who can be assigned there', async () => {
    const t = await setup();
    const bobs = (await t.create({ title: 'Bobs', assigneeId: t.bob.user.id })).body;
    const anns = (await t.create({ title: 'Anns', assigneeId: t.ann.user.id })).body;
    await t.create({ title: 'Nobodys' });
    const archive = (await downloadArchive(t.owner.client)).archive!;
    const byTitle = new Map(archive.tasks.map((x) => [x.title, x]));
    expect(byTitle.get('Bobs')!.assigneeId).toBe(t.bob.user.id);
    expect(byTitle.get('Anns')!.assigneeId).toBe(t.ann.user.id);
    expect('assigneeId' in byTitle.get('Nobodys')!).toBe(false);
    expect(archive.users.map((u) => u.id)).toEqual(expect.arrayContaining([t.bob.user.id, t.ann.user.id]));

    // A new space for the import, where only the importer is a member: Bob's rows go to the importer (a member, so
    // the assignment is kept), Ann's to a placeholder (never assignable, so that task arrives unassigned).
    const target = (await t.owner.client.post<{ id: string }>('/api/spaces', { name: 'Moved', forImport: true })).body.id;
    const mapping = {
      mapping: archive.users.map((u) => ({
        archiveId: u.id,
        target: u.id === t.ann.user.id ? { kind: 'placeholder' } : { kind: 'user', userId: t.owner.user.id },
      })),
    };
    const result = await importArchive(t.owner.client, { path: `/api/s/${target}/data`, mode: 'new', file: archive, mapping });
    expect(result.commit.status).toBe(200);
    const moved = (await t.owner.client.post<TaskQueryResult>(`/api/s/${target}/tasks/query`, {})).body.tasks;
    const movedByTitle = new Map(moved.map((x) => [x.title, x]));
    expect(movedByTitle.get(bobs.title)!.assigneeId).toBe(t.owner.user.id);
    expect(movedByTitle.get(anns.title)!.assigneeId).toBeNull(); // a placeholder can't be assigned
  });
});
