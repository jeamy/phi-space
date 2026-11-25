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

Since 2026-11-25 the plan keeps file contents out of the Space: each version is an AES-256-GCM-sealed blob in a blob
directory of its own, and FsContent names it (plan section 3, *Contents*). Files are bytes, text or binary, bounded by
`maxFileBytes` rather than by the Space's entry limit. Phase 2's text row and its 10 KiB limit (`content()`, `checkText`,
`textBytes`, the content-row cases of `assertLimitsFit`) are replaced by the blob store in phase 3.

## Phase 3: filesystem service (under way)

- Step 1, the blob store (`server/blobs.ts`): one sealed blob per file version under
  `<FILES_BLOB_DIR>/<tenant>/<shard>/<blobId>`, written to a temporary file, flushed, renamed and its directory flushed.
  AES-256-GCM with a key per blob (HKDF-SHA-256 of the content key and the blob ID) and associated data that binds
  tenant, node, version, blob ID and key generation; a missing, truncated, flipped, moved or foreign blob is
  `inconsistentState`. The content keys are generations of their own in the deployment state
  (`content-keys.json`, mode 600): a content-key rotation keeps old blobs readable, and a restore rotation of the
  signing keys never touches them. The sweep removes, in bounded batches, blobs no content row names and leftover
  temporary files, nothing else, and nothing while a backup holds deletion. FsContent now holds `blobId`, `size`
  and `keyGeneration`; `maxFileBytes` (16 MiB) and `maxContentBytes` (1 GiB per tenant) bound the contents
  (`tests/blobs.test.ts`). `sweepBlobs` runs the sweep in the tenant queue and only while the tenant Space holds no
  open transaction, reservation or uncommitted write: a save's taken content row is invisible to a read, and its blob
  must outlive the abort, also across a crash before the reaper resolves it.
- Step 2, operation IDs and receipts (`server/opids.ts`, `server/receipts.ts`): `issueOperationIds` signs IDs
  (HMAC-SHA-256 with the current signing generation over tenant, actor kind and ID, issue time, generation and a
  nonce) for a valid session; verification rejects another actor or tenant, a forged or malformed ID, a retired
  generation, an issue time beyond the clock skew and, from the exact expiry instant on, an expired one, persisting
  the time floor first. A receipt answers a retry with the same digest and gives `requestMismatch` for another;
  `reserveReceipt` bounds the ordinary pool (`maxReceipts`) and the security reserve, prunes expired receipts (earliest
  first, floor persisted before) and never evicts a live one. Defaults: retry window one hour, skew two minutes
  (`tests/opids.test.ts`).
- Step 3, the file operations (`server/service.ts`): `workspaces`, `list`, `read`, `mkdir` and `write` in the order of
  checks of section 5 (session, queue, actor, input, operation ID, rights, receipt, preconditions, budgets). Creation
  follows the parent branch (`notFound`, `invalidInput`, `permissionDenied`, then the receipt, then `alreadyExists` or
  `versionConflict` with the version); a save checks the receipt before the version, writes the blob only after every
  check, takes and verifies the old content row inside the transaction and deletes the old blob after the commit. A
  failure before the commit deletes the new blob; an unknown commit outcome closes admission for every tenant until
  `resolveOutcomes` lets the content row decide which blob survives. After a restart a tenant waits until transactions
  of the earlier process have lapsed. An `inconsistentState` suspends that tenant alone. Tests on memory and on disk,
  races, budgets, injected failures, both kinds of unknown outcome, and SIGKILL at every point of a save in a child
  process (`tests/files.test.ts`, `tests/support/crash-driver.ts`).
- Step 4, grants and memberships: `grant`, `revoke`, `listGrants` (owner on the target), `addMember`, `removeMember`
  and `createWorkspace` (an enabled `tenant#admin` user; a refusal is audited in a transaction of its own, without a
  receipt). Grants are validated (shape, no redundant viewer below the root, a live subject); identical grants and
  absent revocations succeed idempotently with a receipt; a revocation keeps the final owner. Budgets: a mutation's rows
  fit `maxTenantBytes`, with its audit row the audit reserve, less `securityReserveBytes`, which only revocations,
  membership removals and (later) actor disablement may use, like the receipt reserve. A security action that does not
  fit even that closes the tenant durably in the deployment state with its pending action, across restarts, until
  `reopenClosedTenant`. Tests: the opening journey, the retry after a revocation (`notFound`, then `permissionDenied`,
  never the version), validation, the final owner, denied admin audits, and the reserve (`tests/grants.test.ts`).
- Step 5, the admin operations: `registerActor` through a session with an operation ID (the host-level form is
  `provisionActor`), `disableActor`, `enableActor` and `deleteActor` with replacement owners per workspace (enabled
  direct users or agents other than the actor, granted in the same transaction), `lastOwner` and `lastAdmin`, no-ops
  and invalid transitions, tombstones that keep IDs and identity pairs from reuse; `deleteActor` beyond
  `maxDeleteRelations` or one transaction's bytes is `capacityExceeded` and changes nothing (disable, remove in batches,
  then delete); `grantTenantAdmin`, `revokeTenantAdmin` (a security action); `listWorkspaces`, `listActors`,
  `listGroups`, `listGroupMembers`, each checked against `maxReplyBytes` on open (`tests/admin.test.ts`).
- Step 6, maintenance and upkeep: the admission mode (normal or maintenance) in the deployment state and in the order
  of checks; `setMode` persists the intent, refuses queued operations, drains started ones, persists the destination
  and reopens, and a restart completes an interrupted transition first. In maintenance mode only an enabled
  administrator's admin operations, `issueOperationIds` and the maintenance metadata operations (`maintenanceList`,
  `maintenanceListGrants`, `maintenancePutGrant`: names, kinds and grants without visibility, never contents) run.
  `pruneAudit` removes rows older than `maxAuditAgeMs` (90 days), oldest first, never the newest; `maintainTenant` runs
  receipt pruning, audit pruning and the blob sweep; `compact()` gives free pages back with admission drained
  (`tests/maintenance.test.ts`).

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
- `FILES_BLOB_DIR`: the blob directory with the sealed file contents (default `spaces-files/.local/blobs`, mode 700,
  apart from the other two)
- `FILES_MEM=1`: everything in memory, throwaway
