// The MCP endpoint (POST /api/mcp): Lyren Plan as tools for an AI assistant, over MCP's Streamable HTTP
// transport, stateless (no session id, no server-sent stream), JSON-RPC written by hand as SPEC §2 asks
// for no new dependency. Runtime-neutral: both gateways call serveMcp.
//
// Only personal access tokens reach it (directory/accessTokens.ts). Each tool is one request to the space API,
// sent through the same space host and gate (space/gate.ts) as the web app's, with the token as its
// credential: the gate's role, re-auth, size and write-budget rules apply unchanged, and the token's
// role cap with them. The tools' inputs are the API's own schemas (@shared/schemas) as JSON Schema, so
// the API's validation answers a bad call the way it answers the web app.

import { z } from 'zod';
import { PRIORITY_META, PRIORITY_VALUES } from '@shared/constants';
import {
  activityQueryInput,
  commentCreateInput,
  dashboardQueryInput,
  epicCreateInput,
  epicUpdateInput,
  milestoneCreateInput,
  milestoneUpdateInput,
  projectCreateInput,
  projectUpdateInput,
  searchQueryInput,
  tagCreateInput,
  taskBulkUpdateInput,
  taskCreateInput,
  taskQueryInput,
  taskUpdateInput,
  worklogCreateInput,
  worklogReportQuery,
} from '@shared/schemas';
import { sha256Hex } from '../core/crypto';
import { isSpaceId } from '../core/ids';
import type { DirectoryClient, SpaceHostClient, TokenSpace, TrustedMeta } from '../core/ports';
import { APP_VERSION } from '../core/version';

export interface McpDeps {
  /** The spaces the request's token reaches (null: the token is not valid). */
  tokenSpaces(): Promise<TokenSpace[] | null>;
  /** One space API request with the token: `path` as the space app knows it (/api/tasks/12). */
  callSpace(spaceId: string, method: string, path: string, body?: unknown): Promise<Response>;
}

/**
 * The McpDeps of a gateway: the token's spaces from the directory, and each call as a request to
 * /api/s/<spaceId>/… through the space host, with the token as the request's credential.
 */
export function gatewayMcpDeps(o: {
  request: Request;
  token: string;
  meta: TrustedMeta;
  directory: Pick<DirectoryClient, 'tokenSpaces'>;
  spaces: SpaceHostClient;
}): McpDeps {
  const tokenHash = sha256Hex(o.token);
  const meta: TrustedMeta = { ...o.meta, sessionTokenHash: tokenHash, sessionCookie: 'token' };
  return {
    tokenSpaces: () => o.directory.tokenSpaces({ tokenHash, client: { clientIp: o.meta.clientIp, userAgent: o.meta.userAgent } }),
    async callSpace(spaceId, method, path, body) {
      if (!isSpaceId(spaceId)) return json({ error: { code: 'not_found', message: 'No such space' } }, 404);
      const url = new URL(`/api/s/${spaceId}${path.slice('/api'.length)}`, o.request.url);
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { 'Content-Type': 'application/json' };
      }
      return o.spaces.serve(spaceId, new Request(url, init), meta);
    },
  };
}

/** Protocol versions this endpoint speaks, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** "0 No priority, 1 Low, …": priorities are numbers in the API. */
const PRIORITIES = PRIORITY_VALUES.map((p) => `${p} ${PRIORITY_META[p].label}`).join(', ');

const INSTRUCTIONS =
  'Lyren Plan is a project manager: spaces hold projects, which hold milestones, epics and tasks. Start with ' +
  'list_spaces, then get_space_overview for a space to learn its statuses, tags, people and projects (their ids ' +
  'are what the other tools take). Tasks have a number within their project and a reference such as "WEB-12". ' +
  `Priority is a number: ${PRIORITIES}.`;

type JsonObject = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  /** Extra properties beside `space` (path parameters such as the task id). */
  params?: Record<string, { type: 'integer' | 'string'; description: string }>;
  /** The request body (or, for GET, the query) schema; the tool's other inputs. */
  body?: z.ZodType;
  /** Whether the tool takes a space at all (list_spaces does not). */
  space?: false;
  run(args: JsonObject, deps: McpDeps): Promise<ToolResult>;
}

interface ToolResult {
  text: string;
  isError: boolean;
}

const idParam = (description: string) => ({ type: 'integer' as const, description });

/** Answer a tool with a space API response: its JSON as the text, an error when its status is not 2xx. */
async function fromResponse(res: Response): Promise<ToolResult> {
  const text = await res.text();
  return { text: text === '' ? `${res.status}` : text, isError: res.status < 200 || res.status >= 300 };
}

/** The arguments without the ones a tool reads itself (space, path parameters). */
function rest(args: JsonObject, ...names: string[]): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(args)) if (k !== 'space' && !names.includes(k)) out[k] = v;
  return out;
}

const spaceOf = (args: JsonObject) => String(args.space ?? '');
const intOf = (args: JsonObject, name: string) => {
  const v = args[name];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new ToolInputError(`${name} must be a positive integer`);
  return v;
};

class ToolInputError extends Error {}

const call = (method: string, path: (args: JsonObject) => string, body?: (args: JsonObject) => unknown) =>
  async (args: JsonObject, deps: McpDeps) => fromResponse(await deps.callSpace(spaceOf(args), method, path(args), body?.(args)));

/** `path` with the tool's other arguments (all but space and `names`) as its query string. */
const withQuery = (path: string, args: JsonObject, ...names: string[]) => {
  const query = new URLSearchParams(Object.entries(rest(args, ...names)).map(([k, v]): [string, string] => [k, String(v)])).toString();
  return query === '' ? path : `${path}?${query}`;
};

const TOOLS: Tool[] = [
  {
    name: 'list_spaces',
    description: 'The spaces this token reaches, with your role in each (the token may cap it).',
    space: false,
    run: async (_args, deps) => {
      const spaces = await deps.tokenSpaces();
      if (spaces === null) return { text: 'This token is no longer valid', isError: true };
      return { text: JSON.stringify({ spaces }), isError: false };
    },
  },
  {
    name: 'get_space_overview',
    description: "A space's statuses, tags, people, projects and settings: the ids the other tools take.",
    run: call('GET', () => '/api/bootstrap'),
  },
  {
    name: 'list_projects',
    description: "A space's projects, with their milestones' and epics' counts.",
    run: call('GET', () => '/api/projects'),
  },
  {
    name: 'search',
    description: 'Search a space by text: tasks, projects, epics and milestones whose title or reference matches.',
    body: searchQueryInput,
    run: call('GET', (a) => withQuery('/api/search', a)),
  },
  {
    name: 'query_tasks',
    description:
      'Tasks matching a filter (projects, statuses, status categories, priorities, tags, due dates, text), sorted and paged. ' +
      'Closed tasks are included unless filter.statusCategories or filter.closedWithinDays says otherwise.',
    body: taskQueryInput,
    run: call('POST', () => '/api/tasks/query', (a) => rest(a)),
  },
  {
    name: 'get_task',
    description: 'One task by its reference (such as "WEB-12") or its id.',
    params: {
      ref: { type: 'string', description: 'The task reference, such as WEB-12 (or give id)' },
      id: { type: 'integer', description: 'The task id (or give ref)' },
    },
    run: async (args, deps) => {
      const space = spaceOf(args);
      if (typeof args.ref === 'string' && args.ref !== '') {
        return fromResponse(await deps.callSpace(space, 'GET', `/api/tasks/ref/${encodeURIComponent(args.ref)}`));
      }
      return fromResponse(await deps.callSpace(space, 'GET', `/api/tasks/${intOf(args, 'id')}`));
    },
  },
  {
    name: 'get_task_timeline',
    description: "A task's comments, work logs and change history, oldest first.",
    params: { id: idParam('The task id') },
    run: call('GET', (a) => `/api/tasks/${intOf(a, 'id')}/timeline`),
  },
  {
    name: 'create_task',
    description: `Create a task in a project. Without statusId it gets the space's default status. Priority: ${PRIORITIES}.`,
    body: taskCreateInput,
    run: call('POST', () => '/api/tasks', (a) => rest(a)),
  },
  {
    name: 'update_task',
    description: `Change a task: give only the fields to change. Use statusId to move it, archived to archive it. Priority: ${PRIORITIES}.`,
    params: { id: idParam('The task id') },
    body: taskUpdateInput,
    run: call('PATCH', (a) => `/api/tasks/${intOf(a, 'id')}`, (a) => rest(a, 'id')),
  },
  {
    name: 'add_comment',
    description: 'Add a comment to a task (Markdown).',
    params: { taskId: idParam('The task id') },
    body: commentCreateInput,
    run: call('POST', (a) => `/api/tasks/${intOf(a, 'taskId')}/comments`, (a) => rest(a, 'taskId')),
  },
  {
    name: 'log_work',
    description: 'Log work on a task: a date and minutes spent, a note, or both.',
    params: { taskId: idParam('The task id') },
    body: worklogCreateInput,
    run: call('POST', (a) => `/api/tasks/${intOf(a, 'taskId')}/worklogs`, (a) => rest(a, 'taskId')),
  },
  {
    name: 'list_boards',
    description: "A space's saved boards (their filters and columns).",
    run: call('GET', () => '/api/boards'),
  },
  {
    name: 'bulk_update_tasks',
    description: `Change several tasks at once: status, priority, epic, due date, tags added or removed, archived. Priority: ${PRIORITIES}.`,
    body: taskBulkUpdateInput,
    run: call('POST', () => '/api/tasks/bulk', (a) => rest(a)),
  },
  {
    name: 'delete_task',
    description: 'Delete a task for good, with its comments and work logs. Prefer update_task with archived: true unless asked to delete.',
    params: { id: idParam('The task id') },
    run: call('DELETE', (a) => `/api/tasks/${intOf(a, 'id')}`),
  },
  {
    name: 'get_project',
    description: 'One project, with its task counts.',
    params: { id: idParam('The project id') },
    run: call('GET', (a) => `/api/projects/${intOf(a, 'id')}`),
  },
  {
    name: 'create_project',
    description: 'Create a project. Its key (such as WEB) prefixes its task references.',
    body: projectCreateInput,
    run: call('POST', () => '/api/projects', (a) => rest(a)),
  },
  {
    name: 'update_project',
    description: "Change a project's name, key, description, color or status: give only the fields to change.",
    params: { id: idParam('The project id') },
    body: projectUpdateInput,
    run: call('PATCH', (a) => `/api/projects/${intOf(a, 'id')}`, (a) => rest(a, 'id')),
  },
  {
    name: 'list_milestones',
    description: "A project's milestones, in order, with their dates and progress.",
    params: { projectId: idParam('The project id') },
    run: call('GET', (a) => `/api/projects/${intOf(a, 'projectId')}/milestones`),
  },
  {
    name: 'create_milestone',
    description: 'Create a milestone in a project.',
    body: milestoneCreateInput,
    run: call('POST', () => '/api/milestones', (a) => rest(a)),
  },
  {
    name: 'update_milestone',
    description: "Change a milestone's name, description, status or dates: give only the fields to change.",
    params: { id: idParam('The milestone id') },
    body: milestoneUpdateInput,
    run: call('PATCH', (a) => `/api/milestones/${intOf(a, 'id')}`, (a) => rest(a, 'id')),
  },
  {
    name: 'list_epics',
    description: "A project's epics, in order, with their milestone, dates and progress.",
    params: { projectId: idParam('The project id') },
    run: call('GET', (a) => `/api/projects/${intOf(a, 'projectId')}/epics`),
  },
  {
    name: 'create_epic',
    description: 'Create an epic in a project.',
    body: epicCreateInput,
    run: call('POST', () => '/api/epics', (a) => rest(a)),
  },
  {
    name: 'update_epic',
    description: "Change an epic's name, description, milestone, color, status or dates: give only the fields to change.",
    params: { id: idParam('The epic id') },
    body: epicUpdateInput,
    run: call('PATCH', (a) => `/api/epics/${intOf(a, 'id')}`, (a) => rest(a, 'id')),
  },
  {
    name: 'list_tags',
    description: "A space's tags, with how many tasks carry each.",
    run: call('GET', () => '/api/tags'),
  },
  {
    name: 'create_tag',
    description: 'Create a tag (then set it on tasks with update_task tagIds or addTagIds).',
    body: tagCreateInput,
    run: call('POST', () => '/api/tags', (a) => rest(a)),
  },
  {
    name: 'get_dashboard',
    description: "The space's dashboard: overdue and due-soon work, recent activity and progress by project.",
    body: dashboardQueryInput,
    run: call('GET', (a) => withQuery('/api/dashboard', a)),
  },
  {
    name: 'work_log_report',
    description: 'Work logged across tasks between two dates (default: the last 30 days), optionally for one project or person.',
    body: worklogReportQuery,
    run: call('GET', (a) => withQuery('/api/worklogs', a)),
  },
  {
    name: 'get_activity',
    description: 'Recent changes in the space, newest first, optionally for one project or task; page with before.',
    body: activityQueryInput,
    run: call('GET', (a) => withQuery('/api/activity', a)),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The JSON Schema of a tool's input: `space`, its path parameters and its body's properties. */
function inputSchema(tool: Tool): JsonObject {
  const body = tool.body ? (z.toJSONSchema(tool.body, { io: 'input', unrepresentable: 'any' }) as JsonObject) : {};
  const properties: JsonObject = { ...((body.properties as JsonObject | undefined) ?? {}) };
  const required = new Set<string>((body.required as string[] | undefined) ?? []);
  for (const [name, p] of Object.entries(tool.params ?? {})) properties[name] = p;
  if (tool.space !== false) {
    properties.space = { type: 'string', description: 'The space id (from list_spaces)' };
    required.add('space');
  }
  // get_task takes ref or id; every other path parameter is required.
  if (tool.name !== 'get_task') for (const name of Object.keys(tool.params ?? {})) required.add(name);
  const schema: JsonObject = { type: 'object', properties };
  if (required.size > 0) schema.required = [...required];
  return schema;
}

let toolList: JsonObject[] | null = null;
function listTools(): JsonObject[] {
  toolList ??= TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t) }));
  return toolList;
}

// ---- JSON-RPC -----------------------------------------------------------------------------------

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type RpcId = string | number;

const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: RpcId | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function dispatch(method: string, params: JsonObject, deps: McpDeps): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lyren-plan', version: APP_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listTools() };
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? TOOL_BY_NAME.get(params.name) : undefined;
      if (!tool) throw new RpcFailure(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as JsonObject) : {};
      if (tool.space !== false && (typeof args.space !== 'string' || args.space === '')) {
        return { content: [{ type: 'text', text: 'space is required (from list_spaces)' }], isError: true };
      }
      try {
        const result = await tool.run(args, deps);
        return { content: [{ type: 'text', text: result.text }], isError: result.isError };
      } catch (err) {
        if (err instanceof ToolInputError) return { content: [{ type: 'text', text: err.message }], isError: true };
        throw err;
      }
    }
    default:
      throw new RpcFailure(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * POST /api/mcp. The gateway has already checked the path, the token's format and the body's
 * Content-Length; the token's validity is checked by each call it makes (a revoked token gets 401s).
 */
export async function serveMcp(request: Request, deps: McpDeps): Promise<Response> {
  // Streamable HTTP: GET would open a server-sent stream, DELETE end a session; this endpoint has neither.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

  // An invalid token is told so at once, before anything is parsed (and before initialize succeeds).
  if ((await deps.tokenSpaces()) === null) return json(rpcError(null, INVALID_REQUEST, 'Invalid or expired token'), 401);

  let message: unknown;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return json(rpcError(null, PARSE_ERROR, 'Parse error'), 400);
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || (message as JsonObject).jsonrpc !== '2.0') {
    return json(rpcError(null, INVALID_REQUEST, 'Invalid request: one JSON-RPC 2.0 message per POST'), 400);
  }
  const m = message as JsonObject;
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;

  // A notification or a response from the client: accepted, nothing to answer.
  if (typeof m.method !== 'string') return new Response(null, { status: 202 });
  if (id === null) return new Response(null, { status: 202 });

  const params = m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? (m.params as JsonObject) : {};
  try {
    return json(rpcResult(id, await dispatch(m.method, params, deps)));
  } catch (err) {
    if (err instanceof RpcFailure) return json(rpcError(id, err.code, err.message));
    console.error('[lyren] An MCP request failed:', err);
    return json(rpcError(id, -32603, 'Internal error'));
  }
}
