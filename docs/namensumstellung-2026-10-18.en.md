# Complete renaming to phi-spaces

Status: 18 October 2026. The complete unification covers not only visible
product texts, but also persistent document types and build contracts. No old project names
remain as deliberate exceptions in the repository texts.
External projects and third-party products such as pi-durable, pi-ai and pi-server keep their own names.

## Implementation

- [x] Root and help READMEs, technical documentation, planning documents and DE/EN corpus unified.
- [x] Persistent document types in core, federation, recovery, replication, worker control,
  help admin and examples changed to `phi-spaces.*`; matching checks and audit helpers adapted.
- [x] Runtime/test bed bundles, import paths, Docker copy rules, fixture labels and build scripts unified.
- [x] Local admin password variable name changed to `PHI_SPACES_ADMIN_PASSWORD`;
  the password value was neither changed nor printed.
- [x] Historical text evidence normalized and its editorial change explicitly documented
  in the [evidence note](../test/evidence/README.en.md). They are no longer unchanged raw logs;
  hashes/signatures contained in them still attest only the original artifacts of the time.
- [x] Corpus build cleans up only dropped articles that the previous generated index explicitly
  names as property of the generator. Unknown files are preserved; unsafe paths are rejected
  before the first deletion. A regression checks ownership, protection against traversal and repetition.
- [x] Old distribution and Next output backed up and then freshly generated, instead of continuing to use mixed
  names or outdated development chunks.
- [x] New purely read-only check `npm run check:branding` checks versioned/new project texts,
  generated distribution/help/Next outputs and local environment variable names. It does not check
  Git history, third-party dependencies, binary stores or password values.

## Incompatible storage and integration change

The document type namespace change is **no cosmetic refactoring**. Document version 5 alone
migrates no document types. A previous database must not be started unchanged as a productive store
of this version: documents in the previous namespace are not found automatically;
a new empty namespace is no proof that earlier data would be deleted.

> **Addendum 2026-10-23:** The tool `scripts/migrate-namespace.mjs` and its test have been removed. It
> migrated pi-durable stores, and these are no longer taken over (decision D6,
> [umstellung-u0-bestand.en.md](umstellung-u0-bestand.en.md)). The following section describes the state of
> 2026-10-18; the tool is in the Git history.

No automatic in-place changeover takes place. In the subsequent migration run,
`scripts/migrate-namespace.mjs` was added: dry run as the default,
SQLite backup into a new file, change of document type and the associated metadata index only,
integrity/collision check and streamed hash check of all other tables as well as normalized
document metadata. The new file is published atomically and without overwriting only after a successful check.
Original stores remain unchanged. Replication markers and unknown schemas are rejected;
JSONL and the coordinated migration of journal/hash/signature chains are not implemented.
Blind replacement inside database bytes or signed contents is no migration.

```bash
# Namespace als Argument angeben; kein implizites Ersetzen beliebiger Inhalte.
node scripts/migrate-namespace.mjs --input /absolut/store.sqlite --from BISHERIGER_NAMESPACE
node scripts/migrate-namespace.mjs --input /absolut/store.sqlite --from BISHERIGER_NAMESPACE \
  --output /absolut/store.phi.sqlite --apply
npm run test:migration
```

The tests demonstrate a real harness reopen with an identical entry, unchanged source file,
abort before publication without a partial result, protection against overwriting, target collision
and rejection of replicated stores. Local data copies were additionally opened; see the closing addendum below.

The bundle is now called `phi-spaces.mjs`. Consumers outside this repository must adapt their
imports, artifact manifests and provisioning accordingly. The local check run uses
`npm run bundle -- --local`: this builds the new bundle without changing the neighboring mobile checkout
on one side only. Without `--local`, the documented automatic synchronization still applies.
Renamed help IDs/anchors have no old-name aliases; old external bookmarks must be adapted accordingly.
Existing hosts, containers and productive services were not switched or restarted.

## Re-check: overlooked contracts

The changeover changes more than document types and the bundle. The following names are part of wire,
crypto or operating contracts; old and new versions are **not interoperable** there.

1. **Signature domains.** All signed bytes begin with a domain, which now reads `phi-spaces/…`:
   `auth/v1`, `rotate/v1`, `grant/v1`, `recovery-rpc/v1`, `recovery-authority/v1`, `router-lease/v1`,
   `federation-policy/v1`, `replica-config-notice/v1`, `replica-sync/v1/request|response`,
   `control-host-change/v1`, `worker-assignments/v1`, `run-gate-…`, `space-lifecycle-…`, `membership-…`
   and `delegation` (`phi-spaces/<kind>/v1`). Consequences: hosts of different versions accept from each other
   no challenge, no grant and no instruction; evidence signed and stored before the changeover (e.g. a signed authority
   transition in a recovery kit, signed instructions not yet delivered in outbox/mailbox) no longer verifies afterwards.
   The store migration changes nothing about that.
2. **Protocol and request IDs.** `phi-spaces-rpc-v1` (router/federation), `phi-spaces-claim-receipt-v1`
   (claim receipts) and the request prefix `phi-spaces:` for deliveries to conversations
   (`src/index.ts`). A delivery open at the time of the changeover gets a new request ID and may arrive
   twice once.
3. **SSH forced commands.** `scripts/recovery-ssh.mjs`, `fence-ssh.mjs`, `fence-docker-ssh.mjs` and
   `recovery-docker-ssh.mjs` compare `SSH_ORIGINAL_COMMAND` exactly (`phi-spaces-recovery`,
   `phi-spaces-register-read|operator`, `phi-spaces-fence`, `phi-spaces-fence-status`). Client and
   server-side scripts including `authorized_keys` (`/opt/phi-spaces/…`, see `docs/_attic/abnahme/ap1b-betrieb.en.md`)
   must be changed at the same time, otherwise recovery and fencing fail.
4. **Fencing drop-in.** `ContainerFencing` locks the unit with `zz-phi-spaces-fenced.conf`. A host fenced before the
   changeover carries the drop-in of the old version: `verify` does not recognize it as fenced
   (fail-safe), and `release` would have removed only the new drop-in, the unit would have stayed locked.
   **Fixed:** `release` now aborts and names every foreign `zz-*-fenced.conf`
   (test in `test/test-container-fencing.test.ts`); it is deliberately removed only by the operator.
5. **Server and test bed names.** Compose project and containers `phi-spaces-test-*`, images, the
   iptables rule `phi-spaces-component-fault-proxy`, the service `phi-spaces-fault-proxy.service` and the
   directories `~/.local/share/phi-spaces-operations/` and `/opt/phi-spaces` respectively. Resources still running under the old name on `big`
   are not found by `npm run testbed -- status|down`, `fault-cleanup.py` does not remove the
   old DNAT rule. Before the first run of the new version: dismantle old resources with the old version
   or remove them by hand in a targeted way.
6. **Environment variables.** Old variables are silently ignored. Affected are among others
   `PHI_SPACES_ADMIN_PASSWORD` (help admin; without a value a random password, the admin is then
   locked out — Docker Compose aborts loudly thanks to `:?`), `PHI_SPACES_MOBILE_ROOT`, `PHI_SPACES_LLM*`,
   `PHI_SPACES_ROOT_ACCEPTANCE_FILE`, `PHI_SPACES_TESTBED_TRACE` and on the device
   `PHI_SPACES_KEY_SOCKET`. Server `.env`, systemd units and Compose files outside the repository
   are to be adapted; `check:branding` checks only the local `.env` keys.
7. **Device state (mobile).** The mobile adaptation is in the addendum below. Concretely persistent on the device
   and thus unreachable after the update: Keystore aliases (`SpaceKeyStore.alias` enforces the
   new prefix by regex, old aliases are rejected as "invalid key alias"), the SharedPreferences name of the
   key bindings and the key socket name. On re-enrollment, revoke the old device key in the key directory;
   the old Keystore entry remains unused on the device.
8. **Gap in the branding check.** The pattern captured neither the singular without separator nor the form with a dot,
   and because of `\b` no occurrences with a `_` prefix (e.g. in longer variable names). **Fixed:** the check
   now accepts any separator (`-`, `_`, `.`, space) or none, singular and plural, as long as the
   name is not inside a word. With the stricter pattern there is still no hit.

### Changeover order for existing installations

1. Quiesce the federation: no running recovery or promotion, no fenced host, outboxes,
   mailboxes and fanout jobs emptied, runs stopped or paused.
2. Stop all hosts together (mixed versions are not interoperable, see 1–3).
3. Migrate an offline copy per store (`migrate-namespace.mjs`, first without `--apply`); do not use this tool for replicated stores
   and JSONL.
4. Change server-side scripts, `authorized_keys`, systemd units, `.env`/Compose variables and paths;
   dismantle old test bed resources.
5. Start hosts with the new version; have grants and leases issued anew, pair phones anew.

**Carried out on 2026-10-18** for the test federation on big, vpsc, nanoi and 100: the data could not be taken over
(see 1–3), so the federation was stopped, backed up and set up fresh under the new names; new CA
and certificates, new authority and keys, forced commands, units, directories and SSH aliases renamed,
old data removed. Details and checks: [Test environment §20](testumgebung-big.en.md#20-rebuild-under-phi-spaces-2026-10-18).
The phone `xi` was paired anew with a new APK and a new Keystore key. Open: the primary/sync main store of
host-a was not set up again.

## Checks and evidence

The following checks were run in the closing run:

```bash
npm run typecheck
./node_modules/.bin/tsc -p help-site/tsconfig.json --noEmit --incremental false
npm test
npm run test:examples -- --test-concurrency=1
npm --prefix help-site test
npm --prefix help-site run test:production
npm run build
npm run bundle -- --local
npm run build:operations
node test/testbed/build-artifacts.mjs /media/data/programming/phi-spaces/dist/testbed-artifacts
npm run check:branding
git diff --check
```

| Check after changing all document types | Result |
|---|---|
| Root and help typecheck | successful |
| Root suite including persistent JSONL/SQLite reopen/recovery cases | 741 tests: 740 passed, one optional bootstrap copy case skipped, no failures |
| Model-free examples serially | 158/158 passed |
| Full help suite | 46 tests: 45 passed, separate SSR case skipped, no failures |
| Fresh Next production build and SSR | build successful, separate SSR test 1/1 passed |
| Documentation gate | 45 articles, 90 language records, 14 signature groups, 60 TypeScript examples checked successfully |
| Distribution, local bundle and operations build | successful |
| Test bed artifacts | 47 files built, without transfer or deployment |
| Branding including generated outputs and local variable names | 1,393 text files checked, no old project name found |
| Compose configuration | validated successfully, without starting containers |
| Relative documentation links | 173 targets checked, no missing target |
| `git diff --check` | successful |

Temporary local logs: `/tmp/phi-spaces-rename-root-final.log`,
`/tmp/phi-spaces-rename-help-final.log`, `/tmp/phi-spaces-rename-production-final.log`,
`/tmp/phi-spaces-rename-examples-final.log`, `/tmp/phi-spaces-rename-artifacts.log` and
`/tmp/phi-spaces-branding-final.log`. No paid model calls, productive stores,
external mobile files or hosts were changed for this evidence.

## Backups and remaining operating effort

**Status 2026-10-19:** All temporary logs, source and release backups named in this document under `/tmp`
(local and on big) as well as the release directories `/media/docker/phi-spaces-release-*` have been deleted. The
results are in this document and in the Git history; the path details below are only historical now.

The 44 specifically changed code/test files were backed up before the changeover:
`/tmp/phi-namespace-source-backup-4HiS6d/sources.json`. The check found no already assigned
target namespace values. The previously generated `dist`/Next files are kept for local restoration under
`/tmp/phi-generated-before-rebuild-1LUZSz/`; this backup is neither a store backup nor a deployment.
Temporary backups deliberately contain the previous state and lie outside the project directory.

The following addendum replaces, for the subsequent work run, the blanket open marking
of the local copy migration and mobile source code adaptation. Running services, devices and productive
switchovers remain expressly separate.

## Addendum: existing stores and mobile consumers

### Local SQLite stores

- [x] `help-site/.local/spaces-eibrain.sqlite` copied to `spaces-eibrain.phi.sqlite` and migrated:
  seven document type metadata entries changed; other tables and document contents checked as unchanged.
- [x] `help-site/.local/swarm-b.sqlite` copied to `swarm-b.phi.sqlite` and migrated:
  three document type metadata entries changed; other tables and document contents checked as unchanged.
- [x] Both copies opened with the current harness. The help copy contains the same five Space identities,
  the shard copy the same two. The migration does not write to the original databases;
  the running shard can continue to change its original store independently.
- [x] After renewed verification that the help original database is not in use, set exclusively
  `HELP_SQLITE` in the local `.env` to the checked help copy. No password values changed.
- [x] The running local shard was stopped in a controlled way, **afterwards a new, current copy** was
  migrated and switched to `swarm-b.phi.sqlite`. The first snapshot was not used as the last
  data state. The inactive help copy was also freshly produced before completion.
- [x] Both local original databases including existing WAL/SHM files were deleted after the check,
  with explicit approval. The shard delivers existing posts with an unchanged Space ID;
  the help copy opens with the same five Space identities. The start script and the direct nano host start
  use the migrated shard path by default; a regression test secures this.

The migration function changes only a new output file, offers no automatic
service switchover and refuses existing target paths. JSONL and replicated stores need
a coordinated procedure of their own and were not blindly rewritten.

### External mobile checkout

In the checkout `/media/data/programming/pi-termux-mobile`:

- [x] Twelve identified consumer/build/Java/test files adapted; runtime bundle renamed.
- [x] Current bundle and twelve CLI example modules synchronized; source texts backed up beforehand under
  `/tmp/phi-mobile-source-backup-eMzhUt/sources.json`.
- [x] Node imports, provisioning manifest, packaging source path/variables and Android signature domains unified.
- [x] Offline runtime tests 20/20 and isolated mobile/protection tests 6/6 passed.
- [x] Debug APK built offline. The first attempt hit a still incomplete parallel core change;
  a renewed run after a successful bundle ended with `BUILD SUCCESSFUL`.
- [x] Opened `assets/runtime.bin` contained in the APK: the contained `runtime/phi-spaces.mjs`
  is byte-identical to the tested runtime bundle. Import and `Space.definition.kind` checked.
- [x] Installation and basic device test done in the subsequent fix run: device reachable,
  updated APK installed as a regular upgrade and new bundle verified on the device.
  Existing Android Keystore identities and profiles were not deleted or rewritten.
- [ ] Controlled re-enrollment at the separate federation coordinator: see last addendum.
  Private hardware keys are not exported or blindly renamed.

APK: `/media/data/programming/pi-termux-mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
SHA-256: `4c220e4692bba3a8de77d5edf999e012b32ae9ef5ca089b586186c1ac0af3d3b`.
Bundle SHA-256: `1c9d0dc242c28c7713f21098d31369eb9f0566991ce44469a0923ad20a564220`.
These hashes belong to a source state before the corrections from `docs/codeanalyse-src-2026-10-18.md`
(core, service, recovery service, fencing, replication). Bundle and APK must be rebuilt before use.

**Transparency about the test run:** the existing `runtime/test-remote-client.mjs` was, contrary to the
original classification, a live script. A start created a local test session and ran
a deduplicated short model submission. The session was then removed in a targeted way on the verified
server; no existing user sessions were deleted. Costs were not determined.
The script now explicitly requires `PI_MOBILE_LIVE_TEST=1`; an isolated regression test proves
that without approval it aborts before reading the server identity and before any connection.

### Productive help service on big

- [x] Purely read-only inventory: existing help production container, Compose directory
  `/media/docker/spaces/help-site/docker`, volume mount and document types determined.
  Configuration: help on `127.0.0.1:3500`, store `/data/spaces-eibrain.sqlite`, second shard
  at `tcp:127.0.0.1:3600`. This writer must be included in the coordinated maintenance.
  The listener is an existing SSH tunnel from big to nano, not a second container on big.
  It is not to be equated with the additionally running local development shard.
- [x] After explicit approval, help on big and the actual swarm shard on nano were stopped in a coordinated way,
  their last data state migrated and both services started under new names.
  The earlier rollback reservation no longer applies after the additionally approved original DB deletion.
  Other test/NetBird containers are not part of this switchover.

### Check limits with parallel changes

During this run, further core/recovery/replication files were edited independently.
One overall run reported five recovery errors with a temporarily undefined `failure`;
the targeted repetition after an intermediate correction passed 13/13 tests.
Another overall run hit a temporarily missing `digestJson` import and was likewise
no green acceptance evidence. Before/after hashes confirmed changes during the run.
These foreign changes were neither overwritten nor presented as fixes of this migration.
Both temporary errors (`failure`, `digestJson`) were intermediate states of the parallel corrections
from `docs/codeanalyse-src-2026-10-18.md`; in the finished state they are resolved.
A productive deployment needs a stable, completely re-checked source state.

The subsequent overall suite passed **748/749 tests**, one optional bootstrap copy case
skipped and no failures. However, the source hash also changed during this run;
that is a green test run, but not yet an immutably pinned release evidence.

After completion of the code analysis corrections and this re-check: `npm run typecheck` clean, `npm test`
**753/754** (one optional case skipped, no failures), `npm run check:branding` with the tightened pattern
green, `git diff --check` clean. During the run only foreign files changed (`.dockerignore`,
`help-site/scripts/swarm-shards.sh`, `help-site/server/nano-host.ts` and the files of the running local
shard), no source file under `src/`. This run too is no pinned release evidence.

Current logs: `/tmp/phi-mobile-offline-final.log`, `/tmp/phi-mobile-unit-tests-final.log`,
`/tmp/phi-mobile-android-build-final.log`, `/tmp/phi-spaces-concurrent-recovery-recheck.log`
and `/tmp/phi-spaces-migration-root-recheck.log`. The status of the last overall run must be checked separately before
a deployment approval; older green results above apply to their state at the time.

## Closing addendum: actual service switchover and original DB deletion

### Carried out

- [x] An immutable release copy created under `/tmp/phi-release-vWcoTqoR` and checked independently
  of further changes in the working checkout. Source archive without databases, `.env`,
  dependencies or Git history: SHA-256
  `fb345112fe31cd5314be00eabb85a6be9fd83cc69d98bf89cbf87ee7c754eb0b`.
- [x] Docker context secured against accidentally packing `.env` files, SQLite files and
  private PEM/key files. Production and nano image built successfully on big from the same
  release copy; the nano image then loaded on nano.
- [x] New services `phi-spaces-help-prod` on big and `phi-spaces-swarm-nano` on nano started.
  New data volumes: `phi-spaces-help_spaces-help-data` and `phi-spaces-help_swarm-nano-data`.
  The existing listen addresses, private configuration, credentials and the SSH tunnel on
  port 3600 including its other forwarding were kept.
- [x] Private Compose configurations provided under
  `/media/docker/phi-spaces-release-vWcoTqoR` on big and
  `/home/mux/phi-spaces-release-vWcoTqoR` on nano. Previous environment files adapted
  only with regard to the project variable prefix; resolution with Compose compared against
  the running containers: all service environment values identical, without printing secrets.
  The containers were created directly, not taken over by Compose. For a later switch
  to Compose management, these **new** containers must be replaced in a controlled way; a blind
  `compose up` would collide with the container names already assigned. For an ordinary
  restart, `docker restart` with the respective new container name suffices.
- [x] While both original writers were stopped, ten document type metadata entries were migrated on big and three on nano. All other tables and document contents were proven unchanged by
  fingerprint. Afterwards both productive databases reported
  `PRAGMA integrity_check = ok`; all project document types use the new namespace.
- [x] Both services healthy; help delivers 90 localized articles. The feed reports two reachable
  shards and, after the restart, more than 25,500 preserved posts; normal production operation
  produces further posts. An internal WebSocket test delivered two complete 100-post pages without
  duplicate post IDs. This is no proof that both shards accept new writes: see quota below.
- [x] After integrity, payload and function checks, deleted only the explicitly approved
  original DB files including any existing WAL/SHM files:
  locally `help-site/.local/spaces-eibrain.sqlite` and `help-site/.local/swarm-b.sqlite`,
  on big the original store `/data/spaces-eibrain.sqlite`, on nano the original
  store `/data/swarm-b.sqlite`, each **in the old volume**, not in the new stores of the same name.
  The migrated databases are preserved. The originals cannot be restored without an external backup;
  this run kept no further original DB backup.

During the first nano migration attempt, SQLite could not create its WAL coordination file on the read-only
original mount. The attempt aborted without a published target file.
The successful repetition worked with a private, writable copy of the already
stopped original, including existing sidecars. These staging files were removed after
successful migration; the original remained read-only until the finally approved deletion.
The normal operating interruption was extended as a result.

### Renewed checks

| Check | Result |
| --- | --- |
| Frozen release: typecheck and root suite | 749 passed, 3 skipped, 0 failures |
| Frozen release: help suite | 45 passed, 1 SSR test skipped, 0 failures |
| Docker production build and nano build | successful, from the same source archive |
| Final working checkout: typecheck and root suite | 751 passed, 1 skipped, 0 failures |
| Help suite including new start path regression | 46 passed, 1 SSR test skipped, 0 failures |
| Branding check | 1,397 text files including generated files and local environment keys passed |
| Productive SQLite integrity and types | both stores `ok`, no former project document types |
| Internal feed paging | two 100-post pages, `complete:true`, no duplicates |
| Public HTTPS/WSS | HTTP and feed initialization reachable; paging not accepted as stable, see below |

The additional local Next build from the temporary release copy was **no** green evidence:
at first Turbopack rejected the externally linked dependencies, after a local copy of the
dependencies the TypeScript `--showConfig` evaluation failed. The production build actually rolled out
was, by contrast, built successfully in the Docker builder with the lockfile dependencies.

Logs: `/tmp/phi-spaces-cutover-root-tests.log`, `/tmp/phi-spaces-cutover-help-tests.log`,
`/tmp/phi-spaces-cutover-branding.log`, `/tmp/phi-release-root-tests.log`,
`/tmp/phi-release-help-tests.log`; on big `/tmp/phi-release-production-build.log` and
`/tmp/phi-release-nano-build.log`.

### Findings after the first switchover; for the current state see the fix addendum

- [x] **Stabilize public history paging.** Implemented in the subsequent fix run and
  checked publicly with fresh stores; details and load check limit see last addendum.
  Original finding: the internal two-page test passed,
  but was clearly slow. A public HTTPS/WSS test reached index, feed and both shards,
  but at paging received `complete:false` with `remote shard timeout after 20000ms`.
  The repetition also delivered the first complete 100-post page, but failed at the
  next page with the same shard timeout. Reachability and data preservation are proven,
  durably low-latency paging is not. Without a comparable earlier load test, it is not proven whether the
  observed latency already occurred the same way in the old operation; it is not presented as accepted.
  After the repeated read checks, help also reported health check timeouts and `unhealthy`.
  A controlled restart of the new help container only restored `healthy` and
  HTTP 200 at the help index (measured single call: 2,823 ms). Afterwards no further
  heavy paging load tests. Queries possibly continuing after a `Promise.race` timeout and
  their load must be investigated separately; the restart is no performance fix.
- [x] **Remove default entry count limits.** Implemented project-wide after explicit approval;
  new defaults are set to `FOREVER`. Original finding: the shard reported the limit
  of 10,000 entries on worker writes. The default is identical in old and new images; no quota was
  raised in this migration. Permanently more posts need a deliberate limits/retention decision,
  not the deletion of history data to disguise the limit.
- [x] **Remove old containers and old volumes.** After the subsequent explicit
  approval, both old help/swarm containers and their volumes, checked again as empty, were removed.
  Original approval state: the safety check
  rejected their complete removal as going beyond the original DB deletion approval.
  Therefore the stopped old containers and the old volumes remained; only the explicitly
  approved DB files were deleted. **The old containers must not be restarted:**
  their original databases are removed. Without additional approval no circumvention of the block.
- [x] **Update Android device and check bundle.** Carried out in the fix run; re-enrollment
  is separate and remains open. Existing hardware keys and profiles are preserved.
- [ ] **Separate federation/test bed stores and services.** Not part of the approved help/swarm
  maintenance. Signed or hash-chained replication stores must not be migrated by mere
  replacement of document types or original DB deletion; the copy tool expressly rejects
  known replication markers.
- [x] **Clean up historical content on the two productive help/swarm stores.** Done by the
  subsequently expressly requested complete DB reset of these two services,
  not by blind replacement in old entries. Local development copies were not additionally
  reset. Original limit of the copy migration:
  The copy migration
  changes document types, not historical posts, texts or channel IDs contained in them. In existing
  demo entries, earlier project identifiers can therefore still occur; this was actually observed in the read-only
  local post test. A complete content/channel reference migration must
  handle posts, history nodes, channel entries and their references consistently through the intended
  change path. It is expressly not covered by the payload-unchanged evidence of this migration. No blind replacement in serialized data or replication journals.

## Fix addendum: count limits, history paging and fresh production start

### Implemented and rolled out

- [x] Cause of the nano limit identified concretely: `src/core.ts`, `DEFAULT_LIMITS.maxEntries = 10_000`
  and `maxEntriesPerOwner = 1_000`; check in `core.write` for external participants. Host writes were
  exempt, which is why big could grow beyond this count and the remote shard was blocked anyway.
- [x] After explicit project-wide approval, both default count quotas set to `FOREVER`
  (`Number.MAX_SAFE_INTEGER`, JSON-safe). There is no default upper limit on the entry count
  any more. Explicitly stored quotas remain effective; byte, commit, frame, transaction and
  document budgets were **not** switched off. Quotas already configured individually are
  not silently deleted by an update. A regression checks external writes with more than 10,000
  existing entries as well as explicit count quotas that remain effective.
- [x] `readChain` introduced as an optional `SpaceLike` capability: a byte-bounded chain page from
  an immutable snapshot, without commit. Remote over the existing `readAll` path and
  feature `read.chain`; normal authentication, type rights also for the head and frame budgets
  are preserved. Cycles, expired/invisible nodes, invalid cursors and too small budgets
  are checked. No specialized unprotected side port.
- [x] History uses bundled chain pages instead of one RPC per history node. Older peers keep
  the compatibility path. Deadlines, connection loss and a failed other shard
  stop further traversal steps. Individual reads already sent can still finish;
  but no uncontrolled sequence of further reads runs afterwards. The fallback scan is also
  paged and abortable instead of a full `readAll` that is only externally time-limited.
- [x] README EN/DE, API reference and bilingual help limits article adapted to the new defaults.
- [x] Standalone release state built and checked. Final source archive:
  `/tmp/phi-fix-release-C954sUxC-source.tgz`, SHA-256
  `0771159a03257e53f6fd6fa4a4d7ffce70573ea9064538f9940eb2d0f62d579d`.
  A first Docker build failed on two explicit type annotations demanded by the Next type checker;
  these were corrected and build and suites run again.
- [x] After an additional explicit reset order, both current writers were stopped and **only**
  `/data/spaces-eibrain.sqlite` on big and `/data/swarm-b.sqlite` on nano including their
  SQLite sidecars deleted. The old posts, chats, claims, Space identities and histories of these
  two stores were thereby deliberately discarded without an additional backup.
  Separate test bed/federation stores, credentials and other volume files remained untouched.
- [x] Both applications started with the new image and **freshly created Spaces**. They are now
  managed regularly by Compose; the earlier name collision on a future `compose up`
  is thereby eliminated as well. Releases:
  `/media/docker/phi-spaces-release-C954sUxC` on big and
  `/home/mux/phi-spaces-release-C954sUxC` on nano. Private environment values checked identical before the switchover.
- [x] New nano Space ID `sp-8b106cfb-2eb4-420f-b261-2655b6b297da`, changed from the previous
  identity. New nano posts, new defaults and `read.chain` confirmed over real RPCs.
  The feed contains exclusively the new seed/production posts and the channel `phi-spaces`.
- [x] Public HTTPS/WSS: with 229 freshly created posts two complete 100-post pages,
  `complete:true`, no duplicate post IDs, posts from both shards, **56 ms in total** from
  WebSocket setup. Both containers `healthy` afterwards. This is the live evidence on fresh stores,
  **not** a new production load test with 34,000 entries; the earlier large data state was deleted at
  explicit request. Unit/RPC regressions check among others the 100-node page in one RPC.
- [x] Both stopped old containers and their two old help/swarm volumes, checked again immediately beforehand as empty and
  exclusively assigned, removed permanently after separate approval.
- [x] Android APK built offline from the same core release and updated successfully on the now reachable
  device as `adb install -r`; no uninstall and no app data deletion.
  App started. Bundle actually installed on the device checked by SHA-256 and module import:
  `phi-spaces.space`, `readChain` and both `FOREVER` defaults present.

APK SHA-256: `314cd8ef58f755f9e5e904dfe7a9dd42e3b8427b251668ad1d69e8983dba3987`.
Bundle SHA-256, identical on the device:
`eca8d56a8a53be7c4438734b92b4186af4b99120f6a3e10603de9009c01ef8cc`.

### Test evidence of this fix run

| Check | Result |
| --- | --- |
| Working checkout: typecheck and overall suite | 755 passed, 1 skipped, 0 failures |
| Final frozen release: typecheck and overall suite | 753 passed, 3 skipped, 0 failures |
| Final release: help suite | 47 passed, 1 SSR test skipped, 0 failures |
| Corpus check | 45 articles, 90 localized records, 14 signature groups, 60 type-checked examples |
| Production and nano Docker build | successful |
| Mobile runtime offline | 20/20 passed |
| Android build / installation / installed bundle | successful / `Success` / import and hash match |
| Public two-shard history paging | 2 × 100 posts, complete, without duplicates, 56 ms |
| Extended branding check including private test bed project values | Two open hits: `TESTBED_REMOTE_DIR` and `TESTBED_PROJECT`; no output of their values or other secrets |

Release logs: `/tmp/phi-fix-release-root-final.log`, `/tmp/phi-fix-release-help-final.log`,
`/tmp/phi-fix-mobile-runtime-tests.log`, `/tmp/phi-fix-android-build.log`;
on big `/tmp/phi-fix-production-build-final.log` and `/tmp/phi-fix-nano-build-final.log`.

### Not yet completed

- [ ] **Separate federation/test bed changeover:** On big the previous
  federation/NetBird test environment and its signed stores are still running. Their additional discarding and
  fresh provisioning was asked about as a decision of its own, since the concretely confirmed
  DB reset concerned only help and swarm. Until an answer, change no data or active federation processes.
  The ignored local `test/testbed/testbed.env` also still points to the previous
  test bed project/directory; it must not silently point to another, empty environment.
  The branding check now also takes into account these two expressly project-identifying private
  settings and reports the open point as an error instead of overlooking it.
- [ ] **Android re-enrollment:** The preserved device profile is still `paired` to the previous
  federation coordinator `phase1b-host-a`, with an alias from the previous namespace.
  Installation is done, a valid new pairing is not. Do not delete keys or
  pending user operations; first coordinate the target coordinator and afterwards register a
  new hardware-bound identity in a controlled way.
- [ ] **Local historical demo content:** The local development copies were not part of the
  additionally requested server reset. Their historical entry texts/channel IDs are therefore
  still payload data from the previous state; code and document types have already been changed.
