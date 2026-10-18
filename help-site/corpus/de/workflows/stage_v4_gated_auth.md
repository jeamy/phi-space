---
standard: help_workflow
id: help.workflow.stage_v4_gated_auth
title: "Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B, Enrollment & 60s-Grants"
short: "Sichert den Multiplayer Space-Chat mit startFederationHost, kryptografischer Verbindungs-Challenge (Ed25519), Token-Enrollment, 60-Sekunden-Grants und Boot-Guard ab."
tags: [v4, gate, auth, ed25519, enroll, grants, rotation, bootguard]
owner: security
related: [help.workflow.stage_v3_remote_socket, help.workflow.stage_v5_federated_cluster]
since: 0.0.1
---

# Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B, Enrollment & 60s-Grants

## Überblick {#overview}

Stufe 4 (`help-site/examples/v4-gated-auth/run.ts`) hebt den Space-Chat auf das Sicherheitsniveau von Phase 1b: Kein Client oder Worker darf den Space lesen oder beschreiben, ohne (1) im Overlay-Verzeichnis als Peer bekannt zu sein (**Schicht A**), (2) seinen eingeschriebenen `Ed25519`/`P-256`-Schlüssel per Verbindungs-Challenge zu beweisen (**Schicht B**) und (3) für jede Operation einen frischen, vom Control-Host signierten **60-Sekunden-Grant** vorzulegen.

## Topologie: Space-Verteilung {#topology}

- **2 unabhängige, persistente Harnesses**, jeweils hinter einem eigenen TCP-Gate:
  - **Control Host** mit dem `CONTROL_SPACE` (PeerDirectory, Enroll-Tokens, Grants, Key-Rotation, BootGuard).
  - **Data Host** mit dem Chat-Space (Threads, `Msg`, `Presence`).
- Zugriff auf den Data-Space nur über **Gate Layer A (Overlay-Peer) + Layer B (Ed25519-Challenge)** und pro Operation einen 60-s-Grant aus dem Control-Space.

## Arbeitsablauf {#workflow}

### Schritt 1: Boot-Register und startFederationHost starten {#step-1-host}

Der Host initialisiert ein `SqliteRecoveryRegister` und `installBootGuard`, erzeugt die Host- und Authority-Schlüssel (`generateKey("ed25519")`) und startet `startFederationHost(harness, ctx, ...)` auf einem TCP-Loopback-/Overlay-Port.

### Schritt 2: Admin-Bootstrap & Worker-Enrollment {#step-2-enroll}

1. Der Admin koppelt seinen Schlüssel einmalig über `bootstrapEnroll`.
2. Anschließend sendet der Admin ein `createEnroll`-Command an den Supervisor, um ein Einmal-Token für den Chat-Worker (`peerId: "peer-chat-worker"`) zu erzeugen.
3. Der Chat-Worker ruft `await workerControl.enroll(token)` auf und ist damit kryptografisch im `CONTROL_SPACE` registriert.

### Schritt 3: Space-Chat mit 60s-Grant-Provider & Live-Key-Rotation {#step-3-grants-rotation}

Der `RemoteSpace` des Chat-Workers erhält `grantProvider: () => workerControl.requestGrant("effect")`. Vor jedem `write`, `take` und `commit` im Chat-Space wird automatisch ein signierter 60-s-Grant beigefügt. Zum Abschluss demonstriert das Skript eine **unterbrechungsfreie Schlüsselrotation (`rotateKey`)** des Workers im laufenden Chat-Betrieb.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
```

## Siehe auch {#see-also}

- [Stufe 5 (v5-federated-cluster): Föderierte Spaces mit Router & HRW-Sharding](help.workflow.stage_v5_federated_cluster#overview)
