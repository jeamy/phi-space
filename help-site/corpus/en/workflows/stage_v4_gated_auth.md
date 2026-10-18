---
standard: help_workflow
id: help.workflow.stage_v4_gated_auth
title: "Stage 4 (v4-gated-auth): Overlay Gate, Layer A/B, Enrollment & 60s Grants"
short: "Secures the Multiplayer Space-Chat with startFederationHost, cryptographic connection challenge (Ed25519), token enrollment, 60-second grants, and boot guard."
tags: [v4, gate, auth, ed25519, enroll, grants, rotation, bootguard]
owner: security
related: [help.workflow.stage_v3_remote_socket, help.workflow.stage_v5_federated_cluster]
since: 0.0.1
---

# Stage 4 (v4-gated-auth): Overlay Gate, Layer A/B, Enrollment & 60s Grants

## Overview {#overview}

Stage 4 (`help-site/examples/v4-gated-auth/run.ts`) upgrades the Space-Chat to Phase 1b security: no client or worker can read or mutate the space without (1) being recognized in the overlay peer directory (**Layer A**), (2) proving possession of its enrolled `Ed25519`/`P-256` private key via connection challenge (**Layer B**), and (3) presenting a fresh control-signed **60-second grant** on every operation.

## Topology: Space Distribution {#topology}

- **2 independent, persistent harnesses**, each behind its own TCP gate:
  - **Control host** owning `CONTROL_SPACE` (peer directory, enroll tokens, grants, key rotation, boot guard).
  - **Data host** owning the chat space (threads, `Msg`, `Presence`).
- Access to the data space only through **Gate Layer A (overlay peer) + Layer B (Ed25519 challenge)** plus a 60s grant from the control space per operation.

## Workflow {#workflow}

### Step 1: Initialize Boot Register And startFederationHost {#step-1-host}

The host sets up a `SqliteRecoveryRegister` and `installBootGuard`, generates host and authority keys (`generateKey("ed25519")`), and starts `startFederationHost(harness, ctx, ...)` on a TCP port.

### Step 2: Admin Bootstrap & Worker Enrollment {#step-2-enroll}

1. The admin pairs its key once using `bootstrapEnroll`.
2. Next, the admin submits a `createEnroll` command to the supervisor to issue a one-time token for the chat worker (`peerId: "peer-chat-worker"`).
3. The chat worker calls `await workerControl.enroll(token)`, registering its public key in `CONTROL_SPACE`.

### Step 3: Space-Chat With 60s Grant Provider & Live Key Rotation {#step-3-grants-rotation}

The chat worker's `RemoteSpace` is configured with `grantProvider: () => workerControl.requestGrant("effect")`. Every `write`, `take`, and `commit` automatically carries a verified 60s grant. Finally, the script performs a **zero-downtime own-key rotation (`rotateKey`)** while the chat continues running.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
```

## See Also {#see-also}

- [Stage 5 (v5-federated-cluster): Federated Spaces with Router & HRW Sharding](help.workflow.stage_v5_federated_cluster#overview)
