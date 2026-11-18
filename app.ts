// The forge's HTTP server: one process serving git smart HTTP, REST v3,
// GraphQL v4 and MCP over a single shared store. Routing and auth live here;
// the surfaces live in git.ts, rest.ts, graphql.ts and mcp.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { advertiseReceivePack, advertiseUploadPack, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function isAuthed(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function hasAuthHeader(req: IncomingMessage): boolean {
  return typeof req.headers.authorization === 'string' && req.headers.authorization !== '';
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (status === 204) {
    res.writeHead(204, { 'content-type': JSON_TYPE, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = store.nextRequestId();
      const apiHeaders = { 'x-github-request-id': requestId };
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot probe.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ------------------------------------------------------------ REST
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const segments = pathname
            .slice('/api/v3'.length)
            .split('/')
            .filter((s) => s !== '')
            .map(decodeSegment);
          const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
          if (!isPublic && !isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, apiHeaders);
            return;
          }
          let body: Record<string, unknown> | null = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                body = (parsed ?? {}) as Record<string, unknown>;
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, apiHeaders);
                return;
              }
            } else {
              body = {};
            }
          }
          const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
          const result = handleRest(store, method, segments, url.searchParams, body, baseUrl, pathname);
          const headers = { ...apiHeaders, ...(result.headers ?? {}) };
          if (result.status === 204) {
            sendJson(res, 204, null, headers);
            return;
          }
          sendJson(res, result.status, result.json ?? {}, headers);
          return;
        }

        // --------------------------------------------------------- GraphQL
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
            return;
          }
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, apiHeaders);
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, apiHeaders);
            return;
          }
          const result = executeGraphql(store, parsed);
          sendJson(res, 200, result, apiHeaders);
          return;
        }

        // ------------------------------------------------------------- MCP
        if (pathname === '/mcp') {
          if (!hasAuthHeader(req) || !isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, apiHeaders);
            return;
          }
          const raw = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const outcome = handleMcp(store, method, raw);
          if (outcome.json === undefined) {
            res.writeHead(outcome.status, { ...apiHeaders, ...(outcome.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.json, { ...apiHeaders, ...(outcome.headers ?? {}) });
          return;
        }

        // ------------------------------------------------ Git smart HTTP
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeSegment(gitMatch[1]);
          const repoName = decodeSegment(gitMatch[2]);
          const route = gitMatch[3];
          if (!isAuthed(req)) {
            sendBytes(res, 401, Buffer.from('authentication required\n'), 'text/plain; charset=utf-8');
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendBytes(res, 404, Buffer.from('repository not found\n'), 'text/plain; charset=utf-8');
            return;
          }
          if (route === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service');
            if (service === 'git-upload-pack') {
              const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
              sendBytes(res, 200, advertiseUploadPack(repo, version2), 'application/x-git-upload-pack-advertisement');
              return;
            }
            if (service === 'git-receive-pack') {
              sendBytes(res, 200, advertiseReceivePack(repo), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendBytes(res, 400, Buffer.from('missing service\n'), 'text/plain; charset=utf-8');
            return;
          }
          if (route === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            try {
              const out = handleUploadPack(repo, raw, version2);
              sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
            } catch {
              sendBytes(res, 400, Buffer.from('invalid upload-pack request\n'), 'text/plain; charset=utf-8');
            }
            return;
          }
          if (route === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            try {
              const out = handleReceivePack(repo, raw);
              sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
            } catch {
              sendBytes(res, 400, Buffer.from('invalid receive-pack request\n'), 'text/plain; charset=utf-8');
            }
            return;
          }
          sendBytes(res, 405, Buffer.from('method not allowed\n'), 'text/plain; charset=utf-8');
          return;
        }

        // --------------------------------------------------------- fallback
        sendJson(res, 404, { message: 'Not Found' }, apiHeaders);
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal error' }, apiHeaders);
        } else {
          res.end();
        }
      }
    })();
  });
}
