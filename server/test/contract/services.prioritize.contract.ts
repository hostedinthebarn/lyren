// Pairwise prioritization (services/prioritize.ts) on any Db: run on NodeDb by
// server/test/services.prioritize.test.ts and on DoDb in workerd by server/test-workers/services.test.ts.

import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db';
import { HttpError } from '../../src/http/errors';
import {
  confirmResult,
  createSet,
  getResult,
  nextQuestion,
  recordChoice,
  undoChoice,
} from '../../src/services/prioritize';
import { insertEpic, insertProject, insertTask, type SpaceDb, type WithSpaceDb } from './fixtures';

function setup({ db }: SpaceDb, n: number) {
  const projectId = insertProject(db, 'PRI');
  const ids = Array.from({ length: n }, (_, i) => insertTask(db, { projectId, title: `T${i}` }));
  return { db, projectId, ids };
}

/** Answers every open question so that earlier entries of `order` win. */
function answerAll(db: Db, userId: number, setId: number, order: number[]): number {
  let asked = 0;
  for (;;) {
    const q = nextQuestion(db, setId);
    if (q.done || !q.pair) return asked;
    const [a, b] = q.pair.map((i) => i.taskId) as [number, number];
    const winner = order.indexOf(a) < order.indexOf(b) ? a : b;
    recordChoice(db, { userId }, setId, { a, b, winner });
    asked++;
    if (asked > 500) throw new Error('did not converge');
  }
}

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return (err as HttpError).status;
  }
  return 0;
}

export function definePrioritizeContract(adapter: string, withSpaceDb: WithSpaceDb): void {
  describe(`prioritize (${adapter})`, () => {
    it('ranks five tasks answered in a known order', async () => {
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 5);
        const set = createSet(db, space, { scope: { type: 'tasks', taskIds: ids } });
        const order = [ids[3]!, ids[0]!, ids[4]!, ids[1]!, ids[2]!];
        answerAll(db, space.userId, set.id, order);
        const result = getResult(db, set.id);
        expect(result.done).toBe(true);
        expect(result.items.map((i) => i.taskId)).toEqual(order);
        expect(result.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
      });
    });

    it('takes the open tasks of a project or an epic', async () => {
      await withSpaceDb((space) => {
        const { db, projectId, ids } = setup(space, 4);
        db.run('UPDATE tasks SET archived_at = :t WHERE id = :id', { t: '2026-03-01T00:00:00.000Z', id: ids[0]! });
        const set = createSet(db, space, { scope: { type: 'project', projectId } });
        expect(set.itemCount).toBe(3);
        expect(set.scopeType).toBe('project');
        const epicId = insertEpic(db, projectId, { name: 'Epic' });
        db.run('UPDATE tasks SET epic_id = :e WHERE id IN (:a, :b)', { e: epicId, a: ids[1]!, b: ids[2]! });
        expect(createSet(db, space, { scope: { type: 'epic', epicId } }).itemCount).toBe(2);
      });
    });

    it('rejects too few, too many, and unknown tasks', async () => {
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        expect(status(() => createSet(db, space, { scope: { type: 'tasks', taskIds: [ids[0]!, ids[0]!] } }))).toBe(400);
        expect(status(() => createSet(db, space, { scope: { type: 'tasks', taskIds: [ids[0]!, 9999] } }))).toBe(404);
        const many = Array.from({ length: 61 }, (_, i) => insertTask(db, { projectId: 1, title: `M${i}` }));
        expect(status(() => createSet(db, space, { scope: { type: 'tasks', taskIds: many } }))).toBe(400);
      });
    });

    it('re-answering a pair replaces it and undo reopens it', async () => {
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const [a, b, c] = ids as [number, number, number];
        const set = createSet(db, space, { scope: { type: 'tasks', taskIds: ids } });
        recordChoice(db, space, set.id, { a, b, winner: a });
        recordChoice(db, space, set.id, { a: b, b: a, winner: b });
        expect(getResult(db, set.id).set.answered).toBe(1);
        expect(getResult(db, set.id).items[0]!.taskId).toBe(b);
        undoChoice(db, set.id, a, b);
        expect(getResult(db, set.id).set.answered).toBe(0);
        expect(status(() => undoChoice(db, set.id, a, b))).toBe(404);
        expect(status(() => recordChoice(db, space, set.id, { a, b: 9999, winner: a }))).toBe(400);
        void c;
      });
    });

    it('confirm writes priority_rank and priority_set_id and leaves rank alone', async () => {
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 4);
        const before = db.all<{ id: number; rank: string }>('SELECT id, rank FROM tasks ORDER BY id');
        const set = createSet(db, space, { scope: { type: 'tasks', taskIds: ids } });
        expect(status(() => confirmResult(db, set.id, {}))).toBe(409);
        answerAll(db, space.userId, set.id, [ids[2]!, ids[0]!, ids[3]!, ids[1]!]);
        const result = confirmResult(db, set.id, {});
        expect(result.set.confirmedAt).not.toBeNull();
        const rows = db.all<{ id: number; priority_rank: number; priority_set_id: number }>(
          'SELECT id, priority_rank, priority_set_id FROM tasks ORDER BY priority_rank',
        );
        expect(rows.map((r) => r.id)).toEqual([ids[2], ids[0], ids[3], ids[1]]);
        expect(rows.map((r) => r.priority_rank)).toEqual([1, 2, 3, 4]);
        expect(rows.every((r) => r.priority_set_id === set.id)).toBe(true);
        expect(db.all('SELECT id, rank FROM tasks ORDER BY id')).toEqual(before);
      });
    });

    it('the latest confirmed set wins, and the older set keeps its own result', async () => {
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const s1 = createSet(db, space, { scope: { type: 'tasks', taskIds: ids } });
        answerAll(db, space.userId, s1.id, [ids[0]!, ids[1]!, ids[2]!]);
        confirmResult(db, s1.id, {});
        const s2 = createSet(db, space, { scope: { type: 'tasks', taskIds: ids } });
        answerAll(db, space.userId, s2.id, [ids[2]!, ids[1]!, ids[0]!]);
        confirmResult(db, s2.id, {});
        const t = db.get<{ priority_rank: number; priority_set_id: number }>(
          'SELECT priority_rank, priority_set_id FROM tasks WHERE id = :id',
          { id: ids[2]! },
        )!;
        expect(t).toEqual({ priority_rank: 1, priority_set_id: s2.id });
        expect(getResult(db, s1.id).items.map((i) => i.taskId)).toEqual([ids[0], ids[1], ids[2]]);
      });
    });

    it('archiving a task keeps its history', async () => {
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const set = createSet(db, space, { scope: { type: 'tasks', taskIds: ids } });
        answerAll(db, space.userId, set.id, ids);
        db.run('UPDATE tasks SET archived_at = :t WHERE id = :id', { t: '2026-03-02T00:00:00.000Z', id: ids[1]! });
        const result = getResult(db, set.id);
        expect(result.items).toHaveLength(3);
        const item = result.items.find((i) => i.taskId === ids[1])!;
        expect(item.archived).toBe(true);
        expect(item.deleted).toBe(false);
      });
    });

    it('hard-deleting a task keeps its comparisons and shows it as deleted', async () => {
      await withSpaceDb((space) => {
        const { db, ids } = setup(space, 3);
        const set = createSet(db, space, { scope: { type: 'tasks', taskIds: ids } });
        answerAll(db, space.userId, set.id, ids);
        const count = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prioritization_comparisons')!.n;
        const before = count();
        expect(before).toBeGreaterThan(0);
        const gone = ids[1]!;
        const ref = getResult(db, set.id).items.find((i) => i.taskId === gone)!.ref;
        db.run('DELETE FROM tasks WHERE id = :id', { id: gone });
        expect(count()).toBe(before);
        const result = getResult(db, set.id);
        const item = result.items.find((i) => i.taskId === gone)!;
        expect(item.deleted).toBe(true);
        expect(item.ref).toBe(ref);
        expect(item.title).toBe('T1');
        expect(result.items.map((i) => i.taskId)).toEqual(ids);
        expect(nextQuestion(db, set.id).done).toBe(true);
        expect(status(() => recordChoice(db, space, set.id, { a: gone, b: ids[0]!, winner: ids[0]! }))).toBe(409);
        // Confirming writes only the tasks that still exist.
        confirmResult(db, set.id, {});
        expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE priority_rank IS NOT NULL')!.n).toBe(2);
        // A re-run leaves the deleted task out.
        const again = createSet(db, space, { scope: { type: 'project', projectId: 1 } });
        expect(again.itemCount).toBe(2);
      });
    });
  });
}
