# phi-spaces files

A filesystem for people and agent instances on phi-spaces, with Zanzibar-style relationships: every actor has a home,
teams share workspaces, roles are inherited from directories, and a revocation is seen by every operation admitted
after it. Files are UTF-8 text with versions; a save over a stale version is a conflict, never a silent overwrite.
The plan, with its phases and exit evidence, is `docs/zanzibar-agent-filesystem-plan.en.md`.

**Status: before phase 1 of that plan.** The directory has its manifest, its typecheck and test commands and the
`.env` loader the projects share (`server/env.ts`, kept the same as the others by `checks/shared-copies.test.mjs`).
Phase 1 (storage and identity spike) brings the service, the tenant queues, tenant initialization, actors with their
homes and the session adapter, and registers the application in the repository checks (`APPS` in `checks/roots.mjs`)
and the root scripts.

The application is a directory of its own and depends on the library as `"phi-spaces": "file:../spaces"`, importing
only `phi-spaces` and its exported subpaths. Unlike the other applications, the pilot embeds its Space host in the one
service process and runs only on this machine: no Docker, no Rust Space server, no deployment on big or nano (the
plan's section 2 and section 8). Its Spaces are never shown by the dashboard.

## Commands

From this directory (or with `npm --prefix spaces-files` from the repository root):

- `npm run typecheck` (own tsconfig, not part of the root `tsc`)
- `npm test` (node test runner, `tests/*.test.ts`)

Variables are read from `spaces-files/.env`; values already in the environment win.
