# Run gate case 3 over the real NetBird overlay — 2026-10-15

Acceptance case 3 of [Betrieb und mobile Steuerung](../../../docs/betrieb-und-mobile-steuerung.en.md) §7.4 (step B4):
a Member is offline during a pause. Driver: `test/testbed/netbird/run-run-gate-overlay.py`, node fixture
`test/testbed/scenarios/run-gate-overlay-node.ts` (only the compiled `.mjs` and `phi-spaces.mjs` were shipped).

Setup: the run controller and a second Member ran on the operator host (NetBird 100.89.218.189). The other Member
ran in an owned rootless container on `big` (NetBird 100.89.53.156) with the pinned test image, read-only root, no
capabilities, 1 CPU and 512 MiB, behind the composed Gate on TCP 17432 of its NetBird address. The driver created
and removed its own firewall rules on both hosts and its own NetBird group and policy.

Sequence and result (`report.json`):

1. Start: both Members prepared and released, `running` at revision 2.
2. `docker kill` of the big Member container.
3. Pause: `pauseIncomplete`, the local Member applied revision 3, big is listed as missing.
4. Controller crash (harness abandoned, reopened): still `pauseIncomplete` at revision 3; an early resume is
   refused because the pause is still being applied.
5. New container on the same store and key: `advance` completes the **same** pause command; the big gate shows
   `paused`, revision 3, command `pause-3`.
6. Resume to revision 4, then late instructions to big: the same pause command replays its stored ACK without
   changing the gate (`running`/4); another command at revision 3 or 4 is refused.
7. Stop at revision 5.

Authentication: layer B key proof of the controller and signed run gate instructions and ACKs. Layer A is a fixture
peer-IP pin, not the NetBird Management API. One run, one physical server plus the operator host; no load test.
`cleanup.json`: owned containers, policy, group and firewall rules removed; protected container inventory on big
unchanged; the private remote store is retained under the operator directory. `build.json` records the artifact
hashes; the build came from the parent commit with uncommitted changes, including parallel Phase 3 work.
`smoke-report.json` is the same sequence on loopback (`--local-smoke`), run before the overlay run.
