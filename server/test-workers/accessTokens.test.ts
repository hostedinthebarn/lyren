// Personal access tokens and the MCP endpoint on Cloudflare (design §5.12): through the real Worker,
// DirectoryDO and SpaceDO, as the Node suite does through the gateway (server/test/directory/accessTokens.test.ts).
// A file of its own, for fresh storage.

import { SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TokenDTO } from '@shared/types';
import { ORIGIN, setupOwner, within, type WorkerClient } from './support';

let owner: WorkerClient;
let spaceId: string;
let projectId: number;

beforeAll(async () => {
  ({ client: owner, spaceId } = await setupOwner());
  const project = await owner.post<{ id: number }>(`/api/s/${spaceId}/projects`, { name: 'Web', key: 'WEB' });
  expect(project.status).toBe(201);
  projectId = project.body.id;
});

/** Setup's session is inside the re-auth window, so the owner creates tokens without a password. */
async function issue(role: 'viewer' | 'member' | 'admin', name = `Token ${role}`) {
  const res = await owner.post<{ token: string; summary: TokenDTO }>('/api/account/tokens', { name, spaceId: null, role, expiresInDays: 30 });
  expect(res.status).toBe(201);
  return res.body;
}

/** A request with the token only: no cookie, no CSRF header. */
async function call(token: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '192.0.2.20' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await SELF.fetch(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const rpc = (token: string, id: number, method: string, params: Record<string, unknown> = {}) =>
  call(token, 'POST', '/api/mcp', { jsonrpc: '2.0', id, method, params });

describe('personal access tokens on Cloudflare', () => {
  it('reach the space API without the CSRF header, at most at their role, and no directory path', async () => {
    const { token } = await issue('member');
    expect((await call(token, 'GET', `/api/s/${spaceId}/projects`)).status).toBe(200);
    const task = await call(token, 'POST', `/api/s/${spaceId}/tasks`, { projectId, title: 'From a token' });
    expect(task.status).toBe(201);
    expect((await call(token, 'DELETE', `/api/s/${spaceId}/projects/${projectId}`)).status).toBe(403);
    // Owner-only and re-auth routes stay out of reach.
    expect((await call(token, 'GET', `/api/s/${spaceId}/data/export`)).status).toBe(403);
    for (const path of ['/api/account', '/api/account/tokens', '/api/spaces', '/api/auth/status']) {
      expect([path, (await call(token, 'GET', path)).status]).toEqual([path, 401]);
    }

    const viewer = await issue('viewer');
    expect((await call(viewer.token, 'GET', `/api/s/${spaceId}/tasks/${task.body.id}`)).status).toBe(200);
    expect((await call(viewer.token, 'POST', `/api/s/${spaceId}/tasks`, { projectId, title: 'Refused' })).status).toBe(403);
  });

  it('a malformed or unknown bearer is 401, never a fall-through to the cookie', async () => {
    expect((await call('not-a-token', 'GET', `/api/s/${spaceId}/projects`)).status).toBe(401);
    expect((await call(`lyr_pat_${'A'.repeat(43)}`, 'GET', `/api/s/${spaceId}/projects`)).status).toBe(401);
    const both = await SELF.fetch(`${ORIGIN}/api/s/${spaceId}/projects`, {
      headers: { Authorization: `Bearer lyr_pat_${'A'.repeat(43)}`, Cookie: owner.cookieHeader() },
    });
    expect(both.status).toBe(401);
  });

  it('serves MCP: initialize, the tools, and a tool call through the space object', async () => {
    const { token } = await issue('member', 'MCP');
    const init = await rpc(token, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.body.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'lyren-plan' } });
    const tools = await rpc(token, 2, 'tools/list');
    expect(tools.body.result.tools.map((t: { name: string }) => t.name)).toContain('create_task');
    const created = await rpc(token, 3, 'tools/call', { name: 'create_task', arguments: { space: spaceId, projectId, title: 'Via MCP' } });
    expect(created.body.result.isError ?? false).toBe(false);
    expect(JSON.parse(created.body.result.content[0].text)).toMatchObject({ title: 'Via MCP' });
    expect((await SELF.fetch(`${ORIGIN}/api/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
  });

  it('stops working once revoked', async () => {
    const { token, summary } = await issue('member', 'Revoked');
    expect((await call(token, 'GET', `/api/s/${spaceId}/projects`)).status).toBe(200);
    expect((await owner.delete(`/api/account/tokens/${summary.id}`)).status).toBe(200);
    await within(5_000, async () => (await call(token, 'GET', `/api/s/${spaceId}/projects`)).status === 401);
    expect((await rpc(token, 1, 'tools/list')).status).toBe(401);
  });
});
