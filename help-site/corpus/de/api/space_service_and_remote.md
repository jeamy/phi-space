---
standard: help_api
id: help.api.space_service_and_remote
title: "SpaceService, serveSpace & RemoteSpace – Netzwerk-RPC über Socket & TCP"
short: "Veröffentlicht Spaces über Unix-Socket, TCP oder pi-serverd mit Rollen-Policy und bedient RemoteSpace-Clients mit stabiler Retry-Identität."
tags: [spaceservice, servespace, remotespace, sockettransport, inprocesstransport]
owner: remote
related: [help.topic.space_service_and_remote_space, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# SpaceService, serveSpace & RemoteSpace – Netzwerk-RPC über Socket & TCP

## Überblick {#overview}

`serveSpace(service, { listen, connection })` bindet `SpaceService` an einen Unix-Socket oder TCP-Port. `new RemoteSpace(socketTransport(target), options)` verbindet sich als Client und implementiert `SpaceLike`.

## Technische Referenz {#technical-reference}

```ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
```

## Rollen und Fehlerbild {#parameters}

- **`SpaceService`**: Transportunabhängige Fassade vor `SpaceHost`; ordnet jeder Verbindung über `IdentityAdapter` einen vertrauenswürdigen `Principal` zu und erzwingt Rollen-Policies.
- **`serveSpace`**: Bindet den Service an Unix-Socket (`{ path }`) oder TCP (`{ host, port }`); alternativ als `pi-serverd`-Plugin.
- **`RemoteSpace`**: Vollständiger `SpaceLike`-Client mit Retry-Identität; blockierende Calls kehren bei Transportabbruch als `OutcomeUnknown` zurück und werden per `pollOperation` aufgelöst.
- **`inProcessTransport`**: Dieselbe Client-Fassade ohne Netzwerk – ideal für Tests der Remote-Grenze.

## Typische Anwendungsfälle {#use-cases}

- **Prozess-Trennung (v3)**: Web-Server, Chat-Worker und Subagent laufen als eigene Prozesse und greifen per `RemoteSpace` über Unix-Socket auf denselben Chat-Space zu.
- **Geteilte Mailboxen**: Jeder Remote-Consumer besitzt eine eigene dauerhafte Mailbox; `events`/`ack` funktionieren über den Socket genauso wie lokal.
- **Pi-Server-Hosting**: `pi-serverd` stellt Spaces als persistenten Dienst für mehrere Maschinen im Netzwerk bereit.
