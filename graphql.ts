// A small GraphQL executor covering exactly the surface the suite exercises:
// the gh / github-mcp-server documents, introspection of the named types,
// Relay node(id:), connections with cursor pagination, and the five client
// mutations. Unknown fields produce errors naming the field, per the spec.

import {
  Store, Repo, VIEWER_LOGIN, isoOf, nowSec,
  repoNodeId, issueNodeId, pullNodeId, commentNodeId, decodeNodeId, repoByDbId,
  type Issue, type PullRequest,
} from './store.ts';
import { createIssue, createPull, mergePull, pullConflicts, diffCommits } from './domain.ts';

// ---------------------------------------------------------------------------
// Lexer / parser for the GraphQL subset in the suite's documents
// ---------------------------------------------------------------------------

type Token = { kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:$@=!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  readonly fragments = new Map<string, SelectionNode[]>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth -= 1;
      else if (token.kind === 'eof') throw new Error('unexpected end of input');
    } while (depth > 0);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ operation: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.value === 'query' || token.value === 'mutation') {
        const operation = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.skipBalanced(); // variable definitions
        // Directives are not used by the suite; skip any.
        while (this.peek().value === '@') {
          this.next();
          this.next();
          if (this.peek().value === '(') this.skipBalanced();
        }
        operations.push({ operation, name, selection: this.parseSelectionSet() });
      } else if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.next(); // 'on'
        this.next(); // type condition
        this.fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return operations;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().value === '...') {
        this.next();
        if (this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.next().value });
        }
        continue;
      }
      let name = this.next().value;
      let alias: string | null = null;
      if (this.peek().value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args: Record<string, Value> = {};
      if (this.peek().value === '(') {
        this.next();
        while (this.peek().value !== ')') {
          const argName = this.next().value;
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.next();
      }
      while (this.peek().value === '@') {
        this.next();
        this.next();
        if (this.peek().value === '(') this.skipBalanced();
      }
      const selection = this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.next();
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.value === '[') {
      const values: Value[] = [];
      while (this.peek().value !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek().value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// Schema surface for introspection
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'comments', 'labels',
    'createdAt', 'updatedAt', 'closedAt', 'repository', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author',
    'createdAt', 'updatedAt', 'repository', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  Type: ['name', 'fields', 'enumValues', 'kind', 'description'],
  Field: ['name', 'description', 'type'],
  EnumValue: ['name', 'description'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueClosedStateReason: ['COMPLETED', 'NOT_PLANNED'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface GqlObject {
  type: string;
  value: unknown;
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: unknown[] }>;
  fragments: Map<string, SelectionNode[]>;
}

function obj(type: string, value: unknown): GqlObject {
  return { type, value };
}

function evalValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'variable': return ctx.variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((v) => evalValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value.fields)) out[key] = evalValue(v, ctx);
      return out;
    }
  }
}

function evalArgs(args: Record<string, Value>, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(args)) out[key] = evalValue(v, ctx);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  wrap: (item: T) => GqlObject;
  numberOf: (item: T) => number;
}

function makeConnection<T>(type: string, spec: ConnectionSpec<T>, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : spec.items.length;
  let startIndex = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberFromCursor(args.after);
    if (afterNumber !== null) {
      const idx = spec.items.findIndex((item) => spec.numberOf(item) === afterNumber);
      if (idx !== -1) startIndex = idx + 1;
    }
  }
  const page = spec.items.slice(startIndex, startIndex + first);
  const hasNext = startIndex + first < spec.items.length;
  const pageInfo = obj('PageInfo', {
    hasNextPage: hasNext,
    hasPreviousPage: startIndex > 0,
    startCursor: page.length > 0 ? cursorFor(spec.numberOf(page[0])) : null,
    endCursor: page.length > 0 ? cursorFor(spec.numberOf(page[page.length - 1])) : null,
  });
  return obj(type, {
    nodes: page.map((item) => spec.wrap(item)),
    pageInfo,
    totalCount: spec.items.length,
  });
}

function repoWrapper(repo: Repo): GqlObject {
  return obj('Repository', repo);
}

function issueWrapper(repo: Repo, issue: Issue): GqlObject {
  return obj('Issue', { repo, issue });
}

function pullWrapper(repo: Repo, pull: PullRequest): GqlObject {
  return obj('PullRequest', { repo, pull });
}

function resolveRepositoryField(repo: Repo, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  switch (field) {
    case 'id': return repoNodeId(repo);
    case 'databaseId': return repo.dbId;
    case 'name': return repo.name;
    case 'nameWithOwner': return repo.fullName;
    case 'owner': return obj('User', { login: VIEWER_LOGIN });
    case 'defaultBranchRef': {
      const tip = repo.branchTip(repo.defaultBranch);
      return tip ? obj('Ref', { name: repo.defaultBranch }) : null;
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'description': return repo.description;
    case 'isPrivate': return repo.isPrivate;
    case 'createdAt':
    case 'updatedAt': return isoOf(repo.createdSec);
    case 'url': return `https://github.invalid/${repo.fullName}`;
    case 'issue': {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueWrapper(repo, issue) : null;
    }
    case 'issues': {
      let list = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states && states.length > 0) {
        list = list.filter((i) => states.includes(i.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      list.sort((a, b) => a.number - b.number);
      if (orderBy && orderBy.direction === 'DESC') list.reverse();
      return makeConnection('IssueConnection', {
        items: list,
        wrap: (issue) => issueWrapper(repo, issue),
        numberOf: (issue) => issue.number,
      }, args);
    }
    case 'pullRequests': {
      const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      return makeConnection('PullRequestConnection', {
        items: list,
        wrap: (pull) => pullWrapper(repo, pull),
        numberOf: (pull) => pull.number,
      }, args);
    }
    case 'pullRequest': {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullWrapper(repo, pull) : null;
    }
    default: return undefined;
  }
}

function resolveIssueField(data: { repo: Repo; issue: Issue }, field: string): unknown {
  const { repo, issue } = data;
  switch (field) {
    case 'id': return issueNodeId(repo, issue);
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return issue.state.toUpperCase();
    case 'author': return obj('User', { login: VIEWER_LOGIN });
    case 'repository': return repoWrapper(repo);
    case 'createdAt':
    case 'updatedAt': return isoOf(issue.createdSec);
    case 'closedAt': return issue.state === 'closed' ? isoOf(issue.createdSec) : null;
    case 'url': return `https://github.invalid/${repo.fullName}/issues/${issue.number}`;
    case 'comments': {
      return makeConnection('IssueCommentConnection', {
        items: issue.comments,
        wrap: (c) => obj('IssueComment', { repo, issue, comment: c }),
        numberOf: (c) => c.id,
      }, {});
    }
    case 'labels': {
      return makeConnection('LabelConnection', {
        items: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
        wrap: (l) => obj('Label', l),
        numberOf: () => 0,
      }, {});
    }
    default: return undefined;
  }
}

function resolvePullField(data: { repo: Repo; pull: PullRequest }, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const { repo, pull } = data;
  switch (field) {
    case 'id': return pullNodeId(repo, pull);
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    case 'merged': return pull.merged;
    case 'mergeable': return pull.merged ? 'UNKNOWN' : pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'headRef': return obj('Ref', { name: pull.headRef });
    case 'baseRef': return obj('Ref', { name: pull.baseRef });
    case 'author': return obj('User', { login: VIEWER_LOGIN });
    case 'repository': return repoWrapper(repo);
    case 'createdAt':
    case 'updatedAt': return isoOf(pull.createdSec);
    case 'url': return `https://github.invalid/${repo.fullName}/pull/${pull.number}`;
    case 'files': {
      const headTip = repo.branchTip(pull.headRef) ?? pull.headShaAtCreate;
      const headCommit = repo.peelToCommit(headTip);
      const baseCommit = repo.peelToCommit(pull.baseShaAtCreate);
      const mergeBase = headCommit && baseCommit ? repo.mergeBase(headCommit, baseCommit) : null;
      const changes = diffCommits(repo, mergeBase ?? baseCommit, headCommit);
      return makeConnection('PullRequestFileConnection', {
        items: changes,
        wrap: (c) => obj('PullRequestFile', {
          path: c.path,
          additions: c.additions,
          deletions: c.deletions,
          changeType: c.status === 'added' ? 'ADDED' : c.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }),
        numberOf: () => 0,
      }, args);
    }
    default: return undefined;
  }
}

function resolveField(target: GqlObject, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const { type, value } = target;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return obj('User', { login: VIEWER_LOGIN });
      if (field === 'repository') {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoWrapper(repo) : null;
      }
      if (field === 'node') {
        const decoded = decodeNodeId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const repo = repoByDbId(ctx.store, decoded.repoDbId);
          return repo ? repoWrapper(repo) : null;
        }
        if (decoded.kind === 'issue') {
          const repo = repoByDbId(ctx.store, decoded.repoDbId);
          const issue = repo?.issues.get(decoded.number);
          return repo && issue ? issueWrapper(repo, issue) : null;
        }
        if (decoded.kind === 'pull') {
          const repo = repoByDbId(ctx.store, decoded.repoDbId);
          const pull = repo?.pulls.get(decoded.number);
          return repo && pull ? pullWrapper(repo, pull) : null;
        }
        if (decoded.kind === 'comment') {
          for (const repo of ctx.store.repos.values()) {
            for (const issue of repo.issues.values()) {
              const comment = issue.comments.find((c) => c.id === decoded.number);
              if (comment) return obj('IssueComment', { repo, issue, comment });
            }
          }
          return null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name]) return obj('Type', { name, fields: TYPE_FIELDS[name], enumValues: null });
        if (TYPE_ENUMS[name]) return obj('Type', { name, fields: null, enumValues: TYPE_ENUMS[name] });
        return null;
      }
      if (field === '__schema') return obj('Schema', {});
      return undefined;
    }
    case 'Mutation': {
      return resolveMutation(field, args, ctx);
    }
    case 'User': {
      const user = value as { login: string };
      if (field === 'login') return user.login;
      if (field === 'id') return Buffer.from(`U:${user.login === VIEWER_LOGIN ? 1000 : 0}`, 'utf8').toString('base64');
      if (field === 'name') return user.login === VIEWER_LOGIN ? 'ada iversen' : user.login;
      if (field === 'email') return user.login === VIEWER_LOGIN ? 'adaiversen@example.invalid' : null;
      if (field === 'url') return `https://github.invalid/${user.login}`;
      return undefined;
    }
    case 'Repository': return resolveRepositoryField(value as Repo, field, args, ctx);
    case 'Issue': return resolveIssueField(value as { repo: Repo; issue: Issue }, field);
    case 'PullRequest': return resolvePullField(value as { repo: Repo; pull: PullRequest }, field, args, ctx);
    case 'Ref': {
      const ref = value as { name: string };
      if (field === 'name') return ref.name;
      if (field === 'prefix') return `refs/heads/${ref.name}`.replace(new RegExp(`${ref.name}$`), '');
      return undefined;
    }
    case 'IssueComment': {
      const data = value as { comment: { id: number; body: string; createdSec: number } };
      if (field === 'id') return commentNodeId(data.comment.id);
      if (field === 'body') return data.comment.body;
      if (field === 'author') return obj('User', { login: VIEWER_LOGIN });
      if (field === 'createdAt' || field === 'updatedAt') return isoOf(data.comment.createdSec);
      return undefined;
    }
    case 'PageInfo': {
      const info = value as Record<string, unknown>;
      return field in info ? info[field] : undefined;
    }
    case 'Type': {
      const typeInfo = value as { name: string; fields: string[] | null; enumValues: string[] | null };
      if (field === 'name') return typeInfo.name;
      if (field === 'kind') return typeInfo.enumValues ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        return typeInfo.fields ? typeInfo.fields.map((name) => obj('Field', { name })) : null;
      }
      if (field === 'enumValues') {
        return typeInfo.enumValues ? typeInfo.enumValues.map((name) => obj('EnumValue', { name })) : null;
      }
      if (field === 'description') return null;
      return undefined;
    }
    case 'Field': {
      const f = value as { name: string };
      if (field === 'name') return f.name;
      if (field === 'description') return null;
      return undefined;
    }
    case 'EnumValue': {
      const e = value as { name: string };
      if (field === 'name') return e.name;
      if (field === 'description') return null;
      return undefined;
    }
    case 'Label': {
      const label = value as { name: string; color: string };
      if (field === 'name') return label.name;
      if (field === 'color') return label.color;
      if (field === 'id') return Buffer.from(`L:${label.name}`, 'utf8').toString('base64');
      return undefined;
    }
    case 'PullRequestFile': {
      const file = value as Record<string, unknown>;
      return field in file ? file[field] : undefined;
    }
    default: {
      // Connections and payloads carry plain records of wrapped values.
      if (value !== null && typeof value === 'object' && field in (value as Record<string, unknown>)) {
        return (value as Record<string, unknown>)[field];
      }
      return undefined;
    }
  }
}

function resolveMutation(field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      const repo = decoded ? repoByDbId(ctx.store, decoded.repoDbId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const result = createIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if (!result.ok) {
        ctx.errors.push({ message: result.message });
        return null;
      }
      return obj('CreateIssuePayload', { issue: issueWrapper(repo, result.issue), clientMutationId: null });
    }
    case 'closeIssue': {
      const decoded = decodeNodeId(String(input.issueId ?? ''));
      const repo = decoded ? repoByDbId(ctx.store, decoded.repoDbId) : null;
      const issue = repo && decoded ? repo.issues.get(decoded.number) : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Issue not found' });
        return null;
      }
      issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueWrapper(repo, issue), clientMutationId: null });
    }
    case 'createPullRequest': {
      const decoded = decodeNodeId(String(input.repositoryId ?? ''));
      const repo = decoded ? repoByDbId(ctx.store, decoded.repoDbId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const result = createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? 'main'),
      });
      if (!result.ok) {
        ctx.errors.push({ message: result.message });
        return null;
      }
      return obj('CreatePullRequestPayload', { pullRequest: pullWrapper(repo, result.pull), clientMutationId: null });
    }
    case 'mergePullRequest': {
      const decoded = decodeNodeId(String(input.pullRequestId ?? ''));
      const repo = decoded ? repoByDbId(ctx.store, decoded.repoDbId) : null;
      const pull = repo && decoded ? repo.pulls.get(decoded.number) : undefined;
      if (!repo || !pull) {
        ctx.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const result = mergePull(repo, pull);
      if (!result.ok) {
        ctx.errors.push({ message: result.message });
        return null;
      }
      return obj('MergePullRequestPayload', { pullRequest: pullWrapper(repo, pull), clientMutationId: null });
    }
    case 'addComment': {
      const decoded = decodeNodeId(String(input.subjectId ?? ''));
      const repo = decoded ? repoByDbId(ctx.store, decoded.repoDbId) : null;
      const issue = repo && decoded && decoded.kind === 'issue' ? repo.issues.get(decoded.number) : undefined;
      if (!repo || !issue) {
        ctx.errors.push({ message: 'Subject not found' });
        return null;
      }
      const comment = {
        id: ctx.store.nextComment(),
        body: String(input.body ?? ''),
        createdSec: nowSec(),
      };
      issue.comments.push(comment);
      const node = obj('IssueComment', { repo, issue, comment });
      return obj('AddCommentPayload', {
        commentEdge: obj('IssueCommentEdge', { node, cursor: cursorFor(comment.id) }),
        subject: issueWrapper(repo, issue),
        clientMutationId: null,
      });
    }
    default:
      return undefined;
  }
}

function executeSelectionSet(
  target: GqlObject,
  selections: SelectionNode[],
  ctx: Ctx,
  path: unknown[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === target.type) {
        Object.assign(out, executeSelectionSet(target, selection.selection, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(target, fragment, ctx, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args = evalArgs(selection.args, ctx);
    const raw = resolveField(target, selection.name, args, ctx);
    if (raw === undefined) {
      ctx.errors.push({
        message: `Field '${selection.name}' doesn't exist on type '${target.type}'`,
        path: [...path, key],
      });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(raw, selection, ctx, [...path, key]);
  }
  return out;
}

function completeValue(raw: unknown, selection: FieldNode, ctx: Ctx, path: unknown[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    return raw.map((item) => completeValue(item, selection, ctx, path));
  }
  if (typeof raw === 'object' && raw !== null && 'type' in (raw as Record<string, unknown>) && 'value' in (raw as Record<string, unknown>)) {
    const wrapped = raw as GqlObject;
    if (!selection.selection) return null;
    return executeSelectionSet(wrapped, selection.selection, ctx, path);
  }
  if (typeof raw === 'object') {
    // Plain records (payload internals/connections) wrapped implicitly.
    if (!selection.selection) return raw;
    return executeSelectionSet(obj(selection.name, raw), selection.selection, ctx, path);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphqlResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: unknown[] }>;
}

export function executeGraphql(store: Store, body: unknown): GraphqlResult | GraphqlResult[] {
  if (Array.isArray(body)) {
    return body.map((operation) => executeOne(store, operation) as GraphqlResult);
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): GraphqlResult {
  const operation = (body ?? {}) as { query?: unknown; variables?: unknown };
  if (typeof operation.query !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  let operations: OperationNode[];
  let fragments: Map<string, SelectionNode[]>;
  try {
    const parser = new Parser(operation.query);
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const op = operations[0];
  if (!op) return { errors: [{ message: 'no operation found' }] };
  const ctx: Ctx = {
    store,
    variables: (operation.variables ?? {}) as Record<string, unknown>,
    errors: [],
    fragments,
  };
  const root = obj(op.operation === 'mutation' ? 'Mutation' : 'Query', null);
  // Mutations resolve through the Mutation root; queries through Query. The
  // resolveField switch keys root handling on the wrapper type, so give the
  // query root the Query type and dispatch mutation fields from it too.
  const rootForExec = op.operation === 'mutation' ? obj('Mutation', null) : obj('Query', null);
  void root;
  const data = executeSelectionSet(rootForExec, op.selection, ctx, []);
  const result: GraphqlResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
