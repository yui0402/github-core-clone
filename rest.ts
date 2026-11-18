// The REST v3 surface under /api/v3: repositories, contents, labels, issues,
// comments, pull requests, branches, refs and commits — all over the shared
// store, with real git hashing underneath.

import {
  Repo, Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, isoOf, nowSec,
  parseCommit, parseTree,
} from './store.ts';
import {
  repoJson, issueJson, pullJson, createIssue, createPull,
  diffCommits, mergePull,
} from './domain.ts';

export interface RestResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResult => ({ status: 404, json: { message: 'Not Found' } });
const unprocessable = (message: string): RestResult => ({ status: 422, json: { message } });

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

/** Slice a list by page/per_page and build the GitHub-style Link header. */
function paginate(all: unknown[], query: URLSearchParams, baseUrl: string, path: string): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const lastPage = Math.ceil(all.length / perPage);
    const sep = path.includes('?') ? '&' : '?';
    const cleanPath = path.split('?')[0];
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const next = `${baseUrl}${cleanPath}?${params.toString()}`;
    params.set('page', String(lastPage));
    const last = `${baseUrl}${cleanPath}?${params.toString()}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
    void sep;
  }
  return { items, headers };
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  baseUrl: string,
  pathname: string,
): RestResult {
  // segments are the path parts after /api/v3, percent-decoded.
  const [s0, s1, s2] = segments;

  if (segments.length === 0) {
    return {
      status: 200,
      json: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (s0 === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, json: { installed_version: '1.0.0-forge', verifiable_password_authentication: false } };
  }
  if (s0 === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: 'User',
      },
    };
  }
  if (s0 === 'user' && s1 === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].map((repo) => repoJson(repo));
      const page = paginate(all, query, baseUrl, pathname);
      return { status: 200, json: page.items, headers: page.headers };
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('name is required');
      if (store.repos.has(name)) {
        return unprocessable(`name already exists on this account`);
      }
      const repo = store.createRepo(
        name,
        body?.private === true,
        typeof body?.description === 'string' ? body.description : '',
      );
      return { status: 201, json: repoJson(repo) };
    }
    return notFound();
  }

  if (s0 === 'repos' && s1 !== undefined && s2 !== undefined) {
    const owner = s1;
    const repoName = s2;
    const repo = store.getRepo(owner, repoName);
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (!repo) return notFound();
      if (method === 'GET') return { status: 200, json: repoJson(repo) };
      if (method === 'PATCH') {
        if (typeof body?.description === 'string') repo.description = body.description;
        if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
        return { status: 200, json: repoJson(repo) };
      }
      if (method === 'DELETE') {
        store.repos.delete(repoName);
        return { status: 204 };
      }
      return notFound();
    }
    if (!repo) return notFound();
    return handleRepoScoped(store, repo, method, rest, query, body, baseUrl, pathname);
  }

  return notFound();
}

function handleRepoScoped(
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  baseUrl: string,
  pathname: string,
): RestResult {
  const [head, ...tail] = rest;

  if (head === 'labels' && tail.length === 0 && method === 'POST') {
    const name = typeof body?.name === 'string' ? body.name : '';
    if (name === '') return unprocessable('name is required');
    if (repo.labels.has(name)) return unprocessable(`label "${name}" already exists`);
    const color = typeof body?.color === 'string' ? body.color : 'ededed';
    repo.labels.set(name, { name, color });
    return { status: 201, json: { name, color, default: false } };
  }

  if (head === 'issues') return handleIssues(store, repo, method, tail, query, body, baseUrl, pathname);
  if (head === 'pulls') return handlePulls(repo, method, tail, query, body, baseUrl, pathname);
  if (head === 'contents') return handleContents(repo, method, tail, query, body);
  if (head === 'branches') return handleBranches(repo, method, tail);
  if (head === 'commits' && tail.length === 0 && method === 'GET') {
    return handleCommits(repo, query);
  }
  if (head === 'git' && tail[0] === 'refs') {
    return handleGitRefs(repo, method, tail.slice(1), body);
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Issues and comments
// ---------------------------------------------------------------------------

function handleIssues(
  store: Store,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  baseUrl: string,
  pathname: string,
): RestResult {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') return unprocessable('title is required');
      const labels = Array.isArray(body?.labels)
        ? body.labels.filter((l): l is string => typeof l === 'string')
        : undefined;
      const result = createIssue(repo, {
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        labels,
      });
      if (!result.ok) return { status: result.status, json: { message: result.message } };
      return { status: 201, json: issueJson(repo, result.issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const direction = query.get('direction') ?? 'asc';
      list.sort((a, b) => a.number - b.number);
      if (direction === 'desc') list.reverse();
      const page = paginate(list.map((i) => issueJson(repo, i)), query, baseUrl, pathname);
      return { status: 200, json: page.items, headers: page.headers };
    }
    return notFound();
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, json: issueJson(repo, issue) };
    if (method === 'PATCH') {
      if (body?.state === 'closed' || body?.state === 'open') issue.state = body.state;
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      if (Array.isArray(body?.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const name of labels) {
          if (!repo.labels.has(name)) return unprocessable(`Label "${name}" does not exist`);
        }
        issue.labels = labels;
      }
      return { status: 200, json: issueJson(repo, issue) };
    }
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      const comment = { id: store.nextComment(), body: text, createdSec: nowSec() };
      issue.comments.push(comment);
      return {
        status: 201,
        json: {
          id: comment.id,
          body: comment.body,
          created_at: isoOf(comment.createdSec),
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        },
      };
    }
    if (method === 'GET') {
      return {
        status: 200,
        json: issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          created_at: isoOf(c.createdSec),
          user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        })),
      };
    }
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function handlePulls(
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  baseUrl: string,
  pathname: string,
): RestResult {
  if (tail.length === 0) {
    if (method === 'POST') {
      const result = createPull(repo, {
        title: typeof body?.title === 'string' ? body.title : '',
        body: typeof body?.body === 'string' ? body.body : '',
        head: typeof body?.head === 'string' ? body.head : '',
        base: typeof body?.base === 'string' ? body.base : 'main',
      });
      if (!result.ok) return { status: result.status, json: { message: result.message } };
      return { status: 201, json: pullJson(repo, result.pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const page = paginate(list.map((p) => pullJson(repo, p)), query, baseUrl, pathname);
      return { status: 200, json: page.items, headers: page.headers };
    }
    return notFound();
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (tail.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return { status: 200, json: pullJson(repo, pull) };
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pull) return notFound();
    const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
    const headCommit = repo.peelToCommit(headTip);
    const baseCommit = repo.peelToCommit(pull.baseShaAtCreate);
    const mergeBase = headCommit && baseCommit ? repo.mergeBase(headCommit, baseCommit) : null;
    const changes = diffCommits(repo, mergeBase ?? baseCommit, headCommit);
    return {
      status: 200,
      json: changes.map((c) => ({
        filename: c.path,
        status: c.status === 'modified' ? 'modified' : c.status,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.additions + c.deletions,
      })),
    };
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) return notFound();
    const result = mergePull(repo, pull);
    if (!result.ok) return { status: result.status, json: { message: result.message } };
    return { status: 200, json: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function resolveBranchTip(repo: Repo, branch: string): { tip: string | null; tree: string | null } {
  const tip = repo.branchTip(branch);
  if (!tip) return { tip: null, tree: null };
  const commit = repo.peelToCommit(tip);
  if (!commit) return { tip, tree: null };
  const info = repo.commitInfo(commit);
  return { tip: commit, tree: info ? info.tree : null };
}

/** Walk a tree to the entry at `parts`; returns {kind, sha} or null. */
function lookupPath(repo: Repo, treeSha: string | null, parts: string[]): { kind: 'file' | 'dir'; sha: string } | null {
  if (parts.length === 0) return treeSha ? { kind: 'dir', sha: treeSha } : null;
  if (!treeSha) return null;
  const obj = repo.getObject(treeSha);
  if (!obj || obj.type !== 'tree') return null;
  const entries = parseTree(obj.data);
  const entry = entries.find((e) => e.name === parts[0]);
  if (!entry) return null;
  if (parts.length === 1) {
    return { kind: entry.mode === '40000' ? 'dir' : 'file', sha: entry.sha };
  }
  if (entry.mode !== '40000') return null;
  return lookupPath(repo, entry.sha, parts.slice(1));
}

function handleContents(
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResult {
  const path = tail.join('/');
  const parts = tail.filter((p) => p !== '');

  if (method === 'GET') {
    const branch = query.get('ref') ?? repo.defaultBranch;
    const { tree } = resolveBranchTip(repo, branch);
    if (tree === null && parts.length > 0) return notFound();
    const found = lookupPath(repo, tree, parts);
    if (!found) return notFound();
    if (found.kind === 'dir') {
      const obj = repo.getObject(found.sha);
      if (!obj) return notFound();
      const entries = parseTree(obj.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: parts.length === 0 ? entry.name : `${path}/${entry.name}`,
        sha: entry.sha,
        size: entry.mode === '40000' ? 0 : (repo.getObject(entry.sha)?.data.length ?? 0),
      }));
      return { status: 200, json: entries };
    }
    const obj = repo.getObject(found.sha);
    if (!obj) return notFound();
    return {
      status: 200,
      json: {
        type: 'file',
        name: parts[parts.length - 1] ?? '',
        path,
        sha: found.sha,
        size: obj.data.length,
        encoding: 'base64',
        content: obj.data.toString('base64'),
      },
    };
  }

  if (method === 'PUT') {
    const message = typeof body?.message === 'string' ? body.message : '';
    const contentB64 = typeof body?.content === 'string' ? body.content : '';
    const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const data = Buffer.from(contentB64, 'base64');
    const blobSha = repo.putObject('blob', data);

    let { tip, tree } = resolveBranchTip(repo, branch);
    if (tip === null) {
      // A PUT naming a branch that does not exist yet creates it, forked from
      // the default branch tip (or as the repo's first branch when unborn).
      const fallback = resolveBranchTip(repo, repo.defaultBranch);
      tip = fallback.tip;
      tree = fallback.tree;
    }
    const existing = lookupPath(repo, tree, parts);
    const isCreate = !existing || existing.kind !== 'file';
    if (!isCreate && typeof body?.sha === 'string' && body.sha !== existing.sha) {
      return { status: 409, json: { message: 'sha does not match the current file sha' } };
    }
    const newTree = repo.treeSet(tree, parts, blobSha);
    const commitSha = repo.createCommit(newTree, tip ? [tip] : [], message, nowSec());
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return {
      status: isCreate ? 201 : 200,
      json: {
        content: {
          name: parts[parts.length - 1] ?? '',
          path,
          sha: blobSha,
          size: data.length,
          encoding: 'base64',
        },
        commit: { sha: commitSha },
      },
    };
  }

  if (method === 'DELETE') {
    const message = typeof body?.message === 'string' ? body.message : '';
    const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const { tip, tree } = resolveBranchTip(repo, branch);
    const existing = lookupPath(repo, tree, parts);
    if (!existing || existing.kind !== 'file') return notFound();
    if (typeof body?.sha === 'string' && body.sha !== existing.sha) {
      return { status: 409, json: { message: 'sha does not match the current file sha' } };
    }
    const newTree = repo.treeSet(tree, parts, null);
    const commitSha = repo.createCommit(newTree, tip ? [tip] : [], message, nowSec());
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { status: 200, json: { content: null, commit: { sha: commitSha } } };
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Branches, refs, commits
// ---------------------------------------------------------------------------

function handleBranches(repo: Repo, method: string, tail: string[]): RestResult {
  if (method !== 'GET') return notFound();
  if (tail.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, json: branches };
  }
  const branch = tail.join('/');
  const tip = repo.branchTip(branch);
  if (!tip) return notFound();
  const commit = repo.peelToCommit(tip);
  const info = commit ? repo.commitInfo(commit) : null;
  return {
    status: 200,
    json: {
      name: branch,
      commit: {
        sha: commit ?? tip,
        commit: { message: info ? info.message : '' },
      },
    },
  };
}

function handleGitRefs(
  repo: Repo,
  method: string,
  tail: string[],
  body: Record<string, unknown> | null,
): RestResult {
  if (tail.length === 0 && method === 'POST') {
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    const sha = typeof body?.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !repo.getObject(sha)) {
      return unprocessable('ref or sha is invalid');
    }
    repo.refs.set(ref, sha);
    const obj = repo.getObject(sha);
    return { status: 201, json: { ref, object: { sha, type: obj?.type ?? 'commit' } } };
  }
  if (method === 'GET' && tail[0] === 'heads' && tail.length >= 2) {
    const branch = tail.slice(1).join('/');
    const tip = repo.branchTip(branch);
    if (!tip) return notFound();
    return {
      status: 200,
      json: { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } },
    };
  }
  return notFound();
}

function handleCommits(repo: Repo, query: URLSearchParams): RestResult {
  const shaParam = query.get('sha');
  let start: string | null = null;
  if (shaParam) {
    start = repo.branchTip(shaParam) ?? (repo.getObject(shaParam) ? shaParam : null);
    if (start) start = repo.peelToCommit(start) ?? start;
  } else {
    const tip = repo.branchTip(repo.defaultBranch);
    start = tip ? repo.peelToCommit(tip) : null;
  }
  if (!start) return { status: 200, json: [] };
  // Breadth-first walk from the tip: linear histories list newest first.
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const info = repo.commitInfo(sha);
    if (!info) continue;
    order.push(sha);
    for (const parent of info.parents) queue.push(parent);
  }
  const items = order.map((sha) => {
    const obj = repo.getObject(sha);
    const raw = obj ? obj.data.toString('utf8') : '';
    const info = parseCommit(obj?.data ?? Buffer.alloc(0));
    const authorLine = /^author (.*)$/m.exec(raw)?.[1] ?? '';
    const authorMatch = /^(.*) <(.*)> (\d+) /.exec(authorLine);
    return {
      sha,
      commit: {
        message: info.message,
        author: {
          name: authorMatch ? authorMatch[1] : '',
          email: authorMatch ? authorMatch[2] : '',
          date: authorMatch ? isoOf(Number(authorMatch[3])) : isoOf(info.timeSec),
        },
        committer: {
          name: authorMatch ? authorMatch[1] : '',
          email: authorMatch ? authorMatch[2] : '',
          date: authorMatch ? isoOf(Number(authorMatch[3])) : isoOf(info.timeSec),
        },
      },
      parents: info.parents.map((p) => ({ sha: p })),
    };
  });
  return { status: 200, json: items };
}
