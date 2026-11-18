// The forge's single in-memory store: git objects, refs, and the REST/GraphQL/MCP
// resources (repos, labels, issues, pull requests, comments) that share them.
// Everything is a deterministic function of the requests received: ids come from
// counters, timestamps from a logical clock, ordering from creation sequence.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Logical clock base (2025-01-01T00:00:00Z); every mutation advances it by a minute. */
const CLOCK_BASE_SEC = 1735689600;
let clockTick = 0;

/** Current logical time in epoch seconds (deterministic; never the wall clock). */
export function nowSec(): number {
  clockTick += 1;
  return CLOCK_BASE_SEC + clockTick * 60;
}

/** ISO-8601 rendering of a logical epoch-second value. */
export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Git object primitives (SHA-1 object model, raw bytes preserved end to end)
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 of a git object: sha1("<type> <size>\0" + data), hex. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  timeSec: number;
}

/** Parse a commit object's header fields without touching its raw bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let timeSec = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) {
      const m = / (\d+) [+-]\d{4}$/.exec(line);
      if (m) timeSec = Number(m[1]);
    }
  }
  return { tree, parents, message, timeSec };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const mode = data.toString('utf8', i, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries in git order into raw tree-object bytes. */
export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag object: the oid and type it points at. */
export function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = ZERO_OID;
  let type = 'commit';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSec: number;
}

export interface Issue {
  /** Per-repo number, shared with pull requests (GitHub semantics). */
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSec: number;
  isPull: false;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSec: number | null;
  headRef: string;
  baseRef: string;
  /** Branch tips captured at creation time (REST reads these back). */
  headShaAtCreate: string;
  baseShaAtCreate: string;
  createdSec: number;
  isPull: true;
}

export class Repo {
  readonly dbId: number;
  readonly name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch = 'main';
  /** Git objects by sha, raw bytes preserved. */
  readonly objects = new Map<string, GitObject>();
  /** Full ref names ("refs/heads/main") to oids. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  /** Shared issue/PR number sequence (GitHub shares one counter per repo). */
  nextNumber = 1;
  readonly createdSec: number;

  constructor(dbId: number, name: string, isPrivate: boolean, description: string, createdSec: number) {
    this.dbId = dbId;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
    this.createdSec = createdSec;
  }

  get fullName(): string {
    return `${VIEWER_LOGIN}/${this.name}`;
  }

  headTarget(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** Tip oid of a branch by short name, or null when the branch does not exist. */
  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Store raw object bytes; returns the object's sha. Idempotent. */
  putObject(type: GitObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  getObject(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  commitInfo(sha: string): CommitInfo | null {
    const obj = this.objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Resolve any object to the commit it ultimately points at (tags peeled). */
  peelToCommit(sha: string): string | null {
    let current = sha;
    for (let depth = 0; depth < 16; depth += 1) {
      const obj = this.objects.get(current);
      if (!obj) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /**
   * Every object reachable from a commit (the commit, its ancestors, and all
   * trees/blobs they reference). `boundaries` are commits whose parents are
   * treated as already held (the client's shallow list).
   */
  reachableFrom(tips: Iterable<string>, boundaries?: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const tip of tips) {
      // Include tag objects themselves, then walk from the commit they name.
      let cursor = tip;
      while (true) {
        const obj = this.objects.get(cursor);
        if (!obj || obj.type !== 'tag') break;
        seen.add(cursor);
        cursor = parseTag(obj.data).object;
      }
      const commit = this.peelToCommit(tip);
      if (commit) stack.push(commit);
    }
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      const info = this.commitInfo(sha);
      if (!info) continue;
      seen.add(sha);
      this.addTreeClosure(info.tree, seen);
      if (boundaries && boundaries.has(sha)) continue;
      for (const parent of info.parents) {
        if (!seen.has(parent)) stack.push(parent);
      }
    }
    return seen;
  }

  /** Add a tree and everything under it to `seen`. */
  addTreeClosure(treeSha: string, seen: Set<string>): void {
    if (seen.has(treeSha)) return;
    const obj = this.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return;
    seen.add(treeSha);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') this.addTreeClosure(entry.sha, seen);
      else seen.add(entry.sha);
    }
  }

  /** Flatten a tree into path -> {sha, mode}; empty map for a missing tree. */
  flattenTree(treeSha: string | null, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
    if (!treeSha) return out;
    const obj = this.objects.get(treeSha);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.sha, path, out);
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
    return out;
  }

  /** Flattened files of a commit (empty map when the commit is unknown). */
  filesOfCommit(commitSha: string | null): Map<string, { sha: string; mode: string }> {
    if (!commitSha) return new Map();
    const info = this.commitInfo(commitSha);
    if (!info) return new Map();
    return this.flattenTree(info.tree);
  }

  /**
   * Set (or, with blobSha null, delete) the blob at `parts` under the tree
   * `treeSha` (null = empty tree), writing new trees. Returns the new tree sha.
   */
  treeSet(treeSha: string | null, parts: string[], blobSha: string | null, mode = '100644'): string {
    const entries: TreeEntry[] = treeSha
      ? parseTree((this.objects.get(treeSha) as GitObject).data).map((e) => ({ ...e }))
      : [];
    const [head, ...rest] = parts;
    const index = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobSha === null) {
        if (index !== -1) entries.splice(index, 1);
      } else if (index !== -1) {
        entries[index] = { mode, name: head, sha: blobSha };
      } else {
        entries.push({ mode, name: head, sha: blobSha });
      }
    } else {
      const childTree = index !== -1 && entries[index].mode === '40000' ? entries[index].sha : null;
      const newChild = this.treeSet(childTree, rest, blobSha, mode);
      if (index !== -1) entries.splice(index, 1);
      // Keep the subtree only if it still holds something.
      const childObj = this.objects.get(newChild);
      if (childObj && parseTree(childObj.data).length > 0) {
        entries.push({ mode: '40000', name: head, sha: newChild });
      }
    }
    return this.putObject('tree', buildTreeData(entries));
  }

  /** Create a commit object with the forge's deterministic identity/clock. */
  createCommit(treeSha: string, parents: string[], message: string, timeSec: number): string {
    const lines = [`tree ${treeSha}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    const identity = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${timeSec} +0000`;
    lines.push(`author ${identity}`);
    lines.push(`committer ${identity}`);
    const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
    return this.putObject('commit', data);
  }

  /** First common ancestor of two commits (BFS from both), or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOf = (start: string): Map<string, number> => {
      const depths = new Map<string, number>();
      const queue: Array<[string, number]> = [[start, 0]];
      while (queue.length > 0) {
        const [sha, depth] = queue.shift() as [string, number];
        if (depths.has(sha)) continue;
        depths.set(sha, depth);
        const info = this.commitInfo(sha);
        if (info) for (const parent of info.parents) queue.push([parent, depth + 1]);
      }
      return depths;
    };
    const fromA = ancestorsOf(a);
    const fromB = ancestorsOf(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [sha, depth] of fromA) {
      const other = fromB.get(sha);
      if (other !== undefined && depth + other < bestScore) {
        bestScore = depth + other;
        best = sha;
      }
    }
    return best;
  }

  /** True when `ancestor` is reachable from `descendant` (inclusive). */
  isAncestor(ancestor: string, descendant: string): boolean {
    const stack = [descendant];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = this.commitInfo(sha);
      if (info) for (const parent of info.parents) stack.push(parent);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoDbId = 1;
  private nextCommentId = 1;
  private requestSeq = 0;

  /** Deterministic request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoDbId, name, isPrivate, description, nowSec());
    this.nextRepoDbId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(name) ?? null;
  }

  nextComment(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }
}

// ---------------------------------------------------------------------------
// Global (GraphQL node) ids: opaque, stable, never the bare numeric id
// ---------------------------------------------------------------------------

export function repoNodeId(repo: Repo): string {
  return Buffer.from(`R:${repo.dbId}`, 'utf8').toString('base64');
}

export function issueNodeId(repo: Repo, issue: Issue): string {
  return Buffer.from(`I:${repo.dbId}:${issue.number}`, 'utf8').toString('base64');
}

export function pullNodeId(repo: Repo, pull: PullRequest): string {
  return Buffer.from(`P:${repo.dbId}:${pull.number}`, 'utf8').toString('base64');
}

export function commentNodeId(id: number): string {
  return Buffer.from(`C:${id}`, 'utf8').toString('base64');
}

export interface DecodedNodeId {
  kind: 'repo' | 'issue' | 'pull' | 'comment';
  repoDbId: number;
  number: number;
}

export function decodeNodeId(id: string): DecodedNodeId | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const m = /^([RIPC]):(\d+)(?::(\d+))?$/.exec(text);
  if (!m) return null;
  const kind = m[1] === 'R' ? 'repo' : m[1] === 'I' ? 'issue' : m[1] === 'P' ? 'pull' : 'comment';
  if (kind === 'repo') return { kind, repoDbId: Number(m[2]), number: 0 };
  if (kind === 'comment') return { kind, repoDbId: 0, number: Number(m[2]) };
  return { kind, repoDbId: Number(m[2]), number: Number(m[3]) };
}

export function repoByDbId(store: Store, dbId: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.dbId === dbId) return repo;
  }
  return null;
}
