# phi-spaces files

A filesystem for people and agent instances on phi-spaces, with Zanzibar-style relationships: every actor has a home,
teams share workspaces, roles are inherited from directories, and a revocation is seen by every operation admitted
after it. Files are UTF-8 text with versions; a save over a stale version is a conflict, never a silent overwrite.
The plan, with its phases and exit evidence, is `docs/zanzibar-agent-filesystem-plan.en.md`.

**Status: phase 1 of that plan, steps 1 to 5.** The application is registered in the repository checks (`APPS` in
`checks/roots.mjs`) and the root scripts. The service process (`server/launch.ts`, `server/service.ts`) opens phi-spaces'
own SQLite store in a data directory it refuses when group or others can reach it. The store's owner lock refuses a
second process, and a crash releases it. The service runs the reaper (`startService`) and reserves one private named
Space per tenant (alias `t-<tenantId>`), reached only through that tenant's queue. Admission (`server/admission.ts`)
gives each tenant a bounded queue that runs one operation at a time, with one gate above all of them that refuses
queued operations and drains started ones, and it can suspend one tenant. The deployment state
(`server/deployment.ts`, plan section 6.6) sits in a directory of its own beside the data: a SQLite database with its
own owner lock holding the session epoch, the signing-key generations (key material in `keys.json`, mode 600), the
durable time floor, the sessions (handles stored hashed; idle, absolute and epoch expiry) and the login index. Nothing
Tenant initialization (`createTenant`, plan section 2) takes two commits: the named Space is reserved, then FsMeta, the
first administrator's FsActor with its verified issuer/subject, the home root, the `tenant#admin` and home-owner relations
and the first FsAudit row commit together (`server/schema.ts` holds the entry types, their creation keys and the
canonical names). A Space whose FsMeta has not committed admits no operation; a repeat resumes an interrupted
initialization or answers `alreadyExists`; an unknown schema version or leftover rows are refused as
`inconsistentState`. The login-index entry follows the commit, and every start rebuilds the index from the FsActor rows.
`registerActor` (plan section 5, an enabled tenant administrator calls it) commits the enabled FsActor, its private home
root, the home's owner relation and the audit row in one transaction, then a user's tenant goes into the login index.
Agent instances are bound to (enrolledHostPeerId, agentId), users to (issuer, subject); an existing actor ID (tombstones
included), home name or identity pair gives `alreadyExists` and creates nothing. `findActor` resolves a verified identity
to its enabled actor or fails with `unauthenticated`. Operation IDs and receipts come with phase 3. Nothing listens
yet. The next step of phase 1 is the session adapter.

The application is a directory of its own and depends on the library as `"phi-spaces": "file:../spaces"`, importing
only `phi-spaces` and its exported subpaths. Unlike the other applications, the pilot embeds its Space host in the one
service process and runs only on this machine: no Docker, no Rust Space server, no deployment on big or nano (the
plan's section 2 and section 8). Its Spaces are never shown by the dashboard.

## Commands

From this directory (or with `npm --prefix spaces-files` from the repository root):

- `npm start` (root: `npm run spaces-files`): the service; prints `[files] ready (store …)`, stops cleanly on SIGINT/SIGTERM
- `npm run dev` (root: `npm run spaces-files:dev`): the same, restarted on every change
- `npm run typecheck` (own tsconfig, not part of the root `tsc`)
- `npm test` (root: `npm run test:spaces-files`; node test runner, `tests/*.test.ts`; the store test starts the service
  as child processes)

Variables, read from `spaces-files/.env` (values already in the environment win):

- `FILES_DATA_DIR`: the data directory (default `spaces-files/.local/data`, created with mode 700)
- `FILES_STATE_DIR`: the deployment-state directory (default `spaces-files/.local/state`, mode 700, never inside the
  data directory or around it)
- `FILES_MEM=1`: everything in memory, throwaway
