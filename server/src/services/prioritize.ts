// Pairwise prioritization (HL-5): sets of tasks to rank by answering "which first?", the answers, and the
// confirmed result on tasks.priority_rank. The engine is ranking-core (pure); this file stores what it is
// given and writes what it returns.
//
// Rules (Gary, 2026-11-27):
//  - Confirming writes tasks.priority_rank and priority_set_id, never `rank` (the board order).
//  - A set keeps each item's ref and title as they were; no table here has a foreign key to tasks, so archiving
//    a task (a flag) or deleting it (a row) never touches the history. A deleted item stays in the result, marked
//    deleted, and is no longer asked about.
//  - A comparison is one row per unordered pair of a set: answering a pair again replaces the answer (the undo
//    is deleting it). Each space has its own database, so nothing here says which space it is.

import { PRIORITIZE_MAX_ITEMS, type PrioritizeChoiceInput, type PrioritizeConfirmInput, type PrioritizeSetCreateInput } from '@shared/schemas';
import type {
  PrioritizeChoiceDTO,
  PrioritizeItemDTO,
  PrioritizeNextDTO,
  PrioritizeResultDTO,
  PrioritizeSetDTO,
} from '@shared/types';
import type { Db } from '../db';
import { badRequest, conflict, notFound } from '../http/errors';
import { nextPair, rank, type Answer } from '../ranking-core';
import { recordActivity, valueChange } from './activity';
import { nowIso } from './sql';
import { taskOpenSql } from './tasks';

interface SetRow {
  id: number;
  name: string;
  scope_type: 'project' | 'epic' | 'tasks';
  scope_id: number | null;
  created_by: number | null;
  created_at: string;
  confirmed_at: string | null;
}

interface ItemRow {
  task_id: number;
  ref_snapshot: string;
  title_snapshot: string;
  live_ref: string | null;
  live_title: string | null;
  live_id: number | null;
  archived_at: string | null;
}

const toSetDTO = (r: SetRow, itemCount: number, answered: number): PrioritizeSetDTO => ({
  id: r.id,
  name: r.name,
  scopeType: r.scope_type,
  scopeId: r.scope_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  confirmedAt: r.confirmed_at,
  itemCount,
  answered,
});

function requireSet(db: Db, id: number): SetRow {
  const row = db.get<SetRow>('SELECT * FROM prioritization_sets WHERE id = :id', { id });
  if (!row) throw notFound('Prioritization set');
  return row;
}

function counts(db: Db, setId: number): { itemCount: number; answered: number } {
  return db.get<{ itemCount: number; answered: number }>(
    `SELECT (SELECT COUNT(*) FROM prioritization_items WHERE set_id = :setId) AS itemCount,
            (SELECT COUNT(*) FROM prioritization_comparisons WHERE set_id = :setId) AS answered`,
    { setId },
  )!;
}

function setDTO(db: Db, row: SetRow): PrioritizeSetDTO {
  const c = counts(db, row.id);
  return toSetDTO(row, c.itemCount, c.answered);
}

/** The set's items; a task that still exists shows its current ref and title, a deleted one its snapshot. */
function readItems(db: Db, setId: number): PrioritizeItemDTO[] {
  return db
    .all<ItemRow>(
      `SELECT i.task_id, i.ref_snapshot, i.title_snapshot, t.id AS live_id, t.title AS live_title, t.archived_at,
              (SELECT key FROM projects WHERE id = t.project_id) || '-' || t.number AS live_ref
         FROM prioritization_items i LEFT JOIN tasks t ON t.id = i.task_id
        WHERE i.set_id = :setId ORDER BY i.task_id`,
      { setId },
    )
    .map((r) => ({
      taskId: r.task_id,
      ref: r.live_id === null ? r.ref_snapshot : (r.live_ref ?? r.ref_snapshot),
      title: r.live_id === null ? r.title_snapshot : (r.live_title ?? r.title_snapshot),
      deleted: r.live_id === null,
      archived: r.archived_at !== null,
    }));
}

function readAnswers(db: Db, setId: number): Answer[] {
  return db
    .all<{ task_lo: number; task_hi: number; winner: number | null }>(
      'SELECT task_lo, task_hi, winner FROM prioritization_comparisons WHERE set_id = :setId ORDER BY id',
      { setId },
    )
    .map((r) => ({ a: r.task_lo, b: r.task_hi, winner: r.winner }));
}

export function listSets(db: Db): PrioritizeSetDTO[] {
  return db
    .all<SetRow>('SELECT * FROM prioritization_sets ORDER BY id DESC')
    .map((r) => setDTO(db, r));
}

export function getSet(db: Db, id: number): PrioritizeSetDTO & { items: PrioritizeItemDTO[] } {
  const row = requireSet(db, id);
  return { ...setDTO(db, row), items: readItems(db, id) };
}

/**
 * Make a set. A project or epic gives its open, unarchived tasks (not done or cancelled), and an explicit list
 * gives exactly those tasks (404 for one that does not exist). At least 2 and at most PRIORITIZE_MAX_ITEMS: over
 * the cap the caller narrows the selection instead of getting a quiet subset.
 */
export function createSet(db: Db, ctx: { userId: number }, input: PrioritizeSetCreateInput): PrioritizeSetDTO {
  return db.tx(() => {
    const { scope } = input;
    let label: string;
    let scopeType: SetRow['scope_type'];
    let scopeId: number | null;
    let tasks: Array<{ id: number; ref: string; title: string }>;
    const select = `SELECT t.id, t.title, (SELECT key FROM projects WHERE id = t.project_id) || '-' || t.number AS ref FROM tasks t`;
    if (scope.type === 'project') {
      const p = db.get<{ id: number; name: string }>('SELECT id, name FROM projects WHERE id = :id', { id: scope.projectId });
      if (!p) throw notFound('Project');
      label = p.name;
      scopeType = 'project';
      scopeId = p.id;
      tasks = db.all(`${select} WHERE t.project_id = :id AND t.archived_at IS NULL AND ${taskOpenSql()} ORDER BY t.rank, t.id`, { id: p.id });
    } else if (scope.type === 'epic') {
      const e = db.get<{ id: number; name: string }>('SELECT id, name FROM epics WHERE id = :id', { id: scope.epicId });
      if (!e) throw notFound('Epic');
      label = e.name;
      scopeType = 'epic';
      scopeId = e.id;
      tasks = db.all(`${select} WHERE t.epic_id = :id AND t.archived_at IS NULL AND ${taskOpenSql()} ORDER BY t.rank, t.id`, { id: e.id });
    } else {
      const ids = [...new Set(scope.taskIds)];
      tasks = db.all(`${select} WHERE t.id IN (SELECT value FROM json_each(:ids)) ORDER BY t.rank, t.id`, { ids: JSON.stringify(ids) });
      if (tasks.length !== ids.length) {
        const found = new Set(tasks.map((t) => t.id));
        throw notFound(`Task ${ids.find((id) => !found.has(id))}`);
      }
      label = 'Selected tasks';
      scopeType = 'tasks';
      scopeId = null;
    }
    if (tasks.length < 2) throw badRequest(`Pick at least 2 tasks to rank (this has ${tasks.length})`);
    if (tasks.length > PRIORITIZE_MAX_ITEMS) {
      throw badRequest(`That is ${tasks.length} tasks; a set holds at most ${PRIORITIZE_MAX_ITEMS}. Narrow the selection.`);
    }
    const now = nowIso();
    const { lastInsertRowid } = db.run(
      `INSERT INTO prioritization_sets (name, scope_type, scope_id, created_by, created_at)
       VALUES (:name, :scopeType, :scopeId, :userId, :now)`,
      { name: input.name ?? label, scopeType, scopeId, userId: ctx.userId, now },
    );
    db.run(
      `INSERT INTO prioritization_items (set_id, task_id, ref_snapshot, title_snapshot, added_at)
       SELECT :setId, json_extract(value, '$.id'), json_extract(value, '$.ref'), json_extract(value, '$.title'), :now
         FROM json_each(:rows)`,
      { setId: lastInsertRowid, now, rows: JSON.stringify(tasks) },
    );
    return setDTO(db, requireSet(db, lastInsertRowid));
  });
}

/** The next question: the engine's pair among the items that still exist, or done. */
export function nextQuestion(db: Db, setId: number): PrioritizeNextDTO {
  requireSet(db, setId);
  const items = readItems(db, setId);
  const answers = readAnswers(db, setId);
  const live = items.filter((i) => !i.deleted).map((i) => i.taskId);
  const pair = nextPair(
    items.map((i) => i.taskId),
    answers,
    live,
  );
  const byId = new Map(items.map((i) => [i.taskId, i]));
  return {
    pair: pair ? [byId.get(pair[0])!, byId.get(pair[1])!] : null,
    done: pair === null,
    answered: answers.length,
  };
}

/** Record (or replace) the answer for a pair. Both tasks must be items of the set, and still exist. */
export function recordChoice(db: Db, ctx: { userId: number }, setId: number, input: PrioritizeChoiceInput): PrioritizeChoiceDTO {
  return db.tx(() => {
    requireSet(db, setId);
    const items = new Map(readItems(db, setId).map((i) => [i.taskId, i]));
    for (const id of [input.a, input.b]) {
      const item = items.get(id);
      if (!item) throw badRequest(`Task ${id} is not in this set`);
      if (item.deleted) throw conflict(`${item.ref} was deleted, so it can no longer be compared`);
    }
    const lo = Math.min(input.a, input.b);
    const hi = Math.max(input.a, input.b);
    const now = nowIso();
    db.run(
      `INSERT INTO prioritization_comparisons (set_id, task_lo, task_hi, winner, answered_by, answered_at)
       VALUES (:setId, :lo, :hi, :winner, :userId, :now)
       ON CONFLICT (set_id, task_lo, task_hi) DO UPDATE
         SET winner = excluded.winner, answered_by = excluded.answered_by, answered_at = excluded.answered_at`,
      { setId, lo, hi, winner: input.winner, userId: ctx.userId, now },
    );
    return { a: lo, b: hi, winner: input.winner, answeredBy: ctx.userId, answeredAt: now };
  });
}

/** Take an answer back (the undo): the pair becomes a question again. 404 when it was not answered. */
export function undoChoice(db: Db, setId: number, a: number, b: number): void {
  requireSet(db, setId);
  const { changes } = db.run(
    'DELETE FROM prioritization_comparisons WHERE set_id = :setId AND task_lo = :lo AND task_hi = :hi',
    { setId, lo: Math.min(a, b), hi: Math.max(a, b) },
  );
  if (changes === 0) throw notFound('Answer');
}

export function listChoices(db: Db, setId: number): PrioritizeChoiceDTO[] {
  requireSet(db, setId);
  return db
    .all<{ task_lo: number; task_hi: number; winner: number | null; answered_by: number | null; answered_at: string }>(
      'SELECT task_lo, task_hi, winner, answered_by, answered_at FROM prioritization_comparisons WHERE set_id = :setId ORDER BY id',
      { setId },
    )
    .map((r) => ({ a: r.task_lo, b: r.task_hi, winner: r.winner, answeredBy: r.answered_by, answeredAt: r.answered_at }));
}

/** The ranking so far, every item of the set (deleted ones included, marked), best first. */
export function getResult(db: Db, setId: number): PrioritizeResultDTO {
  const row = requireSet(db, setId);
  const items = readItems(db, setId);
  const answers = readAnswers(db, setId);
  const ids = items.map((i) => i.taskId);
  const byId = new Map(items.map((i) => [i.taskId, i]));
  const ranked = rank(ids, answers);
  const done = nextPair(ids, answers, items.filter((i) => !i.deleted).map((i) => i.taskId)) === null;
  return {
    set: toSetDTO(row, items.length, answers.length),
    done,
    items: ranked.map((r) => ({
      ...byId.get(r.id)!,
      position: r.position,
      score: r.score,
      wins: r.wins,
      losses: r.losses,
      ties: r.ties,
    })),
  };
}

/**
 * Confirm the result: write each existing task's place (1..n among the live tasks) to tasks.priority_rank and the set to
 * priority_set_id (the latest confirmed set wins; tasks outside this set keep what they had). `rank` is not
 * touched. Needs every question answered unless `allowIncomplete`. Admins only (the gate). Each task whose
 * priority rank changes gets a `task.updated` activity entry and a new updated_at, like any field edit
 * (Gary, 2026-11-27). Returns the result as written.
 */
export function confirmResult(db: Db, actor: { userId: number }, setId: number, input: PrioritizeConfirmInput): PrioritizeResultDTO {
  db.tx(() => {
    const result = getResult(db, setId);
    if (!result.done && !input.allowIncomplete) {
      throw conflict('Some pairs are still open. Finish the questions, or confirm with allowIncomplete.');
    }
    const now = nowIso();
    // Renumbered 1..n over the tasks that still exist, so a deleted task leaves no gap (Gary, 2026-11-27).
    const rows = result.items.filter((i) => !i.deleted).map((i, n) => ({ id: i.taskId, position: n + 1 }));
    const before = new Map(
      db
        .all<{ id: number; project_id: number; title: string; priority_rank: number | null; ref: string }>(
          `SELECT t.id, t.project_id, t.title, t.priority_rank,
                  (SELECT key FROM projects WHERE id = t.project_id) || '-' || t.number AS ref
             FROM tasks t WHERE t.id IN (SELECT json_extract(value, '$.id') FROM json_each(:rows))`,
          { rows: JSON.stringify(rows) },
        )
        .map((t) => [t.id, t]),
    );
    db.run(
      `UPDATE tasks SET priority_rank = (SELECT json_extract(value, '$.position') FROM json_each(:rows) WHERE json_extract(value, '$.id') = tasks.id),
                        priority_set_id = :setId, updated_at = :now
        WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(:rows))`,
      { rows: JSON.stringify(rows), setId, now },
    );
    for (const { id, position } of rows) {
      const t = before.get(id);
      if (!t) continue;
      const change = valueChange('priorityRank', t.priority_rank, position);
      if (!change) continue;
      recordActivity(db, {
        userId: actor.userId,
        projectId: t.project_id,
        taskId: id,
        entityType: 'task',
        entityId: id,
        action: 'task.updated',
        data: { changes: [change], title: t.title, ref: t.ref, prioritySetId: setId, prioritySetName: result.set.name },
        createdAt: now,
      });
    }
    db.run('UPDATE prioritization_sets SET confirmed_at = :now WHERE id = :setId', { setId, now });
  });
  return getResult(db, setId);
}
