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

Diese Bausteine regeln, wer einen Space im Netz benutzen darf. Ein Gerät wird einmal gekoppelt und beweist danach bei jeder Verbindung seinen Schlüssel. Für Aufrufe braucht es zusätzlich kurzlebige Berechtigungen. `startFederationHost` startet das alles zusammen.

## Technische Referenz {#technical-reference}

`startFederationHost(host, ctx, options)` komponiert Gate, Schicht-A/B-Authentisierung, Enrollment, Grant-Ausstellung/-Prüfung, Supervisor, Schlüsselrotation und Boot-Guard zu einem einzigen persistenten Host-Dienst.

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

Die Beispielvariablen keyDirectory, grantVerifier, directory und die beiden unabhängigen Register sind vorab sicher zu konfigurieren; ein öffentlicher Schlüssel allein ist kein GrantVerifier. listen/directory liegen direkt auf den Host-Optionen, nicht unter gate. Der lokale v4-Runner zeigt den vollständigen Aufbau.

## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| `startGate` | Schicht A: Übersetzt NetBird-Peer-Identität in `peerId` + Rolle und lehnt unbekannte Peers ab. |
| `authenticate` (Schicht B) | Ed25519-/P-256-Challenge-Beweis des Client-Schlüssels unabhängig vom Overlay. |
| `EnrollmentService` / `enrollQr` | Einmal-Tokens und QR-Payloads zum Pairing von Smartphone, Host oder Browser. |
| `GrantAuthority` / `GrantVerifier` | Stellt Grants mit höchstens 60 Sekunden Laufzeit aus (`purpose`: `effect` oder `resolution`) und prüft sie auf Data-Hosts. |
| `RotationService` / `rotateKey` | Atomare Schlüsselrotation im laufenden Betrieb ohne Gate-Neustart. |
| `HostBootState` | CAS-geschützter Boot-Guard gegen doppelte Host-Inkarnationen und Restore-Konflikte. |

## Typische Anwendungsfälle {#use-cases}

- **Handy-Pairing (v6)**: `enrollQr` am Koordinator erzeugt einen QR-Code; `pi-termux-mobile` scannt ihn, führt `enroll` im `CONTROL_SPACE` aus und erhält die Rolle, die das Token festlegt.
- **Kurzlebige Berechtigungen**: Ein Grant gilt höchstens 60 Sekunden. Ein abgefangener Grant ist also schnell wertlos.
- **Schlüsselwechsel**: `rotateKey` ersetzt den eigenen Schlüssel im laufenden Betrieb, mit alter und neuer Signatur. Einen fremden Peer sperrt ein Admin mit dem Command `revokePeer`.
