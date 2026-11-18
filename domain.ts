// Shared domain operations used identically by REST, GraphQL and MCP, so an
// object created on one surface reads back the same on every other surface.

import {
  Repo, Store, VIEWER_LOGIN, isoOf, nowSec,
  type Issue, type PullRequest,
} from './store.ts';

// ---------------------------------------------------------------------------
// Serializers (REST shapes)
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    html_url: `https://github.invalid/${repo.fullName}`,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.createdSec),
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.dbId * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label ? label.color : 'ededed' };
    }),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.createdSec),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    pull_request: undefined,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  // The checks assert head/base shas are the branch tips at creation time.
  const headTip = pull.headShaAtCreate;
  const baseTip = pull.baseShaAtCreate;
  const out: Record<string, unknown> = {
    id: repo.dbId * 100000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: {
      ref: pull.headRef,
      sha: headTip,
      label: `${VIEWER_LOGIN}:${pull.headRef}`,
      repo: { name: repo.name, full_name: repo.fullName },
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip,
      label: `${VIEWER_LOGIN}:${pull.baseRef}`,
      repo: { name: repo.name, full_name: repo.fullName },
    },
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.createdSec),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
  };
  if (pull.merged) {
    out.merged_at = isoOf(pull.mergedSec ?? pull.createdSec);
    out.merge_commit_sha = pull.mergeCommitSha;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type CreateIssueResult =
  | { ok: true; issue: Issue }
  | { ok: false; status: number; message: string };

export function createIssue(
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): CreateIssueResult {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) {
      return { ok: false, status: 422, message: `Label "${name}" does not exist in ${repo.fullName}` };
    }
  }
  const issue: Issue = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSec: nowSec(),
    isPull: false,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { ok: true, issue };
}

// ---------------------------------------------------------------------------
// File diffs between two commits (path set + line counts)
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-diff counts between two blob versions (LCS-based; files are small). */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const a = oldData ? countLines(oldData) : [];
  const b = newData ? countLines(newData) : [];
  // LCS dynamic program over lines.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: b.length - common, deletions: a.length - common };
}

/** Every path that differs between two commits' trees. */
export function diffCommits(repo: Repo, fromCommit: string | null, toCommit: string | null): FileChange[] {
  const before = repo.filesOfCommit(fromCommit);
  const after = repo.filesOfCommit(toCommit);
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && newEntry && oldEntry.sha === newEntry.sha) continue;
    const oldData = oldEntry ? (repo.getObject(oldEntry.sha)?.data ?? null) : null;
    const newData = newEntry ? (repo.getObject(newEntry.sha)?.data ?? null) : null;
    const { additions, deletions } = lineDiff(oldData, newData);
    changes.push({
      path,
      status: !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified',
      additions,
      deletions,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Pull requests: creation, mergeability, squash merge
// ---------------------------------------------------------------------------

export type CreatePullResult =
  | { ok: true; pull: PullRequest }
  | { ok: false; status: number; message: string };

export function createPull(
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): CreatePullResult {
  const headTip = repo.branchTip(input.head);
  if (!headTip) return { ok: false, status: 422, message: `Head branch "${input.head}" does not exist` };
  const baseTip = repo.branchTip(input.base);
  if (!baseTip) return { ok: false, status: 422, message: `Base branch "${input.base}" does not exist` };
  const pull: PullRequest = {
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedSec: null,
    headRef: input.head,
    baseRef: input.base,
    headShaAtCreate: headTip,
    baseShaAtCreate: baseTip,
    createdSec: nowSec(),
    isPull: true,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { ok: true, pull };
}

/**
 * Mergeability against the CURRENT base tip: the head's changes since the
 * merge base conflict when the base also changed the same path to a
 * different result.
 */
export function pullConflicts(repo: Repo, pull: PullRequest): boolean {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) return true;
  const headCommit = repo.peelToCommit(headTip);
  const baseCommit = repo.peelToCommit(baseTip);
  if (!headCommit || !baseCommit) return true;
  const base = repo.mergeBase(headCommit, baseCommit);
  if (!base) return true;
  if (base === baseCommit || base === headCommit) return false;
  const headChanges = new Map(diffCommits(repo, base, headCommit).map((c) => [c.path, c]));
  const baseChanges = new Map(diffCommits(repo, base, baseCommit).map((c) => [c.path, c]));
  const headFiles = repo.filesOfCommit(headCommit);
  const baseFiles = repo.filesOfCommit(baseCommit);
  for (const path of headChanges.keys()) {
    if (!baseChanges.has(path)) continue;
    const headSha = headFiles.get(path)?.sha ?? null;
    const baseSha = baseFiles.get(path)?.sha ?? null;
    if (headSha !== baseSha) return true;
  }
  return false;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; status: number; message: string };

/** Squash-merge a pull request onto its base branch's current tip. */
export function mergePull(repo: Repo, pull: PullRequest): MergeResult {
  if (pull.merged) return { ok: false, status: 405, message: 'Pull request was already merged' };
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is not open' };
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (!headTip || !baseTip) return { ok: false, status: 405, message: 'A branch tip is missing' };
  const headCommit = repo.peelToCommit(headTip);
  const baseCommit = repo.peelToCommit(baseTip);
  if (!headCommit || !baseCommit) return { ok: false, status: 405, message: 'A branch tip is not a commit' };
  if (pullConflicts(repo, pull)) {
    return { ok: false, status: 405, message: 'Pull request has conflicts and cannot be merged' };
  }
  const mergeBase = repo.mergeBase(headCommit, baseCommit);
  // Result tree: the base tip's tree with the head's changes (relative to the
  // merge base) applied on top.
  const baseFiles = repo.filesOfCommit(mergeBase);
  const headFiles = repo.filesOfCommit(headCommit);
  let tree = repo.commitInfo(baseCommit)?.tree ?? null;
  const changedPaths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of changedPaths) {
    const inBase = baseFiles.get(path)?.sha ?? null;
    const inHead = headFiles.get(path)?.sha ?? null;
    if (inBase === inHead) continue;
    tree = repo.treeSet(tree, path.split('/'), inHead, headFiles.get(path)?.mode ?? '100644');
  }
  const sec = nowSec();
  const sha = repo.createCommit(tree as string, [baseCommit], pull.title, sec);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedSec = sec;
  return { ok: true, sha };
}

/** Look up a repo by owner/name through the store (viewer-owned only). */
export function findRepo(store: Store, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name);
}
