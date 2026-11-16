# Phase 1b evidence, 2026-10-11

These public reports record successful live checks from this run. They contain no private keys or tokens.

- `register.json`: independent VPS register, TLS reader/operator separation and persisted CAS after restart.
- `two-host.json`: real NetBird peers and management API, two persistent container processes, grants, write/take and rotation after restart.
- `fence.json`: narrowly scoped F15 maintenance cycle with real stop and restart refusal; no restore or successor installed.
- `control-private.json`: signed private RPC through forced SSH; negative authorization checks, not a successful live restore ACK.
- `keystore.json`: native Android signer checks before and after app restart; fixture message identities, not overlay/UI acceptance.

- `phone.json`: real phone enrollment, native-key authentication and object access over NetBird after the user added space-hosts; rotation, old-key rejection and pending-rotation recovery after app restart passed. Visible object UI and a continuously sampled short screen-off object-access test passed. Complete UI and long background/Doze acceptance remain open.
- `tui.json`: built inspector reads both live SQLite stores and displays spaces and objects without errors.

- `data-restore.json`: isolated distributed Data restore with actual F15 process/service fencing, host-signed control ACK, SIGKILL/reopen, quarantine, scoped release and real phone access after normal restart.

- `control-restore.json`: isolated Control-authority restore, source fencing, separate member installation with public OP pin and scoped register certificate, both release guards, fresh keys, normal gate restart and successful grants/write/take; 233 tests passed.

The full NetBird outage matrix and complete mobile UI/background acceptance remain outstanding. See [acceptance status](../../../docs/_attic/abnahme/ap1b-abnahme.en.md).

- `phone-ui.json`: actual native UI pairing-status/authentication/rotation/status-repeat/object buttons after the live status bug was fixed; four mobile regressions passed. First pairing forms and camera QR remain separate.

- `netbird-management-5m.json`: completed scoped management reachability outage for two real peers, preserved signal/relay/direct TCP, gate closed after cache expiry, object access recovered. Remaining timed matrix phases are running.

- `phone-background-10m.json`: completed continuous ten minute screen-off/background interval, six real object checks passed, app independently STOPPED/not visible; natural deep Doze is separate.

- `phone-doze.json`: completed controlled forced deep-Doze interval, four real object checks passed, original ForceIdle=false restored, no battery exemption/settings changed.
