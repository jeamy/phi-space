---
standard: help_topic
id: help.topic.federation_router_and_membership
title: "Federation, Router, HRW-Sharding und Membership"
short: "Wie createFederationController mehrere Member-Spaces über HRW-Routing, signierte Delegationen und journalisierte Waiter-Wettläufe zu einem Cluster verbindet."
tags: [federation, router, routerlease, delegation, hrw, federatedspace, takewaiting, membership, erasure]
owner: federation
related: [help.workflow.stage_v5_federated_cluster, help.api.federation_controller]
since: 0.0.1
---

# Federation, Router, HRW-Sharding und Membership

## Überblick {#overview}

Phase 2 (`src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts`) verbindet mehrere physische Member-Spaces unter einem Koordinator-Router zu einem logischen `FederatedSpace`.

## Begriffs- und Systemmodell {#concept-model}

### RouterController und Journal-Partitionen {#router-and-journals}

Jede föderierte Operation durchläuft im `RouterController` die persistente Zustandsmaschine `accepted → applying → completed | failed | needsReview`. Vor dem ersten RPC-Versand an einen Member stehen Ziel-`spaceId`, `primaryEpoch`, `requestId` und Argument-Hash fest im Journal (1 bis 1024 Partitionen). Nach einem Router-Neustart löst `recover()` offene Unterrequests über `pollOperation` / `resolveOperation` auf, ohne jemals blind eine zweite Wirkung auszulösen.

### HRW-Routing (Highest Random Weight) und Transaktionsbindung {#hrw-routing}

Die `FederationPolicy` ordnet jedem Entry-Typ eine Platzierungsregel zu:

- **`local`**: Fester einzelner Member-Space.
- **`expand` nach Typ oder Schlüsselfeld (HRW)**: Bei `by: { field: "threadId" }` berechnet der Router deterministisch über den kanonischen Feldwert und die Member-IDs den zuständigen Member.
- **Vorteil für unseren Multiplayer Space-Chat**: Da `Thread`, `Msg` und `ChatTask` alle über `field: "threadId"` auf dieselbe Member-Menge geroutet werden, landen alle Operationen eines Threads garantiert auf demselben Member-Space! Damit funktionieren lokale Space-Transaktionen und `CompletionProfiles` ohne verteiltes Two-Phase-Locking.

### Journalisierter Waiter-Wettlauf bei takeWaiting {#waiter-race}

Ruft ein globaler Worker `federatedSpace.takeWaiting(template, timeoutMs, txnLeaseMs, request)` ohne festes Schlüsselfeld auf, registriert der Router begrenzte Take-Waiter auf allen in Frage kommenden Members. Sobald ein Member einen Treffer in seiner Mailbox liefert, wird das Event **vor** dem Mailbox-ACK im Router-Journal erfasst: Die erste aktive Reservierung wird dauerhaft zum Gewinner gekürt; etwaige parallele Reservierungen auf anderen Members werden automatisch per `abort` zurückgegeben.

## Siehe auch {#see-also}

- [Stufe 5 (v5-federated-cluster): Föderierter Multiplayer Space-Chat](help.workflow.stage_v5_federated_cluster#overview)
- [createFederationController & FederatedSpace API](help.api.federation_controller)
