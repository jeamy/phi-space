# Help corpus: consistency, implementation and completion

This report documents the corpus corrections before the complete namespace rename.
The newer final runs, including additional generator cleanup and the storage format change,
are in the [rename report](../namensumstellung-2026-10-18.en.md).

As of 18 October 2026. Supplements the [help system / demo analysis](analyse-hilfesystem-demo-apps-2026-10-18.en.md).
The historical findings remain there; F01–F23 and the following corpus corrections
are implemented locally. "Done" means the described change and its local evidence,
not a blanket production release.

## 1. Result and maintenance contract

The help corpus now contains **45 unique articles, 90 localized DE/EN records,
nine areas and 14 API reference groups**. Eight additional practical guides close the
gap between the API description and a workflow that can actually be run.

The authoritative text sources are under `help-site/scripts/`:

- `corpus-articles-data.ts`: fundamentals and cross-cutting topics.
- `corpus-workflows-and-api.ts`: stages and API reference.
- `corpus-practical-guides.ts`: additional practical guides.
- `corpus.ts`: shared article list for generator and checks.

`help-site/corpus/{de,en}/` and the delivered JSON/Markdown artifacts are generated.
Direct changes there would be lost at the next build. Catalog and API classification
are in `help_product_catalog.json` and `api_facts.json`; API signatures are derived from the
TypeScript program, not maintained as a second manual API.

## 2. Completed findings

| ID | Status | Correction and evidence |
|---|---|---|
| C01 | Done | `CompletionProfile` corrected to `resultTypes`, `equalFields`, `maxResultCount`; real limit fields and `ResourceExhausted` instead of invented schemas/error names. Actual TS code blocks are compiled. |
| C02 | Done | `readPage`/`changes` documented with `items`, `next`, `token`, `rev`, `streamId`, `batches`, `more`. Snapshot expiry and stream change lead to a rebuild, not to silently counting on. |
| C03 | Done | Local conversation delivery separated from remote consumer mailboxes; actual `events`/`ack` signatures, opaque string epoch and processing before prefix ACK described. A full mailbox is not a promised lossless infinite queue. |
| C04 | Done | EntryView/lease fields, entry ID, reaper/service role and fork as a parent/sequence-boundary reference corrected. No message duplication through a supposed fork copy. |
| C05 | Done | JavaSpaces classified as the semantic basis. Promise/RPC call, waiting operation, persistent registration and CPU work distinguished. Decoupling is not a claim that every operation works immediately or without a service. |
| C06 | Done | `FederatedSpace` no longer presented as an interchangeable `SpaceLike`. Host/controller/run/alert examples adapted to real parameters. V4 = gate, V5 = routing, V6 = operations control; web login and peer enrollment separated. |
| C07 | Done | API signatures derived from real exports/methods. `strictNullChecks` preserves possible miss/`null` results. Absolute checkout paths contained in inferred types are converted into relative source module references; regressions check both. |
| C08 | Done | IDs, catalog/related references, API facts, link targets, anchors, DE/EN anchor parity, code fences and table columns validated before generation. Negative tests deliberately reject broken inputs. Content hash covers the full content; source shows the real Git revision and dirty status. |
| C09 | Done | API search, filter, language and the requested workbench stage are preserved in URLs. Related articles and internal anchor changes work. Search text takes article content into account; index load errors offer a visible error and retry, stale responses are discarded. |
| C10 | Done | Markdown tables take pipes in code spans/escaped pipes into account; nested lists and numbering not starting at 1 are preserved. Unsafe link schemes are discarded. |
| C11 | Done | Browser check revealed missing mounting of the standalone app. New `client/main.tsx` creates the React root; the standalone build uses this entry. Next still imports only the shared app. Bundle assertion and actual browser check complement SSR. |
| C12 | Done | Shutdown race fixed: an init still running during `close()` must not start swarm timers afterwards. History work is aborted/awaited; a regression counts real timers. The complete help suite now ends without a timeout. |
| C13 | Done | Tests disable models, operator-side remote shards and high swarm load before the server import. The final run uses no production shards. Docker Compose test command switched to the same complete help suite instead of selecting only the integration file. Container run remains open separately. |
| C14 | Done | Root README in English, German version `README_DE.md`; help README in English with a German version. Experimental notice at the top of both root versions, MIT license file and package metadata present. Outdated shutdown-check notes and documentation index corrected. |

The earlier unconditional statement that `write` "always" creates a new entry was also replaced in the
short API text: request replay creates no second entry; `unique` enables an
atomic singleton first creation. This is not a global cross-shard uniqueness guarantee.

## 3. Guides added in detail

All of the following articles are **done**, available in German and English and wired into catalog/search:

| Help ID (`help.topic.…`) | Content |
|---|---|
| `first_running_space` | Complete model-free program with imports, harness, service, task, read/take, result, commit/abort, cleanup and exact output. |
| `async_interaction` | Decoupling of time/place/reference in the system as actually implemented; promise versus wait/notify and persistent delivery; CPU/commit costs. |
| `task_lifecycle` | Task lease versus transaction lease, reservation/commit, completion, safe retry, external idempotency; ThreadSequence, `unique` and pointer forks. |
| `live_sync_recipe` | Complete snapshot over all pages, subsequent changes including delete/empty revision, stream change/expiry, atomic publication and UI filter. |
| `social_swarm_pipeline` | Producer → task → worker reservation → computation → completion batch → history/feed; two real worker storage commits, shards and remaining costs. |
| `failure_playbook` | Failure symptom, probable cause and safe next action; in particular unknown outcome, completion, budget, snapshot, mailbox and poisoned store. |
| `safe_operations` | Local start, password/enrollment/grants, model budget, limits, backup/restore and limits for process, power and host failure. |
| `topology_and_readiness` | Stage matrix v1–v6, actually local components versus real hosts; merge versus primary/sync, fencing and separate acceptance gates. |

The executable [tutorial](../../help-site/examples/tuple-basics.ts) returns
`{ inspected: 7, squared: 49, jobsRemaining: 0 }` (CLI as JSON).
The [live mirror implementation](../../help-site/examples/shared/live-mirror.ts) is tested with
multi-page fake protocols and real PhiSpaces put/delete operations.
Incomplete or failed updates do not change the previously published mirror.

## 4. Automated evidence

| Check | Result |
|---|---|
| Root `npm run typecheck` | successful |
| Help `tsc -p help-site/tsconfig.json --noEmit --incremental false` | successful |
| Root suite | 741 tests: 740 passed, one optional bootstrap-copy test skipped, no failures |
| Examples serially | 158/158 passed |
| Complete help suite | 45 tests: 44 passed, separate SSR case skipped, no failures; process ends cleanly |
| Fresh production build + SSR | build successful, separate SSR test 1/1 passed |
| Documentation gate | 45 articles/90 records, 14 derived signature groups, 60 actual TypeScript code blocks checked |
| Local documentation links | 172 relative file references in final report, index, implementation status and four READMEs checked, no missing target |
| Compose configuration | `docker compose … --profile test config --quiet` successful; no image/container run |
| Whitespace/diff check | `git diff --check` successful |

The regular build runs the purely reading documentation gate before generation:

```bash
npm --prefix help-site run check:docs
npm --prefix help-site test
npm --prefix help-site run test:production
```

`help-consistency.test.ts` also checks deliberately broken links, missing API facts,
language deviations, invalid example code, renderer, URL round trips, retry/stale load,
tutorial output, shutdown and mirror error boundaries. The tests do not replace a blanket
acceptance of all prose, browser devices or failure scenarios.

Current temporary local logs: `/tmp/phi-spaces-root-completion-final.log`,
`/tmp/phi-spaces-examples-completion-final.log`, `/tmp/phi-spaces-help-completion-final.log`,
`/tmp/phi-spaces-help-production-completion-final.log`. The earlier runs remain traceable under
`/tmp/phi-spaces-root-help-consistency.log`, `/tmp/phi-spaces-help-fixes-examples.log` and
the `*-completion.log` files. These logs are not versioned CI artifacts.

## 5. Browser check

Isolated local in-memory server, no models, no remote shards:

- The standalone app renders after a real reload instead of an empty mount area.
- Complete introductory article in English and German; language switch preserves the article.
- Internal link to the task lifecycle loads the right article.
- Start page contains 45 articles and the introductory guide.
- API search `write` with provider `client` and category `mutation`: URL contains all filters;
  a full reload reconstructs input and selection.
- A stage-5 resource opens the workbench with `stage=v5` and a visibly active stage V5;
  the stage is not secretly started as an external run.
- Full-text search for `SnapshotExpired` finds four matching articles, including the new
  failure and live synchronization guides.
- A freshly loaded API parameter table shows `Promise<EntryView | null>` in a single
  type cell, without creating an additional table column from the pipe character.
- A freshly loaded security API shows relative type references instead of local checkout paths.

This is a limited interactive smoke test, not a complete E2E matrix.
The check tab and both in-memory check servers started during the work were closed after the
checks. Existing operator-side services/shards were not terminated.

## 6. Open points and responsibility

Within the described local correction scope, no known implementation points
were deliberately left unaddressed. The following evidence/actions remain open separately:

1. **Deployment and container acceptance:** build/start changed images, publish the service,
   check migration/start in the actual target operation. Not executed without separate approval
   because of shared hosts; a Compose/Dockerfile change is not a container run.
2. **Large-store performance:** measure CPU, event-loop lag, throughput and HTTP p95/p99 on the actual
   34k-entry store and on `big`. The local two-commit evidence guarantees no
   blanket speed factor; document serialization and core scans remain costs.
3. **Real device/network/failure acceptance:** browser matrix, phone, proxy/TLS, new multi-host
   configuration as well as kill/power/host failure and recovery for exactly this state.
   Historical other acceptances are neither replaced nor retroactively revoked by this report.
4. **Paid providers:** check the live model path with explicit cost approval.
   All final checks use deterministic answers.
5. **Optional bootstrap-copy test:** requires an explicitly configured suitable
   store copy; deliberately skipped in the normal root run.
6. **Publication:** Git commit/push and GitHub About change not executed. The
   requested About one-liner was delivered; writing to remote repositories was not commissioned.

Deliberate architecture/operations limits are not hidden completed guarantees:
a Space remains a complete durable document, external effects need their own
idempotency, unclear admin outcomes can require `needsReview`, and stage reports are
not executable backups. New operations acceptances are to be planned against the current
[implementation status](../implementierungsstand.en.md), not against help prose alone.
