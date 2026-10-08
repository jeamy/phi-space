# AGENTS.md

pi-spaces as a `@earendil-works/pi-durable` extension. TypeScript, ESM, run directly with
`node --experimental-strip-types` (no build step for tests or examples).

## Commands

- Typecheck: `npm run typecheck` (`tsc`, covers `src`, `examples`, `*.test.ts`)
- Bundle: `npm run bundle` (also synchronizes the sibling mobile runtime and compiled example modules;
  `PI_SPACES_MOBILE_ROOT` selects another mobile checkout)
- Tests: `npm test` (node test runner: `test-core.test.ts`, `test-meter.test.ts`, `integration.test.ts`,
  `test-persistence.test.ts`, `test-spaces.test.ts`, `test-claims.test.ts`, `test-scenario.test.ts`); crash/reopen helpers for JSONL and SQLite
  in `test/support/persistent.ts`
- Single test: `node --experimental-strip-types --test --test-name-pattern=<pattern> integration.test.ts`
- Remote test bed (docker on the server `big`; `npm run testbed -- check|up|test|status|down`, `--dry-run` first): `test/testbed/`,
  docs in `docs/testumgebung-big.md`; `scenario sieve-mobile create|run|evaluate|all` is the phone-simulating sieve test. Starting containers or syncing changes a shared server: ask before the first real run.
- Examples without a model: `npm run example`, `npm run example:pipeline`, `npm run example:chat`, `npm run example:sieve`, `npm run example:cache`
- Live examples (real model, cost tokens, ask first): `examples/chat.ts --live`, `npm run example:arxiv`

Run typecheck and tests after every change.

## Layout

- `src/core.ts` pure semantics, `src/doc.ts` the default Space document, `src/spaces.ts` registry and named spaces,
  `src/claims.ts` request claims/generations, `src/client.ts` `PiSpaces`, `src/index.ts` tools, delivery, reaper,
  `src/meter.ts` metrics.
- `examples/` runnable examples; `examples/sensor-pipeline.ts` is also imported by the pipeline tests.
- `docs/` plans and documentation: `spaces-v1.md` (current implementation, gaps), `federation-plan-v3.md` (current
  federation plan; v1/v2 are superseded), `examples.md` (examples in detail).

## Conventions

- No new dependencies without asking; nothing is installed locally.
- Scripted model tests: filter out system messages before checking the last message (see `docs/examples.md` §5).
- Documentation in `docs/` is German; code comments and README are English.
- Call this project's library and spaces pi-spaces; the local client class is `PiSpaces`.
  JavaSpaces names the historical reference only.
