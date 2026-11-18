# github-core-clone

A standalone, GitHub-compatible git forge in TypeScript (Node.js standard
library only — no dependencies, no git binary), built for the make.fun
`github-core-clone-01` bounty.

One process serves, from a single in-memory store:

- **Git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch with shallow /
  deepen support) and v0, receive-pack v0 with report-status; fast-forward
  enforcement; real SHA-1 object model with packfile read/write.
- **REST v3** under `/api/v3` — repositories, contents (backed by real git
  trees/commits), labels, issues, comments, pull requests with squash merges,
  branches, refs and commit history, with GitHub-style pagination.
- **GraphQL v4** at `/api/graphql` — the query/mutation surface used by `gh`
  and `github-mcp-server`, introspection, Relay `node(id:)` and cursor
  connections.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP (modern
  `server/discover` plus the legacy initialize handshake) with six tools that
  act on the same store as REST.

## Run

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22. The program binds an
ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, serves until
the suite answers `{"done": true}` on `$MAKEFUN_ENV_URL/done`, then exits 0.
Authentication is the trial bearer token in `$MAKEFUN_SHOP_TOKEN`.

## Layout

- `main.ts` — entry <-> env lifecycle (from the contest starter).
- `app.ts` — HTTP routing and auth.
- `store.ts` — the in-memory store and git object primitives.
- `git.ts` — pkt-lines, packfiles, upload-pack / receive-pack.
- `rest.ts` — the REST v3 surface.
- `domain.ts` — issues, pull requests, diffs and merges shared by all surfaces.
- `graphql.ts` — the GraphQL executor.
- `mcp.ts` — the MCP endpoint.

MIT licensed.
