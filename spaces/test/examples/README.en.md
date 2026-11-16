# Tests of the Examples

Status: 2026-10-07. Built-in Node test runner, no new test library.
compat.ts reproduces a limited matcher/hook subset; vi.useFakeTimers is a stub
and must not be interpreted as real time control.

```bash
npm run typecheck
npm test
npm run test:examples
# Scripted-model examples of the agent package (they live in agent/test/examples/):
npm run test:agent
# Nested test details without the file-level runner summary:
node --experimental-strip-types test/examples/recovery.test.ts
```

| File | Actual scope |
|---|---|
| agent/test/examples/workers.test.ts | own scripted master/worker flow with a real Space |
| agent/test/examples/blocking-tool.test.ts | local blocking operations and timeouts |
| agent/test/examples/chat.test.ts | own faux chat and notify pattern |
| sensor-pipeline.test.ts | imported collect/analyse/present functions |
| golomb.test.ts | BitSet, ruler validation, references and manually created entries |
| agent/test/examples/arxiv-research.test.ts | own scripted research flow, feed parser |
| agent/test/examples/dark-energy-research.test.ts | own scripted flow with local fixtures |
| sieve.test.ts | real sieve functions, independent reference, concurrency, rollback and JSONL reopen |
| cache.test.ts | real cache class, CAS concurrency, TTL, rollback and JSONL reopen |
| codemode-evolve.test.ts | evolution of prime-number code in the codemode sandbox; skipped when pi-codemode is missing |
| recovery.test.ts | real Golomb search and runner, JSONL reopen, error/rollback cases |

The files with the path `agent/test/examples/` run with `npm run test:agent`, the others with `npm run test:examples`.

New regressions check: an actually found order-4 ruler; a persistent completed run;
a subprocess ended by SIGKILL with a JSONL reservation and a subsequent new search;
a foreign runId does not affect completion; a changed run configuration is rejected; an error at
task completion returns the task and discards results; unsafe old checkpoints are ignored;
a valid measured value after an invalid identical delivery; atomic presenter return; oversized window;
complete abstract/date/authors; actual research runners with faux and fresh JSONL;
a missing result txn and an invented citation count are rejected; a real scripted chat ring.

The runner tests use the real production prompts with scripted answers. This checks the
host orchestration, not whether a real model reliably fulfils the prompts. No
paid models or actual arXiv network requests are run.

Old test names such as "complete search" are, for manually created entries, no independent evidence of a search.
No coverage percentages, performance, fuzz, multi-process or federation acceptance exist.
The outer npm runner can report only file results; no total number of inner cases is derived from that.
On 2026-10-07, 158 inner tests passed outside the restricted sandbox, with no failures or skips.
Of these, 7 new tests check the sieve and 8 new tests the local cache. The sieve reference uses
independent trial division; lease/TTL tests inject a clock instead of using the fake-timer stub.
The process-crash test needs permission to start and end a local Node subprocess.
Under a sandbox with child_process blocked, a targeted approval is required for it.
[Example documentation](../../docs/examples.en.md).
