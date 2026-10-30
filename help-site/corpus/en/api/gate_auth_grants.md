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

These building blocks control who may use a space on the network. A device is paired once and proves its key on every connection afterwards. Calls also need short-lived permissions. `startFederationHost` starts all of it together.

## Technical Reference {#technical-reference}

`startFederationHost(host, ctx, options)` composes gate, Layer A/B authentication, enrollment, grant issuance/verification, supervisor, key rotation, and boot guard into a single persistent host runtime.

```ts
const federation = await startFederationHost(host, ctx, {
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
| `GrantAuthority` / `GrantVerifier` | Issues grants valid for at most 60 seconds (`purpose`: `effect` or `resolution`) and verifies them on data hosts. |
| `RotationService` / `rotateKey` | Atomic key rotation at runtime without restarting the gate. |
| `HostBootState` | CAS-protected boot guard against duplicate host incarnations and restore conflicts. |

## Typical Use Cases {#use-cases}

- **Phone pairing (v6)**: `enrollQr` on the coordinator produces a QR code; `pi-termux-mobile` scans it, runs `enroll` in the `CONTROL_SPACE`, and receives the role the token sets.
- **Short-lived permissions**: A grant lasts at most 60 seconds, so an intercepted grant soon becomes worthless.
- **Key change**: `rotateKey` replaces your own key at runtime, with old and new signature. An admin blocks another peer with the `revokePeer` command.
