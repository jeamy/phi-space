---
standard: help_api
id: help.api.operations_runs_workers
title: "RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Operations Extension (B2–B10)"
short: "Controls runs via RunGate ACK barriers, assigns signed worker lists to hosts, manages space lifecycles, and powers MobileSpaces & AdminSpaces."
tags: [runcontroller, workersupervisor, spacelifecycle, deploymentcontroller, collectalerts, auditlog]
owner: ops
related: [help.topic.operations_mobile_and_replication, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Operations Extension (B2–B10)

## Overview {#overview}

These controllers power both the mobile control pages (`pi-termux-mobile`) and the login-protected **`AdminSpaces`** web portal at `https://spaces.eibrain.org`.

## Technical Reference {#technical-reference}

```ts
await runController.start(spec);
await runController.pause(runId, "cmd-pause-1");
await runController.resume(runId, "cmd-resume-1");
const alerts = collectAlerts({ runs, workers, capabilities, now: Date.now() });
```

## Controllers At A Glance {#parameters}

| Controller | Task |
| --- | --- |
| `SpaceLifecycle` | `createSpace`, `archiveSpace`, `reactivateSpace`, `deleteSpace` – idempotent per space. |
| `WorkerSupervisor` | Assigns signed worker lists to hosts; `setWorkers` starts/stops worker loops cleanly after the current task. |
| `RunController` / `RunGate` | `start`, `dryRun`, `pause`, `resume`, `stop`, `schedule`, `export`, `reconcile` with a confirmed ACK barrier across all involved hosts. |
| `DeploymentController` | Declarative bootstrap: `planDeployment`, `applyDeployment`, `startWorkers`, `exportDeployment` (schema v1: hosts, spaces, routing, workers, mobile access). |
| `collectAlerts` / `auditLog` | Aggregates alerts (stale heartbeats, blocked hosts) and the auditable command log. |

## Typical Use Cases {#use-cases}

- **Available from stage v1**: All controllers already operate on the local `SpaceHost` – stages v3–v5 only extend the transport path (socket → gate → cluster).
- **Maintenance windows**: `pauseRun` freezes all `RunGate`-bound workers cluster-wide; `resumeRun` lets them continue after confirmation.
- **One-click bootstrap**: `AdminSpaces` panel 7 plans and activates a complete deployment (hosts + spaces + workers) from a single JSON configuration.
