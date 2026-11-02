# Task assignees: design

Status: **proposed**, implemented on `feature/task-assignees` (stacked on `feature/task-dependencies`, whose
migration 4 it follows). Extends SPEC.md (§5.5, §5.8, the filter semantics) and
docs/design/multi-user-and-cloudflare.md (§3.3 the space schema, §3.5 the users mirror, §8 the archive).

Conventions as in the multi-user design: MUST / SHOULD as in RFC 2119, paths relative to the repository root.

---------------------------------------------------------------------------------------------------------

## 1. Goal

A task can have one person who owns it. Teams can see who has what, filter a board to one person's work, and
hand a task on. A script or an assistant with a personal access token is an ordinary account that is a member of
the space, so "this one is the bot's" is a normal assignment, with no separate notion of an agent.

Non-goals for this version: several assignees, assigning by dropping a card on a board column, notifications,
and a "me" that follows whoever is viewing a saved board (a board filter stores user ids).

## 2. Rules

1. A task has **at most one** assignee, or none ("unassigned").
2. **Who can be assigned:** a current member of the space whose role can edit tasks: member, admin or owner.
   Never a viewer (who can't change the task), a former member, a placeholder or an account outside the space.
   An assignment that breaks this is a 400 on `assigneeId` (`patch.assigneeId` in a bulk update).
3. **Checked only when it changes.** A task assigned to someone who later leaves the space, or becomes a viewer,
   keeps them: the history stays true, and other edits to the task still work (sending the same `assigneeId`
   again is not a change). The UI shows such an assignee as it shows a task's creator: "(former member)".
4. **Reassign people** (design §8.6) moves a former member's assigned tasks to the chosen member as well, unless
   that member is a viewer, in which case the assignments stay with the former member. The answer counts them
   (`counts.assigned`).
5. Who may assign: anyone who may edit the task (member and up), as for every other field.

## 3. Data

Space migration 5 (server/src/space/schema.ts):

```sql
ALTER TABLE users ADD COLUMN role TEXT CHECK (role IN ('owner', 'admin', 'member', 'viewer'));
ALTER TABLE tasks ADD COLUMN assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX tasks_assignee ON tasks(assignee_id);
DELETE FROM _meta WHERE key = 'sync_version';
```

- `tasks.assignee_id` points into the users mirror, like `created_by`. Mirror rows are never deleted while
  referenced (§3.5), so an assignee who leaves keeps a name.
- `users.role` is the member's role in the space, NULL for everyone who isn't a current member. It is what rule 2
  needs: before this, a space knew who its members were but not their roles, which only the directory held.
  - **spaceSync** (DirectoryService) now sends each member's role (`MirrorMember.role`); `applySync` writes it,
    and clears it for anyone who stops being a member. A role change already bumps the space's sync_version
    (directory/members.ts), so it reaches the mirror the same way a membership change does.
  - **healActor** writes the actor's own role from the identity, so the acting user's row is right even when a
    sync failed.
  - Forgetting the applied `sync_version` makes the first request after the upgrade pull a sync, so existing
    members' roles arrive without waiting for a membership change. Until then a member's role is NULL, which
    rule 2 treats as assignable (only `viewer` is refused).
- An older build never reads either column, so migration 5 is compatible from 1, as 2–4 are.
- Duplicating a task copies its assignee, as it copies every other field.

## 4. API

- `TaskDTO.assigneeId: number | null`.
- `assigneeId` (nullable) on `POST /api/tasks`, `PATCH /api/tasks/:id` and the `patch` of `POST /api/tasks/bulk`.
- Filter: `assigneeIds: Array<number | null>`, where `null` means unassigned, with the same semantics as `epicIds`
  (ORed within, ANDed with the rest, empty = no constraint), in the SQL filter and the reference `matchesTaskFilter`
  (the randomized SQL-vs-reference contract draws it too).
- Activity: `task.updated` records `{ field: 'assignee', from, to, fromLabel, toLabel }` with display-name
  snapshots, between epic and the dates in the field order. The web says "assigned it to Ann", "unassigned Ann",
  "reassigned it from Ann to Bob".
- `PersonDTO.role` (bootstrap `people`): the web's assignee picker offers the members who aren't viewers.
- MCP (where the token and MCP work is deployed): the task tools' inputs are the API's schemas, so `create_task`,
  `update_task`, `bulk_update_tasks` and `query_tasks` take `assigneeId` / `assigneeIds` with no tool changes.

## 5. Archive

Archive v2 task rows carry `assigneeId` (one of `users`, omitted when unassigned), like `blockedBy`: optional, so
archives written before it still import, and no format version bump. Its user counts toward that archive user's
references, so the import's mapping step asks about them. On import the assignee is kept only when the person it
maps to can be assigned in the target space (rule 2, as of the commit); anyone else, a placeholder above all,
leaves the task unassigned. v1 exports never had assignees.

## 6. Web

- Task detail: an **Assignee** row (picker: "Unassigned", you, then the other assignable members by name; a
  current assignee who can't be assigned any more stays listed, disabled).
- Board cards and list rows: the assignee's avatar next to the counts, dimmed for a former member. It isn't a
  card-field toggle: adding one would rewrite every stored board config's defaults.
- Board filter: **Assignees**, with "Unassigned". A custom column filtered by assignee warns that a dropped task
  keeps its own assignee.

## 7. Tests

server/test/taskAssignees.test.ts (create, update, unassign, no-op, who can be assigned, viewers can't assign,
bulk, leaving and demotion, reassign, the filter, the archive round trip); the filter contract on both runtimes;
the migration and import-parity contracts updated for migration 5; web unit tests for the picker's options and
the activity sentences.
