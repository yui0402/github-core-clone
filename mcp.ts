// The MCP endpoint (/mcp): JSON-RPC 2.0 over Streamable HTTP. Answers the
// modern server/discover probe (revision 2026-07-28) and the legacy
// initialize handshake, and exposes six tools over the same store as REST.

import { Store, VIEWER_LOGIN } from './store.ts';
import { repoJson, issueJson, createIssue, createPull, mergePull } from './domain.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The name of the branch to merge from.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The account owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

/** Normalized tool-name matching: lowercase, non-alphanumerics stripped. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const CANONICAL = new Map(TOOLS.map((tool) => [normalizeName(tool.name), tool.name]));

function findTool(name: string): string | null {
  const normalized = normalizeName(name);
  if (CANONICAL.has(normalized)) return CANONICAL.get(normalized) as string;
  for (const [canonical, original] of CANONICAL) {
    if (normalized.endsWith(canonical)) return original;
  }
  return null;
}

function textResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    isError,
  };
  if (!isError && value !== null && typeof value === 'object') {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

function missingArgResult(tool: string, arg: string): Record<string, unknown> {
  return textResult(`${tool}: missing required argument "${arg}"`, true);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (!tool) {
    throw Object.assign(new Error(`unknown tool ${name}`), { rpcCode: -32602 });
  }
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const requireArgs = (...keys: string[]): string | null => {
    for (const key of keys) {
      if (args[key] === undefined || args[key] === null || args[key] === '') return key;
    }
    return null;
  };

  switch (tool) {
    case 'create_repo': {
      const missing = requireArgs('name');
      if (missing) return missingArgResult(tool, missing);
      const repoName = str('name');
      const existing = store.repos.get(repoName);
      if (existing) return textResult(repoJson(existing));
      const repo = store.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      const missing = requireArgs('owner', 'repo');
      if (missing) return missingArgResult(tool, missing);
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return textResult(`repository ${str('owner')}/${str('repo')} not found`, true);
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const missing = requireArgs('owner', 'repo', 'title');
      if (missing) return missingArgResult(tool, missing);
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return textResult('repository not found', true);
      const result = createIssue(repo, {
        title: str('title'),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if (!result.ok) return textResult(result.message, true);
      return textResult(issueJson(repo, result.issue));
    }
    case 'list_issues': {
      const missing = requireArgs('owner', 'repo');
      if (missing) return missingArgResult(tool, missing);
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return textResult('repository not found', true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      return textResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const missing = requireArgs('owner', 'repo', 'title', 'head', 'base');
      if (missing) return missingArgResult(tool, missing);
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return textResult('repository not found', true);
      const result = createPull(repo, {
        title: str('title'),
        body: typeof args.body === 'string' ? args.body : '',
        head: str('head'),
        base: str('base'),
      });
      if (!result.ok) return textResult(result.message, true);
      return textResult({
        number: result.pull.number,
        title: result.pull.title,
        state: result.pull.state,
        head: { ref: result.pull.headRef },
        base: { ref: result.pull.baseRef },
      });
    }
    case 'merge_pull_request': {
      const missing = requireArgs('owner', 'repo', 'pull_number');
      if (missing) return missingArgResult(tool, missing);
      const repo = store.getRepo(str('owner'), str('repo'));
      if (!repo) return textResult('repository not found', true);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return textResult('pull request not found', true);
      const result = mergePull(repo, pull);
      if (!result.ok) return textResult(result.message, true);
      return textResult({ merged: true, sha: result.sha, number: pull.number });
    }
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { rpcCode: -32602 });
  }
}

export interface McpOutcome {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

/** Handle one /mcp request. `rawBody` is the unparsed request body. */
export function handleMcp(store: Store, method: string, rawBody: Buffer): McpOutcome {
  if (method === 'DELETE') return { status: 200, json: { ok: true } };
  if (method !== 'POST') return { status: 405, json: { error: 'method not allowed' } };

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as JsonRpcRequest;
  } catch {
    return {
      status: 400,
      json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const id = request.id ?? null;
  const rpcError = (code: number, message: string): McpOutcome => ({
    status: 200,
    json: { jsonrpc: '2.0', id, error: { code, message } },
  });
  const rpcResult = (result: unknown, headers?: Record<string, string>): McpOutcome => ({
    status: 200,
    json: { jsonrpc: '2.0', id, result },
    headers,
  });

  const methodName = typeof request.method === 'string' ? request.method : '';
  // Notifications carry no id and expect no JSON-RPC response.
  if (methodName.startsWith('notifications/')) {
    return { status: 202 };
  }

  switch (methodName) {
    case 'server/discover':
      return rpcResult({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = (request.params?.protocolVersion as string) ?? '2025-11-25';
      const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(
        { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
        { 'mcp-session-id': 'forge-session' },
      );
    }
    case 'ping':
      return rpcResult({});
    case 'tools/list':
      return rpcResult({ tools: TOOLS });
    case 'tools/call': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(callTool(store, toolName, args));
      } catch (err) {
        const code = (err as { rpcCode?: number }).rpcCode ?? -32602;
        return rpcError(code, err instanceof Error ? err.message : 'tool call failed');
      }
    }
    default:
      return rpcError(-32601, `Method not found: ${methodName}`);
  }
}

export { VIEWER_LOGIN };
