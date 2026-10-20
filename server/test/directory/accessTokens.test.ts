// Personal access tokens (directory/accessTokens.ts) and the MCP endpoint (gateway/mcp.ts), through the real
// Node gateway: what a token reaches, what it is refused, when it stops working, and the MCP tools.

import { describe, expect, it } from 'vitest';
import type { TaskDTO } from '@shared/types';
import { createToken, listTokens, revokeToken, type TokenRole } from '../../src/directory/accessTokens';
import type { UserRow } from '../../src/directory/users';
import { createTestContext } from '../helpers';

async function setup() {
  const ctx = createTestContext();
  const owner = await ctx.signedIn();
  const project = await owner.client.post<{ id: number }>('/api/projects', { name: 'Web', key: 'WEB' });
  expect(project.status).toBe(201);
  const userRow = () => ctx.stack.directoryDb.get<UserRow>('SELECT * FROM users WHERE id = :id', { id: owner.user.id })!;
  const issue = (o: { role?: TokenRole; spaceId?: string | null; expiresAt?: string | null } = {}) =>
    createToken(ctx.stack.directoryDb, {
      user: userRow(),
      name: 'Claude',
      spaceId: o.spaceId ?? null,
      maxRole: o.role ?? 'member',
      expiresAt: o.expiresAt ?? null,
      meta: null,
      nowMs: Date.now(),
    }).token;
  /** A request with the token and no CSRF header (and no cookie unless `headers` brings one). */
  const call = async (token: string | null, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (token !== null) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await ctx.app.request(p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const api = (p: string) => `/api/s/${owner.spaceId}${p}`;
  return { ctx, owner, projectId: project.body.id, userRow, issue, call, api };
}

describe('personal access tokens', () => {
  it('reach the space API without the CSRF header, at most at their role', async () => {
    const { issue, call, api, projectId } = await setup();
    const member = issue();
    expect((await call(member, 'GET', api('/projects'))).status).toBe(200);
    const created = await call(member, 'POST', api('/tasks'), { projectId, title: 'From a token' });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('From a token');

    // The owner's member-capped token cannot do what only admins can.
    expect((await call(member, 'DELETE', api(`/projects/${projectId}`))).status).toBe(403);

    const viewer = issue({ role: 'viewer' });
    expect((await call(viewer, 'GET', api(`/tasks/${created.body.id}`))).status).toBe(200);
    expect((await call(viewer, 'POST', api('/tasks'), { projectId, title: 'Refused' })).status).toBe(403);
  });

  it('never pass the re-auth window or reach owner-only routes', async () => {
    const { issue, call, api } = await setup();
    const admin = issue({ role: 'admin' });
    expect((await call(admin, 'GET', api('/data/export'))).status).toBe(403);
  });

  it('are refused on every directory path, and a malformed Authorization header is refused', async () => {
    const { issue, call } = await setup();
    const token = issue();
    for (const p of ['/api/auth/status', '/api/account/sessions', '/api/admin/overview', '/api/spaces']) {
      expect((await call(token, 'GET', p)).status, p).toBe(401);
    }
    expect((await call(null, 'GET', '/api/auth/status', undefined, { Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call(null, 'GET', '/api/auth/status', undefined, { Authorization: 'Basic dXNlcjpwYXNz' })).status).toBe(401);
  });

  it('use the token, not a cookie sent with it', async () => {
    const { issue, call, api, owner } = await setup();
    const viewer = issue({ role: 'viewer' });
    // The owner's own session cookie alongside a viewer token: the token decides.
    const res = await call(viewer, 'POST', api('/projects'), { name: 'Nope' }, { Cookie: owner.client.cookieHeader() });
    expect(res.status).toBe(403);
  });

  it('limited to one space, reach no other', async () => {
    const { issue, call, owner } = await setup();
    const other = (await owner.client.post<{ id: string }>('/api/spaces', { name: 'Other' })).body.id;
    const limited = issue({ spaceId: owner.spaceId });
    expect((await call(limited, 'GET', `/api/s/${owner.spaceId}/projects`)).status).toBe(200);
    expect((await call(limited, 'GET', `/api/s/${other}/projects`)).status).toBe(404);
    expect((await call(issue(), 'GET', `/api/s/${other}/projects`)).status).toBe(200);
  });

  it('stop working when revoked, expired, the account is disabled, or its auth_epoch moves on', async () => {
    const { ctx, issue, call, api, owner } = await setup();
    const db = ctx.stack.directoryDb;
    const ok = async (token: string) => (await call(token, 'GET', api('/projects'))).status;

    const revoked = issue();
    const id = listTokens(db, owner.user.id, Date.now())[0]!.id;
    expect(revokeToken(db, { userId: owner.user.id, tokenId: id, meta: null, nowMs: Date.now() })).toBe(true);
    expect(await ok(revoked)).toBe(401);

    const expiring = issue({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await ok(expiring)).toBe(200);
    db.run("UPDATE personal_access_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE expires_at IS NOT NULL");
    expect(await ok(expiring)).toBe(401);

    const epoch = issue();
    expect(await ok(epoch)).toBe(200);
    db.run('UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = :id', { id: owner.user.id });
    expect(await ok(epoch)).toBe(401);

    const disabled = issue();
    db.run("UPDATE users SET status = 'disabled' WHERE id = :id", { id: owner.user.id });
    expect(await ok(disabled)).toBe(401);
  });

  it('are refused at creation for a space that is not the account’s, and recorded as security events', async () => {
    const { ctx, userRow } = await setup();
    expect(() =>
      createToken(ctx.stack.directoryDb, {
        user: userRow(),
        name: 'x',
        spaceId: '0000000000000000',
        maxRole: 'member',
        expiresAt: null,
        meta: null,
        nowMs: Date.now(),
      }),
    ).toThrow(/No space/);
    const { token: _ } = createToken(ctx.stack.directoryDb, {
      user: userRow(),
      name: 'logged',
      spaceId: null,
      maxRole: 'viewer',
      expiresAt: null,
      meta: null,
      nowMs: Date.now(),
    });
    const events = ctx.stack.directoryDb.all<{ type: string }>("SELECT type FROM security_events WHERE type LIKE 'token_%'");
    expect(events.map((e) => e.type)).toEqual(['token_created']);
  });
});

describe('the MCP endpoint (POST /api/mcp)', () => {
  const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });

  it('initializes, lists its tools and runs them through the space API', async () => {
    const { issue, call, owner, projectId } = await setup();
    const token = issue();
    const init = await call(token, 'POST', '/api/mcp', rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }));
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'lyren-plan' }, capabilities: { tools: {} } });
    expect((await call(token, 'POST', '/api/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);

    const list = await call(token, 'POST', '/api/mcp', rpc(2, 'tools/list'));
    const tools = list.body.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }>;
    expect(tools.map((t) => t.name)).toContain('create_task');
    const createTask = tools.find((t) => t.name === 'create_task')!;
    expect(createTask.inputSchema.required).toEqual(expect.arrayContaining(['space', 'projectId', 'title']));

    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await call(token, 'POST', '/api/mcp', rpc(3, 'tools/call', { name, arguments: args }));
      expect(res.status).toBe(200);
      return res.body.result as { content: Array<{ text: string }>; isError: boolean };
    };
    const spaces = await tool('list_spaces', {});
    expect(JSON.parse(spaces.content[0]!.text).spaces).toEqual([expect.objectContaining({ id: owner.spaceId, role: 'member' })]);

    const created = await tool('create_task', { space: owner.spaceId, projectId, title: 'Via MCP' });
    expect(created.isError).toBe(false);
    const task = JSON.parse(created.content[0]!.text) as TaskDTO;
    expect(task.title).toBe('Via MCP');

    const byRef = await tool('get_task', { space: owner.spaceId, ref: task.ref });
    expect(JSON.parse(byRef.content[0]!.text).id).toBe(task.id);
    expect((await tool('add_comment', { space: owner.spaceId, taskId: task.id, body: 'Noted' })).isError).toBe(false);
    expect((await tool('log_work', { space: owner.spaceId, taskId: task.id, date: '2026-10-20', minutes: 30 })).isError).toBe(false);
    const updated = await tool('update_task', { space: owner.spaceId, id: task.id, title: 'Renamed' });
    expect(JSON.parse(updated.content[0]!.text).title).toBe('Renamed');
    const queried = await tool('query_tasks', { space: owner.spaceId, filter: { search: 'Renamed' } });
    expect(JSON.parse(queried.content[0]!.text).tasks.map((t: TaskDTO) => t.id)).toEqual([task.id]);
    const found = await tool('search', { space: owner.spaceId, q: 'Renamed' });
    expect(found.isError).toBe(false);

    // The API's refusals come back as tool errors: validation, and a missing space.
    expect((await tool('create_task', { space: owner.spaceId, projectId, title: '' })).isError).toBe(true);
    expect((await tool('list_projects', {})).isError).toBe(true);
  });

  it('lists, creates and updates milestones, epics, tags and projects, and reports on the space', async () => {
    const { issue, call, owner, projectId } = await setup();
    const token = issue();
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await call(token, 'POST', '/api/mcp', rpc(9, 'tools/call', { name, arguments: { space: owner.spaceId, ...args } }));
      const result = res.body.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError, `${name}: ${result.content[0]!.text}`).toBe(false);
      return JSON.parse(result.content[0]!.text);
    };

    const milestone = await tool('create_milestone', { projectId, name: 'MVP', dueDate: '2026-12-01' });
    expect((await tool('list_milestones', { projectId })).map((m: { id: number }) => m.id)).toContain(milestone.id);
    expect((await tool('update_milestone', { id: milestone.id, name: 'MVP launch' })).name).toBe('MVP launch');

    const epic = await tool('create_epic', { projectId, milestoneId: milestone.id, name: 'Checkout' });
    expect((await tool('list_epics', { projectId })).map((e: { id: number }) => e.id)).toContain(epic.id);
    expect((await tool('update_epic', { id: epic.id, status: 'in_progress' })).status).toBe('in_progress');

    const tag = await tool('create_tag', { name: 'urgent' });
    expect((await tool('list_tags', {})).map((t: { id: number }) => t.id)).toContain(tag.id);

    expect((await tool('get_project', { id: projectId })).key).toBe('WEB');
    expect((await tool('update_project', { id: projectId, description: 'Relaunch' })).description).toBe('Relaunch');

    const a = await tool('create_task', { projectId, title: 'One', epicId: epic.id });
    const b = await tool('create_task', { projectId, title: 'Two' });
    const bulk = await tool('bulk_update_tasks', { ids: [a.id, b.id], patch: { priority: 3, addTagIds: [tag.id] } });
    expect(bulk.tasks.every((t: TaskDTO) => t.priority === 3)).toBe(true);
    expect(await tool('delete_task', { id: b.id })).toEqual({ ok: true });

    await tool('log_work', { taskId: a.id, date: '2026-10-20', minutes: 45 });
    const report = await tool('work_log_report', { from: '2026-10-01', to: '2026-10-31' });
    expect(JSON.stringify(report)).toContain('45');
    expect(await tool('get_dashboard', { today: '2026-10-20' })).toBeTypeOf('object');
    const activity = await tool('get_activity', { taskId: a.id, limit: 5 });
    expect(JSON.stringify(activity)).toContain('task.created');
  });

  it("applies the token's role: a viewer token's writes are tool errors", async () => {
    const { issue, call, owner, projectId } = await setup();
    const viewer = issue({ role: 'viewer' });
    const res = await call(viewer, 'POST', '/api/mcp', rpc(1, 'tools/call', { name: 'create_task', arguments: { space: owner.spaceId, projectId, title: 'x' } }));
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/view-only/);
  });

  it('needs a valid token, POST and one JSON-RPC message', async () => {
    const { issue, call, ctx } = await setup();
    expect((await call(null, 'POST', '/api/mcp', rpc(1, 'ping'), { 'X-Lyren-Request': '1' })).status).toBe(401);
    const token = issue();
    expect((await call(token, 'GET', '/api/mcp')).status).toBe(405);
    expect((await call(token, 'POST', '/api/mcp', [rpc(1, 'ping')])).status).toBe(400);
    expect((await call(token, 'POST', '/api/mcp', rpc(1, 'nope'))).body.error.code).toBe(-32601);
    ctx.stack.directoryDb.run('UPDATE personal_access_tokens SET revoked_at = :now', { now: new Date().toISOString() });
    expect((await call(token, 'POST', '/api/mcp', rpc(1, 'ping'))).status).toBe(401);
  });
});
