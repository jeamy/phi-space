---
standard: help_workflow
id: help.workflow.stage_v5_federated_cluster
title: "Stufe 5 (v5-federated-cluster): Föderierte Spaces, HRW-Sharding & Router"
short: "Verteilt Threads per Router auf 3 Member-Spaces: HRW-Platzierung je threadId, clusterweites Lesen und LWW-Presence, simuliert in einem Prozess."
tags: [v5, federation, cluster, router, hrw, federatedspace, takewaiting, lww]
owner: federation
related: [help.workflow.stage_v4_gated_auth, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Stufe 5 (v5-federated-cluster): Föderierte Spaces, HRW-Sharding & Router

## Überblick {#overview}

Stufe 5 verteilt den Chat auf mehrere Spaces, damit er über einen Rechner hinaus wachsen kann. Alle Nachrichten eines Threads landen immer am selben Ort, verschiedene Threads aber an verschiedenen Orten. Eine Suche kann trotzdem alle Orte gemeinsam lesen. Die Demo simuliert das in einem einzigen Prozess.

## Topologie: Space-Verteilung {#topology}

`help-site/examples/v5-federated-cluster/run.ts` verteilt Threads und Nachrichten auf **drei Member-Spaces (`member-1`, `member-2`, `member-3`)**. Das Programm setzt `RouterController` und `FederatedSpace` direkt zusammen; für den Betrieb fasst [`createFederationController`](help.api.federation_controller#overview) beide samt Policy und Membership zusammen.

Der Cluster läuft **simuliert in einem einzigen Prozess**: **4 Hosts** im Arbeitsspeicher (`openOwnMemoryHost()`) spielen Member-Hosts mit echten Federation-Komponenten. Es gibt kein Netzwerk, aber dieselbe Routing- und Journal-Logik wie in echter Verteilung.

- **1 Koordinator-Host**: `RouterController` (`router-root` + 2 Partition-Router für die Routing-Journals) und `FederatedSpace` (id `fed-v5`). Der Koordinator besitzt selbst keinen Chat-Daten-Space — er führt nur die Policy aus.
- **3 Member-Hosts** (`member-1`, `member-2`, `member-3`): jeder hat einen eigenen, unabhängigen Space mit eigenem Space-Doc.
- **HRW-Sharding**: die Federation-Policy routet `Thread`, `Msg` und `ChatTask` per Rendezvous-Hashing über `fields.threadId` deterministisch auf genau einen Member. Das Runner-Report-Feld `memberDistribution` zeigt die tatsächliche Verteilung, z.B. `{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }`.
- **`FederationIO`** ist in der Demo ein In-Process-Adapter auf die lokalen `PhiSpaces`-Objekte; das Adapter-Ziel des Routers ebenso. In echter Verteilung wären das RPC-Aufrufe auf entfernte Hosts; der Vertrag (`step`, `snapshot`, `events`, `ack`, `txnActive`) bleibt gleich.
- **Replikation**: 2 `EntryReplicationController` (`rep-1` auf member-1, `rep-2` auf member-2) replizieren `Presence` via HLC + Last-Writer-Wins unter der Space-ID `presence-global`. Das Programm überträgt die Änderungen einmal von `rep-1` nach `rep-2` (`changes`, `importChanges`).

## Arbeitsablauf {#workflow}

### Schritt 1: FederationPolicy mit HRW nach threadId {#step-1-policy}

Alle thread-gebundenen Typen (`Thread`, `Msg`, `ChatTask`) erhalten die Routing-Regel `mode: "expand"`, `by: { field: "threadId" }` über `["member-1", "member-2", "member-3"]`:

- Dadurch landen alle Nachrichten und Aufgaben desselben Threads deterministisch auf demselben Member-Space.
- Verschiedene Threads einer großen Session verteilen sich gleichmäßig auf die 3 Member-Spaces.
- Geschrieben wird mit `federated.write(entry, { id, principal }, FOREVER)`. Das Programm schreibt vier Threads mit je einer Nachricht. Member-Transaktionen (`createTransaction(member, leaseMs, request)`, `finishTransaction(originId, "commit", request)`) bietet `FederatedSpace` ebenfalls an, das Programm nutzt sie nicht.

### Schritt 2: Föderierte Subagent-Suche über alle 3 Members {#step-2-federated-search}

`federated.readAll({ type: "Msg" }, principal)` fragt alle Member-Spaces ab, die zum Template passen, und liefert `{ entries, complete }`. Über `complete` meldet die Antwort, ob alle Members geantwortet haben. Das Programm zählt so alle Nachrichten des Clusters. Einen Search-Subagenten führt diese Stufe nicht aus; das Lesen über alle Members ist die Grundlage dafür.

### Schritt 3: LWW-Presence, Waiter-Wettlauf nur als API {#step-3-waiter-and-lww}

Das Programm schreibt mit `rep1.mutate(...)` einen `Presence`-Eintrag, überträgt die Änderung und liest ihn auf `rep-2`. Der Konflikt zweier Schreiber wird per HLC und Last-Writer-Wins entschieden.

`takeWaiting` führt das Programm nicht aus. Die Methode nimmt eine Aufgabe von dem Member, der sie zuerst hat: `federated.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)`. Ohne Transaktion verlangt sie `timeoutMs` von 1 bis 3 600 000 und `txnLeaseMs` von 1 bis 60 000, sonst gibt es `RoutingConflict`.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
```

## Siehe auch {#see-also}

- [Stufe 6 (v6-mobile-control): Mobile App & Web-Admin Steuerung](help.workflow.stage_v6_mobile_control#overview)
