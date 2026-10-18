---
standard: help_topic
id: help.topic.gate_auth_grants_and_recovery
title: "Overlay Gate, Layer A/B Auth, 60s Grants, and Recovery"
short: "Two-layer authentication (NetBird peer + Ed25519/P-256 challenge), token/QR enrollment, short-lived 60-second grants, key rotation, boot guard, and restore."
tags: [gate, netbird, challenge, ed25519, enroll, grants, rotation, boot, restore]
owner: security
related: [help.workflow.stage_v4_gated_auth, help.api.gate_auth_grants]
since: 0.0.1
---

# Overlay Gate, Layer A/B Auth, 60s Grants, and Recovery

## Overview {#overview}

In a multi-host environment, an IP address alone is insufficient identity proof because multiple processes on the same host share the overlay IP. Phase 1b (`src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/runtime.ts`) therefore combines two authentication layers with short-lived signed **60-second grants** and an external **CAS boot register**.

## Concept And System Model {#concept-model}

### Layer A (Overlay Peer) + Layer B (App-Key Challenge) {#layer-a-and-b}

1. **Layer A (`startGate` / `NetbirdDirectory`)**: Resolves `peerId` and groups (`space-hosts`, `space-admin`, `space-observer`) immediately upon TCP accept (`identifyOnConnect: true`, 5 s timeout) and enforces per-peer (32) and per-listener (64) connection quotas.
2. **Layer B (`ProvingService`)**: Issues a connection-bound 30 s challenge `{ gateHostId, observedPeerId, connNonce }`. The client signs it using its private `Ed25519` or `P-256` key (stored in Android Keystore on mobile or a `0600` key file on servers).

### Enrollment, 60s Grants, And Key Rotation {#enrollment-and-grants}

- **Enrollment (`createEnroll` / `enrollQr`)**: An admin creates a one-time token via the supervisor (only the SHA-256 hash is stored in `CONTROL_SPACE`). The new device registers its public key via `remote.enroll(token)`.
- **Short-Lived Grants (`GrantAuthority` / `GrantVerifier`)**: Before mutating a data space, `RemoteSpace` obtains a control-signed grant (`purpose: "effect" | "resolution"`, max 60 s TTL) via `grantProvider`. The data member re-verifies signature, `authorityId`, `peerId`, `keyId`, scope, and expiry right before commit!
- **Own-Key Rotation (`rotateKey`)**: Requires signatures from both the old and replacement keys over a persisted challenge, swapping the key atomically in `CONTROL_SPACE`.

### Boot Guard And Restore Quarantine {#boot-and-restore}

- **Boot Guard (`SqliteRecoveryRegister` + `installBootGuard`)**: A host may only boot and commit while its local state and the external CAS register match on `authorityId`, `dataIncarnation`, and role for every space.
- **Data Restore (`RecoveryController`)**: Imports snapshots in 192 KiB-bounded batches, increments data incarnation, and quarantines restored exclusive tasks as `restoredUnverified` until an admin explicitly calls `releaseRestored`.

## See Also {#see-also}

- [Stage 4 (v4-gated-auth): Gate, Enrollment & 60s Grants in the Multiplayer Chat](help.workflow.stage_v4_gated_auth#overview)
- [Gate, Layer A/B, Enrollment & Grants API](help.api.gate_auth_grants)
