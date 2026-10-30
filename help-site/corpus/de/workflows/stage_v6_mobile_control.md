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

Stufe 6 zeigt, wie man laufende Spaces bedient: Geräte koppeln, Worker starten und stoppen, Läufe pausieren, Spaces anlegen und archivieren. Das Programm führt diese Schritte lokal aus. Dieselben Aktionen gibt es im Web-Bereich AdminSpaces und auf den Steuerseiten der Android-App.

## Topologie: Space-Verteilung {#topology}

`help-site/examples/v6-mobile-control/run.ts` sowie der Web-Bereich **`AdminSpaces`** unter `https://spaces.eibrain.org/?view=admin` setzen die administrative Steuerung aus `docs/betrieb-und-mobile-steuerung.md` um. Die mobile App (`spaces.html` + `steuerung.html` in `pi-termux-mobile`) und die Webseite kennen dieselben Admin-Commands.

- **1 Host** (`openOwnMemoryHost()` im Runner) trägt **mehrere benannte Spaces**: den `CONTROL_SPACE` (Enroll, Audit), `sieve-ops` und einen per `SpaceLifecycle` erzeugten Chat-Space.
- Verteilung: ein Host, mehrere isolierte Spaces. Steuerbefehle landen im Control-Space, Chat-Daten bleiben im eigenen Daten-Space.

## Arbeitsablauf {#workflow}

### Schritt 1: Login in AdminSpaces & QR-Pairing für das Smartphone {#step-1-login-and-qr}

1. Auf `https://spaces.eibrain.org` klickt der Administrator oben rechts auf **`ADMIN`** und meldet sich mit dem konfigurierten privaten Web-Admin-Passwort an. Enrollment-Tokens koppeln ausschließlich Peers, sie öffnen keine Web-Sitzung.
2. Im ersten Bereich **Geräte-Pairing** erzeugt `createEnroll` ein neues Enrollment-Token samt `enrollQr`-Payload, das in `spaces.html` der Android-App eingefügt oder gescannt wird. Das Programm zeigt denselben Schritt lokal: `enrollQr({ token, endpoint, controlSpaceId })` und ein `Enroll`-Entry im Control-Space.

### Schritt 2: Worker-Skalierung, RunGate-Steuerung und Space-Lebenszyklus {#step-2-control}

Über die Aktionen in `AdminSpaces` (Web) und `steuerung.html` (Mobile) laufen folgende Vorgänge, jeweils mit einer `commandId`, die eine Wiederholung erkennbar macht. Das Programm ruft dieselben Controller direkt auf und zeigt davon Worker-Skalierung, Start/Pause/Resume, Archivieren/Reaktivieren, Alerts und Audit.

- **Worker steuern (`listWorkers` / `setWorkers`)**: Anzahl der Worker je Art (im Programm `chat-worker`, `sieve`), Host und Ziel-Space setzen (`0` stoppt nach dem laufenden Task).
- **Läufe & Wartungsfenster (`startRun` / `pauseRun` / `resumeRun` / `stopRun` / `scheduleRun` / `exportRun` / `listRuns`)**: Pausiert und setzt Verarbeitungsläufe über die `RunGate`-ACK-Barriere auf allen Members fort.
- **Spaces verwalten (`createSpace` / `archiveSpace` / `reactivateSpace` / `deleteSpace`)**: Legt neue Session-Spaces an oder schaltet abgeschlossene Spaces per `archiveSpace` in den schreibgeschützten Archivmodus.
- **Hinweise & Audit (`listAlerts` / `auditLog`)**: Zeigt Warnungen (`collectAlerts`) und die Historie der Admin-Aufträge.
- **Deployment (`planDeployment` / `applyDeployment` / `startWorkers` / `exportDeployment`)**: Plant und aktiviert Hosts, Spaces und Worker aus einer JSON-Konfiguration. Auf der Kommandozeile heißt das `npm run bootstrap -- --check|--plan|--apply|--bind a=id|--start-workers|--export`.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts
```

## Siehe auch {#see-also}

- [Betriebserweiterung (RunGate, Worker, Mobile/Web-Admin) & Phase-3-Replikation](help.topic.operations_mobile_and_replication#overview)
