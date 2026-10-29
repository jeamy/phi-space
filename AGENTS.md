# AGENTS.md

phi-spaces as a `@earendil-works/pi-durable` extension. TypeScript, ESM, run directly with
`node --experimental-strip-types` (no build step for tests or examples).

## Commands

- Typecheck: `npm run typecheck` (`tsc`, covers `src`, `examples`, `*.test.ts`)
- Bundle: `npm run bundle` (also synchronizes the sibling mobile runtime and compiled example modules;
  `PHI_SPACES_MOBILE_ROOT` selects another mobile checkout)
- Tests: `npm test` (node test runner, all suites in `test/`: `test/test-core.test.ts`, `test/test-meter.test.ts`, `test/integration.test.ts`,
  `test/test-persistence.test.ts`, `test/test-spaces.test.ts`, `test/test-claims.test.ts`, `test/test-budgets.test.ts`, `test/test-stream.test.ts`, `test/test-service.test.ts`, `test/test-remote.test.ts`, `test/test-socket.test.ts`, `test/test-gate.test.ts`, `test/test-auth.test.ts`, `test/test-enroll.test.ts`, `test/test-supervisor.test.ts`,
  `test/test-scenario.test.ts`, `test/test-tui.test.ts`, `test/test-ap1.test.ts`, `test/test-pi-server.test.ts`, `test/test-federation-runtime.test.ts`, `test/test-grants.test.ts`, `test/test-recovery.test.ts`, `test/test-operations.test.ts`, `test/test-recovery-boundaries.test.ts`, `test/test-router.test.ts`, `test/test-run-gate.test.ts`, `test/test-run-member.test.ts`, `test/test-run-recovery.test.ts`, `test/test-workers.test.ts`, `test/test-space-lifecycle.test.ts`, `test/test-deployment.test.ts`, `test/test-alerts.test.ts`, `test/test-run-export.test.ts`, `test/test-primary-sync.test.ts`, `test/test-replica-control.test.ts`, `test/test-netcup-fencing.test.ts`, `test/test-replica-transport.test.ts`, `test/test-bootstrap.test.ts`, `test/test-container-fencing.test.ts`, `test/test-control-host-change.test.ts`, `test/test-merge-service.test.ts`, `test/test-entry-erasure.test.ts`, `test/test-entry-compaction.test.ts`, `test/test-commit-sealed.test.ts`, `test/test-not-committed.test.ts`, `test/test-degrade-revoke.test.ts`, `test/test-own-store.test.ts`, `test/test-own-store-ops.test.ts`, `test/test-standalone.test.ts`, `test/test-space-client.test.ts`, `test/test-shared-copies.test.ts` (the copies the projects keep: palettes, markdown, env), `test/test-vectors.test.ts` (the vectors in `test/vectors/` a Rust port must reproduce: canonical JSON, crypto, a wire session, a store file; `npm run vectors` writes them anew, `-- --store` also the store files, docs/wire-protokoll.md), `test/agent-integration.test.ts`); the suite runs on the own store (SQLite, strict about disk maps), `PHI_SPACES_STORE=own` keeps it in memory; pi-durable stores are discarded (decision D6, docs/umstellung-u0-bestand.md); `npm test` first runs `npm run check:durable` (`scripts/durable-imports.mjs --check`: no pi-durable, chord or pi-ai outside its allowlist) and `npm run check:package` (`scripts/package-imports.mjs --check`: projects built on phi-spaces import `phi-spaces`/its exported subpaths, no relative `src/` imports outside its allowlist; docs/api.md „Paket und Unterpfade“); `NODE_OPTIONS=--import=./test/support/no-durable.mjs` blocks them at runtime
  (docs/umstellung-ohne-pi-durable.md) crash/reopen helpers for the own SQLite store
  in `test/support/persistent.ts`
- Native pi-server acceptance: `npm run test:pi-server`; uses packages from the sibling mobile runtime
  (`PI_SERVER_RUNTIME_DIR` overrides the path); skips if not installed, never installs dependencies.
- Single test: `node --experimental-strip-types --test --test-name-pattern=<pattern> test/integration.test.ts`
- Rust port (`rust/`, cargo workspace; docs/rust-portierung.md): `cd rust && cargo test` and `cargo clippy --all-targets`;
  `phi-core`'s tests start the TypeScript core as `test/support/core-driver.ts` (node on PATH) and hold every state against it.
- Space-server probe: `node --experimental-strip-types --no-warnings scripts/server-probe.ts [--store memory|sqlite] [--rate 300] [--cmd "..."]`
  (server CPU per call, RSS, answer times of the standalone service or another implementation; docs/rust-portierung.md R0).
- Branding: `npm run check:branding` (read-only; rejects obsolete project names in tracked text, generated output
  and local `.env` keys).
- Remote test bed (docker on the server `big`; verifies the BUILT artifacts, no source goes to the server;
  `npm run testbed -- check|up|test|status|down`, `--dry-run` first): `test/testbed/`,
  docs in `docs/testumgebung-big.md`; `scenario sieve-mobile create|run|evaluate|all` is the phone-simulating sieve test. Starting containers or shipping artifacts changes a shared server: ask before the first real run.
- TUI: `npm run tui` (read-only spaces/objects and test-bed controls); `--dry-run` previews without server access, `--local-dir DIR` inspects local JSONL state. Docs: `docs/tui.md`.
- Dashboard (read-only live UI): `npm run dashboard -- --dir <store>` in the foreground;
  `npm run dashboard:start|stop|status` (via `scripts/dashboard.sh`) in the background; it also shows the projects'
  spaces over their sockets (`DASHBOARD_APPS` / `--app`, read from the root `.env`; defaults: unix socket, then the
  docker:local port, then the tunnel port on big; public on big as spaces-stats.eibrain.org). Docs: `docs/dashboard.md`.
- Codemode chat (`codemode-chat/`: Next.js; every role its own process around one space, see
  `docs/codemode-space-architektur.md` and its README): `npm --prefix codemode-chat run dev` (space, judge, agents, model, web; port 3700),
  `npm run codemode-chat` (after `npm --prefix codemode-chat run build`), tests `npm run test:codemode-chat` (they start
  the processes), typecheck `npm --prefix codemode-chat run typecheck` (own tsconfig, not part of the root `tsc`),
  Docker `npm --prefix codemode-chat run docker:*` (one container per role; `docker:local:up` runs big and nano together on
  this machine as a test bed, port 3710)
  (changes containers on this machine; never on a shared server without asking).
- spaces-mmo (`spaces-mmo/`: MMORPG engine, first world Leuchtfeuer; processes space, world, web; PixiJS map; docs German in
  `spaces-mmo/docs/`, plan and phases in `spaces-mmo/docs/phasen.md`): `npm --prefix spaces-mmo run build`, then
  `npm --prefix spaces-mmo start` (port 3900; `SPACES_MMO_MEM=1` in memory; model calls only with `SPACES_MMO_LLM=1`, they cost tokens), tests `npm --prefix spaces-mmo test` (they start the
  processes; `npm --prefix spaces-mmo run test:perf` measures the step latency alone, `tests/perf/space-cost.ts` the space process's CPU ms per command, `tests/perf/live-load.ts` plays guest figures against a running world), typecheck `npm --prefix spaces-mmo run typecheck` (own tsconfig). Graphics: `worlds/<id>/assets/CREDITS.md` (CC BY 4.0). Docker like codemode-chat (`spaces-mmo/docker/`, docs `spaces-mmo/docs/betrieb.md`): `npm --prefix spaces-mmo run docker:local:up|down|logs` (big and nano together on this machine, port 3910), `docker:dev:up|down|logs` (one container, the checkout mounted, recompiles and restarts on every change, port 3920), `docker:nano:up` (the accounts space) / `docker:big:up` (the world in its four regions, web) on the servers (change containers; never on a shared server without asking).
- Standalone space service (own store, no pi-durable): `npm run space-server -- --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT`
  (`src/standalone.ts`); `examples/sieve.ts` and `examples/cache.ts` take `--remote <address>`. `test/support/no-durable.mjs`
  (`node --import`) refuses pi-durable, chord and pi-ai; `test/test-standalone.test.ts` runs service and examples under it.
- Examples without a model: `npm run example:pipeline`, `npm run example:sieve`, `npm run example:cache`, `npm run example:golomb` (root); `npm run example`, `npm run example:chat`, `npm run example:blocking` (agent package, scripted models)
- Live examples (real model, cost tokens, ask first): `agent/examples/chat.ts --live`, `npm run example:arxiv`

Run typecheck and tests after every change (root: `npm run typecheck`, `npm test`; agent package: `npm run typecheck:agent`, `npm run test:agent`; the chat and the help site have their own, below).

## Layout

- `src/core.ts` pure semantics, `src/doc.ts` the default Space document, `src/spaces.ts` registry and named spaces,
  `src/claims.ts` request claims/generations, `src/client.ts` `PhiSpaces`, `src/index.ts` exports, delivery, reaper,
  `agent/` the agent package (own dependencies: pi-durable, chord, pi-ai; `agent/src/agent.ts` the space tools over a separate space host, `agent/src/with-agent.ts` the mobile bundle entry, `agent/examples`, `agent/test`), `src/context.ts` the invocation context, `src/store/` the storage boundary
  (`host.ts`/`sqlite.ts` the own store, `sqlite-writer.ts` its writer thread, an eval worker so bundles need no second file;
  `disk-map.ts` the claims kept on the disk, asked through `DISK_MAP` instead of enumerated: tests on own-sqlite throw
  on such an enumeration; `sync-store.ts` what the primary/sync journal needs of a store,
  `sync-sqlite.ts` the own store's side (OwnSyncStore, the replicated primary), `sqlite-ops.ts` the shared row writes),
  `src/meter.ts` metrics; `src/stream.ts`, `src/snapshot.ts`, `src/paging.ts` changes/snapshots/byte pages,
  `src/mailbox.ts` durable mailboxes, `src/pi-server.ts` the structural pi-server adapter.
  `src/service.ts` the transport-independent `space` service, `src/remote.ts` `RemoteSpace`, `src/socket.ts` its unix-socket/TCP transport and server,
  `src/space-client.ts` the client helpers every project shares (parseTarget, connectSpace, readExisting/StillHeld, takeAll, awaitWork, keepAlive), `src/ws.ts` the WebSocket gateway of their web processes (`phi-spaces/ws`),
  `src/gate.ts` the overlay gate (layer A: NetBird peers and groups give identity and roles), `src/auth.ts` layer B (key challenge),
  `src/enroll.ts` pairing (tokens, enroll RPC, bootstrap, key directory in the control space),
  `src/supervisor.ts` the control-space supervisor (createEnroll, revokePeer) and the wire rules for the control space; `src/runtime.ts` composes the federation host;
  `src/grants.ts` / `src/rotation.ts` provide short-lived grants and own-key rotation;
  `src/recovery-register.ts`, `src/recovery.ts`, `src/boot.ts`, `src/restore.ts` are recovery building blocks;
  `src/primary-sync.ts` is the primary/sync journal, `src/replica-control.ts` holds fencing adapters, promotion, degradeToSingle and setStandby, `src/netcup-fencing.ts` the netcup SCP adapter and its mutual-TLS fencing service, `src/container-fencing.ts` the docker/systemd container adapter behind the same service, `src/control-host-change.ts` the same-authority control host change after a control promotion, `src/replica-transport.ts` / `src/replica-notice.ts` / `src/sync-spaces.ts` the signed replica transport, ReplicaConfigNotice and primary/sync Spaces in their own store on a federation host;
  `src/run-controller.ts` journals run start/pause/resume/stop against the core RunGates of each run Member,
  `src/run-member.ts` carries them as signed instructions to Member hosts (`runGateInstruction`),
  `src/workers.ts` keeps desired worker state per host and reconciles registered worker kinds on each host,
  `src/space-lifecycle.ts` creates, archives and deletes named Spaces through signed host instructions,
  `src/deployment.ts` validates, plans and applies deployment configs (CLI: `npm run bootstrap`, `scripts/bootstrap-spaces.ts`),
  `src/alerts.ts` derives alerts, publishes their changes (webhook) and lists the admin command audit.
  `test/testbed/device/b9-coordinator.ts` is the LAN coordinator for phone acceptance of the mobile control page.
- `examples/` runnable examples; `examples/sensor-pipeline.ts` is also imported by the pipeline tests.
- `docs/` plans and documentation: `implementierungsstand.md` (current implementation), `api.md` (public API), `_attic/spaces-v1.md` (historical), `federation-plan-v3.md` (current
  federation plan; v1/v2 are superseded), `examples.md` (examples in detail).

## Conventions

- No new dependencies without asking; nothing is installed locally.
- Projects built on phi-spaces depend on it as `"phi-spaces": "file:.."` and import `phi-spaces`, `phi-spaces/context`,
  `phi-spaces/core`, `phi-spaces/store/*` (root `exports`, pointing at the `.ts` sources); `agent/` keeps relative imports.
- Scripted model tests: filter out system messages before checking the last message (see `docs/examples.md`, „Testumfang").
- Documentation in `docs/` is German; code comments and README are English.
- Call this project's library and spaces phi-spaces; the local client class is `PhiSpaces`.
  JavaSpaces names the historical reference only.
