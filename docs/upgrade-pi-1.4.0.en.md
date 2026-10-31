# Upgrade of the Earendil connection to 1.4.0

As of: 30.10.2026. The upgrade concerns the agent package, Codemode and the neighboring mobile runtime.
The standalone Space core and its SQLite format are not converted to pi-durable.

## Package versions

| Area | Version |
|---|---|
| `agent/`: pi-durable, pi-ai, Chord | exactly `1.4.0` |
| Root examples and Codemode chat: pi-codemode | exactly `1.4.0` |
| Mobile runtime: pi-durable, pi-ai, Chord and pi-coding-agent | exactly `1.4.0` |
| Mobile runtime: pi-client, pi-server and transitive pi-protocol | `1.1.0`, last published version of these packages |

**Transport exception:** pi-client/pi-server/pi-protocol were not published as 1.4.0.
Their version 1.1.0 imports old Chord RPC exports that are missing in 1.4.0
(among others `createServiceCatalogueCall`). The runtime therefore uses npm overrides to isolate
their Chord dependency on `1.1.0`. The harness continues to use Chord `1.4.0`.
A blanket dedupe to a single Chord version would break this boundary again.

## Adaptations

- Tool results use `output` instead of `content`; this concerns the Space tools,
  the arXiv example and the mobile subagent tool. Messages to the model keep their own
  `content` structure.
- The small generations document writes every change as a base (`checkpointWhen: () => true`).
  The mobile session catalog writes a new base at the latest with the 500th change since the last base.
- Agent examples and tests use the Chord context. The Space core keeps its own context
  without Earendil dependencies.
- `agentContext` adds a NOOP telemetry span for a Space/legacy transport context.
  Abort signal and application values are preserved; an existing agent context is used unchanged.
- `withAgentEventSink` adapts conversation delivery at both call boundaries.
  The mobile bundle additionally exports this bridge under the previous name `withEventSink`.
- pi-serverd adapts the context of the older RPC transport before harness calls.

## Data and operations

pi-durable 1.4.0 automatically migrates its SQLite database to schema 2.
An agent database migrated in this way can no longer be opened with 1.3.0 or older.
Before starting an updated installation, agent databases must be backed up,
including the associated WAL state or via a consistent SQLite backup.
A rollback to the old runtime needs the old database state.

This is independent of format 2 of the phi-spaces store.
Existing runtime databases are not opened during local installation or bundling.
The tests use isolated test directories; this upgrade starts no production services,
performs no remote deployment and builds no Android APK.

The mobile runtime is synchronized with the agent/Space bundle and the examples by `npm run bundle`.
A later deployment or Android build is a separate step; before the first start on a
device or server the backup requirement applies.

## Checks

- Root: `npm run typecheck`, `npm test`.
- Agents: `npm run typecheck:agent`, `npm run test:agent`; including the built bundle in the real pi-serverd.
- Codemode chat: own typecheck and tests.
- Help site: documentation check and tests of the shared model access.
- spaces-mmo: own typecheck and tests; live model calls stay off.
- Mobile: `npm test` in `runtime/` and `node --test test/spaces-mobile.test.mjs`.
- Bundle: `npm run bundle`; no change to running hosts.

Local tests replace neither a real model/OAuth acceptance nor an Android device acceptance.
An existing production agent database is not used as a test fixture.

### Result of the local check run

| Check | Result |
|---|---|
| Root typecheck and import guards | passed |
| Root tests | 604 passed, 1 skipped (`PHI_SPACES_BOOTSTRAP_COPY` not set) |
| Agent typecheck and tests | passed; 91 tests, including real pi-serverd acceptance |
| Codemode chat | Typecheck passed; 113 tests passed |
| Help site | Typecheck and documentation check passed; 59 tests passed, 1 production-dependent test skipped |
| spaces-mmo | Typecheck passed; 160 tests passed, 1 garden test failed |
| Mobile runtime | 22 offline tests passed, including session catalog reopening and subagent result |
| Mobile Space lifecycle | 6 tests passed |
| Bundle and mobile CLI | Bundle synchronized; CLI reports `1.4.0` |

**Open MMO deviation:** `spaces-mmo/tests/garden.test.ts:173` fails at
`every harvested plant gave its yield once`. In the full run 2 instead of 3,
in the isolated repeat run 3 instead of 4 yield units were counted.
The garden tests and several related MMO files had already been changed before this upgrade;
these changes remain untouched. Model calls are switched off in the suite.
The full MMO suite is thus expressly **not green**.
The later state of 31.10.2026 is in the [check run of the comparison](vergleich-pi-durable.en.md#check-run): 173 of 173 passed, sporadic failures under load.

A first mobile check run, started at the same time as the large suites, had two
timeouts. The subsequent isolated run and the final run with the two
new regression tests passed completely.

## Relation to the comparison

[vergleich-pi-durable.en.md](vergleich-pi-durable.en.md) describes the state after this upgrade.
The 1.0.3 dependencies and upgrade hurdles named there are the historical starting point,
not the current package state.
The unreleased Earendil main state is expressly not adopted.
