---
standard: help_workflow
id: help.workflow.stage_v6_mobile_control
title: "Stufe 6 (v6-mobile-control): Steuerung über Mobile App & Web-Admin (spaces.eibrain.org)"
short: "Komplette Administration und Überwachung des Space-Clusters über die Android-App (pi-termux-mobile) und den login-geschützten Web-Bereich AdminSpaces."
tags: [v6, mobile, adminspaces, steuerung, rungate, workers, alerts, audit, eibrain]
owner: ops
related: [help.workflow.stage_v5_federated_cluster, help.topic.operations_mobile_and_replication]
since: 0.0.1
---

# Stufe 6 (v6-mobile-control): Steuerung über Mobile App & Web-Admin (spaces.eibrain.org)

## Überblick {#overview}

Stufe 6 (`help-site/examples/v6-mobile-control/run.ts` sowie der Web-Bereich **`AdminSpaces`** unter `https://spaces.eibrain.org/?view=admin`) verbindet den Space-Cluster mit der administrativen Steuerung aus `docs/betrieb-und-mobile-steuerung.md`. Sowohl die mobile App (`spaces.html` + `steuerung.html` in `pi-termux-mobile`) als auch die Webseite nutzen dieselben Admin-Commands im `CONTROL_SPACE`.

## Topologie: Space-Verteilung {#topology}

- **1 Harness** (`MemoryStorage` im Runner) trägt **mehrere benannte Spaces**: den `CONTROL_SPACE` (Operations-Ebene: Enroll, Worker-Assignments, RunGate, Audit), `sieve-ops`, plus dynamisch per `SpaceLifecycle` erzeugte Chat-Spaces.
- Verteilung: ein Host, mehrere isolierte Spaces — Steuerbefehle landen im Control-Space, Chat-Daten bleiben in eigenen Daten-Spaces. In der Live-Bereitstellung entspricht der Harness dem Prod-Host hinter `spaces.eibrain.org`.

## Arbeitsablauf {#workflow}

### Schritt 1: Login in AdminSpaces & QR-Pairing für das Smartphone {#step-1-login-and-qr}

1. Auf `https://spaces.eibrain.org` klickt der Administrator oben rechts auf **`ADMIN`** und meldet sich per Admin-Passwort oder Enrollment-Token an.
2. Im Bereich **Identität & Geräte-Pairing** kann mit einem Klick ein neues Enrollment-Token samt `enrollQr`-Payload generiert werden, das direkt in `spaces.html` der Android-App eingefügt oder gescannt wird.

### Schritt 2: Worker-Skalierung, RunGate-Steuerung und Space-Lebenszyklus {#step-2-control}

Über die identischen Aktionen in `AdminSpaces` (Web) und `steuerung.html` (Mobile) werden folgende Vorgänge mit vorab gespeicherter, wiederholsicherer `commandId` ausgeführt:

- **Worker steuern (`listWorkers` / `setWorkers`)**: Anzahl der `chat-worker`-, `search-subagent`- oder `sieve`-Worker pro Host und Ziel-Space setzen (`0` stoppt sauber nach dem laufenden Task).
- **Läufe & Wartungsfenster (`startRun` / `pauseRun` / `resumeRun` / `stopRun` / `scheduleRun` / `exportRun`)**: Pausiert und setzt Verarbeitungsläufe über die `RunGate`-ACK-Barriere auf allen Members fort.
- **Spaces verwalten (`createSpace` / `archiveSpace` / `reactivateSpace` / `deleteSpace`)**: Legt neue Session-Spaces an oder schaltet abgeschlossene Spaces per `archiveSpace` in den schreibgeschützten Archivmodus.
- **Hinweise & Audit (`listAlerts` / `auditLog`)**: Zeigt Warnungen (`collectAlerts`) und die lückenlose Historie aller Admin-Aufträge.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts
```

## Siehe auch {#see-also}

- [Betriebserweiterung (RunGate, Worker, Mobile/Web-Admin) & Phase-3-Replikation](help.topic.operations_mobile_and_replication#overview)
