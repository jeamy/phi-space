---
standard: help_topic
id: help.topic.space_service_and_remote_space
title: "SpaceService, RemoteSpace und Netzwerk-Transporte"
short: "Wie SpaceService Rollen-Policies erzwingt und wie RemoteSpace über In-Process, Unix-Socket, TCP oder pi-serverd mit stabilen Retries kommuniziert."
tags: [spaceservice, remotespace, socket, tcp, policy, identityadapter, outcomeunknown]
owner: remote
related: [help.workflow.stage_v3_remote_socket, help.api.space_service_and_remote]
since: 0.0.1
---

# SpaceService, RemoteSpace und Netzwerk-Transporte

## Überblick {#overview}

Sobald Web-Server, Worker und Subagenten in getrennten Prozessen oder auf verschiedenen Maschinen laufen, übernimmt `SpaceService` (`src/service.ts`) die serverseitige Abwicklung und `RemoteSpace` (`src/remote.ts`) die Client-Seite.

## Begriffs- und Systemmodell {#concept-model}

### Authentisierung über IdentityAdapter und Policy {#identity-and-policy}

`SpaceService` vertraut niemals einer vom Client im JSON-Body mitgesendeten Identität. Stattdessen bestimmt der `IdentityAdapter` (`StaticIdentity` lokal oder `GateIdentity` über NetBird/Schicht B) aus dem `Connection`-Kontext den `Principal` und seine Rollen (`admin`, `host`, `member`, `observer`). Die `Policy` prüft vor jeder Operation sowohl die erlaubte Methode als auch die erlaubten Entry-Typen.

### Stabile Retries und OutcomeUnknown in RemoteSpace {#remote-retries}

Vor der ersten Mutation ruft `RemoteSpace` automatisch `hello` und `generation` auf und vergibt für jeden schreibenden Aufruf eine stabile `requestId`. Geht auf dem Socket/TCP-Transport eine Antwort verloren, wiederholt `RemoteSpace` denselben Aufruf mit **unveränderter `requestId`**. Läuft `maxClientWaitMs` ab, wirft der Client `OutcomeUnknown`, während die Operation am Host weiterläuft und über `pollOperation` aufgelöst werden kann.

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace in der Praxis](help.workflow.stage_v3_remote_socket#overview)
- [SpaceService, serveSpace & RemoteSpace API](help.api.space_service_and_remote)
