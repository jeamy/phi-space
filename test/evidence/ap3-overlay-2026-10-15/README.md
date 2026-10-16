# Entry replication across a real ten-minute NetBird partition — 2026-10-15

Component run of `test/testbed/netbird/run-phase3-overlay.py` with the compiled fixture
`scenarios/phase3-overlay-node.mjs` (only `pi-spaces.mjs` and the fixture were shipped). Two independent hosts:
the operator host (NetBird 100.89.218.189) and an owned container on `big` (NetBird 100.89.53.156), each with its
own SQLite store and `EntryReplicationController`, exchanging over TCP 17431 bound to the NetBird addresses.

Sequence (`report.json`): both directions bootstrapped and exchanged over the overlay; then both replication
listeners stopped (the VPN and all other traffic unchanged) for **600.4 real seconds** (19:46:15–19:56:15 UTC).
During the partition both hosts kept mutating: 21 samples, each with concurrent puts and lease renewals on the
same LWW key, a delete, and winners that expire during the partition. Afterwards both harnesses were reopened from
their stores and exchanged again.

Result: both views are identical (revision 90 on both sides, three visible entries); neither the deleted key nor the
expired winners became visible again; a maintenance pass followed by further exchanges did not grow either stream
(no echo). `cleanup.json`: owned container, NetBird group/policy and both firewall rules removed, protected
container inventory on big unchanged; the remote store is retained privately under the operator directory.

Scope and limits, as recorded in the report: a component fixture with a peer-IP pin and a private test token, not
the production key-proof/grant/boot protocol; no snapshot under load; no production service activated; not a
Phase 3 acceptance (`fullPhase3Accepted: false`). The artifact hashes in `report.json` identify the build; it was
made from the uncommitted tree that was committed afterwards as `830f01c`.
