---
standard: help_topic
id: help.topic.architecture_layers
title: "Schichtenarchitektur und Modul-Landkarte"
short: "Vollständige Zuordnung aller Quellmodule in src/ zu den 6 Architekturschichten von der reinen Zustandsmaschine bis zu Federation, RunGate und Replikation."
tags: [architecture, layers, modules, core, service, gate, router, replication]
owner: core
related: [help.topic.overview, help.topic.guarantees_and_boundaries, help.topic.space_service_and_remote_space]
since: 0.0.1
---

# Schichtenarchitektur und Modul-Landkarte

## Überblick {#overview}

Die Codebasis von `pi-spaces` ist strikt schichtenweise aufgebaut. Der Kern (`src/core.ts`) ist eine völlig reine, deterministische Zustandsmaschine ohne Netzwerk-, Krypto- oder Dateisystem-Abhängigkeiten. Alle höheren Schichten (Persistenz, RPC, Kryptografie, Overlay-Gate, Router-Federation und Betriebssteuerung) bauen darauf auf, ohne die Kerninvarianten zu umgehen.

## Begriffs- und Systemmodell {#concept-model}

### Die 6 Schichten im Überblick {#six-layers}

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Schicht 6: Betrieb, Mobile/Web-Admin & Phase-3-Replikation                 │
│  run-controller.ts · workers.ts · space-lifecycle.ts · deployment.ts       │
│  alerts.ts · dashboard.ts · entry-replication.ts · primary-sync.ts         │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 5: Federation, Router & Membership (Phase 2)                       │
│  router.ts · delegation.ts · federation-policy.ts · federated-space.ts     │
│  membership.ts · capability-directory.ts · data-admin.ts · root-erasure.ts │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 4: Overlay-Gate, Schicht-A/B-Auth, Grants & Recovery (Phase 1b)    │
│  gate.ts · auth.ts · enroll.ts · grants.ts · rotation.ts · supervisor.ts   │
│  runtime.ts · boot.ts · restore.ts · recovery-register.ts                  │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 3: Lokaler Client, LLM-Agent-Tools & Netzwerkdienst                │
│  client.ts (PiSpaces) · index.ts (Tools & Reaper) · service.ts             │
│  remote.ts (RemoteSpace) · socket.ts · pi-server.ts · meter.ts             │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 2: Dauerhafte Claims, Streams, Snapshots & Mailboxes (Phase 1)     │
│  claims.ts · stream.ts · snapshot.ts · paging.ts · mailbox.ts              │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 1: Reiner Kern & Dokumentmodell v5                                 │
│  core.ts · doc.ts · spaces.ts · canonical.ts (RFC 8785)                    │
└────────────────────────────────────────────────────────────────────────────┘
```

### Abhängigkeitsrichtung {#dependency-direction}

- `src/core.ts` akzeptiert den aktuellen Dokumentzustand `SpaceState` und einen expliziten Zeitstempel `now: number`. Dadurch lassen sich Lease-Ablauf, Transaktions-Rollbacks und Uhrsprünge deterministisch ohne echte Wartezeiten testen.
- `src/client.ts` und `src/service.ts` rufen innerhalb eines `host.commit(tx => ...)` die reinen Funktionen aus `core.ts`, `claims.ts`, `stream.ts` und `mailbox.ts` auf.
- `src/gate.ts`, `src/auth.ts` und `src/grants.ts` liegen vor `SpaceService` und liefern den geprüften `Connection`-Kontext.

## Technische Referenz {#technical-reference}

| Schicht | Zentrale Dateien | Öffentliche Haupttypen & Exporte |
|---|---|---|
| **1. Core & Docs** | `src/core.ts`, `src/doc.ts`, `src/spaces.ts` | `core`, `Space`, `NamedSpace`, `Registry`, `createSpace`, `listSpaces`, `DEFAULT_LIMITS` |
| **2. Claims & Streams** | `src/claims.ts`, `src/stream.ts`, `src/mailbox.ts` | `RequestRef`, `ClaimView`, `argHash`, `MailboxPage`, `principalId` |
| **3. Client & RPC** | `src/client.ts`, `src/index.ts`, `src/service.ts`, `src/remote.ts`, `src/socket.ts` | `PiSpaces`, `spaces`, `startService`, `SpaceService`, `RemoteSpace`, `serveSpace`, `socketTransport` |
| **4. Gate & Recovery** | `src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/runtime.ts`, `src/boot.ts`, `src/restore.ts` | `startGate`, `ProvingService`, `EnrollmentService`, `GrantAuthority`, `GrantVerifier`, `startFederationHost`, `installBootGuard`, `RecoveryController` |
| **5. Federation** | `src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts` | `RouterController`, `createFederationController`, `FederatedSpace`, `MembershipController`, `DistributedPrincipalErasure` |
| **6. Operations & Sync** | `src/run-controller.ts`, `src/workers.ts`, `src/space-lifecycle.ts`, `src/deployment.ts`, `src/alerts.ts`, `src/entry-replication.ts` | `RunController`, `WorkerSupervisor`, `SpaceLifecycle`, `DeploymentController`, `collectAlerts`, `EntryReplicationController` |

## Siehe auch {#see-also}

- [pi-spaces Systemüberblick](help.topic.overview#overview)
- [Verbindliche Garantien und Systemgrenzen](help.topic.guarantees_and_boundaries#overview)
