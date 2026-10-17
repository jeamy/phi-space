# AGENTS.md

pi-spaces as a `@earendil-works/pi-durable` extension. TypeScript, ESM, run directly with
`node --experimental-strip-types` (no build step for tests or examples).

## Commands

- Typecheck: `npm run typecheck` (`tsc`, covers `src`, `examples`, `*.test.ts`)
- Bundle: `npm run bundle` (also synchronizes the sibling mobile runtime and compiled example modules;
  `PI_SPACES_MOBILE_ROOT` selects another mobile checkout)
- Tests: `npm test` (node test runner: `test-core.test.ts`, `test-meter.test.ts`, `integration.test.ts`,
  `test-persistence.test.ts`, `test-spaces.test.ts`, `test-claims.test.ts`, `test-budgets.test.ts`, `test-stream.test.ts`, `test-service.test.ts`, `test-remote.test.ts`, `test-socket.test.ts`, `test-gate.test.ts`, `test-auth.test.ts`, `test-enroll.test.ts`, `test-supervisor.test.ts`,
  `test-scenario.test.ts`, `test-tui.test.ts`, `test-ap1.test.ts`, `test-pi-server.test.ts`, `test-federation-runtime.test.ts`, `test-grants.test.ts`, `test-recovery.test.ts`, `test-operations.test.ts`, `test-recovery-boundaries.test.ts`, `test-router.test.ts`, `test-run-gate.test.ts`, `test-run-member.test.ts`, `test-run-recovery.test.ts`, `test-workers.test.ts`, `test-space-lifecycle.test.ts`, `test-deployment.test.ts`, `test-alerts.test.ts`, `test-run-export.test.ts`, `test-primary-sync.test.ts`, `test-replica-control.test.ts`, `test-netcup-fencing.test.ts`, `test-replica-transport.test.ts`, `test-bootstrap.test.ts`, `test-container-fencing.test.ts`, `test-control-host-change.test.ts`); crash/reopen helpers for JSONL and SQLite
  in `test/support/persistent.ts`
- Native pi-server acceptance: `npm run test:pi-server`; uses packages from the sibling mobile runtime
  (`PI_SERVER_RUNTIME_DIR` overrides the path); skips if not installed, never installs dependencies.
- Single test: `node --experimental-strip-types --test --test-name-pattern=<pattern> integration.test.ts`
- Remote test bed (docker on the server `big`; verifies the BUILT artifacts, no source goes to the server;
  `npm run testbed -- check|up|test|status|down`, `--dry-run` first): `test/testbed/`,
  docs in `docs/testumgebung-big.md`; `scenario sieve-mobile create|run|evaluate|all` is the phone-simulating sieve test. Starting containers or shipping artifacts changes a shared server: ask before the first real run.
- TUI: `npm run tui` (read-only spaces/objects and test-bed controls); `--dry-run` previews without server access, `--local-dir DIR` inspects local JSONL state. Docs: `docs/tui.md`.
- Dashboard (read-only live UI): `npm run dashboard -- --dir <store>` in the foreground;
  `npm run dashboard:start|stop|status` (via `scripts/dashboard.sh`) in the background. Docs: `docs/dashboard.md`.
- Examples without a model: `npm run example`, `npm run example:pipeline`, `npm run example:chat`, `npm run example:sieve`, `npm run example:cache`
- Live examples (real model, cost tokens, ask first): `examples/chat.ts --live`, `npm run example:arxiv`

Run typecheck and tests after every change.

## Layout

- `src/core.ts` pure semantics, `src/doc.ts` the default Space document, `src/spaces.ts` registry and named spaces,
  `src/claims.ts` request claims/generations, `src/client.ts` `PiSpaces`, `src/index.ts` tools, delivery, reaper,
  `src/meter.ts` metrics; `src/stream.ts`, `src/snapshot.ts`, `src/paging.ts` changes/snapshots/byte pages,
  `src/mailbox.ts` durable mailboxes, `src/pi-server.ts` the structural pi-server adapter.
  `src/service.ts` the transport-independent `space` service, `src/remote.ts` `RemoteSpace`, `src/socket.ts` its unix-socket/TCP transport and server,
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
- `docs/` plans and documentation: `implementierungsstand.md` (current implementation), `api.md` (public API), `spaces-v1.md` (historical), `federation-plan-v3.md` (current
  federation plan; v1/v2 are superseded), `examples.md` (examples in detail).

## Conventions

- No new dependencies without asking; nothing is installed locally.
- Scripted model tests: filter out system messages before checking the last message (see `docs/examples.md` §5).
- Documentation in `docs/` is German; code comments and README are English.
- Call this project's library and spaces pi-spaces; the local client class is `PiSpaces`.
  JavaSpaces names the historical reference only.
