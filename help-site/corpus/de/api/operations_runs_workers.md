---
standard: help_api
id: help.api.operations_runs_workers
title: "RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Betriebserweiterung (B2–B10)"
short: "Steuert Läufe über RunGate-ACK-Barrieren, weist Hosts signierte Worker-Listen zu, verwaltet Space-Lebenszyklen und Deployments und speist AdminSpaces und die mobile Steuerung."
tags: [runcontroller, workersupervisor, spacelifecycle, deploymentcontroller, collectalerts, auditlog]
owner: ops
related: [help.topic.operations_mobile_and_replication, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Betriebserweiterung (B2–B10)

## Überblick {#overview}

Diese Bausteine bedienen laufende Spaces: Läufe starten und pausieren, Worker skalieren, Spaces anlegen und archivieren, Hinweise sammeln. Du nutzt sie über den Web-Bereich AdminSpaces, die Android-App oder direkt im Code.

## Technische Referenz {#technical-reference}

Diese Controller bilden das Backend für die mobile Steuerung (`pi-termux-mobile`) sowie für den login-geschützten Web-Admin-Bereich **`AdminSpaces`** auf `https://spaces.eibrain.org`. Die Namen `createSpace`, `setWorkers`, `startRun`, `planDeployment` usw. sind Admin-Commands; die Methoden der Controller heißen teils anders.

```ts
await runController.start("cmd-start-1", spec);
await runController.pause("cmd-pause-1", runId);
await runController.resume("cmd-resume-1", runId);
const alerts = await collectAlerts({ host, ctx, controlSpaceId, runs: runController, now: Date.now });
```

## Controller im Überblick {#parameters}

| Controller | Aufgabe |
| --- | --- |
| `SpaceLifecycle` | `apply({ commandId, action: "create", alias })` und `apply({ commandId, action: "archive" \| "reactivate" \| "delete", spaceId })`, idempotent je Command. `spaceCommands` liefert die Admin-Commands `createSpace`, `archiveSpace`, `reactivateSpace`, `deleteSpace`. Fehler: `SpaceInUse` mit Grund. |
| `WorkerAssignments` / `WorkerSupervisor` | `WorkerAssignments.set` hält den signierten Soll-Zustand je Host (Command `setWorkers`). `WorkerSupervisor.reconcile()` läuft auf dem Host und startet oder stoppt Worker-Schleifen; `count: 0` stoppt nach dem laufenden Task. |
| `RunController` / `RunGate` | `start`, `pause`, `resume`, `stop`, `advance`, `reconcile`, `resolve`, `status`, `pending`, `list`, `preview`, `schedule`, `export` mit bestätigter ACK-Barriere über alle beteiligten Hosts. `dryRun: true` an einem Admin-Command ruft `preview` auf. |
| `DeploymentController` | Deklaratives Bootstrap: `validateDeployment`, dann `bindHost`, `plan`, `apply`, `startWorkers`, `export` (Schema v1: Hosts, Spaces, Routing, Worker, Mobile-Zugang; Geheimnisse in der Datei werden abgelehnt). CLI: `npm run bootstrap` mit `--check`, `--plan`, `--apply`, `--bind a=id`, `--start-workers`, `--export` (Exit 0 ok, 1 ungültig, 2 abgelehnt oder blockiert, 3 noch kein Ergebnis). |
| `collectAlerts` / `auditLog` | Sammelt Hinweise zu Läufen, Workern und Hosts (z.B. veraltete Heartbeats, blockierte Hosts) und das Befehls-Audit ohne Result-Payloads. `startAlertMonitor` meldet Änderungen, etwa über `webhookPublisher`. |

## Typische Anwendungsfälle {#use-cases}

- **Lokal nutzbar**: Stufe 6 betreibt die Controller auf einem Host im Arbeitsspeicher; entfernte Hosts kommen über Socket, Gate und signierte Anweisungen dazu.
- **Wartungsfenster**: `pauseRun` friert alle `RunGate`-gebundenen Tasks eines Laufs auf seinen Members ein, `resumeRun` gibt sie bestätigt wieder frei.
- **Bootstrap per Klick**: `AdminSpaces`-Panel 7 plant und aktiviert ein komplettes Deployment (Hosts + Spaces + Worker) aus einer JSON-Konfiguration.
