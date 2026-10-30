---
standard: help_topic
id: help.topic.gate_auth_grants_and_recovery
title: "Overlay-Gate, Schicht-A/B-Auth, 60s-Grants und Recovery"
short: "Zwei-Schichten-Authentisierung (NetBird-Peer + Ed25519/P-256 Challenge), Token/QR-Enrollment, kurzlebige 60-Sekunden-Grants, Schlüsselrotation, Boot-Guard und Restore."
tags: [gate, netbird, challenge, ed25519, enroll, grants, rotation, boot, restore]
owner: security
related: [help.workflow.stage_v4_gated_auth, help.api.gate_auth_grants]
since: 0.0.1
---

# Overlay-Gate, Schicht-A/B-Auth, 60s-Grants und Recovery

## Überblick {#overview}

Sobald ein Space von außen erreichbar ist, muss klar sein, wer anklopft. Eine Netzwerkadresse allein reicht dafür nicht. Darum weist sich jedes Gerät zweimal aus: über das private Netz und mit einem eigenen Schlüssel. Neue Geräte werden mit einem Einmal-Code gekoppelt, und Erlaubnisse gelten nur kurze Zeit.

### Technische Details {#technical-details}

In einer Mehr-Host-Umgebung reicht eine IP-Adresse nicht als Identitätsnachweis, da mehrere Prozesse auf demselben Host dieselbe Netzwerk-IP teilen können. Phase 1b (`src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/runtime.ts`) kombiniert daher zwei Sicherheitsschichten mit kurzlebigen, signierten **60-Sekunden-Grants** und einem externen **CAS-Boot-Register**.

## Begriffs- und Systemmodell {#concept-model}

### Schicht A (Overlay-Peer) + Schicht B (App-Key-Challenge) {#layer-a-and-b}

1. **Schicht A (`startGate` / `NetbirdDirectory`)**: Bestimmt sofort bei TCP-Annahme (`identifyOnConnect: true`, Timeout 5 s) aus der WireGuard-/Overlay-Quelladresse die `peerId` und die Gruppen (`space-hosts`, `space-admin`, `space-observer`) und begrenzt Verbindungen auf max. 32 je Peer / 64 je Listener.
2. **Schicht B (`ProvingService`)**: Sendet eine verbindungsgebundene 30-s-Challenge `{ gateHostId, observedPeerId, connNonce }`. Der Client signiert diese mit seinem privaten `Ed25519`- oder `P-256`-Schlüssel (im Android Keystore auf dem Smartphone bzw. `0600`-Schlüsseldatei auf dem Host).

### Enrollment, 60s-Grants und Schlüsselrotation {#enrollment-and-grants}

- **Enrollment (`createEnroll` / `enrollQr`)**: Ein Admin erzeugt über den Supervisor ein Einmal-Token (nur der SHA-256-Hash liegt im `CONTROL_SPACE`). Das neue Gerät koppelt seinen Public Key per `remote.enroll(token)`.
- **Kurzlebige Grants (`GrantAuthority` / `GrantVerifier`)**: Vor jedem fachlichen Aufruf auf einem Data-Space holt `RemoteSpace` über `grantProvider` einen vom Control-Host signierten Grant (`purpose: "effect" | "resolution"`, max. 60 s gültig). Der Data-Member prüft Signatur, `authorityId`, `peerId`, `keyId`, Scope und Ablaufzeit noch einmal direkt vor dem Commit.
- **Eigene Schlüsselrotation (`rotateKey`)**: Erfordert die Signatur des alten **und** des neuen Schlüssels über eine persistierte Challenge und tauscht den Schlüssel im `CONTROL_SPACE` atomar ohne Rechteverlust aus.

### Boot-Guard und Restore-Quarantäne {#boot-and-restore}

- **Boot-Guard (`SqliteRecoveryRegister` + `installBootGuard`)**: Ein Host darf nur starten und Commits ausführen, solange seine lokale Installation und das externe CAS-Register für jeden Space dieselbe `authorityId`, `dataIncarnation` und Rolle ausweisen.
- **Data-Restore (`RecoveryController`)**: Importiert Snapshots in 192-KiB-konformen Batches, erhöht die Dateninkarnation und markiert restaurierte exklusive Aufgaben als `restoredUnverified`, bis ein Admin sie per `releaseRestored` explizit freigibt.

## Siehe auch {#see-also}

- [Stufe 4 (v4-gated-auth): Gate, Enrollment & 60s-Grants im Multiplayer-Chat](help.workflow.stage_v4_gated_auth#overview)
- [Gate, Schicht A/B, Enrollment & Grants API](help.api.gate_auth_grants)
