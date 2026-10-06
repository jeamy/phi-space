# AGENTS.md

JavaSpaces-style space as a `@earendil-works/pi-durable` extension. TypeScript, ESM, run directly with
`node --experimental-strip-types` (no build step for tests or examples).

## Commands

- Typecheck: `npm run typecheck` (`tsc`, covers `src`, `examples`, `*.test.ts`)
- Tests: `npm test` (node test runner: `test-core.test.ts`, `test-meter.test.ts`, `integration.test.ts`)
- Single test: `node --experimental-strip-types --test --test-name-pattern=<pattern> integration.test.ts`
- Examples without a model: `npm run example`, `npm run example:pipeline`, `npm run example:chat`
- Live examples (real model, cost tokens, ask first): `examples/chat.ts --live`, `npm run example:arxiv`

Run typecheck and tests after every change.

## Layout

- `src/core.ts` pure semantics, `src/doc.ts` the Space document, `src/client.ts` `JavaSpace`, `src/index.ts` tools,
  delivery, reaper, `src/meter.ts` metrics.
- `examples/` runnable examples; `examples/sensor-pipeline.ts` is also imported by the pipeline tests.
- `docs/` plans and documentation: `spaces-v1.md` (current implementation, gaps), `federation-plan-v3.md` (current
  federation plan; v1/v2 are superseded), `examples.md` (examples in detail).

## Conventions

- No new dependencies without asking; nothing is installed locally.
- Scripted model tests: filter out system messages before checking the last message (see `docs/examples.md` §5).
- Documentation in `docs/` is German; code comments and README are English.
