---
standard: help_topic
id: help.topic.operations_mobile_and_replication
title: "Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication"
short: "How runs are controlled via RunGate barriers, workers via signed assignments, and spaces via the mobile app (pi-termux-mobile) and web admin area (AdminSpaces)."
tags: [rungate, runcontroller, workersupervisor, mobile, adminspaces, alerts, audit, replication, lww, hlc]
owner: ops
related: [help.workflow.stage_v6_mobile_control, help.api.operations_runs_workers]
since: 0.0.1
---

# Operations Extension (RunGate, Workers, Mobile/Web Admin) & Phase 3 Replication

## Overview {#overview}

The operations extension (steps B1–B10 in `docs/betrieb-und-mobile-steuerung.md`) adds operational control on top of the federation core for **runs (`RunGate` / `RunController`)**, **host workers (`WorkerSupervisor`)**, **space lifecycles (`SpaceLifecycle`)**, **deployment bootstrap (`DeploymentController`)**, and **alerting/audit (`collectAlerts` / `auditLog`)**. All capabilities are accessible both from the Android app (`pi-termux-mobile`) and from the login-protected **`AdminSpaces`** web area on `https://spaces.eibrain.org`.

## Concept And System Model {#concept-model}

### RunGate And Confirmed Pause/Resume Barrier {#rungate-barrier}

A `RunGate { runId, controlRevision, state: "preparing" | "running" | "paused" | "stopped" }` is a protected control record inside the space document:

- The space core checks on **every** `take` (including waiting takes and host code) whether the run's `RunGate` is `running`.
- On `pauseRun`, each participating member first installs a **fence** (blocking new run transactions and lease renewals on existing ones), allows in-flight reserved tasks to finish within their remaining lease, and only then returns its signed ACK to `RunController`. The run becomes globally `paused` only after all member ACKs arrive.

### Signed Worker Control (WorkerSupervisor) {#worker-supervisor}

Rather than storing mutable worker entries in the control space, the coordinator persists desired worker counts in the protected `WorkerAssignments` journal (`setWorkers`). Each host fetches only its own control-signed assignment via the `workerAssignments` gate method. The local `WorkerSupervisor` starts registered worker loops (e.g. `chat-worker`, `search-subagent`, `sieve`) or stops them cleanly after the active task when `count: 0`.

### Control Via Mobile App (pi-termux-mobile) & Web Admin (AdminSpaces) {#mobile-and-web-admin}

Both `MobileSpaces` (`pi-termux-mobile/runtime/spaces-mobile.mjs`) and our web admin controller (`help-site/server/admin/`) enforce the exact same safety contract:

1. **Pre-persisted `commandId`**: Before sending any admin command, `commandId = m-<kind>-<hex>` or `w-<kind>-<hex>` is saved locally. On timeout or double-click, the exact same `commandId` is reused ("checking outcome" rather than duplicate execution).
2. **Key Proof & 60s Grants**: Every connection proves its `Ed25519`/`P-256` key at the gate and uses short-lived grants.
3. **Phase 3 Replication Building Blocks**: For delay-tolerant metadata and presence, `EntryReplicationController` provides persistent HLC ordering, Last-Writer-Wins with versioned tombstones, and Add-Wins sets.

## See Also {#see-also}

- [Stage 6 (v6-mobile-control): Mobile App & Web Admin Control](help.workflow.stage_v6_mobile_control#overview)
- [RunController, WorkerSupervisor, SpaceLifecycle & Alerts API](help.api.operations_runs_workers)
