---
standard: help_api
id: help.api.gate_auth_grants
title: "Gate, Layer A/B, Enrollment, 60s Grants & Rotation"
short: "Combines NetBird peer resolution (Layer A), Ed25519/P-256 challenge (Layer B), QR/token enrollment, 60s grants, and atomic key rotation."
tags: [startgate, startfederationhost, grantauthority, grantverifier, enroll, rotatekey]
owner: security
related: [help.topic.gate_auth_grants_and_recovery, help.workflow.stage_v4_gated_auth]
since: 0.0.1
---

# Gate, Layer A/B, Enrollment, 60s Grants & Rotation

## Overview {#overview}

`startFederationHost(harness, ctx, options)` composes gate, Layer A/B authentication, enrollment, grant issuance/verification, supervisor, key rotation, and boot guard into a single persistent host runtime.

## Technical Reference {#technical-reference}

```ts
const host = await startFederationHost(harness, ctx, {
  hostId,
  authorityId,
  keys: keyDirectory,
  verifier: grantVerifier,
  listen: { host: "127.0.0.1", port: 0 },
  directory,
  boot: { external: register, installed: installedRegister }
});
```

Configure keyDirectory, grantVerifier, directory and both independent registers before this fragment; a public key alone is not a GrantVerifier. listen/directory are top-level host options, not a gate subobject. The local v4 runner demonstrates the complete setup.

## Components At A Glance {#parameters}

| Component | Task |
| --- | --- |
| `startGate` | Layer A: Translates NetBird peer identity into `peerId` + role and rejects unknown peers. |
| `authenticate` (Layer B) | Ed25519/P-256 challenge proof of the client key, independent of the overlay. |
| `EnrollmentService` / `enrollQr` | One-time tokens and QR payloads for pairing smartphones, hosts, or browsers. |
| `GrantAuthority` / `GrantVerifier` | Issues ~60-second grants for individual operations and verifies them on data hosts. |
| `RotationService` / `rotateKey` | Atomic key rotation at runtime without restarting the gate. |
| `HostBootState` | CAS-protected boot guard against duplicate host incarnations and restore conflicts. |

## Typical Use Cases {#use-cases}

- **Phone pairing (v4/v6)**: `enrollQr` on the coordinator produces a QR code; `pi-termux-mobile` scans it, runs `enroll` in the `CONTROL_SPACE`, and receives `admin` rights.
- **Short-lived commands**: `AdminSpaces` and the mobile app execute every control action with a fresh 60-second grant – stolen tokens expire immediately.
- **Emergency key change**: `rotateKey` rotates the admin key on a compromised device without downtime.
