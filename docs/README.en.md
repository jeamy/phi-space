# phi-spaces documentation

| Document | Content | Status |
|---|---|---|
| [implementierungsstand.en.md](implementierungsstand.en.md) | implemented scope, evidence and limits | **current** |
| [api.en.md](api.en.md) | TypeScript, service and remote API | **current** |
| [vergleich-pi-durable.en.md](vergleich-pi-durable.en.md) | Similarities and differences to Earendil's pi-durable; release 1.4.0 and newer main state kept apart | comparison of 2026-10-30, with sources and upgrade limits |
| [upgrade-pi-1.4.0.en.md](upgrade-pi-1.4.0.en.md) | Earendil upgrade, context bridge, transport exception and database/rollback limits | package state 1.4.0; server/client separately 1.1.0 |
| [agenten-stromausfalltest.en.md](agenten-stromausfalltest.en.md) | FULL/fsync, JSONL marker barrier, regressions and prepared throwaway VM test | sync policy implemented; VM runs of 2026-10-30/31 without loss in the strong profile; drives and other file systems open |
| [Complete renaming](namensumstellung-2026-10-18.en.md) | uniform names, store/bundle format break, check evidence and operating limits | implemented locally; existing stores/external deployment separate |
| [umstellung-ohne-pi-durable.en.md](umstellung-ohne-pi-durable.en.md) | standalone Space host, durability, data migration and acceptance without pi-durable | detailed target and work plan; U0 to U4, U6, U8 and parts of U7 implemented, U5 dropped (D6) |
| [umstellung-u0-bestand.en.md](umstellung-u0-bestand.en.md) | U0: import graph, document catalog, baseline tests, load profile, limit values | inventory of 2026-10-22; D1–D4 and D6 decided |
| [UI mockups](_attic/ui-mockups/UI-MOCKUPS.en.md) | Gallery of the dashboard drafts | UI concept |
| [spaces-v1.md](_attic/spaces-v1.en.md) | local state of 2026-10-07 | historical |
| [federation-plan-v3.en.md](federation-plan-v3.en.md) | Plan for federated Spaces, gates, open questions | **current** |
| [implementierungsplan-v3.en.md](_attic/implementierungsplan-v3.en.md) | Maturity, prior decisions, work packages and progress for v3 | archived |
| [ap1b-abnahme.md](_attic/abnahme/ap1b-abnahme.en.md) | Phase 1b: runtime, grants, rotation and recovery building blocks | accepted in the F15 model |
| [ap2-abnahme.md](_attic/abnahme/ap2-abnahme.en.md) | Phase 2: router, delegation, membership, load and failure acceptances | completed (exception block 4) |
| [ap2-gate4.md](_attic/abnahme/ap2-gate4.en.md) | Gate 4: final operating values | fixed |
| [ap3-replikation.md](_attic/abnahme/ap3-replikation.en.md) | Phase 3: replication building blocks, state and open steps | begun, not accepted |
| [ap3-replica-control.md](_attic/abnahme/ap3-replica-control.en.md) | Phase 3: promotion, degradeToSingle, setStandby, fencing interface | implemented, netcup fencing adapter real; phase 3 not accepted |
| [dashboard.en.md](dashboard.en.md) | reading live dashboard | implemented |
| [datenhaltung.en.md](datenhaltung.en.md) | which data lies in which store and Space, locally and on big/nano | as of 2026-10-28 |
| [wire-protokoll.en.md](wire-protokoll.en.md) | wire protocol of the Space service, basis of a second server | as of 2026-10-29 |
| [rust-portierung.en.md](rust-portierung.en.md) | port of the Space server to Rust | ongoing |
| [codemode-space-architektur.en.md](codemode-space-architektur.en.md) | codemode chat: every role its own process around one Space | current |
| [codemode-kooperation.en.md](codemode-kooperation.en.md) | codemode chat: cooperation of the agents | concept of 2026-10-20 |
| [ap1-abnahme.md](_attic/abnahme/ap1-abnahme.en.md) | AP 1.1–1.9: implementation, regressions and native pi-serverd acceptance | checked locally |
| [testumgebung-big.en.md](testumgebung-big.en.md) | Docker test environment on the server big: script, containers, fault injection, limits | implemented, `test/testbed/` |
| [tui.en.md](tui.en.md) | Terminal interface: Spaces/objects, server actions, tests and reports | implemented; planned backends locked |
| [betrieb-und-mobile-steuerung.en.md](betrieb-und-mobile-steuerung.en.md) | Operations extension: runs, workers, Spaces, bootstrap, mobile control, acceptance cases | **current**: B1–B10 implemented, state per case in §7.6 |
| [projektstart-autoprovisionierung.en.md](_attic/projektstart-autoprovisionierung.en.md) | automatic remote provisioning of runtime, Spaces, monitoring and federation at project start | archived |
| [examples.en.md](examples.en.md) | Examples (pipeline, chat, arXiv team) in detail — what really runs | current |
| [VALIDIERUNG.en.md](_attic/VALIDIERUNG.en.md) | local check evidence and its limits | historical (as of 2026-10-07); current evidence in the implementation status |
| [TESTBESPIELE.md](_attic/TESTBESPIELE.en.md) | Specification of target examples incl. federation modes | draft, target picture |
| [examples/README.en.md](examples/README.en.md) | Index, learning path, quick start for all examples | current |
| [../help-site/](../help-site/) | Interactive help system + demos: Social Swarm Feed, Space Chat Workbench (v1–v6), AdminSpaces portal | current; start with `npm run help` |
| [Help system/demo analysis of 2026-10-18](_attic/analyse-hilfesystem-demo-apps-2026-10-18.en.md) | Logic errors, unused and duplicate code, functional gaps; code references, reproductions and test evidence | F01–F23 fixed locally and documented as done; operating acceptances separate |
| [Help corpus: consistency and completion](_attic/analyse-hilfecorpus-konsistenz-2026-10-18.en.md) | API comparison, eight new practice guides, UI corrections, checks and open gates | local implementation completed; no deployment/large-store acceptance |
| [examples/](examples/) | checked example contracts and clearly separated drafts | sieve and local cache implemented; federation planned |
| _attic/federation-plan-v1.en.md, _attic/federation-plan-v2.en.md, _attic/federation-plan-v2-summary.en.md | earlier versions | replaced by v3, history only |

Reading order: implementation status → API → federation-plan-v3 (section 11 stage plan, 13 gates, 14 questions).

The example documents were consolidated on 2026-10-07: technically wrong code copies, contradictory status
and unbacked performance tables were replaced by current contracts. Evidence distinguishes code,
local scripted tests, still open live model checks and future federation.
The v1/v2 archives document earlier decisions and contain discarded drafts.

- [Phase 1b operation and recovery interfaces](_attic/abnahme/ap1b-betrieb.en.md) – implemented configuration and remaining operational integration.

- [AP 2.1/2.8: router and simulator](_attic/abnahme/ap2-router-und-simulator.en.md): implemented scope, recovery and evidence.

- [AP 2.2–2.5: delegation, routing and membership](_attic/abnahme/ap2-delegation-routing-membership.en.md): APIs, core locks and persistent/TCP evidence.
