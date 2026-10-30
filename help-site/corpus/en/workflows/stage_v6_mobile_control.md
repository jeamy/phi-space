---
standard: help_workflow
id: help.workflow.stage_v6_mobile_control
title: "Stage 6 (v6-mobile-control): Control via Mobile App & Web Admin (spaces.eibrain.org)"
short: "Complete administration and monitoring of the space cluster via the Android app (pi-termux-mobile) and the login-protected AdminSpaces web area."
tags: [v6, mobile, adminspaces, steuerung, rungate, workers, alerts, audit, eibrain]
owner: ops
related: [help.workflow.stage_v5_federated_cluster, help.topic.operations_mobile_and_replication]
since: 0.0.1
---

# Stage 6 (v6-mobile-control): Control via Mobile App & Web Admin (spaces.eibrain.org)

## Overview {#overview}

Stage 6 shows how to operate running spaces: pair devices, start and stop workers, pause runs, create and archive spaces. The program performs these steps locally. The same actions exist in the AdminSpaces web area and on the control pages of the Android app.

## Topology: Space Distribution {#topology}

`help-site/examples/v6-mobile-control/run.ts` and the **`AdminSpaces`** web portal at `https://spaces.eibrain.org/?view=admin` implement the operational control defined in `docs/betrieb-und-mobile-steuerung.md`. The mobile app (`spaces.html` + `steuerung.html` in `pi-termux-mobile`) and the website know the same admin commands.

- **1 host** (`openOwnMemoryHost()` in the runner) carries **several named spaces**: the `CONTROL_SPACE` (enroll, audit), `sieve-ops`, and one chat space created via `SpaceLifecycle`.
- Distribution: one host, several isolated spaces. Control commands land in the control space while chat data stays in its own data space.

## Workflow {#workflow}

### Step 1: Login To AdminSpaces & QR Pairing For Mobile {#step-1-login-and-qr}

1. On `https://spaces.eibrain.org`, the administrator clicks **`ADMIN`** in the topbar and logs in with the configured private web-admin password. Enrollment tokens pair peers only; they open no web session.
2. In the first section, **Device Pairing**, `createEnroll` generates a fresh enrollment token and `enrollQr` payload to paste or scan in `spaces.html` on Android. The program shows the same step locally: `enrollQr({ token, endpoint, controlSpaceId })` and an `Enroll` entry in the control space.

### Step 2: Worker Scaling, RunGate Control, And Space Lifecycle {#step-2-control}

The actions in `AdminSpaces` (web) and `steuerung.html` (mobile) cover the operations below, each with a `commandId` that makes a repeat recognizable. The program calls the same controllers directly and shows worker scaling, start/pause/resume, archive/reactivate, alerts, and audit.

- **Scale Workers (`listWorkers` / `setWorkers`)**: Set the desired count per worker kind (in the program `chat-worker`, `sieve`), host, and target space (`0` stops after the active task).
- **Control Runs & Maintenance Windows (`startRun` / `pauseRun` / `resumeRun` / `stopRun` / `scheduleRun` / `exportRun` / `listRuns`)**: Pause and resume runs across all members via the confirmed `RunGate` ACK barrier.
- **Manage Spaces (`createSpace` / `archiveSpace` / `reactivateSpace` / `deleteSpace`)**: Create new session spaces idempotently or switch completed spaces into read-only `archiveSpace` mode.
- **Alerts & Audit (`listAlerts` / `auditLog`)**: Monitor active warnings (`collectAlerts`) and the history of admin commands.
- **Deployment (`planDeployment` / `applyDeployment` / `startWorkers` / `exportDeployment`)**: Plan and activate hosts, spaces, and workers from a JSON configuration. On the command line this is `npm run bootstrap -- --check|--plan|--apply|--bind a=id|--start-workers|--export`.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts
```

## See Also {#see-also}

- [Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication](help.topic.operations_mobile_and_replication#overview)
