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

`createFederationController` verteilt die Daten eines logischen Space auf mehrere Spaces, auch auf mehreren Rechnern. Du nutzt das, wenn ein einzelner Host nicht mehr reicht. Zusammengehörige Einträge bleiben dabei am selben Ort.

## Technische Referenz {#technical-reference}

`createFederationController(options)` initialisiert und rekonstruiert den föderierten Router (`journalPartitions` von 1 bis 1024, Standard 1, danach unveränderlich), `FederatedSpace`, `FederationPolicyAuthority` und `MembershipController`. Diese APIs gehören zum serverseitigen Router und ersetzen nicht die Signaturen von `RemoteSpace`.

```ts
const fed = await createFederationController({
  ...federationOptions, // Configured keys, transport, grants, lease and authority/admin guards.
  host,
  ctx,
  id: "router-main",
  journalPartitions: 4
});
```

## Komponenten im Überblick {#parameters}

| Komponente | Aufgabe |
| --- | --- |
| `RouterController` | Journalisiert Commands mit stabilen Unterrequest-IDs: `recover`, `submit`, `advance`, `get`, `ingest`, `review`. `renewableRouterLease` betreut den signierten Lease. |
| `FederatedSpace` | Leitet per Policy und HRW-Hash des Routing-Felds (z.B. `threadId`) auf den zuständigen Member. Eigene Signaturen, kein `SpaceLike`: `write(entry, request, leaseMs)`, `read(template, request)`, `take(template, request)`, `readAll(template, principal, options?)` mit `{ entries, complete }`. |
| `FederationPolicyAuthority` | Verwaltet die verbindliche Member-Menge und Shard-Abbildung. |
| `MembershipController` | Kontrolliertes Hinzufügen, Leeren und Entfernen von Membern als journalisierte Kommandos: `execute(id, "add" \| "drain" \| "remove", member, ...)`. |
| `takeWaiting` | Journalisierter Waiter-Wettlauf: genau ein Member gewinnt einen clusterweit geparkten Take-Wunsch. Grenzen: `timeoutMs` bis 3 600 000, `txnLeaseMs` bis 60 000. |
| `EntryReplicationController` | Eigenes Dokument für replizierte Entries (HLC, LWW, Add-Wins), keine Replikation normaler Entries. `erasePrincipal`, `completeErasure`, `compactionStatus` und `compact(id)` löschen und verdichten seine Historie. |

## Typische Anwendungsfälle {#use-cases}

- **Chat-Sharding (v5)**: Threads werden per HRW über `threadId` auf drei Member verteilt – jede Transaktion bleibt lokal atomar, memberübergreifende `txn` werden mit `RoutingConflict` abgelehnt.
- **Clusterweites Lesen**: `readAll` fragt alle passenden Member ab; `complete: false` zeigt, dass Antworten fehlen.
- **Wartung ohne Stillstand**: `execute` mit `"drain"` leert einen Member kontrolliert, bevor er gewartet wird.
