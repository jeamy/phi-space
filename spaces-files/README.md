# phi-spaces files

A filesystem for people and agent instances on phi-spaces, with Zanzibar-style relationships: every actor has a home,
teams share workspaces, roles are inherited from directories, and a revocation is seen by every operation admitted
after it. Files are bytes (text or binary) with versions, sealed in a blob store; a save over a stale version is a
conflict, never a silent overwrite.
The plan, with its phases and exit evidence, is `docs/zanzibar-agent-filesystem-plan.en.md`.

**Status: phases 1 to 5 of that plan are complete** (exit evidence below; the host operator's procedures are in
[docs/operator-guide.en.md](docs/operator-guide.en.md)). The application is registered in the repository checks (`APPS` in
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
state inside it. Phase 4 added the transports that carry sessions: the browser and admin adapter and the agent sockets.

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

## Phase 3: filesystem service

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

| Claim (plan section 7, phase 3, and the phase 3 acceptance cases) | Test |
|---|---|
| The same contracts on memory and SQLite | `tests/files.test.ts` (both media) |
| Two creates and two edits race | `tests/files.test.ts` |
| A failure before, at and after the commit, and between the blob write and the commit; reopen and verify rows, receipts, versions, audit and blobs | `tests/files.test.ts` (injected failures, unknown outcomes, SIGKILL at every fault point) |
| `unauthenticated`, expired IDs, rapid key rotations and a restart during them | `tests/sessions.test.ts`, `tests/opids.test.ts` |
| `requestMismatch`, failed attempts without receipts, idempotent no-ops with receipts, the operation name in the digest | `tests/files.test.ts`, `tests/grants.test.ts`, `tests/opids.test.ts` |
| Retries after revocation | `tests/grants.test.ts` |
| Receipt and audit pruning; the clock across an expiry and back, with a restart | `tests/opids.test.ts`, `tests/maintenance.test.ts` |
| Duplicate actor, workspace, home and identity creation; invalid actor transitions | `tests/admin.test.ts`, `tests/actors.test.ts`, `tests/grants.test.ts` |
| `inconsistentState` suspends the tenant alone | `tests/files.test.ts`, `tests/blobs.test.ts`, `tests/tenant.test.ts` |
| The actor transaction budget | `tests/admin.test.ts` |
| Store-wide suspension after an unknown commit outcome | `tests/files.test.ts` |
| Ordinary budgets full with young rows; a removal on the reserve; the replay without a new receipt; the exhausted reserve closed through a restart | `tests/grants.test.ts` |
| Creation through the parent branch with its collision errors; a lost creation reply replays once | `tests/files.test.ts` |
| A barriered mode switch refusing queued work and draining a paused write; the mode after a restart | `tests/maintenance.test.ts` |
| Blobs: sealed, bound to their owner, swept, held during a backup; content keys never retired by a restore | `tests/blobs.test.ts` |

Not yet there after phase 3: the transports (phase 4) and backup, restore and the recovery interface (phase 5).

## Phase 4: agent and human access

- Step 1, the agent adapter (`server/agent-socket.ts`): one unix socket per enrolled agent host and tenant
  (`FILES_AGENT_SOCKETS`; one socket per tenant, decided 2026-11-25, because the same identity pair may exist in
  several), in a directory others cannot reach (group access is the host user's way in; Node.js sees no peer
  credentials). Calls are phi-spaces socket frames holding `{op, args, frame: {agent}}`; the frame rule is the
  agent-host contract's, a call without an agent acts for nobody, and the adapter logs each agent in and renews its
  session. Only the file operations are offered. `server/wire.ts` holds the operation table and the one mapping of
  errors to public codes (`inconsistentState` without details, anything unexpected `internal` without a message) and
  strict base64 for contents. `client/agent-client.ts` is the host's side: a client per agent and the relative-path
  tools `fs_workspaces`, `fs_list`, `fs_read`, `fs_write`, `fs_mkdir` (refusals as results, a version conflict with the
  current version, a mutation keeping its operation ID across retries) (`tests/agent-socket.test.ts`).
- Step 2, the browser and admin adapter (`server/http.ts`), HTTPS only: sign-in through an OpenID provider
  (`server/oidc.ts`: discovery, code flow with PKCE, state bound to the browser by a cookie, nonce, the ID token checked
  on the server: JWKS signature, issuer, audience, authorized party, expiry, issue time, nonce), the session handle in a
  `__Host-files` cookie (Secure, HttpOnly, SameSite=Strict, a new handle on every sign-in, the previous one ended), a
  tenant choice only among the identity's bindings, and on every call the service's own origin, fetch metadata and a
  CSRF token bound to the session; bodies are bounded before they are read, and one global bound refuses requests
  beyond it. The page (`web/`, no framework, its TypeScript served with the types stripped) has the workspace list, the
  file list, the editor, the grants of a directory and the tenant administration (registration, membership,
  workspaces, listings); its draft logic is `client/draft.ts`: a conflict or a refusal keeps the draft, a lost reply is
  retried with its operation ID. The development IdP (`server/dev-idp.ts`, decided 2026-11-25) is a process of its own
  on loopback that the service talks to like any IdP; it proves nothing, and the tests use it. The host operator's
  local socket (`server/operator.ts`, in the state directory: `create-tenant`, `tenants`, `mode`) carries no file
  operation. The launcher starts all of them (`tests/http.test.ts`, `tests/draft.test.ts`, `tests/launch.test.ts`).
- After the first browser check (2026-11-25): `/api/session` tells the page whether the session is an enabled tenant
  administrator (`sessionInfo`, read-only, never audited), and the page offers the administration only then; refused
  admin calls of one actor and operation within `deniedAuditWindowMs` (one hour) share one audit row with a count, so
  a caller cannot fill the audit by asking again and again (`tests/admin.test.ts`).

| Claim (plan section 7, phase 4, and the acceptance case of phases 1 and 4) | Test |
|---|---|
| The opening journey through both adapters with two browser clients and a scripted agent | `tests/phase4-exit.test.ts` |
| Automatic private homes | `tests/phase4-exit.test.ts`, `tests/agent-socket.test.ts` |
| Stale editor saves: a version conflict with the current version; the draft kept | `tests/phase4-exit.test.ts`, `tests/agent-socket.test.ts`, `tests/draft.test.ts` |
| Revoked group membership: the workspace leaves the list, `notFound` inside it like an absent path, the file unchanged | `tests/phase4-exit.test.ts` |
| Instance isolation for two conversations of one host | `tests/phase4-exit.test.ts`, `tests/agent-socket.test.ts` |
| Two tenants with the same user name; a forged tenant selector | `tests/http.test.ts` |
| An expired session fails; cross-origin or unbound requests produce no mutation; a sign-in this browser did not start is refused | `tests/http.test.ts` |
| The ID-token checks | `tests/http.test.ts` |
| The launched service: operator, browser, admin registration, an agent's save | `tests/launch.test.ts` |

## Phase 5: local acceptance

- Step 1, the deployment state's loss and age: a state ID and a sequence number, raised by every key, epoch and
  roster change, mirrored beside the data (`state-marker.json`); data without its state, an older state or another
  deployment's is refused on start (`StateLost`) instead of a fresh state with new content keys. The encrypted archive
  (`server/archive.ts`): chunks sealed with AES-256-GCM under a key derived per archive, index and final flag bound,
  every chunk verified before anything is extracted, names kept inside the destination. The state backup and
  `restore-state`, which brings it forward (time floor, new epoch, a signing generation retiring all earlier ones,
  content keys kept, maintenance mode); a new content-key generation seals nothing until a state backup holds it
  (`tests/state-backup.test.ts`).
- Step 2, the data backup and the restore (`server/backup.ts`): blob deletion held, the store copied by `VACUUM INTO`
  from a read-only connection while saves go on, the blobs beside it; the restore as a journal in the deployment state
  that a crash at any step resumes (intent, verified, installing, installed, rekeyed, checked), the blob check closing
  a tenant whose contents lack a blob. The restore stays open: maintenance admits only each tenant's approved
  reconciler, and normal admission waits until every tenant is marked reconciled (`tests/restore.test.ts`).
- Step 3, the recovery interface: a recoverer signs in by OIDC on `/recovery/login` under a cookie of its own and is
  admitted by the recovery roster alone; its actor ID is derived from tenant, identity and restore epoch, so its
  recovery operation IDs belong to that restore. It inspects actors and administrators, provisions today's
  administrator with the registration invariants and removes the obsolete one after; each step commits a `recoverer`
  receipt and audit row with its change and goes into the operator audit (`tests/recovery.test.ts`, page
  `web/recovery.*`). The pilot's independent authority check is the operator's roster entry plus the approval of one
  reconciler per tenant and restore (decided 2026-11-25, plan section 6.5).
- Step 4, operation: health (`ok`, `maintenance`, `degraded`, the state backup's lag, the store's live and free
  sizes) and counters (`server/metrics.ts`: queue wait and run time, adapter calls by offered name and error code,
  evaluator work; no tenant, actor or path), the limits file (`FILES_LIMITS`), regular upkeep (`FILES_UPKEEP_MS`), the
  operator commands for all of it, the maintenance metadata operations on the browser adapter, the repeatable
  workload fixture (`tests/workload/workload.ts`; measurements in the operator guide, section 8) and the multi-batch
  runbook (`tests/health.test.ts`, `tests/workload.test.ts`, `tests/runbook.test.ts`).

| Claim (plan section 7, phase 5) | Test |
|---|---|
| Restart, clean and online backup, maintenance-mode restore with a revoked user, a restored direct grant and a pending retry | `tests/phase5-exit.test.ts`, `tests/restore.test.ts`, `tests/recovery.test.ts` |
| A repeated recovery step is answered by its `recoverer` receipt; a recovery ID of another restore epoch is rejected | `tests/recovery.test.ts`, `tests/phase5-exit.test.ts` |
| A backed-up administrator A gains nothing; B, missing from the backup, is provisioned and reconciles after approval | `tests/recovery.test.ts`, `tests/phase5-exit.test.ts` |
| Lost deployment state: refused start, restore from its own backup, new epoch and generation, rebuilt login index, every file reads | `tests/state-backup.test.ts` |
| A backup whose blob copy misses a referenced blob: `inconsistentState` for that tenant only | `tests/restore.test.ts` |
| Old-session and old-ID rejection after reauthentication, metadata-only reconciliation, per-tenant markers before normal admission | `tests/recovery.test.ts`, `tests/restore.test.ts`, `tests/phase5-exit.test.ts` |
| Restart at each restore step | `tests/restore.test.ts` (`tests/support/restore-driver.ts`) |
| An encrypted backup copy alone yields no readable content, name or identity | `tests/phase5-exit.test.ts`, `tests/state-backup.test.ts` |
| The multi-batch owner-replacement and relation-removal runbook | `tests/runbook.test.ts` |
| Health, counters, limits configuration, compaction | `tests/health.test.ts`, `tests/phase5-exit.test.ts` |
| Queue wait, latency, evaluator work, live and free sizes with tenant count, depth, concurrency and hardware | `tests/workload.test.ts`; recorded in `docs/operator-guide.en.md` |

Checked by hand on each machine, as the operator guide says (section 1), because the service cannot see them: the
encrypted volume under the three directories, encrypted or no swap, no core dumps, and backup keys kept apart from
their archives.

## After the pilot: the plan's subsequent decisions

Section 8 of the plan, item by item, each decided in the plan and built after the five phases:

| Item | Decision in the plan | Test |
|---|---|---|
| Nested groups: group members may be another group's members, bounded by `maxGroupDepth`, cycles refused on write and `inconsistentState` when stored | section 4, *Nested groups* | `tests/nested-groups.test.ts` |
| Move and delete: `move` keeps the node ID with versions, blobs, grants and restriction, inheritors of the old place lose it at once; `remove` takes files, empty directories and empty workspaces with their content, grants and blob, through crashes at the commit | section 5, *Move and delete* | `tests/move-remove.test.ts`, `tests/agent-socket.test.ts` |
| Scale: measured (operator guide, section 8); `listPage` pages a directory in name order, every page rechecks access, the cursor is bound to tenant, actor and directory; no decision cache, no store per tenant yet | section 5, *Scale* | `tests/scale.test.ts`, `tests/agent-socket.test.ts` |
| Virtual files: read-only providers as `@<name>` workspaces, called outside the queue with the caller's verified binding only, a deadline and no cache; mutations refused, `@` names reserved; a directory provider with a per-identity access table (`FILES_MOUNTS`) | section 5, *Virtual files* | `tests/mounts.test.ts` |
| Restricted children: an owner restricts a node below the root; viewers and editors above lose it at once unless they hold a grant on it, owners above keep it; `list` leaves hidden children out | section 4, *Restricted children*; section 5 | `tests/restricted.test.ts` |
| Network agent hosts: a TLS listener (`FILES_AGENT_NET`) where a host enrolls an Ed25519 key with the operator's one-time token (`operator enroll-host`), proves it on every connection and acts for its agents in the tenants its key names; the key is looked up on every call, `revoke-host` refuses the next one, a restore revokes every host key; `client/agent-net-client.ts` is the host's side | section 2, *Network agent hosts* | `tests/agent-net.test.ts` |
| Separate Space process: the tenant Spaces in `server/space-host.ts` on a socket in the data directory, started and stopped by the service; a lost reply is `unavailable` or an unknown outcome, the retry after a restart applies once; host keys in `control.sqlite` of the state directory; `npm run test:space` runs every suite against it; the Rust `files-space` (`rust/`, `cargo build --release`) is the same process, `FILES_SPACE_SERVER=$PWD/rust/target/release/files-space npm run test:space` runs every suite against it, and one store moves between the two | section 2, *The Space in a process of its own* | `tests/space-process.test.ts`, `npm run test:space` |
| Replicas (single-owner admission kept): the Space store as the primary of phi-spaces' primary/sync journal; the deployment state as one changeset per transaction and the blobs before their row's commit to a standby (`server/standby.ts`, `standby` option), seeded on every open, fenced by the promotion marker; an unconfirmed change is never answered and closes admission; a revocation and a lost reply's retry hold across a kill, fencing and promotion. The standby on another machine: `server/standby-host.ts` over mutual TLS (`server/standby-net.ts`, `FILES_STANDBY`, `operator promote-standby`) | section 6.7 | `tests/replica-handover.test.ts`, `tests/standby.test.ts`, `tests/standby-net.test.ts` |

## Commands

From this directory (or with `npm --prefix spaces-files` from the repository root):

- `npm start` (root: `npm run spaces-files`): the service; prints `[files] ready (store …)`, stops cleanly on SIGINT/SIGTERM
- `npm run dev` (root: `npm run spaces-files:dev`): the same, restarted on every change
- `npm run dev-cert`: a self-signed certificate for `localhost` in `.local/tls/` (openssl)
- `npm run dev-idp`: the development IdP on `http://127.0.0.1:4201` (it proves nothing; this machine only)
- `npm run operator -- create-tenant <tenant> <adminId> <homeName> <issuer> <subject>`, `-- tenants`,
  `-- mode normal|maintenance`, `-- health`, `-- metrics`, `-- maintain [tenant]`, `-- compact`, `-- backup <file>`,
  `-- backup-state <file>`, `-- rotate-content-key`, `-- roster-add|roster-remove <tenant> <issuer> <subject>`,
  `-- roster`, `-- approve-reconciler <tenant> <issuer> <subject>`, `-- mark-reconciled <tenant>`,
  `-- restore-status`: the host operator's commands against the running service; with the service stopped:
  `-- new-backup-key <file>`, `-- backup-offline <file>`, `-- restore <file>`, `-- restore-state <file>`
  (docs/operator-guide.en.md)
- `node --experimental-strip-types tests/workload/workload.ts [--tenants N] … [--out report.json]`: the workload fixture
- `npm run typecheck` (own tsconfig, not part of the root `tsc`)
- `npm test` (root: `npm run test:spaces-files`; node test runner, `tests/*.test.ts`; the store test starts the service
  as child processes)

Variables, read from `spaces-files/.env` (values already in the environment win):

- `FILES_DATA_DIR`: the data directory (default `spaces-files/.local/data`, created with mode 700)
- `FILES_STATE_DIR`: the deployment-state directory (default `spaces-files/.local/state`, mode 700, never inside the
  data directory or around it)
- `FILES_BLOB_DIR`: the blob directory with the sealed file contents (default `spaces-files/.local/blobs`, mode 700,
  apart from the other two)
- `FILES_MEM=1`: everything in memory, throwaway (no operator socket)
- `FILES_PUBLIC_ORIGIN`: the browser's origin (default `https://localhost:4200`); `FILES_HTTP_HOST` (default
  `127.0.0.1`) and `FILES_HTTP_PORT` (default: the origin's port) where it listens
- `FILES_TLS_CERT`, `FILES_TLS_KEY`: PEM files (default `.local/tls/cert.pem`, `key.pem`); without them the browser
  adapter stays off
- `FILES_OIDC_ISSUER`, `FILES_OIDC_CLIENT_ID`, `FILES_OIDC_CLIENT_SECRET`, `FILES_OIDC_CA`: the identity provider
  (default: the development IdP, client `spaces-files-dev`)
- `FILES_AGENT_SOCKETS`: `hostPeer@tenant=/absolute/path.sock;…`, one socket per enrolled agent host and tenant
- `FILES_SPACE_SERVER`: the Space process; unset or `ts` runs `server/space-host.ts`, a path names a binary with the
  same command line, `inprocess` keeps the store in the service's process
- `FILES_AGENT_NET`: `host:port` of the TLS listener for agent hosts on other machines (the certificate of
  `FILES_TLS_CERT`/`FILES_TLS_KEY`); `FILES_AGENT_NET_ID` the service ID in each challenge (default `spaces-files`)
- `FILES_LIMITS`: a JSON file of limit overrides (`server/limits.ts`), checked on start
- `FILES_UPKEEP_MS`: how often each tenant's upkeep runs (default 600000; 0 turns it off)
- `FILES_MOUNTS`: a JSON file of read-only directory mounts, `[{"name": "docs", "kind": "directory", "root": "/abs",
  "access": {"<tenant>/user:<issuer> <subject>": ["path/below/root", …]}}]`, each the workspace `@docs`
- `FILES_BACKUP_KEY`, `FILES_STATE_BACKUP_KEY`: the key files of the data and the state backup (operator commands)

A first local run: `npm run dev-cert`, `npm run dev-idp` in one terminal, `npm start` in another, then
`npm run operator -- create-tenant acme adm adm http://127.0.0.1:4201 adm` and sign in as `adm` at
`https://localhost:4200` (the browser warns about the self-signed certificate).
