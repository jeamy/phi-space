---
standard: help_api
id: help.api.operations_runs_workers
title: "RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Betriebserweiterung (B2–B10)"
short: "Steuert Läufe über RunGate-ACK-Barrieren, weist Hosts signierte Worker-Listen zu, verwaltet Space-Lebenszyklen und speist MobileSpaces & AdminSpaces."
tags: [runcontroller, workersupervisor, spacelifecycle, deploymentcontroller, collectalerts, auditlog]
owner: ops
related: [help.topic.operations_mobile_and_replication, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Betriebserweiterung (B2–B10)

## Überblick {#overview}

Diese Controller bilden das Backend für die mobile Steuerung (`pi-termux-mobile`) sowie für den login-geschützten Web-Admin-Bereich **`AdminSpaces`** auf `https://spaces.eibrain.org`.

## Technische Referenz {#technical-reference}

```ts
await runController.start(spec);
await runController.pause(runId, "cmd-pause-1");
await runController.resume(runId, "cmd-resume-1");
const alerts = collectAlerts({ runs, workers, capabilities, now: Date.now() });
```

## Controller im Überblick {#parameters}

| Controller | Aufgabe |
| --- | --- |
| `SpaceLifecycle` | `createSpace`, `archiveSpace`, `reactivateSpace`, `deleteSpace` – idempotent je Space. |
| `WorkerSupervisor` | Weist Hosts signierte Worker-Listen zu; `setWorkers` startet/stoppt Worker-Schleifen sauber nach dem laufenden Task. |
| `RunController` / `RunGate` | `start`, `dryRun`, `pause`, `resume`, `stop`, `schedule`, `export`, `reconcile` mit bestätigter ACK-Barriere über alle beteiligten Hosts. |
| `DeploymentController` | Deklaratives Bootstrap: `planDeployment`, `applyDeployment`, `startWorkers`, `exportDeployment` (Schema v1: Hosts, Spaces, Routing, Worker, Mobile-Access). |
| `collectAlerts` / `auditLog` | Aggregiert Hinweise (stale Heartbeats, blockierte Hosts) und das nachvollziehbare Befehls-Audit. |

## Typische Anwendungsfälle {#use-cases}

- **Ab Stufe v1 verfügbar**: Alle Controller arbeiten bereits auf dem lokalen `SpaceHost` – die Stufen v3–v5 erweitern nur den Transportweg (Socket → Gate → Cluster).
- **Wartungsfenster**: `pauseRun` friert alle `RunGate`-gebundenen Worker clusterweit ein, `resumeRun` lässt sie bestätigt weiterlaufen.
- **Bootstrap per Klick**: `AdminSpaces`-Panel 7 plant und aktiviert ein komplettes Deployment (Hosts + Spaces + Worker) aus einer JSON-Konfiguration.
