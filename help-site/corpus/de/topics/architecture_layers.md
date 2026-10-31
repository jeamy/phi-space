---
standard: help_topic
id: help.topic.architecture_layers
title: "Schichtenarchitektur und Modul-Landkarte"
short: "Zuordnung der wichtigsten Quellmodule in src/ zu den 6 Architekturschichten, von der reinen Zustandsmaschine über den eigenen Speicher bis zu Federation, RunGate und Replikation."
tags: [architecture, layers, modules, core, service, gate, router, replication]
owner: core
related: [help.topic.overview, help.topic.guarantees_and_boundaries, help.topic.space_service_and_remote_space]
since: 0.0.1
---

# Schichtenarchitektur und Modul-Landkarte

## Überblick {#overview}

phi-spaces ist in Schichten aufgebaut, wie ein Haus mit Stockwerken. Ganz unten liegen die Spielregeln des Space, und sie kennen weder Netzwerk noch Festplatte. Darüber kommen Speicher, Netzwerk, Sicherheit und Betrieb hinzu. Wer nur einen Space in einem Programm braucht, nutzt die unteren Schichten und ignoriert den Rest.

### Technische Details {#technical-details}

Der Kern (`src/core.ts`) ist eine reine, deterministische Zustandsmaschine ohne Netzwerk-, Krypto- oder Dateisystem-Abhängigkeiten. Alle höheren Schichten (Speicher, RPC, Kryptografie, Overlay-Gate, Router-Federation und Betriebssteuerung) bauen darauf auf, ohne die Kerninvarianten zu umgehen. Die Agenten-Werkzeuge liegen nicht in `src/`, sondern im eigenen Paket `agent/`.

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
│ Schicht 3: Lokaler Client & Netzwerkdienst                                 │
│  client.ts (PhiSpaces) · index.ts (Zustellung, Reaper) · service.ts        │
│  remote.ts (RemoteSpace) · socket.ts · space-client.ts · ws.ts             │
│  standalone.ts · pi-server.ts · meter.ts                                   │
├────────────────────────────────────────────────────────────────────────────┤
│ Schicht 2: Eigener Speicher, Claims, Streams, Snapshots & Mailboxes        │
│  store/ (host · sqlite · sqlite-writer · disk-map · sync-sqlite)           │
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

### Der eigene Speicher {#own-store}

- **Ein Besitzer**: `openSqliteHost(path)` nimmt eine Sperre in `path.owner`. Ein zweiter Prozess erhält `StoreUnavailable`, ebenso jede Datei, die kein phi-spaces-Speicher ist.
- **Ein Schreib-Thread**: Commits laufen geordnet und werden in SQLite-Transaktionen gebündelt. Antworten warten auf das dauerhafte Schreiben (WAL, Standard `synchronous=FULL`, `NORMAL` ist wählbar). Scheitert das Schreiben, sperrt sich der Host.
- **Große Sammlungen getrennt**: Entries und andere große Teile liegen in eigenen Zeilen. Request-Claims bleiben auf der Platte und werden gezielt gelesen (`disk-map.ts`).
- **Speicherbudget**: Über `memoryBudget` (Standard 40 000 Datensätze) verdrängt der Host die am längsten unberührten Dokumente und liest sie bei Bedarf neu. Dokumente, die innerhalb von `hotMs` (Standard 250 ms) benutzt wurden, bleiben.
- **Datei verdichten**: `OwnStoreHost.compact()` gibt freie Seiten der Datei zurück. Der erste Aufruf schreibt sie einmal mit `VACUUM` um, danach werden nur freie Seiten abgeschnitten. Ein Store im Speicher antwortet `null`.
- **Optionen für Dauerlast**: `OwnStoreHost.skipUnchangedRecords` überspringt unveränderte Datensätze großer Sammlungen. Die Option ist standardmäßig aus.
- **Nur im Arbeitsspeicher**: `openOwnMemoryHost()` für Tests und Wegwerf-Spaces.

JSONL ist kein Speicher des Space mehr. pi-durable-Stores werden nicht importiert (Entscheidung D6). Nur das Agenten-Paket nutzt pi-durable und dessen eigene Speicher; siehe [Agent-Werkzeuge](help.topic.agent_tools_and_replay#two-stores).

### Rust-Portierung {#rust-port}

Das laufende System ist TypeScript. Im Ordner `rust/` entstehen `phi-json`, `phi-core` und `phi-store` (`docs/rust-portierung.en.md`). R0 (Verträge festschreiben) ist umgesetzt, die Scheiben von R1 (Kern) und die Scheiben 0–4 von R2 (Speicher) sind erledigt. Speicherbudget und mehrere Spaces sind auf R3 verschoben. Einen Rust-Server gibt es noch nicht: Er ist R3.

## Technische Referenz {#technical-reference}

| Schicht | Zentrale Dateien | Öffentliche Haupttypen & Exporte |
|---|---|---|
| **1. Core & Docs** | `src/core.ts`, `src/doc.ts`, `src/spaces.ts` | `core`, `Space`, `NamedSpace`, `Registry`, `createSpace`, `listSpaces`, `DEFAULT_LIMITS` |
| **2. Speicher, Claims & Streams** | `src/store/`, `src/claims.ts`, `src/stream.ts`, `src/mailbox.ts` | `openSqliteHost`, `openOwnMemoryHost`, `OwnStoreHost`, `RequestRef`, `ClaimView`, `argHash`, `MailboxPage`, `principalId` |
| **3. Client & RPC** | `src/client.ts`, `src/index.ts`, `src/service.ts`, `src/remote.ts`, `src/socket.ts`, `src/space-client.ts`, `src/ws.ts` | `PhiSpaces`, `startService`, `SpaceService`, `RemoteSpace`, `serveSpace`, `socketTransport`, `connectSpace`, `upgradeWebSocket` (`phi-spaces/ws`) |
| **4. Gate & Recovery** | `src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/runtime.ts`, `src/boot.ts`, `src/restore.ts` | `startGate`, `ProvingService`, `EnrollmentService`, `GrantAuthority`, `GrantVerifier`, `startFederationHost`, `installBootGuard`, `RecoveryController` |
| **5. Federation** | `src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts` | `RouterController`, `createFederationController`, `FederatedSpace`, `MembershipController`, `DistributedPrincipalErasure` |
| **6. Operations & Sync** | `src/run-controller.ts`, `src/workers.ts`, `src/space-lifecycle.ts`, `src/deployment.ts`, `src/alerts.ts`, `src/entry-replication.ts` | `RunController`, `WorkerSupervisor`, `SpaceLifecycle`, `DeploymentController`, `collectAlerts`, `EntryReplicationController` |

## Siehe auch {#see-also}

- [phi-spaces Systemüberblick](help.topic.overview#overview)
- [Verbindliche Garantien und Systemgrenzen](help.topic.guarantees_and_boundaries#overview)
