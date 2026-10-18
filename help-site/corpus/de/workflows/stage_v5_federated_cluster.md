---
standard: help_workflow
id: help.workflow.stage_v5_federated_cluster
title: "Stufe 5 (v5-federated-cluster): Föderierte Spaces, HRW-Sharding & Router"
short: "Verbindet 3 Member-Spaces unter createFederationController: HRW-Platzierung je threadId, föderierte Subagent-Suche, Waiter-Wettlauf (takeWaiting) und Phase-3-LWW-Presence."
tags: [v5, federation, cluster, router, hrw, federatedspace, takewaiting, lww]
owner: federation
related: [help.workflow.stage_v4_gated_auth, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Stufe 5 (v5-federated-cluster): Föderierte Spaces, HRW-Sharding & Router

## Überblick {#overview}

Stufe 5 (`help-site/examples/v5-federated-cluster/run.ts`) skaliert den Multiplayer Space-Chat horizontal über **drei Member-Spaces (`member-1`, `member-2`, `member-3`)**, die durch `createFederationController` (`RouterController` + `FederatedSpace` + `FederationPolicy`) koordiniert werden.

## Topologie: Space-Verteilung {#topology}

Der Cluster läuft **simuliert in einem einzigen Prozess**: **4 Harnesses** (alle `MemoryStorage`), die echte Member-Hosts mit echten Federation-Komponenten spielen — kein Netzwerk, aber exakt dieselbe Routing- und Journal-Logik wie in echter Verteilung.

- **1 Koordinator-Host**: `RouterController` (`router-root` + 2 Partition-Router für die Routing-Journals) und `FederatedSpace` (id `fed-v5`). Der Koordinator besitzt selbst keinen Chat-Daten-Space — er führt nur die Policy aus.
- **3 Member-Hosts** (`member-1`, `member-2`, `member-3`): jeder hat einen eigenen, unabhängigen Space mit eigenem Space-Doc.
- **HRW-Sharding**: die Federation-Policy routet `Thread`, `Msg` und `ChatTask` per Rendezvous-Hashing über `fields.threadId` deterministisch auf genau einen Member. Das Runner-Report-Feld `memberDistribution` zeigt die tatsächliche Verteilung, z.B. `{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }`.
- **`FederationIO`** ist in der Demo ein in-process Adapter auf die lokalen `PiSpaces`-Objekte; in einer echten Bereitstellung wären das `RemoteSpace`-/RPC-Aufrufe auf entfernte Hosts — die Semantik (`step`, `snapshot`, `events`, `ack`, `txnActive`) bleibt identisch.
- **Replikation**: 2 `EntryReplicationController` (`rep-1` auf member-1, `rep-2` auf member-2) replizieren `Presence` via HLC + Last-Writer-Wins in den gemeinsamen Space `presence-global`.

## Arbeitsablauf {#workflow}

### Schritt 1: FederationPolicy mit HRW nach threadId {#step-1-policy}

Alle thread-gebundenen Typen (`Thread`, `Msg`, `ChatTask`) erhalten die Routing-Regel `mode: "expand"`, `by: { field: "threadId" }` über `["member-1", "member-2", "member-3"]`:

- Dadurch landen alle Nachrichten und Aufgaben desselben Threads deterministisch auf demselben Member-Space.
- Verschiedene Threads einer großen Session verteilen sich gleichmäßig auf die 3 Member-Spaces.
- Eine Transaktion wird per `federatedSpace.createTransaction(member, leaseMs, request)` auf dem zuständigen Member geöffnet und mit `finishTransaction(originId, "commit", request)` abgeschlossen.

### Schritt 2: Föderierte Subagent-Suche über alle 3 Members {#step-2-federated-search}

Wenn `bob` in einem Thread (der z.B. auf `member-2` liegt) nach der `"PostgreSQL"`-Entscheidung aus einem anderen Thread (der auf `member-1` liegt) fragt, ruft der Search-Subagent `federatedSpace.readAll({ type: "Msg" }, request)` auf. Der Router fragt alle 3 Member-Spaces ab, führt die Treffer zusammen und liefert die Antwort samt Member- und Thread-Referenz zurück!

### Schritt 3: Waiter-Wettlauf (takeWaiting) & LWW-Presence {#step-3-waiter-and-lww}

Globale Worker nutzen `federatedSpace.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)`, um Aufgaben von jedem beliebigen Member entgegenzunehmen. Ergänzend zeigt Stufe 5, wie `EntryReplicationController` (Phase 3) `Presence`-Daten per HLC und Last-Writer-Wins zwischen Replikaten abgleicht.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
```

## Siehe auch {#see-also}

- [Stufe 6 (v6-mobile-control): Mobile App & Web-Admin Steuerung](help.workflow.stage_v6_mobile_control#overview)
