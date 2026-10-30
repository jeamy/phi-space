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

Stage 4 secures access: anyone who wants to read or write the chat has to identify themselves first. A device is paired once and proves its key on every connection afterwards. Its calls also need short-lived permissions that expire after a minute.

## Topology: Space Distribution {#topology}

With `help-site/examples/v4-gated-auth/run.ts`, no client can read or change the space without (1) being known in the overlay peer directory (**Layer A**, a simulated directory in the demo), (2) proving its enrolled key via connection challenge (**Layer B**), and (3) presenting a fresh control-signed **60-second grant**.

- **2 independent, persistent hosts** in one process (each with its own SQLite store), each behind its own TCP gate:
  - **Control host** owning `CONTROL_SPACE` (peer directory, enroll tokens, grants, key rotation, boot guard).
  - **Data host** owning the chat space (threads, `Msg`, `Presence`).
- Access to the data space only through **Gate Layer A (overlay peer) + Layer B (Ed25519 challenge)** and with a 60s grant from the control space. `RemoteSpace` fetches it through `grantProvider` before every call and every retry; only `challenge`, `prove`, `enroll`, `enrollStatus`, and `grant` are exempt.

## Workflow {#workflow}

### Step 1: Initialize Boot Register And startFederationHost {#step-1-host}

The program opens two `SqliteRecoveryRegister`s (external and installed) and records a boot permit for each space. It generates the control host's signing key (`generateKey("ed25519", "control-signer")`) and starts both hosts with `startFederationHost(host, ctx, ...)` on a loopback TCP port; the boot guard is installed from `boot: { external, installed }`.

### Step 2: Admin Bootstrap & Worker Enrollment {#step-2-enroll}

1. `bootstrapEnroll` creates a one-time token for the peer `chat-worker` in the control store. In the demo this peer acts as admin and worker at once.
2. In the overlay group `space-enroll` the peer only has the role `unpaired`. It calls `controlClient.enroll(token)`, which registers it in `CONTROL_SPACE`.
3. The program moves it to the group `space-admin`, calls `controlHost.revalidate()`, and reconnects; `controlClient.authenticate()` proves the key. This stage does not use `createEnroll` for further devices; see [Stage 6](help.workflow.stage_v6_mobile_control#overview).

### Step 3: Space-Chat With 60s Grant Provider & Live Key Rotation {#step-3-grants-rotation}

The chat worker's `RemoteSpace` gets `grantProvider: () => controlClient.requestGrant("effect")`, plus `signer`, `expectedGateHostId`, and `ownPeerId`. Finally, the script rotates the key: `rotationChallenge`, then `rotateKey(challenge, replacementSigner)` with old and new signature. After the result appears in the control space it reconnects with the new key and writes another message, with no gate restart.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
```

## See Also {#see-also}

- [Stage 5 (v5-federated-cluster): Federated Spaces with Router & HRW Sharding](help.workflow.stage_v5_federated_cluster#overview)
