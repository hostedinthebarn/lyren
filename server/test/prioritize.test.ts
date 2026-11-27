// /api/prioritize over HTTP (HL-5): the question loop, permissions, the task API's priorityRank (field, sort,
// filter), and the archive round trip (export, replace-import, export again).

import { describe, expect, it } from 'vitest';
import type {
  PrioritizeNextDTO,
  PrioritizeResultDTO,
  PrioritizeSetDTO,
  SpaceArchiveDTO,
  TaskDTO,
} from '@shared/types';
import { createTestContext, type TestClient } from './helpers';
import { downloadArchive, replaceImport } from './support/archive';

async function setupSet() {
  const ctx = createTestContext();
  const owner = await ctx.signedIn({ createSampleData: true });
  const tasks = (await owner.client.post<{ tasks: TaskDTO[] }>('/api/tasks/query', { limit: 5000 })).body.tasks;
  const ids = tasks.slice(0, 5).map((t) => t.id);
  const made = await owner.client.post<PrioritizeSetDTO>('/api/prioritize/sets', { scope: { type: 'tasks', taskIds: ids } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return { ctx, owner, ids, set: made.body };
}

async function answerAll(client: TestClient, setId: number, order: number[]) {
  for (let i = 0; i < 200; i++) {
    const next = (await client.get(`/api/prioritize/sets/${setId}/next`)).body as PrioritizeNextDTO;
    if (next.done || !next.pair) return;
    const [a, b] = next.pair.map((p) => p.taskId) as [number, number];
    const winner = order.indexOf(a) < order.indexOf(b) ? a : b;
    expect((await client.post(`/api/prioritize/sets/${setId}/choices`, { a, b, winner })).status).toBe(200);
  }
  throw new Error('did not converge');
}

describe('/api/prioritize', () => {
  it('asks, records, ranks and confirms onto priority_rank, never rank', async () => {
    const { owner, ids, set } = await setupSet();
    const order = [ids[4]!, ids[2]!, ids[0]!, ids[3]!, ids[1]!];
    const before = (await owner.client.post<{ tasks: TaskDTO[] }>('/api/tasks/query', { limit: 5000 })).body.tasks;
    await answerAll(owner.client, set.id, order);
    const result = (await owner.client.get<PrioritizeResultDTO>(`/api/prioritize/sets/${set.id}/result`)).body;
    expect(result.done).toBe(true);
    expect(result.items.map((i) => i.taskId)).toEqual(order);
    const confirmed = await owner.client.post<PrioritizeResultDTO>(`/api/prioritize/sets/${set.id}/confirm`, {});
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.set.confirmedAt).not.toBeNull();

    const sorted = await owner.client.post<{ tasks: TaskDTO[] }>('/api/tasks/query', {
      limit: 5000,
      sort: { field: 'priorityRank', dir: 'asc' },
      filter: { hasPriorityRank: true },
    });
    expect(sorted.status).toBe(200);
    expect(sorted.body.tasks.map((t) => t.id)).toEqual(order);
    expect(sorted.body.tasks.map((t) => t.priorityRank)).toEqual([1, 2, 3, 4, 5]);
    expect(sorted.body.tasks.every((t) => t.prioritySetId === set.id)).toBe(true);

    const after = (await owner.client.post<{ tasks: TaskDTO[] }>('/api/tasks/query', { limit: 5000 })).body.tasks;
    const rankOf = (ts: TaskDTO[]) => Object.fromEntries(ts.map((t) => [t.id, t.rank]));
    expect(rankOf(after)).toEqual(rankOf(before));
  });

  it('refuses a confirm with open questions, and bad input', async () => {
    const { owner, ids, set } = await setupSet();
    expect((await owner.client.post(`/api/prioritize/sets/${set.id}/confirm`, {})).status).toBe(409);
    expect((await owner.client.post(`/api/prioritize/sets/${set.id}/confirm`, { allowIncomplete: true })).status).toBe(200);
    expect((await owner.client.post(`/api/prioritize/sets/${set.id}/choices`, { a: ids[0], b: ids[0], winner: ids[0] })).status).toBe(400);
    expect((await owner.client.post(`/api/prioritize/sets/${set.id}/choices`, { a: ids[0], b: ids[1], winner: ids[2] })).status).toBe(400);
    expect((await owner.client.post('/api/prioritize/sets', { scope: { type: 'tasks', taskIds: [ids[0]] } })).status).toBe(400);
    expect((await owner.client.get('/api/prioritize/sets/99999/next')).status).toBe(404);
  });

  it('a viewer can read but not write', async () => {
    const { ctx, owner, ids, set } = await setupSet();
    const viewer = await ctx.addUser({ email: 'viewer@example.com', role: 'viewer' });
    expect((await viewer.client.get('/api/prioritize/sets')).status).toBe(200);
    expect((await viewer.client.get(`/api/prioritize/sets/${set.id}/next`)).status).toBe(200);
    expect((await viewer.client.post('/api/prioritize/sets', { scope: { type: 'tasks', taskIds: ids } })).status).toBe(403);
    expect((await viewer.client.post(`/api/prioritize/sets/${set.id}/choices`, { a: ids[0], b: ids[1], winner: null })).status).toBe(403);
    expect((await viewer.client.post(`/api/prioritize/sets/${set.id}/confirm`, { allowIncomplete: true })).status).toBe(403);
    void owner;
  });

  it('a member can answer but only an admin can confirm', async () => {
    const { ctx, owner, ids, set } = await setupSet();
    const member = await ctx.addUser({ email: 'member@example.com', role: 'member' });
    expect((await member.client.post(`/api/prioritize/sets/${set.id}/choices`, { a: ids[0], b: ids[1], winner: ids[0] })).status).toBe(200);
    expect((await member.client.post(`/api/prioritize/sets/${set.id}/confirm`, { allowIncomplete: true })).status).toBe(403);
    expect((await owner.client.post(`/api/prioritize/sets/${set.id}/confirm`, { allowIncomplete: true })).status).toBe(200);
  });

  it('import rejects a task pointing at a set that is not in the file, and a comparison about a task outside its set', async () => {
    const { owner, ids, set } = await setupSet();
    await answerAll(owner.client, set.id, ids);
    expect((await owner.client.post(`/api/prioritize/sets/${set.id}/confirm`, {})).status).toBe(200);
    const archive = (await downloadArchive(owner.client)).archive as SpaceArchiveDTO;
    const mapping = { mapping: archive.users.map((u) => ({ archiveId: u.id, target: { kind: 'user' as const, userId: owner.user.id } })) };

    const noBlock = structuredClone(archive);
    delete noBlock.prioritization;
    const r1 = await replaceImport(owner.client, noBlock, { mapping });
    expect(r1.status).toBe(400);
    expect(JSON.stringify(r1.body)).toContain('prioritySetId');

    const outsider = structuredClone(archive);
    const other = outsider.tasks.find((t) => !ids.includes(t.id))!;
    const c = outsider.prioritization!.comparisons[0]!;
    const lo = Math.min(c.taskLo, other.id);
    const hi = Math.max(c.taskLo, other.id);
    outsider.prioritization!.comparisons.push({ ...c, id: 99999, taskLo: lo, taskHi: hi, winner: null });
    const r2 = await replaceImport(owner.client, outsider, { mapping });
    expect(r2.status).toBe(400);
    expect(JSON.stringify(r2.body)).toContain(`task ${other.id} is not in set`);
  });

  it('a deleted task stays in the set as deleted', async () => {
    const { owner, ids, set } = await setupSet();
    await answerAll(owner.client, set.id, ids);
    const del = await owner.client.delete(`/api/tasks/${ids[2]}`);
    expect(del.status).toBe(200);
    const result = (await owner.client.get<PrioritizeResultDTO>(`/api/prioritize/sets/${set.id}/result`)).body;
    expect(result.items).toHaveLength(5);
    expect(result.items.find((i) => i.taskId === ids[2])!.deleted).toBe(true);
    expect(result.set.answered).toBeGreaterThan(0);
  });

  it('survives an archive export and a replace import', async () => {
    const { owner, ids, set } = await setupSet();
    await answerAll(owner.client, set.id, ids);
    expect((await owner.client.post(`/api/prioritize/sets/${set.id}/confirm`, {})).status).toBe(200);
    const first = (await downloadArchive(owner.client)).archive as SpaceArchiveDTO;
    expect(first.prioritization?.sets).toHaveLength(1);
    expect(first.prioritization!.comparisons.length).toBeGreaterThan(0);
    expect(first.tasks.filter((t) => t.priorityRank != null)).toHaveLength(5);

    const imported = await replaceImport(owner.client, first, {
      mapping: {
        mapping: first.users.map((u) => ({ archiveId: u.id, target: { kind: 'user', userId: owner.user.id } })),
      },
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(200);
    const second = (await downloadArchive(owner.client)).archive as SpaceArchiveDTO;
    const strip = (a: SpaceArchiveDTO) => ({
      p: a.prioritization,
      t: a.tasks.map((t) => [t.id, t.priorityRank, t.prioritySetId]),
    });
    // Attribution is not carried (documented); everything else is.
    const norm = (p: SpaceArchiveDTO['prioritization']) =>
      JSON.stringify(p, (k, v) => (k === 'createdBy' || k === 'answeredBy' ? undefined : v));
    expect(norm(strip(second).p)).toEqual(norm(strip(first).p));
    expect(strip(second).t).toEqual(strip(first).t);
    const result = (await owner.client.get<PrioritizeResultDTO>(`/api/prioritize/sets/${set.id}/result`)).body;
    expect(result.items.map((i) => i.taskId)).toEqual(ids);
  });
});
