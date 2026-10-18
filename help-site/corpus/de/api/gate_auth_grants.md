---
standard: help_api
id: help.api.gate_auth_grants
title: "Gate, Schicht A/B, Enrollment, 60s-Grants & Rotation"
short: "Kombiniert NetBird-Peer-Auflösung (Schicht A), Ed25519/P-256-Challenge (Schicht B), QR/Token-Enrollment, 60-s-Grants und atomare Schlüsselrotation."
tags: [startgate, startfederationhost, grantauthority, grantverifier, enroll, rotatekey]
owner: security
related: [help.topic.gate_auth_grants_and_recovery, help.workflow.stage_v4_gated_auth]
since: 0.0.1
---

# Gate, Schicht A/B, Enrollment, 60s-Grants & Rotation

## Überblick {#overview}

`startFederationHost(harness, ctx, options)` komponiert Gate, Schicht-A/B-Authentisierung, Enrollment, Grant-Ausstellung/-Prüfung, Supervisor, Schlüsselrotation und Boot-Guard zu einem einzigen persistenten Host-Dienst.

## Technische Referenz {#technical-reference}

```ts
const host = await startFederationHost(harness, ctx, {
  hostId,
  authorityId,
  keys: hostSigner,
  verifier: authorityPublicKey,
  gate: { listen: { host: "127.0.0.1", port: 0 }, directory },
  boot: { external: register, installed: bootState },
  control: { host: harness, authority: authoritySigner }
});
```

## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| `startGate` | Schicht A: Übersetzt NetBird-Peer-Identität in `peerId` + Rolle und lehnt unbekannte Peers ab. |
| `authenticate` (Schicht B) | Ed25519-/P-256-Challenge-Beweis des Client-Schlüssels unabhängig vom Overlay. |
| `EnrollmentService` / `enrollQr` | Einmal-Tokens und QR-Payloads zum Pairing von Smartphone, Host oder Browser. |
| `GrantAuthority` / `GrantVerifier` | Stellt ~60-s-Grants für einzelne Operationen aus und prüft sie auf Data-Hosts. |
| `RotationService` / `rotateKey` | Atomare Schlüsselrotation im laufenden Betrieb ohne Gate-Neustart. |
| `HostBootState` | CAS-geschützter Boot-Guard gegen doppelte Host-Inkarnationen und Restore-Konflikte. |

## Typische Anwendungsfälle {#use-cases}

- **Handy-Pairing (v4/v6)**: `enrollQr` am Koordinator erzeugt einen QR-Code; `pi-termux-mobile` scannt ihn, führt `enroll` im `CONTROL_SPACE` aus und erhält `admin`-Rechte.
- **Kurzlebige Befehle**: `AdminSpaces` und die mobile App rufen jede Steueraktion mit einem frischen 60-s-Grant auf – gestohlene Tokens verfallen sofort.
- **Notfall-Keywechsel**: `rotateKey` rotiert den Admin-Schlüssel bei kompromittiertem Gerät ohne Downtime.
