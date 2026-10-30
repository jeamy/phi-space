---
standard: help_topic
id: help.topic.space_service_and_remote_space
title: "SpaceService, RemoteSpace und Netzwerk-Transporte"
short: "Wie SpaceService Rollen-Policies erzwingt, wie der eigenständige Dienst läuft und wie RemoteSpace über In-Process, Unix-Socket, TCP oder pi-serverd mit stabilen Retries kommuniziert."
tags: [spaceservice, remotespace, socket, tcp, policy, identityadapter, outcomeunknown]
owner: remote
related: [help.workflow.stage_v3_remote_socket, help.api.space_service_and_remote]
since: 0.0.1
---

# SpaceService, RemoteSpace und Netzwerk-Transporte

## Überblick {#overview}

Sobald mehrere Prozesse oder Rechner denselben Space nutzen, braucht es einen Dienst in der Mitte. Der Space läuft dann in einem Prozess, und die anderen verbinden sich über einen Socket. Geht dabei eine Antwort verloren, wiederholt der Client den Aufruf gefahrlos. Für dein Programm sieht das fast so aus wie ein lokaler Space.

### Technische Details {#technical-details}

Sobald Web-Server, Worker und Subagenten in getrennten Prozessen oder auf verschiedenen Maschinen laufen, übernimmt `SpaceService` (`src/service.ts`) die serverseitige Abwicklung und `RemoteSpace` (`src/remote.ts`) die Client-Seite.

## Begriffs- und Systemmodell {#concept-model}

### Eigenständiger Dienst {#standalone}

```sh
npm run space-server -- --store ./space.db --listen unix:/tmp/space.sock
npm run space-server -- --store memory --listen tcp:127.0.0.1:7777
```

`src/standalone.ts` serviert den eigenen Speicher ohne pi-durable, ohne Modell und ohne Agent und startet die Hintergrundwartung mit. Sobald der Dienst bereit ist, schreibt er `[phi-spaces] ready on …`.

**Sicherheitsgrenze:** Jede Verbindung ist derselbe Peer (`--peer`, Standard `local`) mit der Rolle `member`. Wer den Socket erreicht, benutzt den Space. Lass ihn deshalb auf einem Unix-Socket oder einer internen Adresse laufen, oder setze das [Overlay-Gate](help.topic.gate_auth_grants_and_recovery#overview) davor. Ein offener TCP-Port ist nicht abgesichert.

### Client-Helfer {#client-helpers}

`src/space-client.ts` enthält, was jeder Prozess braucht, der einen Space woanders nutzt:

| Funktion | Inhalt |
|---|---|
| `parseTarget(spec)` | `unix:/pfad`, `tcp:host:port` oder ein bloßer Pfad wird zum Listen-Ziel |
| `connectSpace(spec, options?)` | Liefert `{ space, transport, close }`; Standard: Aufruf 30 s, Verbindungsaufbau 5 s, 3 Versuche |
| `readExisting` / `takeExisting` | Wie `readIfExists`/`takeIfExists`, unterscheiden aber „weg“ (`null`) von „gehalten“ (`StillHeld`) |
| `peek(space, template)` | Erster Treffer als Schnappschuss, ohne Claim |
| `takeAll(space, template)` | Nimmt jeden jetzt freien Treffer und liefert die Anzahl |
| `awaitWork(space, template, waitMs, halt?)` | Blockierendes `read` ohne Transaktion: `true`, sobald Arbeit da ist |
| `keepAlive(space, lease, leaseMs)` | Erneuert eine Lease alle `leaseMs / 3`; liefert die Stopp-Funktion |
| `cutText(text, max)` | Kürzt Text, ohne ein halbes Emoji zu hinterlassen |

```ts
import { connectSpace } from "phi-spaces";

const { space: client, close } = connectSpace("unix:/tmp/space.sock");
await client.write({ type: "Job", fields: { id: 1 } });
close();
```

Web-Prozesse nehmen für ihre Browser-Verbindungen das WebSocket-Gateway `upgradeWebSocket(req, socket, head, { maxMessagesPerMin })` aus `phi-spaces/ws` (RFC 6455, nur Text, Rahmen bis 1 MiB).

### Authentisierung über IdentityAdapter und Policy {#identity-and-policy}

`SpaceService` vertraut niemals einer vom Client im JSON-Body mitgesendeten Identität. Stattdessen bestimmt der `IdentityAdapter` (`StaticIdentity` lokal oder `GateIdentity` über NetBird/Schicht B) aus dem `Connection`-Kontext den `Principal` und seine Rollen (`DEFAULT_POLICY`: `admin`, `host`, `member`, `observer`, `resolution`, `unpaired`). Die `Policy` prüft vor jeder Operation sowohl die erlaubte Methode als auch die erlaubten Entry-Typen. Ein Typ-Grant gilt auch für Subtypen: Ein Write ist erlaubt, sobald der Typ oder einer der deklarierten Supertypen freigegeben ist. Weil der Schreibende die Supertypen selbst angibt, kann eine Rolle mit Grant auf `Job` auch `{ type: "X", types: ["Job"] }` schreiben; Typ-Grants sind daher keine Integritätsgrenze für Subtypen. Federation-Members erzwingen dagegen die in der Typ-Policy deklarierten Supertypen.

### Stabile Retries und OutcomeUnknown in RemoteSpace {#remote-retries}

Vor der ersten Mutation ruft `RemoteSpace` automatisch `hello` und `generation` auf und vergibt für jeden schreibenden Aufruf eine stabile `requestId`. Geht auf dem Socket/TCP-Transport eine Antwort verloren, wiederholt `RemoteSpace` denselben Aufruf mit **unveränderter `requestId`**. Läuft `maxClientWaitMs` ab, wirft der Client `OutcomeUnknown`, während die Operation am Host weiterläuft und über `pollOperation` aufgelöst werden kann. Nicht klassifizierte Hostfehler kommen als Code `Internal` mit der festen Meldung `internal error` an; den eigentlichen Fehler protokolliert nur der Host.

### Wann wartende Aufrufe nachsehen {#polling}

Lange Wartezeiten (`read`/`take` im Zustand `pending`, `events`, `changes`) laufen im Dienst in Runden, höchstens 25 s je Long Poll.

- **Standard**: Der Dienst sieht alle 50 ms nach.
- **Mit `wakeOnCommit: true`** (`SpaceServiceOptions`, Opt-in): Er sieht beim ersten Commit nach, danach bei `read`, `take` und `events` höchstens alle 25 ms. Ohne Commit sieht er spätestens nach 1 s nach. spaces-mmo schaltet das ein.
- **Lokal**: Ein wartender `PhiSpaces`-Aufruf wird durch die Änderung geweckt und wartet danach 20 ms plus bis zu 20 ms Zufall. So kostet eine Folge von Writes nur eine Runde, und viele Wartende schauen nicht im selben Moment nach.

### Text, Statistik und Space-Liste {#service-details}

- **Wohlgeformter Text**: Der Dienst ersetzt ein unpaariges Surrogat in jedem String und Schlüssel durch U+FFFD, bevor etwas den Aufruf sieht, auch der Argument-Hash (`wellFormed`).
- **Typisierte Fehlschläge**: `read` und `take` tragen über den Dienst `locked`; `hello` meldet das Feature `read.locked`.
- **`spaces` / `RemoteSpace.spaces()`**: Listet die Spaces des Hosts (`spaceId`, `alias`, `createdAt`), auch die zur Laufzeit angelegten. Die Rolle `observer` darf das.
- **`RemoteSpace.statsWithRevision()`**: Liefert die Kennzahlen mit der Revision und `streamId`, zu der sie gelesen wurden, dazu `process` (CPU-Zeit und Speicher des bedienenden Prozesses). Zwei Abfragen ergeben so die Commits dazwischen.

## Siehe auch {#see-also}

- [Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace in der Praxis](help.workflow.stage_v3_remote_socket#overview)
- [SpaceService, serveSpace & RemoteSpace API](help.api.space_service_and_remote)
