---
standard: help_api
id: help.api.operations_runs_workers
title: "RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Operations Extension (B2–B10)"
short: "Controls runs via RunGate ACK barriers, assigns signed worker lists to hosts, manages space lifecycles and deployments, and powers AdminSpaces and mobile control."
tags: [runcontroller, workersupervisor, spacelifecycle, deploymentcontroller, collectalerts, auditlog]
owner: ops
related: [help.topic.operations_mobile_and_replication, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# RunController, WorkerSupervisor, SpaceLifecycle & Alerts – Operations Extension (B2–B10)

## Overview {#overview}

These building blocks operate running spaces: start and pause runs, scale workers, create and archive spaces, collect alerts. You use them through the AdminSpaces web area, the Android app, or directly in code.

## Technical Reference {#technical-reference}

These controllers power both the mobile control pages (`pi-termux-mobile`) and the login-protected **`AdminSpaces`** web portal at `https://spaces.eibrain.org`. The names `createSpace`, `setWorkers`, `startRun`, `planDeployment`, and so on are admin commands; the controllers' methods are partly named differently.

```ts
await runController.start("cmd-start-1", spec);
await runController.pause("cmd-pause-1", runId);
await runController.resume("cmd-resume-1", runId);
const alerts = await collectAlerts({ host, ctx, controlSpaceId, runs: runController, now: Date.now });
```

## Controllers At A Glance {#parameters}

| Controller | Task |
| --- | --- |
| `SpaceLifecycle` | `apply({ commandId, action: "create", alias })` and `apply({ commandId, action: "archive" \| "reactivate" \| "delete", spaceId })`, idempotent per command. `spaceCommands` provides the admin commands `createSpace`, `archiveSpace`, `reactivateSpace`, `deleteSpace`. Error: `SpaceInUse` with a reason. |
| `WorkerAssignments` / `WorkerSupervisor` | `WorkerAssignments.set` keeps the signed desired state per host (command `setWorkers`). `WorkerSupervisor.reconcile()` runs on the host and starts or stops worker loops; `count: 0` stops after the current task. |
| `RunController` / `RunGate` | `start`, `pause`, `resume`, `stop`, `advance`, `reconcile`, `resolve`, `status`, `pending`, `list`, `preview`, `schedule`, `export` with a confirmed ACK barrier across all involved hosts. `dryRun: true` on an admin command calls `preview`. |
| `DeploymentController` | Declarative bootstrap: `validateDeployment`, then `bindHost`, `plan`, `apply`, `startWorkers`, `export` (schema v1: hosts, spaces, routing, workers, mobile access; secrets in the file are refused). CLI: `npm run bootstrap` with `--check`, `--plan`, `--apply`, `--bind a=id`, `--start-workers`, `--export` (exit 0 ok, 1 invalid, 2 refused or blocked, 3 no result yet). |
| `collectAlerts` / `auditLog` | Collects alerts on runs, workers, and hosts (e.g. stale heartbeats, blocked hosts) and the command audit without result payloads. `startAlertMonitor` reports changes, for example through `webhookPublisher`. |

## Typical Use Cases {#use-cases}

- **Usable locally**: Stage 6 runs the controllers on one host in memory; remote hosts join through socket, gate, and signed instructions.
- **Maintenance windows**: `pauseRun` freezes all `RunGate`-bound tasks of a run on its members; `resumeRun` releases them again after confirmation.
- **One-click bootstrap**: `AdminSpaces` panel 7 plans and activates a complete deployment (hosts + spaces + workers) from a single JSON configuration.
