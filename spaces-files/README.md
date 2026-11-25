# phi-spaces files

A filesystem for people and agent instances on phi-spaces, with Zanzibar-style relationships: every actor has a home,
teams share workspaces, roles are inherited from directories, and a revocation is seen by every operation admitted
after it. Files are UTF-8 text with versions; a save over a stale version is a conflict, never a silent overwrite.
The plan, with its phases and exit evidence, is `docs/zanzibar-agent-filesystem-plan.en.md`.

**Status: phases 1 and 2 of that plan are complete** (exit evidence below). The application is registered in the repository checks (`APPS` in
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
to its enabled actor or fails with `unauthenticated`. Operation IDs and receipts come with phase 3.

The session layer follows the order of checks (plan section 5): `login` resolves an identity an adapter has verified to
an enabled actor of an initialized tenant and stores the session in the deployment state; `withSession` authenticates a
handle there first, outside every queue (missing, expired, logged out or from an old epoch: `unauthenticated`, and the
request never reaches a tenant queue), then admits the request into that tenant's queue and checks the actor's current
state inside it. Nothing listens yet: the browser and agent-host transports are later work.

The application is a directory of its own and depends on the library as `"phi-spaces": "file:../spaces"`, importing
only `phi-spaces` and its exported subpaths. Unlike the other applications, the pilot embeds its Space host in the one
service process and runs only on this machine: no Docker, no Rust Space server, no deployment on big or nano (the
plan's section 2 and section 8). Its Spaces are never shown by the dashboard.

## Phase 1 exit evidence

Each claim of the plan's section 7, phase 1, and the test that holds it:

| Claim | Test |
|---|---|
| A second service process is refused on the same store; killing the first releases the lock and the store reopens | `tests/service.test.ts` (child processes, SIGKILL) |
| Two tenants stay isolated | `tests/service.test.ts`, `tests/sessions.test.ts`, `tests/phase1-exit.test.ts` |
| An uninitialized named Space admits no session | `tests/tenant.test.ts`, `tests/sessions.test.ts`, `tests/phase1-exit.test.ts` |
| Two conversations of one host and equal agent IDs on two hosts resolve to distinct actors and distinct private homes | `tests/actors.test.ts`, `tests/phase1-exit.test.ts` (through login and session) |
| Duplicate identity pairs fail without creating an actor or home | `tests/actors.test.ts`, `tests/phase1-exit.test.ts` |
| Disabled and unknown actors and old session epochs fail closed | `tests/sessions.test.ts`, `tests/phase1-exit.test.ts` |

Not yet there, by the plan's order: operation IDs and receipts, the file and admin operations beyond `registerActor`
(phase 3), and the transports that carry sessions (browser login, agent-host socket).

## Phase 2: policy and namespace

- `server/schema.ts`: every entry type of section 3 with its creation key (FsMeta, FsActor, FsNode, FsContent,
  FsRelation, FsReceipt, FsAudit), the error classes with their codes.
- `server/paths.ts`: the one path parser (NFC segments, a lone dot only for the operations that may name the root) and
  verbatim text measured in UTF-8 bytes. `server/digest.ts`: the request digest, SHA-256 of the RFC 8785 JSON of the
  digest version, the operation name and the canonical arguments.
- `server/limits.ts`: the filesystem's limits, checked on open in their worst case against the Space's limits (the
  Space counts the UTF-8 bytes of an entry's JSON, so a control character costs six bytes: text is 10 KiB by
  default; the tenant's stored rows, 56 MiB, with a 4 MiB audit reserve must fit the Space's 64 MiB); each row is
  measured exactly before it is written, and a worst-case save (take, successor, receipt, audit) fits one commit.
- `server/policy.ts`: the typed relation validator, the evaluator (`resolve` down a path, `roleOn` up from a node ID
  along the recorded parent, both charged against a work budget), the final-owner and final-admin checks and the
  derived groups; `spaceData` reads a tenant Space for it. Every bounded read asks for one row more than its bound and
  refuses with `capacityExceeded` when it gets it, so no decision or listing rests on a partial list.
  `server/quotas.ts`: the live-data quotas, `registerActor` checks them.

| Claim (plan section 7, phase 2) | Test |
|---|---|
| Direct, group, inherited and overlapping grants; workspace visibility; inert grants below an invisible workspace | `tests/policy.test.ts` (the case table, each case also by node ID) |
| Redundant viewer grants and unknown or deleted subjects are rejected | `tests/policy.test.ts` (validator) |
| Final-owner and final-admin protection | `tests/policy.test.ts` |
| Group existence after removing the last member | `tests/policy.test.ts`, `tests/policy-space.test.ts` |
| Cycles and missing parents map to `inconsistentState`; work and depth limits to `capacityExceeded` | `tests/policy.test.ts` |
| Quotas and tenant isolation | `tests/policy-space.test.ts` |
| Canonical paths, text and request digest; byte limits against the Space's limits | `tests/paths.test.ts` |

Suspending a tenant on `inconsistentState` belongs to the operations that meet it and arrives with phase 3.

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
