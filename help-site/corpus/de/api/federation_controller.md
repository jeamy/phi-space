---
standard: help_api
id: help.api.federation_controller
title: "createFederationController & FederatedSpace – Router, HRW-Sharding & Membership"
short: "Verbindet Router-Journal-Partitionen, signierte RouterLease, Original-Principal-Delegation, HRW-Policy, Waiter-Wettlauf und Membership-Lifecycle."
tags: [createfederationcontroller, routercontroller, federatedspace, membershipcontroller, hrw]
owner: federation
related: [help.topic.federation_router_and_membership, help.workflow.stage_v5_federated_cluster]
since: 0.0.1
---

# createFederationController & FederatedSpace – Router, HRW-Sharding & Membership

## Überblick {#overview}

`createFederationController(options)` initialisiert und rekonstruiert den föderierten Router (mit bis zu 1024 Journal-Partitionen), `FederatedSpace`, `FederationPolicyAuthority` und `MembershipController`.

## Technische Referenz {#technical-reference}

```ts
const fed = await createFederationController({
  ...federationOptions, // Configured keys, transport, grants, lease and authority/admin guards.
  host: harness,
  ctx,
  id: "router-main",
  journalPartitions: 4
});
```

## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| `RouterController` | Journalisiert Routing-Entscheidungen partitioniert (bis 1024) und signiert `RouterLease`s für autorisierte Member. |
| `FederatedSpace` | `SpaceLike`-Fassade, die `write`/`read`/`take` per HRW-Hash des Korrelationsfelds (z.B. `threadId`) auf den zuständigen Member-Space leitet. |
| `FederationPolicyAuthority` | Verwaltet die verbindliche Member-Menge und Shard-Abbildung. |
| `MembershipController` | Kontrolliertes Beitreten/Drainen/Entfernen von Membern (`join`, `drain`, `leave`) als journalisierte Kommandos. |
| `takeWaiting` | Journalisierter Waiter-Wettlauf: genau ein Member gewinnt einen clusterweit geparkten Take-Wunsch. |

## Typische Anwendungsfälle {#use-cases}

- **Chat-Sharding (v5)**: Threads werden per HRW über `threadId` auf drei Member verteilt – jede Transaktion bleibt lokal atomar, memberübergreifende `txn` werden mit `RoutingConflict` abgelehnt.
- **Clusterweite Suche**: Der `search_history`-Subagent schreibt `SearchTask`s, die jeder Member lokal beantwortet; der Koordinator fusioniert die `SearchResult`s.
- **Wartung ohne Stillstand**: `membership.execute(cmdId, "drain", member)` leert einen Host kontrolliert, bevor er gewartet wird.
