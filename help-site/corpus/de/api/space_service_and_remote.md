---
standard: help_api
id: help.api.space_service_and_remote
title: "SpaceService, serveSpace & RemoteSpace – Netzwerk-RPC über Socket & TCP"
short: "Veröffentlicht Spaces über Unix-Socket oder TCP, auch als eigenständiger Dienst oder über pi-serverd, mit Rollen-Policy, und bedient RemoteSpace-Clients mit stabiler Retry-Identität."
tags: [spaceservice, servespace, remotespace, sockettransport, inprocesstransport]
owner: remote
related: [help.topic.space_service_and_remote_space, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# SpaceService, serveSpace & RemoteSpace – Netzwerk-RPC über Socket & TCP

## Überblick {#overview}

Damit nutzen mehrere Programme denselben Space über einen Socket oder TCP. `serveSpace` stellt ihn auf der Serverseite bereit, `RemoteSpace` ist der passende Client. Der Client verhält sich wie der lokale, du kannst also denselben Code verwenden.

## Technische Referenz {#technical-reference}

`serveSpace(service, { listen, connection })` bindet `SpaceService` an einen Unix-Socket oder TCP-Port. `new RemoteSpace(socketTransport(target), options)` verbindet sich als Client und implementiert `SpaceLike`. Den fertigen Dienst startet `npm run space-server -- --store FILE|memory --listen unix:/pfad.sock|tcp:HOST:PORT` (`src/standalone.ts`, ohne pi-durable und ohne Modell). Dort ist jede Verbindung derselbe Peer (`--peer`, sonst `local`) mit Rolle `member`. Der Socket gehört daher in ein geschütztes Netz oder hinter das Gate.

```ts
const server = await serveSpace(service, { listen: { path: "/tmp/space.sock" }, connection });
const remote = new RemoteSpace(socketTransport({ path: "/tmp/space.sock" }), { space: "chat-v3" });
```

## Rollen und Fehlerbild {#parameters}

- **`SpaceService`**: Transportunabhängige Fassade vor `SpaceHost`; ordnet jeder Verbindung über `IdentityAdapter` einen vertrauenswürdigen `Principal` zu und erzwingt Rollen-Policies.
- **`serveSpace`**: Bindet den Service an Unix-Socket (`{ path }`) oder TCP (`{ host, port }`). Für den vorhandenen pi-server gibt es `withSpaceService` und `piServerTransport`.
- **`RemoteSpace`**: Vollständiger `SpaceLike`-Client mit Retry-Identität; blockierende Calls kehren bei Transportabbruch als `OutcomeUnknown` zurück und werden per `pollOperation` aufgelöst. Zusätzlich bietet er `probe`, `batch`, `readChain`, `spaces()` und `statsWithRevision()`; ein Feature, das ein älterer Server nicht kennt, ergibt `UnsupportedOperation`.
- **`inProcessTransport`**: Dieselbe Client-Fassade ohne Netzwerk – ideal für Tests der Remote-Grenze.
- **Fehler**: Der Dienst überträgt Fehlercodes; `RemoteSpace` baut daraus `RemoteError` oder die lokale Fehlerklasse. Nicht klassifizierte Fehler kommen als `Internal` mit der Meldung `internal error` an, den Grund protokolliert nur der Host.

### Dienst-Methoden und Rollen {#methods-and-roles}

Der Dienst nimmt `hello`, `generation`, `write`, `read`, `take`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `spaces`, `txn`, `lease`, `changes`, `wait`, `notify`, `events`, `ack` und `batch` an. `spaces` listet die Spaces des Hosts (`spaceId`, `alias`, `createdAt`), auch die zur Laufzeit angelegten. `hello` nennt die Features; neben den Methoden sind das `write.unique`, `write.transient`, `read.chain` und `read.locked`.

| Rolle in `DEFAULT_POLICY` | Rechte |
| --- | --- |
| `admin` | Alle Methoden, auch über die Liste hinaus. |
| `host`, `member` | Alle oben genannten Methoden. |
| `observer` | Lesen und Abonnieren, darunter `spaces`, `stats`, `changes`, `notify`, `events`, `ack`; kein Schreiben. |
| `resolution` | Klärung offener Operationen, `txn`, `lease`. |
| `unpaired` | Nur `hello` und `generation`, dazu das eigene Pairing. |

Text wird beim Eintritt repariert: `wellFormed` ersetzt ein unpaariges Surrogat in Strings und Schlüsseln durch U+FFFD, bevor etwas den Aufruf sieht, auch den Argument-Hash. `maxPollMs` begrenzt einen Long Poll (Standard 25 Sekunden). `wakeOnCommit` ist optional und standardmäßig aus: Ohne die Option schaut der Dienst alle 50 ms nach, mit ihr beim ersten Commit und dann höchstens alle 25 ms.

### Client-Helfer {#client-helpers}

`phi-spaces` enthält, was jeder entfernte Prozess braucht. `parseTarget(spec)` liest `unix:/pfad`, `tcp:host:port` oder einen bloßen Pfad. `connectSpace(spec, { callTimeoutMs, connectTimeoutMs, attempts })` liefert `{ space, transport, close }` (Standard 30 s, 5 s, 3 Versuche); eine blockierende Wartezeit muss unter `callTimeoutMs` bleiben. Dazu kommen `readExisting`, `takeExisting`, `StillHeld`, `peek`, `takeAll`, `awaitWork`, `keepAlive` und `cutText`. Das WebSocket-Gateway der Web-Prozesse steht in `phi-spaces/ws`: `upgradeWebSocket(req, socket, head, { maxMessagesPerMin })`, RFC 6455, nur Text, Rahmen bis 1 MiB.

### Speicher des Hosts {#store-host}

`openSqliteHost(path, options?)` öffnet den eigenen SQLite-Speicher: WAL-Modus, ein Schreib-Thread, standardmäßig `synchronous=FULL`, eine Besitzersperre in `path.owner`. Ein zweiter Prozess oder eine fremde Datei ergibt `StoreUnavailable`. `openOwnMemoryHost()` hält alles im Speicher. Alte pi-durable-Speicher werden nicht übernommen. `OwnStoreHost.skipUnchangedRecords` ist optional und standardmäßig aus.

Drei Vorgänge heißen ähnlich:

- `host.compact()` gibt freie Seiten der SQLite-Datei zurück: `{ freedPages, converted, error? }`, im Speicher `null`. Der erste Aufruf schreibt die Datei einmal mit `VACUUM` neu, Commits warten so lange.
- `compactErasedSqlite(path, assertExclusiveFenced)` aus `src/erasure-sqlite.ts` bereinigt eine gestoppte Datei nach einer Löschung, damit keine gelöschten Bytes in freien Seiten oder im WAL bleiben. Das Paket `phi-spaces` exportiert diese Funktion nicht; sie ist ein Werkzeug des Repositorys.
- `EntryReplicationController.compact(id)` verdichtet die Historie replizierter Entries; siehe [Federation](help.api.federation_controller#parameters).

## Typische Anwendungsfälle {#use-cases}

- **Prozess-Trennung (v3)**: Web-Server, Chat-Worker und Subagent laufen als eigene Prozesse und greifen per `RemoteSpace` über Unix-Socket auf denselben Chat-Space zu.
- **Geteilte Mailboxen**: Jeder Remote-Consumer besitzt eine eigene dauerhafte Mailbox; `events`/`ack` funktionieren über den Socket genauso wie lokal.
- **Eigener Dienst**: `npm run space-server` stellt einen Space ohne weiteren Code bereit; `pi-serverd` bietet ihn als zusätzlichen Dienst `space` an, wenn er dafür freigeschaltet ist.
