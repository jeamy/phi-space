# AGENTS.md

pi-spaces as a `@earendil-works/pi-durable` extension. TypeScript, ESM, run directly with
`node --experimental-strip-types` (no build step for tests or examples).

## Commands

- Typecheck: `npm run typecheck` (`tsc`, covers `src`, `examples`, `*.test.ts`)
- Bundle: `npm run bundle` (also synchronizes the sibling mobile runtime and compiled example modules;
  `PI_SPACES_MOBILE_ROOT` selects another mobile checkout)
- Tests: `npm test` (node test runner: `test-core.test.ts`, `test-meter.test.ts`, `integration.test.ts`,
  `test-persistence.test.ts`, `test-spaces.test.ts`, `test-claims.test.ts`, `test-budgets.test.ts`, `test-stream.test.ts`, `test-service.test.ts`, `test-remote.test.ts`, `test-socket.test.ts`, `test-gate.test.ts`, `test-auth.test.ts`, `test-enroll.test.ts`,
  `test-scenario.test.ts`, `test-tui.test.ts`, `test-ap1.test.ts`, `test-pi-server.test.ts`); crash/reopen helpers for JSONL and SQLite
  in `test/support/persistent.ts`
- Native pi-server acceptance: `npm run test:pi-server`; uses packages from the sibling mobile runtime
  (`PI_SERVER_RUNTIME_DIR` overrides the path); skips if not installed, never installs dependencies.
- Single test: `node --experimental-strip-types --test --test-name-pattern=<pattern> integration.test.ts`
- Remote test bed (docker on the server `big`; verifies the BUILT artifacts, no source goes to the server;
  `npm run testbed -- check|up|test|status|down`, `--dry-run` first): `test/testbed/`,
  docs in `docs/testumgebung-big.md`; `scenario sieve-mobile create|run|evaluate|all` is the phone-simulating sieve test. Starting containers or shipping artifacts changes a shared server: ask before the first real run.
- TUI: `npm run tui` (read-only spaces/objects and test-bed controls); `--dry-run` previews without server access, `--local-dir DIR` inspects local JSONL state. Docs: `docs/tui.md`.
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
  `src/enroll.ts` pairing (tokens, enroll RPC, bootstrap, key directory in the control space).
- `examples/` runnable examples; `examples/sensor-pipeline.ts` is also imported by the pipeline tests.
- `docs/` plans and documentation: `implementierungsstand.md` (current implementation), `api.md` (public API), `spaces-v1.md` (historical), `federation-plan-v3.md` (current
  federation plan; v1/v2 are superseded), `examples.md` (examples in detail).

## Conventions

- No new dependencies without asking; nothing is installed locally.
- Scripted model tests: filter out system messages before checking the last message (see `docs/examples.md` §5).
- Documentation in `docs/` is German; code comments and README are English.
- Call this project's library and spaces pi-spaces; the local client class is `PiSpaces`.
  JavaSpaces names the historical reference only.
