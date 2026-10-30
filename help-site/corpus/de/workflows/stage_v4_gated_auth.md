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

Stufe 4 sichert den Zugang: Wer den Chat lesen oder beschreiben will, muss sich erst ausweisen. Ein Gerät wird einmal gekoppelt und beweist danach bei jeder Verbindung seinen Schlüssel. Zusätzlich braucht es für seine Aufrufe kurzlebige Berechtigungen, die nach einer Minute verfallen.

## Topologie: Space-Verteilung {#topology}

Mit `help-site/examples/v4-gated-auth/run.ts` darf kein Client den Space lesen oder beschreiben, ohne (1) im Overlay-Verzeichnis als Peer bekannt zu sein (**Schicht A**, in der Demo ein simuliertes Verzeichnis), (2) seinen eingeschriebenen Schlüssel per Verbindungs-Challenge zu beweisen (**Schicht B**) und (3) einen frischen, vom Control-Host signierten **60-Sekunden-Grant** vorzulegen.

- **2 unabhängige, persistente Hosts** in einem Prozess (je ein eigener SQLite-Speicher), jeweils hinter einem eigenen TCP-Gate:
  - **Control Host** mit dem `CONTROL_SPACE` (PeerDirectory, Enroll-Tokens, Grants, Key-Rotation, BootGuard).
  - **Data Host** mit dem Chat-Space (Threads, `Msg`, `Presence`).
- Zugriff auf den Data-Space nur über **Gate Layer A (Overlay-Peer) + Layer B (Ed25519-Challenge)** und mit einem 60-s-Grant aus dem Control-Space. `RemoteSpace` holt ihn über `grantProvider` vor jedem Aufruf und jedem Retry; ausgenommen sind nur `challenge`, `prove`, `enroll`, `enrollStatus` und `grant`.

## Arbeitsablauf {#workflow}

### Schritt 1: Boot-Register und startFederationHost starten {#step-1-host}

Das Programm öffnet zwei `SqliteRecoveryRegister` (extern und installiert) und trägt für jeden Space eine Boot-Erlaubnis ein. Es erzeugt einen Signaturschlüssel des Control-Hosts (`generateKey("ed25519", "control-signer")`) und startet beide Hosts mit `startFederationHost(host, ctx, ...)` auf einem TCP-Loopback-Port; der Boot-Guard wird dabei aus `boot: { external, installed }` installiert.

### Schritt 2: Admin-Bootstrap & Worker-Enrollment {#step-2-enroll}

1. `bootstrapEnroll` legt im Control-Speicher ein Einmal-Token für den Peer `chat-worker` an. Dieser Peer spielt in der Demo Admin und Worker zugleich.
2. In der Overlay-Gruppe `space-enroll` hat der Peer nur die Rolle `unpaired`. Er ruft `controlClient.enroll(token)` auf und ist damit im `CONTROL_SPACE` eingeschrieben.
3. Das Programm verschiebt ihn in die Gruppe `space-admin`, ruft `controlHost.revalidate()` auf und verbindet ihn neu; `controlClient.authenticate()` beweist den Schlüssel. `createEnroll` für weitere Geräte nutzt diese Stufe nicht; dazu siehe [Stufe 6](help.workflow.stage_v6_mobile_control#overview).

### Schritt 3: Space-Chat mit 60s-Grant-Provider & Live-Key-Rotation {#step-3-grants-rotation}

Der `RemoteSpace` des Chat-Workers erhält `grantProvider: () => controlClient.requestGrant("effect")`, dazu `signer`, `expectedGateHostId` und `ownPeerId`. Zum Abschluss rotiert das Skript den Schlüssel: `rotationChallenge`, dann `rotateKey(challenge, replacementSigner)` mit alter und neuer Signatur. Nach dem Ergebnis im Control-Space verbindet es sich mit dem neuen Schlüssel neu und schreibt eine weitere Nachricht, ohne dass ein Gate neu startet.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v4-gated-auth/run.ts
```

## Siehe auch {#see-also}

- [Stufe 5 (v5-federated-cluster): Föderierte Spaces mit Router & HRW-Sharding](help.workflow.stage_v5_federated_cluster#overview)
