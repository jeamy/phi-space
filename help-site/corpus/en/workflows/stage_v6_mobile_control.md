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

Stage 6 (`help-site/examples/v6-mobile-control/run.ts` and the **`AdminSpaces`** web portal at `https://spaces.eibrain.org/?view=admin`) connects the space cluster to the operational control layer defined in `docs/betrieb-und-mobile-steuerung.md`. Both the mobile app (`spaces.html` + `steuerung.html` in `pi-termux-mobile`) and the web interface issue the same admin commands to `CONTROL_SPACE`.

## Topology: Space Distribution {#topology}

- **1 host** (in the runner's memory) carries **several named spaces**: the `CONTROL_SPACE` (operations layer: enroll, worker assignments, run gate, audit), `sieve-ops`, plus chat spaces created dynamically via `SpaceLifecycle`.
- Distribution: one host, several isolated spaces — control commands land in the control space while chat data stays in dedicated data spaces. In the live deployment this host is the prod host behind `spaces.eibrain.org`.

## Workflow {#workflow}

### Step 1: Login To AdminSpaces & QR Pairing For Mobile {#step-1-login-and-qr}

1. On `https://spaces.eibrain.org`, the administrator clicks **`ADMIN`** in the topbar and logs in with the configured private web-admin password; enrollment tokens pair peers only.
2. Under **Identity & Device Pairing**, a one-click action generates a fresh enrollment token and `enrollQr` payload ready to paste or scan in `spaces.html` on Android.

### Step 2: Worker Scaling, RunGate Control, And Space Lifecycle {#step-2-control}

Using identical actions in `AdminSpaces` (web) and `steuerung.html` (mobile), all operations persist their `commandId` before transmission for retry safety:

- **Scale Workers (`listWorkers` / `setWorkers`)**: Set the desired count of `chat-worker`, `search-subagent`, or `sieve` workers per host and target space (`0` stops cleanly after the active task).
- **Control Runs & Maintenance Windows (`startRun` / `pauseRun` / `resumeRun` / `stopRun` / `scheduleRun` / `exportRun`)**: Pause and resume runs across all members via the confirmed `RunGate` ACK barrier.
- **Manage Spaces (`createSpace` / `archiveSpace` / `reactivateSpace` / `deleteSpace`)**: Create new session spaces idempotently or switch completed spaces into read-only `archiveSpace` mode.
- **Alerts & Audit (`listAlerts` / `auditLog`)**: Monitor active warnings (`collectAlerts`) and the complete audit log of admin commands.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v6-mobile-control/run.ts
```

## See Also {#see-also}

- [Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication](help.topic.operations_mobile_and_replication#overview)
