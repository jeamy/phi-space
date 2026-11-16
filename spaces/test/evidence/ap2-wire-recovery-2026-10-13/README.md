# Phase 2 signed-wire recovery evidence, 2026-10-13

The full run used the built library on `big`: 10,000 entries, 1,000 sieve jobs, three Members and six workers. Fifteen successful RPC replies were discarded, once per Member and effect kind (Task write, transaction begin, take, Result write, transaction commit). The same Parent identities resolved their retained Child outcomes. The run passed in 462.309 seconds, with 1,000 unique results, no Tasks and all 9,000 background entries retained. Prime reference: 9,592 primes through 100,000, sum 454,396,537.

Background entries were seeded in bounded local bootstrap commits before activation of the fixture policy. The four real NetBird namespaces share one physical server. Provisioning, keys and policy are fixture inputs; independent boot/fencing and production Root enrollment are not accepted here. No process-crash or mailbox-ACK matrix is claimed.

The earlier before-send attempt is an intentional negative diagnostic, not a passing workload: absent claims deny status delegation. The old adapter treated the resulting typed permission error as an unavailable transport indefinitely. The fix persists `needsReview` for typed PermissionDenied, RequestExpired, ResultExpired and IncarnationChanged. Each backend tests all four reply codes, reconstruction, one send attempt and zero effects. The old adapter deliberately fails this regression on both backends.

`checks.json` records passed checks and remaining gates; `netbird-full.json` records individual fault slots, identities and workload results. Cleanup records cover only the temporary fixture objects. Main services and fenced old restore sources were not changed. The initial inventory fixture startup attempt did not run the workload; bootstrap seeding was moved before activation of managed-type admission, and Member logs are now retained until owned-container cleanup.

Reproduce with the commands in `test/testbed/README.md`. Management credentials and private SQLite fixtures stay on the server; only built `.mjs` artifacts were shipped.
