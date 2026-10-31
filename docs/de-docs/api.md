# phi-spaces API

Stand: 2026-10-31. Diese Referenz dokumentiert die öffentliche TypeScript-API
des lokalen Clients `PhiSpaces`, des Remote-Clients `RemoteSpace`, den
Servicevertrag und das Agentenpaket. Der Abschnitt [Exportübersicht](#exportübersicht) nennt jeden Export, den die
übrigen Abschnitte nicht behandeln. Sie beschreibt keine Federation-Garantie; dafür ist
[federation-plan-v3.md](../federation-plan-v3.en.md) maßgeblich.

## Paket und Unterpfade

Projekte, die auf phi-spaces aufbauen (codemode-chat, help-site, künftige), binden die Bibliothek als Paket ein:
`"phi-spaces": "file:.."` in ihren `dependencies` (npm legt einen Symlink an) und Importe über den Paketnamen.
`exports` zeigt direkt auf die TypeScript-Quellen; es gibt keinen Build-Schritt, Node entfernt die Typen
(`--experimental-strip-types`), weil der Symlink auf den echten Pfad außerhalb von `node_modules` auflöst.

| Import | Quelle | Inhalt |
| --- | --- | --- |
| `phi-spaces` | `src/index.ts` | Öffentliche API (`PhiSpaces`, `RemoteSpace`, `serveSpace`, `SpaceService`, Fehler, …) |
| `phi-spaces/context` | `src/context.ts` | `Context`, `BACKGROUND_CONTEXT`, `ContextKey`, `withContextValue`, `withAbortSignal`, `awaitWithContext` |
| `phi-spaces/core` | `src/core.ts` | Reine Semantik: `matches`, Fehlerklassen wie `SnapshotExpired`, Typen, Zustandsfunktionen (auch als Namensraum `core` aus `phi-spaces`) |
| `phi-spaces/store/host` | `src/store/host.ts` | Eigener Store im Speicher (`openOwnMemoryHost`), `OwnStoreHost`, `Ledger`, `memoryLedger`, `StoredDoc`, `PutDoc`, `CommitSet`, `StoreStats`, `HOST_CLOSED` |
| `phi-spaces/store/sqlite` | `src/store/sqlite.ts` | Eigener SQLite-Store (`openSqliteHost`, `StoreUnavailable`), `SqliteStoreOptions`, `FORMAT_VERSION`, `DEFAULT_MEMORY_BUDGET`, `openFiles`, `hostOver`, `StoreFiles`, `StoreFaults`, `Compaction`, `LedgerReplication` |
| `phi-spaces/store/documents` | `src/store/documents.ts` | Dokument-Helfer des Stores: `defineDoc`, `defineDocFamily` |
| `phi-spaces/ws` | `src/ws.ts` | WebSocket-Gateway der Web-Prozesse (`upgradeWebSocket(req, socket, head, { maxMessagesPerMin })` mit `WsOptions`, liefert `WsConnection` oder `null`; RFC 6455, nur Text, Rahmen bis 1 MiB) |
| `phi-spaces/package.json` | `package.json` | Das Paketmanifest selbst |

Nur diese Unterpfade sind Vertrag; ein neuer Unterpfad ist eine API-Änderung und gehört in diese Tabelle.
`npm run check:package` (auch Teil von `npm test`) lehnt in solchen Projekten relative Importe nach `src/` und
nicht exportierte Unterpfade ab. Ausnahmen: das Agentenpaket `agent/` (greift auf Föderations-Interna zu) und zwei
einzeln begründete Dateien der help-site (`scripts/package-imports.mjs`, `ALLOWED`). `pi-codemode` ist nur noch
Entwicklungsabhängigkeit des Roots (Beispiele); wer den Sandbox braucht, führt ihn selbst.

## Gemeinsame Typen

```ts
type EntryDraft = { type: string; types?: string[]; fields: Fields };
type Template = { type?: string | null; fields?: Fields; id?: string | null } | null;
type Lease = { id: string; expires: number };
type RequestRef = { principal: Principal; generation: string; requestId: string };
```

`fields` und `handback` müssen JSON sein. `null` als Template matcht jeden
Entry. Fehlende oder `null`-Templatefelder sind Wildcards; daher lässt sich
nicht nach einem gespeicherten JSON-`null` suchen. `id` ist die lokale ID aus
einem Entry-View; `gid` ist nur die globale Anzeigeform.

Zeitangaben sind Millisekunden. `NO_WAIT` (`0`) wartet nicht,
`ANY` (`-1`) überlässt die Lease-Dauer dem Space und `FOREVER` steht für eine
unbefristete Dauer. Über den Wire-Vertrag werden `ANY` als `null` und `FOREVER`
als `"forever"` übertragen.

## `PhiSpaces`

```ts
const space = new PhiSpaces(harness, ctx, Date.now, meter, conversationId, {
  space: "optional-alias-or-spaceId",
});
```

Die Signatur ist `new PhiSpaces(host, ctx, now?, meter?, as?, options?)`. `harness` meint hier und unten einen `SpaceHost`
(`commit`, `watchDoc`, `snapshot`), etwa den Host aus `openSqliteHost`; der Name stammt aus der Zeit vor dem eigenen Store.
Ohne `space` verwendet der Client den Default-Space. Ein gesetztes
`conversationId` (Parameter `as`, ein `core.Target`) aktiviert Ownership-Prüfungen; Host-Code lässt es weg.
`PhiSpacesOptions` enthält außerdem `authorityId`, `maxPending`, `maxPendingPeer`, `consumer` und `authorization`.
`PhiSpaces` erfüllt `SpaceLike`.

| Methode | Ergebnis | Semantik |
|---|---|---|
| `write(entry, txn?, lease?, { request?, unique? })` | `Lease` | Schreibt einen neuen Entry; unter `txn` zunächst unsichtbar. `unique: ["feld"]` prüft atomar auf einen vorhandenen Entry desselben konkreten Typs mit denselben Schlüsselfeldern, auch wenn dieser reserviert oder noch uncommitted ist. |
| `read(template, timeout, options?)` | `EntryView \| null` | Wartet auf einen sichtbaren Treffer. |
| `readIfExists(template, timeout, options?)` | `EntryView \| null` | Wartet nur auf die Auflösung kollidierender Transaktionen. |
| `take(template, timeout, options?)` | `EntryView \| null` | Entfernt sofort oder reserviert unter `txn`. |
| `takeIfExists(template, timeout, options?)` | `EntryView \| null` | Nichtblockierende Take-Variante, außer bei Locks. |
| `probe(template, timeout, { take?, ... })` | `{ entry, locked }` | Wie `readIfExists`/`takeIfExists`, meldet aber mit `locked`, ob nur gehaltene Treffer da waren. |
| `notify(template, options)` | `{ eventId, lease }` | Registriert lokale Zustellung oder Principal-Mailbox-Events. |
| `wait(template, options)` | `waiterId` | Parkt Read/Take für Conversation- oder Consumer-Zustellung. |
| `readAll(template?, options?)` | `EntryView[]` | Snapshot-Liste, älteste zuerst, alle Treffer, optionales Limit. |
| `readPage(template?, options?)` | `Page` | Bytebegrenzte Snapshot-Seite; mit `next` fortsetzen. |
| `readChain(template, options?)` | `ChainPage` | Optionale `SpaceLike`-Fähigkeit: bis zu 512 verkettete Entries aus einem unveränderlichen Snapshot, ohne Commit. `head`-Template oder `cursor`, `nextField`, `limit`, `maxBytes`; `next` ist die erste nicht konsumierte Entry-ID. Remote als `readAll`-Variante mit Feature `read.chain`; dieselben Rollen-/Typrechte gelten auch für den Head. |
| `changes(afterRev, options?)` | `Changes` | Sichtbare Commit-Batches nach einer Revision. |
| `count(template?, txn?)` | `number` | Sichtbare Treffer ohne Commit oder Warten. |
| `countWithRevision(template?, txn?)` | Anzahl mit Revision | Wie `count`, zusammen mit der Revision und `streamId`, zu der gelesen wurde. |
| `stats()` | `SpaceStats` | Punkt-in-Zeit-Gauges einschließlich Byte-Aufteilung. |
| `statsWithRevision()` | Kennzahlen mit Revision | Wie `stats`, zusammen mit Revision und `streamId`. |
| `revision()` | `{ rev, streamId }` | Aktuelle Revision des Änderungsstroms. |
| `configuration()` | `{ spaceId?, limits }` | Identität und wirksame Grenzen des Space. |
| `commitSignal({ gapMs? })` | `{ wait(ms), stop() }` | Weckt Wartende beim nächsten Commit, statt zu pollen. |
| `snapshot(entry)` | `Snapshot` | Eingefrorene Kopie eines `EntryDraft`. |
| `createTransaction(lease?, { request? })` | `Lease` | Erzeugt eine Transaktion. |
| `transactionState(id)` | `{ state, expires? }` | `active` oder `inactive`. |
| `commit(txn, { request? })` / `abort(...)` | `void` | Schließt eine eigene Transaktion ab. |
| `renew(leaseId, ms, { request? })` / `cancel(...)` | Ablaufzeit / `void` | Erneuert bzw. beendet eigene Leases. |
| `issueGeneration(principal)` | Generation | Öffnet eine Claim-Generation. |
| `pollOperation(request)` / `cancelOperation(request)` | Claim-Status | Liest bzw. beendet eine bekannte Claim-Operation. |
| `resolveOperation(request, method, argumentHash, primaryEpoch)` | `AdmissionResolution` | Prüft bekannte Claim-Bindungen oder erlaubt bei gültiger Generation derselben Epoche ausschließlich Retry derselben ID. |
| `resolveOperationRecord(request, method, argumentHash, primaryEpoch)` | Auflösung mit Bindung | Dasselbe mit der Bindung, aus der der Dienst einen `ClaimReceipt` baut. |
| `resolveNotCommitted(request, method, argumentHash, requestEpoch, primaryEpoch, proofHash)` | `ClaimView` | Negativclaim nach einer Promotion (siehe [Administrative Replikationspflege](#administrative-replikationspflege-und-synchroner-storage)). |
| `beginOperation(template, timeout, options, take, ifExists)` | `ClaimView` | Beginnt eine blockierende Operation als dauerhaften Claim; der Weg des Dienstes. |
| `events(principal, options?)` / `ack(principal, epoch, upTo, options?)` | Mailbox-Seite / ACK-Stand | Eigene Consumer-Mailbox, Präfix-ACK ist kein Txn-Commit. |
| `setCompletionProfiles(profiles)` | `void` | Nur Host-Code; Ergebnisvertrag vor Arbeit installieren. Das erneute Setzen identischer Profile ist ein No-op, auch bei laufenden Transaktionen. |
| `setLimits(partialLimits)` | `Limits` | Nur Host-Code: setzt Grenzen dieses Space. Ein kleineres `maxEventBytes` wird abgelehnt (`ResourceExhausted`), solange eine bestehende Registrierung oder ein Wait damit ein zu großes Event erzeugen könnte. |

Standardmäßig gibt es keine Entry-Anzahlquote pro Space oder Owner: `maxEntries` und
`maxEntriesPerOwner` stehen auf `FOREVER` (`Number.MAX_SAFE_INTEGER`, JSON-sicher).
Mit `setLimits` ausdrücklich gespeicherte Anzahlquoten bleiben wirksam; ein Update entfernt
keine individuell gesetzte Quota. Byte-, Commit-, Frame- und Dokumentbudgets gelten weiterhin.

`read`/`take` akzeptieren zusätzlich `OpOptions`: `txn`, eine absolute
`deadline`, eine durable `request` und lokal einen `once`-Hook. Eine Request-ID
ist für robuste Wiederholung über Neustarts gedacht: Gleiche Identität und
gleiche Argumente liefern dasselbe gespeicherte Ergebnis; abweichende Argumente
führen zu `RequestConflict`.

`notify` braucht `{ target, txn?, lease?, handback?, request? }`. `wait` nimmt
`{ take?, target, timeout, txnLeaseMs?, handback?, request? }`; ein bedienter
Take-Waiter hält den Entry in einer frischen Transaktion, bis der Empfänger
committet oder deren Lease abläuft. Beide Methoden benötigen `startService`,
damit Delivery und Reaper im Leerlauf laufen.

Die optionale `write`-Prüfung `unique` ist eine atomare Prüfung dieses einzelnen
Writes, kein dauerhaft registrierter Unique-Index. Alle Erzeuger eines Singleton-
Typs müssen dieselben Schlüsselfelder angeben. Reservierte und uncommittete
Duplikate werden ebenfalls abgewiesen; der transaktionale Ersatz eines reservierten
Singletons erfolgt anschließend mit normalem `write` in derselben Transaktion.
`RemoteSpace` verlangt dafür das Feature `write.unique` und lehnt ältere Server
ab, statt die Eindeutigkeitsprüfung stillschweigend wegzulassen. Die Zusage gilt
je Space, nicht über voneinander unabhängige Federation-Members hinweg.

**Transientes Schreiben.** `write(entry, txn, lease, { transient: true })` legt keinen Entry an: der Änderungsstrom
trägt ihn als `put` mit `transient: true` (sofort, oder beim Commit von `txn`; ein Abort kündigt nichts an), und kein
`read`, `take`, `wait`, `count` oder Abo sieht ihn je. Gedacht für Ausgaben, die nur Leser des Stroms brauchen (eine
Nachricht auf einem Bildschirm): kein Eintrag, kein Ablauf, kein Abräumen danach. Wer den Space aus dem Strom
spiegelt, legt einen solchen `put` nicht ab; ein `del` folgt nicht. Nicht zusammen mit `unique`. `RemoteSpace`
verlangt das Feature `write.transient`.

**Die Datei verdichten.** `OwnStoreHost.compact()` gibt die freien Seiten der SQLite-Datei zurück (abgelaufene Claims,
entfernte Entries; ohne das wächst die Datei nur). Der erste Aufruf schreibt die Datei mit `VACUUM` einmal neu und stellt
sie auf inkrementelles Auto-Vacuum um, danach schneidet er nur die freien Seiten ab. Er läuft im Schreib-Thread zwischen
zwei Batches; Commits warten so lange. Ein Fehler dabei legt den Store nicht still, das Ergebnis trägt ihn
(`{ freedPages, converted, error? }`); ein Store im Speicher antwortet `null`.

**Mehrere Schritte in einem Aufruf.** `batch(ops, { request? })` (lokal und `RemoteSpace`, Feature `batch`) führt
Schritte in einem Commit unter einem Request aus, alle oder (wirft einer) keiner: `{ op: "begin", lease? }`,
`{ op: "write", entry, txn?, lease?, unique?, transient? }`, `{ op: "take" | "read", template, txn? }` und
`{ op: "commit" | "abort", txn }`. `txn: "$"` meint die Transaktion, die ein `begin` weiter vorn im selben Batch
geöffnet hat. Ergebnis je Schritt: eine `Lease` (begin, write), `{ entry, locked? }` (take, read; sie warten nie) oder
`null`. Jeder Schritt braucht das Recht, das sein eigener Aufruf bräuchte, mit denselben Typprüfungen; höchstens 64
Schritte. So kosten etwa die Schreibvorgänge einer Transaktion samt Commit eine Runde und einen Commit statt einen je
Schritt. Ein Space mit Merge-Typen (Entry-Replikation) bietet `batch` nicht an.

## Benannte Spaces und Hintergrunddienst

`createSpace(tx, alias, now)` erzeugt einen benannten Space im Harness-Commit;
`listSpaces(host, ctx)` listet Alias, `spaceId`, Inkarnation und Erzeugungszeit.
`startService(harness, ctx, { space? })` startet Reaper und lokale Event-
Zustellung. Ohne `space` überwacht es auch später erzeugte benannte Spaces.
Es setzt sich aus `startMaintenance` (Reaper) und `startDelivery` (Zustellung bei jeder Änderung, Wiederholung per Timer)
zusammen; `deliverEvents` führt einen Zustellungslauf aus und liefert die Anzahl. `ServiceOptions` enthält `now`, `onError`,
`retryMs`, `meter`, `space` und `watchDebounceMs` (fasst vom Watch ausgelöste Wartungsläufe zusammen; 0 ist der Standard).
Ereignisse gehen an Conversations: `EventSink` ist diese Schnittstelle, `ServiceHost` ein Store-Host, der sie optional
bietet, und `withEventSink(host, sink)` leitet die Ereignisse eines Space-Hosts an die Conversations eines getrennten
Agent-Hosts.

## Eigener Speicher

phi-spaces hält seine Dokumente selbst ([umstellung-ohne-pi-durable.md](../umstellung-ohne-pi-durable.en.md)). Alte
pi-durable-Speicher werden nicht übernommen (Entscheidung D6).

- `openSqliteHost(path, options?)` öffnet einen Host auf einer SQLite-Datei:
  - WAL-Modus, ein Schreib-Thread;
  - eine Besitzersperre in `path.owner`: ein zweiter Prozess erhält `StoreUnavailable`;
  - eine Datei, die kein phi-spaces-Speicher ist, wird ebenfalls mit `StoreUnavailable` abgewiesen.
- `openOwnMemoryHost()` hält alles im Speicher (Tests, Wegwerf-Spaces).
- `OwnSyncStore(path)` ist derselbe Speicher ohne Host. Ihn brauchen die Werkzeuge der
  primary/sync-Replikation. `primarySyncStorage(store, journal, peer, options)` macht daraus einen
  `ReplicatedOwnStore`, dessen `open()` den replizierten Host liefert.
- `OWN_SYNC_FACTORIES` sind die Fabriken dieser Spaces für `openSyncSpace` und `startConfiguredFederation`.

Ein Journal eines pi-durable-Speichers wird mit `PrimarySyncBlocked` abgewiesen.

## Revisionen und Seiten

`Page` enthält `{ items, next, token?, rev, streamId }`. Der opake Cursor `next` wird in
`readPage(..., { after: next })` eingesetzt; optional kann `token` explizit mitgegeben werden.
Alle Seiten lesen denselben unveränderlichen Snapshot, auch bei konkurrierenden Writes oder Lease-Ablauf.
Token-Bindung: Space/Strom, Owner, Template und Txn. TTL/Eviction/Host-Reopen → `SnapshotExpired`;
danach neue erste Seite lesen. Änderungen nach der Snapshot-Revision werden über `changes` aufgeholt.
`Changes` enthält `{ streamId, batches, next, rev, more }`, mit vollständigen Batches je Seite.
`ResponseBudgetTooSmall {requiredBytes}` verändert weder Cursor noch ACK-Stand.

## `RemoteSpace` und `SpaceService`

`RemoteSpace` implementiert die selben Kernmethoden über einen `Transport`.
`statsWithRevision()` liefert wie beim lokalen `PhiSpaces` die Kennzahlen mit der Revision und `streamId`, zu der sie
gelesen wurden; zwei Abfragen ergeben so die Commits dazwischen (das Dashboard leitet daraus „Commits/min“ ab).
Dazu kommen `info()` (die `hello`-Antwort), `probe`, `readPage`, `requestBound(call)` (ein vorbereiteter Aufruf mit Identität),
`requestGeneration()`, die Föderationsaufrufe `requestMembership`, `requestRouterLease`, `requestRoutingPolicy`,
`entryDescribe` und `entryChanges`, die Schlüsselaufrufe `authenticate()`, `enroll(token)` und `enrollStatus(request?)` sowie
`counters` (`{ retries, unknown }`, was die Verbindung bisher gekostet hat). `RemoteOptions` trägt unter anderem
`attempts` (5), `backoffMs` (100), `maxBackoffMs` (2.000) und `callTimeoutMs` (35.000).
`spaces()` listet die Spaces des Dienstes (`spaceId`, `alias`, `createdAt`). Über den Dienst trägt `statsWithRevision()`
zusätzlich `process: { cpuMs, rssBytes, heapBytes, at }`: CPU-Zeit und Speicher des Prozesses, der den Space bedient
(ältere Server lassen es weg).
`inProcessTransport(service, connection)` ist für lokale Tests;
`socketTransport({ path })` und `socketTransport({ host, port })` stellen
Unix- bzw. TCP-Verbindungen her. Der Server wird mit
`serveSpace(service, { listen: target, connection })` gestartet.
Mit `identifyOnConnect: true` beginnt die Identitätsauflösung schon bei TCP-Annahme;
ohne diese Option beginnt sie beim ersten Frame. `startGate` setzt die Option
immer und begrenzt die Peer-Erkennung auf standardmäßig fünf Sekunden. Damit
verbrauchen auch stumme identifizierte Sockets die Peer-Quota; ein hängendes
Directory schließt sie nach Ablauf. Die Schicht-B-Challenge gilt separat 30 Sekunden.
Die [finalen Betriebsgrenzen](../_attic/abnahme/ap2-gate4.en.md) gelten für das geprüfte Lastprofil.

Vor der Nutzung ruft `RemoteSpace` `hello` auf, eröffnet eine Generation und
gibt jeder Mutation eine Request-ID. Bei verlorener Antwort wiederholt er mit
derselben Identität. `OutcomeUnknown` heißt deshalb nicht, dass die Wirkung
fehlgeschlagen ist: mit `pollOperation` dieselbe Request-ID weiter verfolgen
oder gezielt `cancelOperation` verwenden.

### Client-Helfer (`src/space-client.ts`)

Was jeder Prozess braucht, der einen Space woanders nutzt; die Werte, die sich je Projekt unterscheiden, sind Parameter.

| Funktion | Inhalt |
| --- | --- |
| `cutText(text, max)` | die ersten `max` UTF-16-Einheiten, ohne ein halbes Emoji am Schnitt |
| `parseTarget(spec)` | `unix:/pfad`, `tcp:host:port` oder ein bloßer Pfad → `ListenTarget` (`parseListen` in `src/standalone.ts` ist dieselbe Funktion) |
| `connectSpace(spec, { callTimeoutMs = 30 s, connectTimeoutMs = 5 s, attempts = 3, … })` | `{ space: RemoteSpace, close }`; die Socket-Anfrage darf 5 s länger dauern als der Aufruf |
| `readExisting` / `takeExisting(space, tmpl, waitMs, { txn })` | `readIfExists`/`takeIfExists`, das ein fehlendes von einem gehaltenen Entry unterscheidet: `null` heißt weg, ein Fehlschlag nur wegen gehaltener Treffer wirft `StillHeld` (über `probe`; ohne `probe` gilt `null` als weg) |
| `peek(space, tmpl, { txn })` | Der erste Treffer als Schnappschuss (`readAll` mit `limit: 1`), ohne Claim |
| `takeAll(space, tmpl, { txn })` | Nimmt jeden jetzt freien Treffer, liefert die Anzahl (ein `take` je Entry; gehaltene bleiben) |
| `awaitWork(space, tmpl, waitMs, halt?)` | Ein blockierendes `read` ohne Transaktion: `true`, sobald Arbeit da ist; `false` nach Ablauf oder `halt` |
| `keepAlive(space, lease, leaseMs)` | Erneuert eine Lease alle `leaseMs / 3`, solange lange Arbeit darin läuft; liefert die Stopp-Funktion |

Der Service akzeptiert die Methoden `hello`, `generation`, `write`, `read`,
`take`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `spaces`, `txn`,
`lease`, `changes`, `wait`, `notify`, `events`, `ack` und `batch` (`METHODS`). `spaces` listet die Spaces des Hosts (`spaceId`, `alias`, `createdAt`), auch die zur Laufzeit
angelegten; die Rolle `observer` darf es. Mutationen benötigen `{ generation, requestId }`.
`read` und `take` können `{ state: "pending" }` zurückgeben und werden über
`pollOperation` fortgesetzt. `readAll` ist der paginierte Seitenaufruf.

`wait`, `notify`, `events` und `ack` sind implementiert und richten sich an die eigene
Consumer-Mailbox (`target: "self"` oder eigener `hello.principal`). `events({ mailboxEpoch?, after?, maxBytes?, waitMs? })` liefert
`{ mailboxEpoch, events, next, more, gap? }`; `ack(epoch, upTo)` bestätigt einen
ausgelieferten Präfix. Nach Epochwechsel mit dem gelieferten neuen Cursor fortsetzen.
Ein zugestellter Take trägt eine eigene Txn; sie wird ausdrücklich committet/abgebrochen.

`withSpaceService(existingServerServices, service, trustedConnection)` erweitert den vorhandenen
pi-server um `serviceId: "space"`. Der Client verwendet
`piServerTransport(call => client.request({ serverId }, call))`. Im Nachbarprojekt
wird Space-RPC mit `PI_SERVERD_SPACE_PRINCIPAL` und `PI_SERVERD_SPACE_ROLES` ausdrücklich aktiviert.
Eine vom Client geschickte Identität überschreibt den vertrauenswürdigen Connection-Kontext nicht.

Der Dienst authentisiert über `IdentityAdapter`, nicht über vom Client
übermittelte Principals. `Policy` beschränkt Methoden und Entry-Typen je Rolle.
Ein Typ-Grant gilt auch für Subtypen: Ein Write ist erlaubt, sobald der Typ oder einer der
deklarierten Supertypen freigegeben ist. Da der Schreibende die Supertypen selbst angibt, kann eine
Rolle mit Grant auf `Job` auch `{ type: "X", types: ["Job"] }` schreiben. Typ-Grants sind damit
keine Integritätsgrenze für Subtypen; wer einem Typ vertrauen muss, braucht eine Federation-Typ-Policy
mit festen Supertypen oder eigene Prüfungen der Felder.
`StaticIdentity` ist ein lokaler Konfigurations-/Testadapter. TCP allein bietet keine
Föderationsauthentisierung; die verbindungsgebundene Overlay-/Challenge-Schicht
liefern `startGate` (Schicht A) und `ProvingService` (Schicht B), zusammengesetzt von `startFederationHost`.

## Fehler und Grenzen

`IllegalArgumentError`, `PermissionError`, `TransactionError`, `LimitError`
`CompletionViolation`, `MailboxEpochMismatch`, `InvalidAck`, `ResponseBudgetTooSmall`,
`UniqueConflict` (ein `write` mit `unique`, dessen Schlüsselfelder schon ein Entry des Typs trägt; Code `UniqueConflict`),
`SnapshotExpired`/`RevisionAhead` (ein `changes`-Cursor außerhalb der gehaltenen Historie)
und `ResourceExhausted` beschreiben lokale Semantik bzw. Budgetverletzungen.
Der Dienst serialisiert sie als Fehlercodes; der Remote-Client rekonstruiert
bekannte Fehlerklassen als `RemoteError` oder die spezielle lokale Klasse.
Ein maximaler Client-Wartezeitraum löst `OutcomeUnknown` aus, lässt die
Host-Operation aber weiterlaufen. Nicht klassifizierte Fehler kommen als `Internal` mit der festen Meldung
`internal error` an; den eigentlichen Fehler protokolliert nur der Host (`console.error`).
`ResponseBudgetTooSmall` und `StalePolicyVersion` sind keine Exporte der Paketwurzel; sie
kommen über den Namensraum `core` oder `phi-spaces/core`. `UnsupportedOperation` wirft `RemoteSpace`, wenn dem Server ein
verlangtes Feature fehlt.

Die API garantiert keine FIFO-Auswahl und keine Exactly-once-Ausführung
außerhalb atomarer Space-Mutationen. Anwendungen müssen externe Effekte über
eine eigene Idempotenz-ID oder eine gemeinsame Transaktion absichern.

## Phase-1b-Laufzeit und Grants

`startFederationHost(harness, context, options)` startet die persistente Komposition
von Gate, Schicht A/B, Control-Berechtigungen, Enrollment, Rotation, Supervisor und
Wartung. `options` enthält `hostId`, `authorityId`, `keys`, `verifier`, Gate-Konfiguration
und `boot: { external, installed }`. Nur die Control-Seite setzt
`control: { host: harness, authority }`. Ohne Boot-Register/Installation scheitert
der Start; `unsafeSkipBootGuardForTests` ist ausschließlich für Fixtures.

`GrantAuthority.issue(connection, purpose)` benötigt eine frische Overlay-Identität,
einen provisionierten Signer und das aktuelle Schlüsselverzeichnis. `purpose` ist
`effect` oder `resolution`. `GrantVerifier.check(token, identity, call, connection)`
prüft Signatur, Principal, bewiesenen App-Schlüssel, Scope, Authority und Frist.

Ein `RemoteSpace` erhält über `grantProvider(call)` vor jedem fachlichen Aufruf
und jedem Retry einen aktuellen Grant; dieser Frame verändert weder fachliche
Argumente noch Request-Identität. Die Control-Verbindung bietet:

- `requestGrant(purpose = "effect")`
- `lookupPeerKey(peerId, keyId)` für bewiesene Hosts/Admins
- `rotationChallenge(algorithm, publicKey)`
- `rotateKey(challenge, replacementSigner)` mit alter und neuer Signatur
- `rotationStatus(commandId)` für das eigene Ergebnis

Eigene Rotation verwendet einen eigenen Generation-Aufruf und funktioniert auch
bei einem auf Data-Spaces beschränkten Schlüssel; dadurch werden keine Control-
Entries freigegeben. Alte Schlüssel werden atomar widerrufen, Rollen und Scope
übernommen. Grants und eine erfolgreiche Rotation sind keine Nachweise externer
Exactly-once-Wirkung.

Die Recovery-Exporte (`SqliteRecoveryRegister`, `RecoveryCoordinator`,
`installAuthorityTransition`, `installBootGuard`, `beginRestore`, `restoreBatch`,
`completeRestore`, `releaseRestored`) sind Bausteine für einen administrativen
Pfad. Fencing, Admission-Sperre, Registry-Update, Control-ACK und Boot-Installation
muss der aufrufende Dienst nachweisen. Näheres und offene Verdrahtung stehen in
[ap1b-abnahme.md](../_attic/abnahme/ap1b-abnahme.en.md).

## Provisionierter Betrieb und privater Recovery-Zugang

`startConfiguredFederation(host, ctx, privateConfigFile)` prüft private
Schlüssel-/Konfigurationsdateien, den Besitz der Listen-IP laut NetBird,
externe Autorität und Boot-Berechtigung. Die zurückgegebene `service` dient dem
nativen pi-server-Adapter: ihre Peer-ID und Gruppen werden serverseitig pro
Aufruf neu bestimmt. `trustedConnection()` erzeugt den zugehörigen Kontext;
`close()` beendet Gate, Supervisor, Wartung und eigene Register-Verbindungen.
Konfiguration und SSH-Endpunkte sind in [ap1b-betrieb.md](../_attic/abnahme/ap1b-betrieb.en.md) erklärt.

- `provisionFileSigner(path, algorithm)` erzeugt einmalig einen privaten
  Desktop-/Dienstschlüssel; `loadFileSigner(path)` lädt ihn ohne Ersatzidentität.
- `serveRegister(register, socket, { writable })` trennt Reader und Operator;
  `SocketRecoveryRegister` und `SshRecoveryRegister` erlauben Member-Lesezugriff.
- `serveRecovery({ path, hostId, operator, supervisor?, handle })` verlangt
  signierte, zeitlich begrenzte Anfragen für das festgelegte Host-Ziel.
  `RecoveryClient.call(method, args, requestId?)` sendet diese Anfragen. Ein exakt wiederholter signierter
  Call bekommt innerhalb seines Gültigkeitsfensters die erste Antwort, ohne dass der Handler erneut läuft;
  ein neu signierter Call mit derselben `requestId` wird normal ausgeführt.
- `RecoveryController.submit(request)`, `advance(recoveryId)`,
  `status(recoveryId)` und `release({ commandId, recoveryId, scope })`
  bilden einen journalisierten Data-Restore. `dataRecoveryHandler(controller)`
  bindet ausschließlich diese Methoden an den privaten Dienst.
- `verifySshFence(register, hostId, targets)` verlangt über einen fest
  provisionierten SSH-Zugang einen gestoppten Dienst und eine dauerhafte
  Wiederanlaufsperre; Sync-/Replikat-Konfigurationen werden verweigert.

Der Recovery-Controller benötigt privilegierte `commit`-/`snapshot`-Funktionen
desselben Harness, die vor Installation des normalen Boot-Guards gebunden
werden. Ein zweiter gleichzeitig geöffneter Harness ist dafür kein Ersatz.
Diese Funktionen und die schreibende Register-Capability bleiben ausschließlich
im privaten Recovery-Dienst. Der Snapshot-Lader und der tatsächliche dauerhafte
Control-ACK-Kanal werden ausdrücklich administrativ bereitgestellt. `ControlRecoveryController` und `MemberTransitionInstaller` implementieren den
Control-/Member-Ablauf; `startRecoveryOnly` bindet ihn an einen eigenen privaten
Dienst unter exklusivem Harness-Besitz, ohne normalen Gate-/Agentenstart.
Verteilte Live-Data-/Control-Restores mit bestätigten Member-ACKs sind nachgewiesen
([Implementierungsstand](../implementierungsstand.en.md), Phase 1b).

- `TlsRecoveryRegister` / `serveTlsRegister`: unabhängiges Register mit gepinntem
  CA-Vertrauen und freigegebenen Client-Zertifikaten; Reader, explizit begrenzte
  `writeKeys` und Operator-CAS werden serverseitig getrennt.
- `ControlAckService.acknowledge(tuple, requireHostKey?)`: dauerhafter Receipt für
  die registrierte Data-Transition; aktuelle Authority-/Boot-/Transition-Versionen
  und bei Host-Signatur der weiterhin aktive eingeschriebene Schlüssel werden im
  Commit erneut geprüft.
- `MemberTransitionInstaller.advance(proof)`: gestoppter Normalbetrieb mit
  Neustartsperre, begrenzte Bereinigung, historische Pending-Claims, ungültige
  Generationen, `orphanedAfterRestore`, Epoche 1 und lokales/externes ACK. Ein nach
  lokalem ACK verlorener externer ACK wird beim Retry erneut veröffentlicht.
- `ControlRecoveryController.submit(request)`, `advance(recoveryId)`,
  `authorizeKey(recoveryId, key)` und `status(recoveryId)`: Import mit neuer
  Authority, geschlossenen alten Rechten, erster expliziter Admin-Freigabe,
  bestätigten Member-ACKs und Ablauf der alten Grant-/Lease-Frist.
- `controlRecoveryHandler(controller, member)` akzeptiert nur den gepinnten
  Recovery-Operator. `startRecoveryOnly(host, ctx, configFile, assertQuiesced)`
  startet dafür ausschließlich den privaten Socket.
- `startMemberRecoveryOnly(host, ctx, configFile, assertQuiesced)` startet den
  ausschließlich für OP-signiertes `installAuthority` vorgesehenen Member-Socket.
  Die Konfiguration enthält einen öffentlichen `operator`-Pin und einen
  `registerTls`-Zugang mit Schreibrechten nur für den eigenen Boot-/ACK-Eintrag;
  private OP-/Control-Signierschlüssel sind nicht erforderlich. Normalbetrieb
  muss gestoppt und persistent gegen Wiederanlauf gesperrt sein.

## `RouterController` (AP 2.1)

```ts
const router = new RouterController({
  host: harness, ctx, routerId, authorityId,
  target: idempotentRpcTarget,
  assertAuthority: verifyCurrentRouterOwnership,
});
await router.recover();
await router.submit({ id, area, blocksArea: false, steps });
const state = await router.advance(id);
```

`steps` enthalten unveränderliches Ziel `{hostId, spaceId, authorityId,
dataIncarnation, primaryEpoch}`, Principal, Generation, RPC-Methode, Argumente
und optional `resultBudgetBytes`. Der Controller vergibt stabile Unterrequest-IDs;
Zieladapter müssen sie unverändert als RPC-`requestId` verwenden.

| Methode | Wirkung |
|---|---|
| `recover()` | Rekonstruiert Bindings und Reservierungen; löst alte Unterrequests auf, sendet keine neue Wirkung |
| `submit(spec)` | Persistiert einen Command; dieselbe ID mit anderen Argumenten ist `RouterConflict` |
| `advance(id)` | Führt gebundene Schritte weiter; ungelöste Transporte bleiben `applying` |
| `get(id)` | Liefert aktuellen Command einschließlich Teilresultaten und Review-Nachweisen |
| `ingest(spec, ack)` | Dauerhafte deduplizierte Aufnahme vor Mailbox-ACK |
| `reconcileDataRestore({hostId, spaceId, oldIncarnation, recoveryId})` | Persistiert Restore-Reviews unter Beibehaltung historischer Resultate |
| `review(id, admin, note, releaseArea, authorize)` | Separater autorisierter Audit; verändert `needsReview` nicht in Erfolg |

`RouterBlocked` sperrt fehlende Rekonstruktion/Autorität oder abhängige Bereiche;
`RouterBudgetExceeded` verweigert neue Arbeit vor Wirkung. `RouterTarget` ist
bewusst ein Adaptervertrag. Produktive RouterLease/Delegation ist AP 2.2.
Details und Simulator: [AP 2.1/2.8](../_attic/abnahme/ap2-router-und-simulator.en.md).

## Federation-Controller (AP 2.2–2.5)

`createFederationController` verbindet `RouterController`, `FederationRpc`,
`FederatedSpace`, `FederationPolicyAuthority` und `MembershipController`.
`renewableRouterLease` betreut den signierten Lease. Die Root-Komposition
führt den `lease`-Callback außerhalb von Journal-Commits aus; dort darf eine
Erneuerung den Control-Host selbst verwenden. Innerhalb eines Journal-Commits
prüft sie den bereits bezogenen Lease und die aktuellen Control-Zähler erneut.
Ein abgelaufener oder ersetzter Lease wird weiterhin abgelehnt. Liegt der
Control Space in einem primary/sync-Hauptstore, liefert `controlEpoch` die
Control-Epoche aus dem Journal; Wächter und Lease-Erneuerung vergleichen dann
diese statt der Epoche des Space-Dokuments. `alignControlReplicaIn` führt beim Start den Policy-Schritt der
letzten Control-Transition aus (`lastConfigTransition`, Marker `ControlReplicaMarker`); `RemoteSpace.sendEpochNotice`
überbringt die `EpochNotice` eines Supervisors. Der separat
injektierte `assertAuthority` bleibt eine reine Autoritätsprüfung; er darf
keinen verschachtelten Commit auf demselben Host anfordern. `MemberLifecycle` installiert
signierte Control-Anweisungen; `startConfiguredFederation` aktiviert dies mit
`membership: {memberId, spaceId}`. Diese APIs gehören zum serverseitigen Router;
sie ersetzen nicht die Signaturen des bestehenden `RemoteSpace`.

Optional provisioniert `journalPartitions` (1 bis 1024, Standard 1) feste,
persistente Parent-/Router-Partitionen. Die Rückgabe enthält zusätzlich
`partitionRouters`; `router` bleibt der gemeinsame Control-Router. Die Anzahl
und IDs sind nach Initialisierung unveränderlich. Bestehende Historie wird
nicht automatisch migriert, und alte Request-IDs werden nicht verworfen.
Jede Partition behält die bisherigen Einzelbudgets; die Gesamtreservierung
wächst mit der festgelegten Anzahl. Der Default bleibt kompatibel mit alten
Ein-Journal-Beständen. Direkte `FederatedSpace`-Komposition verlangt passend
viele unterschiedliche `partitionRouters` sowie `initializeJournals()` vor dem
Betrieb; alle Router müssen vorher rekonstruiert sein. Die Factory übernimmt
die Initialisierung und Rekonstruktion vor ihrer Rückgabe. Cross-Partition-
Transaktionen lesen ihre ursprüngliche Child-Bindung aus der Ursprungspartition.

Restore setzt vor dem ersten Abgleich eine persistente Gesamtsperre und hebt
sie erst nach allen Partitionen auf. Ein unterbrochener Abgleich wird mit
demselben Restore-Tupel fortgesetzt. Die Mitgliedsentfernung berücksichtigt
das Manifest und sämtliche zugehörigen Router-/Parent-Referenzen.

Parameter, Rückgaben, Rechte, Budgets und Grenzen:
[Delegation, Routing und Membership](../_attic/abnahme/ap2-delegation-routing-membership.en.md).

## Directory und lokale Admin-Bausteine (AP 2.6/2.7)

`RemoteSpace.publishCapability(report)` veröffentlicht einen `CapabilityReport`
über den geschützten Control-RPC `capabilityHeartbeat`. Der Report enthält
`hostId`, `resources`, `tools`, `models` und `metrics`. Aktueller Host-Key,
Host-Rolle, Grant und eine passende Peer/Host-Bindung sind erforderlich.
Lease und Zeitstempel legt der Empfänger fest: 120 Sekunden bzw. seine Uhr.
Normales `write`, Take, Txn-Locking und Lease-Änderungen an Directory-Entries
stehen Clients nicht zur Verfügung, auch nicht über Supertypes.

`CapabilityDirectory.heartbeat(report, authenticatedIdentity)` ist die interne
Host-API; ihre Identität muss vom bewiesenen Verbindungszustand stammen.
`MemberStatusDirectory.refresh()` übernimmt aktuelle, an den Ziel-Tupel
gebundene Probes. `start()` erneuert sie alle 15 Sekunden und liefert einen
asynchronen Stopper. Status-Lease: 30 Sekunden. Fehlgeschlagene oder veraltete
Probes entfernen Kapazitäts-/Capability-Beobachtungen aus der Routing-Tabelle.
Directory-Veröffentlichung registriert keinen Routing-Member.

Die provisionierte Runtime-Konfiguration `capabilities` kann `dataSpaces`,
`tools`, `models` und im Control `hostBindings` enthalten. Letzteres ordnet
technische Peer-IDs den eigenen Host-IDs zu. Die Runtime veröffentlicht nur
bei dieser expliziten Konfiguration automatisch, im Abstand von 60 Sekunden.
Lesen erfolgt über `readAll({type:"Capability"})` bzw. das vorhandene
`space_list`, innerhalb des eigenen Space-Scopes.

`DataAdminController.execute(commandId, kind, spaceId, admin, input)` akzeptiert
`kind = "purgeTasks" | "deletePrincipal"`. Input ist ein Task-Template bzw.
ein strukturierter Principal. Die vom Betreiber bereitgestellte `authorize`
prüft den gesonderten Scope pro Kind/Space; `assertAuthority` prüft die aktuelle
Autorität. `spaceId` muss die unveränderliche Space-ID sein; Aliasnamen werden
abgelehnt. Beide Prüfungen laufen erneut im Commit. Jeder erfolgreiche Batch und
sein Fortschritt sind atomar; dieselbe Command-ID mit verändertem Inhalt wird abgelehnt.
Ein im Control-Runtime provisionierter `dataAdmin` bindet die Supervisor-
Commands mit `args.spaceId` und `args.template` bzw. `args.principal` ein.

`purgeTasks` akzeptiert nur profilierte, unreservierte Tasks. `deletePrincipal`
setzt zunächst einen ruhenden lokalen Space voraus. `execute` verarbeitet
den Löschlauf in begrenzten Commits bis zum Abschluss. Alternativ starten
`startDeletion(commandId, spaceId, admin, principal)` und
`advanceDeletion(commandId, spaceId, admin, principal)` einen Lauf bzw. genau
einen Batch; das Ergebnis enthält Phase und Batch-Anzahl. Derselbe Command
setzt nach Neustart oder verlorener Antwort fort. Währenddessen blockiert
eine persistente Space-Sperre neue Wirkungen und Objektabfragen. Ein geänderter
Ziel-Tupel verlangt Review. Remote-Members und Router-Historien werden damit
noch nicht gelöscht.

`FederatedSpace.reconcileDataRestore({hostId,spaceId,oldIncarnation,recoveryId})`
markiert Child-Requests und Parents `needsReview`, ohne neue Wirkungen.
Es muss als Reconciliation-Hook vor der Control-Restore-Bestätigung eingebunden
werden. Verwaltete Spaces erhalten ohne diesen Hook kein Control-Receipt.
[Abnahmestand und Grenzen](../_attic/abnahme/ap2-abnahme.en.md).

`PhiSpaces.resolveOperation` erhält einen `RequestRef` einschließlich Principal;
`RemoteSpace.resolveOperation` erhält `{generation, requestId}` und verwendet
die authentifizierte Identität. Methode und Hash bezeichnen die ursprünglichen
normalisierten Claim-Argumente (`write`, `take`, `txn.begin` usw.). Der neue
Wire-Aufruf verlangt bei Delegation eine signierte `targetRequest`-Referenz
mit denselben Bindungen. Die lokalen Kontroll-/Admin-Prüfungen werden auch bei
der Auflösung wiederholt. Eine signierte Generation enthält jetzt ihre
Ausstellungs-Primary-Epoche; ältere Generationen bleiben für vorhandene Claims
kompatibel, erlauben aber keinen neuen Fehl-Claim-Nachweis.

`AdmissionResolution.state === "notAdmitted"` bedeutet ausschließlich, dass
der identische Request beim unveränderten Primary erneut gesendet werden
kann. Die Antwort ist kein terminales `NotCommitted` und erlaubt keine
Ersatz-ID. Bekannte Claims liefern weiterhin `pending`, `done` oder `cancelled`
mit bisherigen Retention-/Restore-Markierungen. Für alte Members ohne
`resolveOperation` fällt der Router auf `pollOperation` für bekannte Claims
zurück; ein unbekannter Ausgang bleibt dort konservativ `needsReview`.


### Native Root- und Verwaltungsbausteine (2026-10-14)

`startConfiguredFederation` akzeptiert im Control-Modus optional `root` mit
festem Root-ID, getrennten `keyFile`/`hostKeyFile`, privatem `leaseFile`,
`journalPartitions` und provisionierten `members`. Ein Member bindet sein
Zieltupel, Peer-ID, App-Key-Pin und seine Overlay-Adresse. `createConfiguredRoot`
prüft die unabhängige Boot-/Control-Autorisierung und aktive Schlüssel; es liefert
die serverseitigen Federation-Controller sowie `close()`. Mit
`allowMembershipCommands` und `adminPeer` verarbeiten die echten Supervisor-
Handler Membership- und Profilbefehle im autorisierten Admin-Kontext.
Dies erzeugt keinen öffentlichen virtuellen Root-Space-RPC-Endpunkt.

`ProfileTransitionController.execute(id, nextPolicy)` ersetzt ausschließlich
Abschlussprofile bei um eins erhöhter Policy-Version. Offene Root-Aufträge,
Transaktionen und Membership-Wechsel verhindern den Start. `start` und `advance`
erlauben einzelnen, dauerhaft journalisierten Fortschritt; dieselbe ID bindet
dieselbe Policy. Members werden eingefroren, umgestellt und erst nach
Veröffentlichung der neuen Policy aktiviert. Der Supervisor-Command heißt
`migrateProfiles`, mit `args.policy`; der Controller muss provisioniert sein.
Gewöhnliche `setPolicy`-Änderungen bestehender Profile bleiben gesperrt.

`RootHistoryErasure` entfernt unter separater Operator-Autorisierung und
nachgewiesenem exklusiven Fencing Principal-Inhalte aus Root-Parent-/Child-
Historien. Erfasste Entry-Digests schließen betroffene fremde gecachte Ergebnisse
ein. Alte Request-IDs bleiben gebunden und liefern `ResultExpired`; sie werden
nicht für neue Wirkungen freigegeben. `DataAdminController` bleibt für die
lokalen Data-Inhalte zuständig. Ein vollständiger verteilter Löschlauf entsteht
nicht allein durch diese beiden Bausteine.

`ErasureArchiveController` verlangt Operator-Autorisierung, eine
`destroy`-Funktion und eine unabhängige `verifyDeletion`-Prüfung. Es registriert
Archive, beginnt eine Lösch-Epoche, quarantänisiert ältere Archive, verarbeitet
Löschfristen und versiegelt die Epoche nach geprüftem lokalem Abschluss.
`assertRestore(spaceId, artifactId)` prüft Katalog und aktuelle Epoche; der
Restore-Aufrufer muss zusätzlich die tatsächlichen Archivbytes an den
registrierten Hash binden. Unvollständige Löschungen, alte Snapshot-Epochen und
überfällige Archive sperren normale Dienste durch den unabhängigen Register-
Eintrag. `SqliteRecoveryRegister` prüft Lösch-Epoche und Archivkatalog atomar
innerhalb des CAS-Commits, auch hinter mTLS: Epochen beginnen bei eins, steigen
nur nach abgeschlossenem vorherigem Löschlauf einschließlich Archivlöschung,
und behalten Command-Hash und Löschfrist. Archiv-IDs, Hashes, Epochen und Arten
sind unveränderlich; Quarantäne und Zerstörung sind nicht rücksetzbar. Eine
verspätete Registrierung eines alten Backups scheitert am aktuellen Floor.
Die vollständige Backup-/Restore-Betriebsintegration steht noch aus.
Andere `RecoveryRegister`-Implementierungen müssen dieselben atomaren
Constraints garantieren; reine Aufruferprüfungen reichen dafür nicht aus.


### Frische Prüfungen und gebundene Claim-Antworten

`RecoveryRegister.getMany(keys)` ist optional. TLS-Clients aktivieren den bounded
Batch-Aufruf ausdrücklich mit `batchReads: true`; höchstens 32 eindeutige Schlüssel
werden pro Batch gelesen. Jeder Batch eröffnet eine neue gegenseitig authentifizierte
TLS-Verbindung. Ohne Opt-in bleiben Einzelabfragen erhalten. Ein `unixPath`-Transport
verlangt einen absoluten Socketpfad und einen explizit gepinnten TLS-Servernamen.

`SpaceKeyDirectory.findMany(keys)` und `inspect(keys)` lesen jedes Mal einen normalen,
geschützten Control-Snapshot. `inspect` liefert dessen Zustand und daraus abgeleitete
Schlüssel gemeinsam; es speichert weder Zustand noch Authentifizierung für Folgeaufrufe.

`RemoteSpace.requestBoundWithClaim(call)` verlangt zusätzlich zum normalen Ergebnis
optional einen gebundenen Claim-Beleg. Der Dienst löst dafür den tatsächlich gespeicherten
ursprünglichen Claim auf; der Router prüft Host, Space, Authority, Incarnation, Epoche,
Principal, Generation, Request-ID, Methode und Argumenthash. Das rohe RPC-Ergebnis
ersetzt diesen Beleg nicht. Fehlt er bei einem älteren Dienst, bleibt eine getrennte
Claim-Auflösung erforderlich. Wiederhergestellte, abgelaufene oder widersprüchliche
Ergebnisse führen weiterhin zu Review.

`RouterStepSpec.generationAdmitUntil` hält die bestätigte Zulassungsfrist fest. Eine
Transaktionsfolge darf die ursprüngliche Generation nur innerhalb dieser Frist und
bei identischer Bindung verwenden. Das ersetzt keinen App-Key-Beweis, Grant oder
Delegationsnachweis. Fehlende Fristen in älteren Journaleinträgen führen zum bisherigen
frischen Generation-Aufruf.

### Verteilte Principal-Löschung und SQLite-Historien

`DistributedPrincipalErasure({register, archives, driver, authorize})` besitzt
`advance(plan)` und `execute(plan)`. Ein Plan bindet `id`, `principal`, bis zu
32 eindeutige Space-Zieltupel mit genau einem Root und `retentionMs` (maximal
24 Stunden). Die Fortschrittsadresse lautet `erasure-command:<id>` im
unabhängigen Register. Geänderte Argumente unter derselben ID werden
abgewiesen. Die aktuelle Sammelgrenze beträgt 4096 Entry-IDs (je höchstens 256 Zeichen);
eine Überschreitung stoppt den Command unter den bestehenden Sperren.
Driver-Aufrufe müssen für dieselbe Command-Bindung wiederholbar
sein und exklusiv gestoppte Writer nachweisen. Vor jedem Wartungsschritt
werden alle Sperren geprüft; Freigabe setzt alle versiegelten Floors voraus.
Die CLI [run-distributed-erasure.ts](../../test/testbed/run-distributed-erasure.ts)
bindet dies für den eigenen Testverbund an echte Prozesse, lokale Löschbelege,
Archivdateien und die unabhängigen mTLS-Registereinträge.

`compactErasedSqlite(path, assertExclusiveFenced)` (in `src/erasure-sqlite.ts`, kein Paketexport) bereinigt einen gestoppten
eigenen SQLite-Speicher nach einer Löschung. Der Speicher hält keine
Revisionshistorie. Bytes gelöschter Zeilen können aber in freien Seiten und im
WAL bleiben. Der Aufruf nimmt die Besitzersperre, schreibt die Datei mit
Secure-Delete und VACUUM neu, leert das WAL und prüft die Integrität.
Abgewiesen werden:

- Symlink-Dateien;
- ein laufender Host (er hält die Sperre);
- jede Datei, die kein phi-spaces-Speicher ist. Das gilt auch für alte
  pi-durable-Speicher (Entscheidung D6).

Der Aufrufer muss die logische Principal-Löschung bereits abgeschlossen haben
und den exklusiven unabhängigen Fence während des gesamten Aufrufs halten. Es
ersetzt keine Löschregel für externe Kopien.


## Entry-Replikation: administrativer Phase-3-Baustein

`EntryReplicationController` verwendet ein eigenes Dokument, keine automatische
Replikation bestehender `PhiSpaces`-Entries. Konfiguration, Aufrufmethoden,
Vertrauensgrenze und Betriebsbeschränkungen stehen in
[Phase 3](../_attic/abnahme/ap3-replikation.en.md). Die exportierten HLC-Funktionen sind
`advanceHybridClock`, `compareHybridClock` und `validateHybridClock`. Die Uhr
muss atomar mit der Änderung gespeichert werden; der Controller übernimmt dies.
`EntryReplicas` ist eine interne administrative Dokumentfamilie und kein
unautorisierter RPC-Importpfad. Über den `space`-Dienst gehen Merge-Typen (`SpaceServiceOptions.merge`) mit
`write`, `read`, `readAll` und `count`; `lease cancel` löscht und `lease renew` erneuert die sichtbare Version
(nur ihr Owner; die Antwort von `renew` nennt die neue ID). `changeForRequest(requestId)` liefert die eigene
Änderung zu einer lokalen Request-ID für Retries. Primary/Standby und Promotion werden dadurch nicht bereitgestellt.


### Gepagter Snapshot-Import

`EntryReplicationController.startSnapshot` und `snapshotPage` exportieren eine
bei R eingefrorene Historie. `beginSnapshotImport`, `importSnapshotPage`,
`snapshotImportStatus`, `finishSnapshotImport` und `abortSnapshotImport`
verwalten dauerhafte Seiten und den Import-Cursor. Erst der Abschluss macht alle
Seiten atomar sichtbar. `sourceRevision` im Abschlussresultat nennt den Startpunkt
für danach entstandene Änderungen. Grenzen, Wiederaufnahme, Abbruch und
Vertrauensbereich: [Snapshot-Transfer](../_attic/abnahme/ap3-snapshot-transfer.en.md).


### Dauerhafter Entry-Stream

`describeStream`, `streamChanges`, `startStreamImport`, `streamImportStatus` und
`importStreamPage` binden den fortlaufenden Austausch an eine feste Quelle. Import
und Cursor-Fortschritt sind atomar. `EntryReplicationPump` bietet einen begrenzten
Schritt und eine explizit gestartete, abbrechbare Pull-Schleife. Pro Quelle bleibt
die letzte Bereichsquittung wiederholbar; ältere Bereiche erfordern ein erneutes
Lesen des Checkpoints. Adapter, Rückgabewerte und Grenzen stehen im
[Stream-Protokoll](../_attic/abnahme/ap3-stream-transfer.en.md). `SpaceService` bietet diese administrativen
Methoden nicht an (`METHODS`). Ein Federation-Host mit `entryExport` beantwortet `entryDescribe` und `entryChanges` vor
dem Dienst; `RemoteSpace.entryDescribe()` und `entryChanges(after, maxBytes)` sind die Clientseite.


### Administrative Replikationspflege und synchroner Storage

`EntryReplicationController.startSnapshotMaintenance(id, pageBytes?)`,
`advanceSnapshotMaintenance(id)` und `snapshotMaintenanceStatus()` kopieren und
veröffentlichen einen vollständigen Präfix und stilllegen anschließend alte
Chunk-Dokumente. `forgetSnapshotReceipt(id)` entfernt nur abgelaufene, nicht mehr
lebende Belege. Origin-/Request-/Konfliktinformationen und Cursor bleiben erhalten.
[Details](../_attic/abnahme/ap3-snapshot-maintenance.en.md).

Kompaktierung (lww/set Schritt 4): `compactionStatus()` nennt Blockadegrund, Ereigniszahl, entfernbare Ereignisse
und Untergrenze; `compact(id)` führt eine Kompaktierung vollständig aus, `startCompaction(id, pageBytes?)` startet
sie als Wartungsgeneration (weiter mit `advanceSnapshotMaintenance`, Abbruch beim Kopieren mit
`abortSnapshotMaintenance`). `recordPeerVector(description)` speichert den
Vektor, den ein Peer in `describeStream()` meldet; `EntryReplicationPump` ruft es selbst auf. Option
`requestRetentionMs` (Standard 24 Stunden) hält eigene Änderungen für Retries. Stream-Seiten tragen `positions`,
wenn sie nicht lückenlos sind. [Regeln](../_attic/abnahme/ap3-replikation.en.md).

`PrimarySyncJournal`, `primarySyncStorage`, `recoverPrimarySync` und
`materializeSyncHistory` bilden den administrativen synchronen Storage-Pfad.
Er besitzt feste Konfigurationspins, dauerhafte Hashkette, Standby-ACK und
atomare Datenmarker; ein unklarer versiegelter Kandidat liefert `CommitSealed`. Im Dienst wird daraus der
Fehlercode `CommitSealed`, im Client `CommitSealedPending` (Unterklasse von `OutcomeUnknown`); `sealedResolver`,
`sealedCandidateOf` und `SyncSpace.resolve()/unserve()` klären den Kandidaten im laufenden Host
([Ablauf](../_attic/abnahme/ap3-primary-sync.en.md)). Nach einer Promotion beantwortet `resolveOperation` einen unbekannten Request
älterer Epoche mit Nachweis (`promotionEvidence`, Dienstoption `promotionProof`) per Negativclaim mit `NotCommitted`
(`claims.decideNotCommitted`, `PhiSpaces.resolveNotCommitted`, Fehlerklasse `claims.NotCommitted`).
Diese Bausteine allein aktivieren keine Sync-Policy; Übergänge und Promotion stehen unten.
[Vertrauensbereich und Betriebsgrenzen](../_attic/abnahme/ap3-primary-sync.en.md).

Konfigurationswechsel sind Einträge der Kette (`applyConfigTransition`,
`recoverSealedWithoutStandby`, `PrimarySyncJournal.catchUp`; `durabilityOf(config)` liest die Dauerhaftigkeit,
`lastConfigTransition` den letzten Wechsel). Darauf bauen
`degradeToSingle`, `promote` und `setStandby` mit `FencingAdapter`
(`SimulatorFencing` nur mit `allowSimulator`, `unconfiguredFencing` als Platzhalter),
`fenceHostBoot`, `revokeSpacePermit` (degradeToSingle mit `revokeStandbySpace`), `releaseHostToQuarantine` sowie `assertSyncPrimary`,
`assertSyncStandby` und `assertQuarantine` auf. Fehlgeschlagene Übergänge werfen
`ReplicaTransitionBlocked`. [Replikatsteuerung](../_attic/abnahme/ap3-replica-control.en.md).

`NetcupFencing` (mit `NetcupScp`, `fileTokenProvider`, `fileFenceState`) ist der
netcup-Adapter; `serveFencing` bietet einen Adapter per mTLS nur für
Operator-Zertifikate an, `TlsFencing` ist der passende Client. Fehler: `NetcupError`.
`ContainerFencing.release` bricht ab, wenn die Unit noch ein anderes `zz-*-fenced.conf`-Drop-in trägt
(etwa von einer früheren Version); es wird nicht automatisch entfernt.
Ohne gespeicherten Fence-Zustand (Autostart bzw. Restart-Policy) brechen `NetcupFencing.release` und
`ContainerFencing.release` ab, statt einen Wert zu raten.

`PrimarySyncJournal.beginTransition`, `openTransitionIds` und `abandonTransition` steuern die Schreibsperre
während eines Übergangs. `installBootGuard(..., { replicaConfig })` bindet primary/sync-Spaces an die
Journal-Konfiguration. `readmitSpace` (Operator) und `installAdmittedPermit` (Host) lassen die übrigen Spaces
eines gefencten Hosts einzeln wieder zu. `signedReplicaPeer` und `replicaSyncHandler` bilden den signierten
Replikat-Transport. `replicaConfigNotice`, `signReplicaConfigNotice` und `adoptReplicaConfigNotice` tragen eine
neue Replikatkonfiguration in die Member-Tabelle des Routers. Die Übernahme ist nur möglich, wenn das Register
den neuen Primary mit genau diesen Werten zulässt. Delegationen tragen `targetReplicaConfigVersion`, und
`DelegationVerifier({ replicaConfig })` antwortet bis zur Übernahme mit `ReplicaConfigPending`. `ReplicaConfigPending` und `StalePolicyVersion`
sind eigene Fehlercodes (Klassen in `core`); der Router wartet bzw. bereitet nie zugelassene Schritte über
`RouterTarget.reprepare` neu vor und klärt offene Schritte beim installierten Nachfolger ihrer Bindung
([Replikatsteuerung](../_attic/abnahme/ap3-replica-control.en.md)). Ein Primary
veröffentlicht seine Notice mit `RemoteSpace.publishReplicaNotice` auf dem `ReplicaNoticeBoard` des Control Space;
der native Root übernimmt sie im Heartbeat (`adoptReplicaNotices`) und adressiert Member über ihre provisionierten
`replicas`.

`openSyncSpace` öffnet einen primary/sync-Space mit eigenem Store, Replikat-Listener, Boot-Guard und Notice.
`startFederationHost({ syncSpaces })` und `startConfiguredFederation(host, ctx, file, { openSyncStorage,
openSyncHarness })` binden solche Spaces in den Federation-Host ein. Ohne die beiden Fabriken liegt jeder Space im
eigenen Speicher (`OWN_SYNC_FACTORIES`). `SyncSpaceConfig.journal` setzt die Journal-Grenzen
(`maxIntentBytes`, `maxHistoryBytes`). Ein erschöpftes Budget lehnt den Commit mit `SyncJournalFull` (kein Paketexport, Unterklasse von `PrimarySyncBlocked`) ab (im Dienst
`ResourceExhausted`), ohne den Host zu sperren. `createSpace(tx, alias, now, { spaceId,
incarnation })` legt einen Space mit vorgegebener Identität an.


Für Set-Regeln unterstützt `EntryMutation` jetzt zusätzlich
`{kind: "renew", type, tag, fields, owner, expiresAt}`. Das erneuert ausschließlich
einen lokal lebenden beobachteten Tag, erhält Felder/Owner und erzeugt atomar einen
neuen Tag samt Entfernung des alten. Die Request-ID bleibt replaybar. Das ist
weiter die administrative Entry-API, keine automatische Umleitung normaler
`PhiSpaces.renew`-Aufrufe.


## Laufsteuerung (Betriebserweiterung)

Vertrag und Abnahme: [Betrieb und mobile Steuerung](../betrieb-und-mobile-steuerung.en.md) §6 und §8.

### RunGate im Core

`CompletionProfile.gateField` (muss in `equalFields` stehen, `maxLeaseMs` ist dann Pflicht) bindet Tasks an den
RunGate ihres Laufs. Alle Funktionen sind Host-Code und über Space-RPC nicht erreichbar.

| Funktion | Wirkung |
|---|---|
| `core.applyRunGate(s, now, {runId, commandId, kind, revision, recoveryId?, expect?})` | `kind`: `prepare`, `release`, `pause`, `resume`, `stop`. Liefert `RunGateAck {phase: "applied" \| "fenced", state, revision, spaceId, incarnation, authorityId, boundTxns}`. Dieselbe Revision mit demselben Command liefert die gespeicherte Bestätigung; mit anderem Command `RunGateConflict`. |
| `core.runGateView(s, runId)` | lesende Sicht auf Gate, Fence, Recovery und gebundene Txns |
| `core.recoverRunGate(s, now, {runId, recoveryId})` | installiert die Recovery-Eintrittssperre und liefert `RunRecoveryView` (`stable` erst ohne gebundene Txn) |
| `core.assertGatedProfilesKept(s, profiles)` | Prüfung vor jedem Profilwechsel |

Fehler: `RunGateConflict` (Revision, Command, Zustand, Recovery), `CompletionViolation` (Ergebnis ohne gebundene
Txn oder mit fremdem Lauf). Gesperrte Tasks sind nur in `preparing` schreibbar.

### `RunController`

```ts
const runs = new RunController({ host, ctx, member: spaceId => RunMember, identity?: async () => ({ authorityId, incarnation }) });
await runs.start(commandId, { runId, kind, config, members });
await runs.pause(commandId, runId); await runs.resume(commandId, runId); await runs.stop(commandId, runId);
await runs.advance(runId);            // offene Übergänge fortsetzen, idempotent
await runs.reconcile(commandId, runId, recoveryId, manifest?);
await runs.resolve(commandId, runId, { expectedViewHash, decision: "pause" | "stop" | "resume" });
await runs.status(runId); await runs.pending();
```

Ein Wechsel der Control-Identität oder ein Member unter Restore-Sperre startet `reconcile` automatisch
(Recovery `control-<inkarnation>` bzw. `runRecoveryIdOf(restoreId)`); offene Aufträge werden dabei nie erneut gesendet.

Lesend: `runs.list(limit)` sowie die Admin-Commands `listRuns`, `runStatus` und `listWorkers` (Zuweisungen plus
zuletzt gemeldeter Stand je Host).

`RunView.state` ist `preparing`, `running`, `pausing`, `pauseIncomplete`, `paused`, `resuming`, `stopping`,
`stopped`, `reconciling` oder `needsReview`; `pending` nennt angewendete, gefencte und fehlende Members,
`recovery` die Views, den View-Hash, geparkte Aufträge und gemeldete Änderungen. `RunBusy` meldet einen noch
offenen Übergang oder eine laufende Recovery. Commands mit gleicher ID und gleichem Inhalt sind idempotent.

Members: `localRunMember(host, ctx, spaceId, prepare)` für eigene Spaces, `remoteRunMember({spaceId, authorityId,
peerId, signer, memberPin, send})` für fremde Hosts; `send` ist z. B. `RemoteSpace.requestRunGate`. Auf dem
Member-Host prüft `RunGateService({..., controllerPin, preparers})` Signatur, Autorität und lokalen Space; er wird
als `runGates` an `startFederationHost` übergeben. `runCommands(runs)` liefert die Supervisor-Handler für
`startRun`, `pauseRun`, `resumeRun`, `stopRun`, `reconcileRun` und `resolveRunRecovery`; mit `control.runs` setzt
`startFederationHost` offene Übergänge serverseitig fort.

Sieb: `SIEVE_GATED_PROFILE`, `configureGatedSieveSpace(host, space)` und `prepareSieveRun(host, config, {space, gate})`
in `examples/sieve.ts`. `SIEVE_COMPLETION_PROFILE` prüft jetzt auch `rangeStart` und `rangeEnd`.

### Worker-Steuerung

```ts
const workers = new WorkerAssignments({ host, ctx, authorityId, peerId, signer, identity?: async () => ({ incarnation }) });
await workers.set(commandId, { assignmentId, hostId, kind, targetSpace, count, runId? }); // count 0 stoppt nach dem Task
await workers.forHost(hostId); await workers.list();

const sup = new WorkerSupervisor({ host, ctx, hostId, authorityId, controllerPin, kinds: { sieve: SIEVE_WORKER_KIND },
  fetch: () => remote.workerAssignments(), backoff?: { minMs, maxMs }, sleep?, space? });
await sup.reconcile();                 // ein Durchlauf: abrufen, prüfen, speichern, skalieren -> WorkerSummary
const stop = startWorkerSupervisor(sup, { intervalMs, publish: summary => heartbeat({ ...report, metrics: { workers: summary } }) });
await sup.acceptControlIdentity(incarnation); // nach geprüftem Control-Restore
```

Eine Workerart ist `{ step({ space, spaceId, runId?, signal }): Promise<boolean>, requiresRun? }`: ein Task je
Schritt, `false`, wenn gerade keiner nehmbar ist. Der Stopp wird zwischen Schritten geprüft, Wartezeiten bricht er
sofort ab. `WorkerSummary` nennt je Zuweisung `desired`, `active`, `stopping`, `tasks`, `errors`, `lastError` und
`rejected`, dazu `generation`, `blocked` und `fetchError`. `appliedWorkers(controlState, now)` liest den letzten
Stand je Host aus den Capability-Entries; `at` zeigt, wie alt er ist. Mit `control.workers` bietet
`startFederationHost` die Gate-Methode `workerAssignments` und den Admin-Command `setWorkers`;
`RemoteSpace.workerAssignments()` ruft sie auf. Worker sind Schleifen im Prozess, keine Threads.

### Space-Lebenszyklus

```ts
const life = new SpaceLifecycle({ host, ctx });
await life.apply({ commandId, action: "create", alias, limits?, profiles? }); // { spaceId, alias, state, existed? }
await life.apply({ commandId, action: "archive" | "reactivate" | "delete", spaceId });
```

Fehler: `SpaceInUse` mit Grund (Mitgliedschaft, Entries, offene Arbeit, Claims, Mailboxes, Läufe, Restore),
`RunGateConflict` bei einem Alias mit anderen Limits/Profilen, `PermissionError` für Default- und Control-Space.
Ein archivierter Space (`SpaceState.archived`) lehnt Writes, Takes, Txns, wartende Takes und Registrierungen ab.
Remote: `SpaceLifecycleService` (als `spaceLifecycle` an `startFederationHost`), `RemoteSpace.requestSpaceLifecycle`,
`signLifecycle`/`verifyLifecycle`; `spaceCommands({authorityId, peerId, signer, hostPin, send})` liefert die
Supervisor-Handler, die über `control.spaces` eingebunden werden.

### Deployment-Bootstrap

```ts
validateDeployment(config) // { config?, configHash?, errors[] }
const deploy = new DeploymentController({ host, ctx, ports: {
  hostStatus: capabilityHostStatus(host, ctx, controlSpaceId), createSpace: spaceCommands(...).createSpace, workers, controlSpaceId } });
await deploy.bindHost(alias, hostId);
await deploy.plan(config);       // { ready, configHash, steps: [{ key, action, status, detail }] }
await deploy.apply(config);      // { state: "applying" | "blocked" | "completed", steps }
await deploy.startWorkers(commandId, deployment);
await deploy.export(deployment);
```

`deploymentCommands(deploy)` liefert die Supervisor-Handler `planDeployment`, `applyDeployment`, `bindHostAlias`,
`startWorkers` und `exportDeployment`; `startFederationHost` bindet sie über `control.deployment` ein.
CLI: `npm run bootstrap -- --check|--plan|--apply|--bind a=id|--start-workers|--export` (Exit 0 ok, 1 ungültige
Config, 2 abgelehnt/blockiert, 3 noch kein Ergebnis).

### Alarmierung, Audit und Vorschau

```ts
await collectAlerts({ runs?, workers?, host, ctx, controlSpaceId, staleMs? }); // Alert[] { key, severity, source, subject, message }
const monitor = startAlertMonitor({ collect, publish: webhookPublisher("https://ntfy.example/topic"), intervalMs });
await auditLog(host, ctx, controlSpaceId, { limit });                            // ohne Result-Payloads
await runs.preview("start" | "pause" | "resume" | "stop", runId, spec?);        // { allowed, reason?, revision?, state? }
```

Admin-Commands: `listAlerts`, `auditLog` (jede Control-Runtime) sowie `dryRun: true` an `startRun`, `pauseRun`,
`resumeRun`, `stopRun`.

### Ergebnisexport und Zeitplan

```ts
new RunController({ ..., exporters: { sieve: SIEVE_EXPORTER }, space: spaceId => SpaceLike });
await runs.export(runId);   // { complete, expected, found, missing, manifestHash, resultHash, summary }
await runs.schedule(commandId, runId, { kind: "pause" | "resume", at, cancel? });
```

Admin-Commands `exportRun` und `scheduleRun` (`scheduleId`, `kind`, `at`, `cancel`).

## Agentenpaket (`agent/`)

`agent/` ist ein eigenes, privates Paket (`phi-spaces-agent`, eigene Abhängigkeiten pi-durable, chord, pi-ai) ohne `main` und
`exports`; es wird über Dateipfade eingebunden und gehört nicht zum Vertrag von `phi-spaces`. Die Agenten verbinden sich mit
einem getrennten Space-Host, nicht mit ihrem Agentenspeicher: Jeder Werkzeugaufruf bekommt eine Request-Identität, die vor dem
ersten Space-Aufruf im Agentenspeicher steht, sodass ein wiederholter Aufruf das erste Ergebnis erhält.

| Datei | Export | Inhalt |
| --- | --- | --- |
| `agent/src/index.ts` (Einstieg, aus `agent.ts`) | `createSpaces(spaces)` | Die pi-durable-Erweiterung mit den Space-Werkzeugen (`space_write`, `space_take`, …) über ein `AgentSpaces` |
| | `localSpaces(host, { space?, meter?, now? })` | `AgentSpaces` auf einem Space-Host in diesem Prozess |
| | `AgentSpaces` | Wo die Werkzeuge handeln: `space(id, ctx)`, `generation(id, ctx)`, `request(id, generation, requestId)` |
| | `conversationPrincipal(id)` | Der Principal einer Conversation in den Claims (`conversation-<id>`) |
| | `agentContext(context)` | Reicht Abbruch und Kontextwerte an die Agenten-Laufzeit weiter, wenn der eigenständige Space sie aufruft |
| | `withAgentEventSink(host, harness)` | Stellt die Ereignisse eines Space-Hosts den Conversations eines Agent-Harness zu |
| `agent/src/with-agent.ts` (Einstieg des mobilen Bundles und von pi-serverd) | alles aus `src/index.ts` und `agent.ts` | Space und Agentenwerkzeuge in einem Prozess; `withEventSink` ist hier `withAgentEventSink`, dazu `openDurableSqliteStorage` |
| `agent/src/storage.ts` | `openDurableSqliteDatabase`, `openDurableSqliteStorage` | SQLite des Agentenspeichers mit der Sync-Politik aus [agenten-stromausfalltest.md](../agenten-stromausfalltest.en.md) |
| | `openDurableJsonlStorage`, `durableJsonlFileSystem` | JSONL mit denselben Zusagen; Bestätigungen folgen dem Flush von Datei und Verzeichnis |
| | `syncDirectory`, `ensureDurableDirectory` | Verzeichnis synchronisieren bzw. dauerhaft anlegen |
| `agent/src/durable-client.ts` | `DurableAgentClient` | Optionale Prozessgrenze: `new DurableAgentClient(store, { modelsModule?, timeoutMs?, maxTokens? })`, `run(request, callbacks, signal?)`, `close()`. Importiert kein pi-durable oder chord; der Worker ist `agent/src/durable-worker.ts` |
| `agent/src/durable-protocol.ts` | `AgentRequest`, `AgentAnswer`, `AgentUsage`, `AgentCallbacks`, `ParentMessage`, `WorkerMessage` | Strukturelle IPC-Typen dieser Grenze |
| `agent/src/live-models.ts` | `liveModels()` | Echte Modelle für die Live-Beispiele (`PI_PROVIDER`, `PI_MODEL`; Zugangsdaten aus der Umgebung oder `~/.pi/agent/auth.json`) |

## Exportübersicht

Diese Tabellen nennen je Bereich die Exporte von `phi-spaces`, die die Abschnitte oben nicht behandeln. Dokumenttypen
(`defineDoc`/`defineDocFamily`) sind die Zustandsablage des jeweiligen Controllers; sie sind exportiert, damit Host-Code sie in
einem Commit lesen kann, und kein eigener Schreibweg.

### Client, Kontext und Messung

| Export | Inhalt |
| --- | --- |
| `SpaceHost`, `PhiSpacesOptions`, `Req`, `Once`, `Taken`, `ChainOptions` | Typen des Clients: benötigter Host, Optionen, Request-Identität mit `unique`/`transient`, Einmal-Hook, Entry-Sicht, `readChain`-Optionen |
| `BatchOp`, `BatchResult` | Schritt und Ergebnis von `batch` |
| `WAKE_DEBOUNCE_MS` | Pause (20 ms plus Jitter) zwischen einer Änderung und dem nächsten Versuch eines blockierten Read/Take |
| `DEFAULT_LIMITS`, `UnknownLeaseError`, `Json`, `Fields`, `Template` | Standardgrenzen, Fehler einer unbekannten Lease, JSON-Typen, Template |
| `Space` | Dokument des Default-Space |
| `ContextKey`, `withContextValue`, `withAbortSignal`, `awaitWithContext` | Typisierter Kontextschlüssel, Kontext mit Wert oder zusätzlichem Abbruchsignal, Warten bis Abschluss oder Abbruch (der Promise läuft weiter) |
| `Meter`, `Counter`, `COUNTERS`, `MeterSnapshot` | Prozesslokale Zähler `writes`, `reads`, `takes`, `misses`, `events`, `failures`, `retries` mit Raten; `meter` ist die Standardinstanz, `Live` eine Abtastung |
| `formatStatus`, `formatWidget`, `watchLive` | Statuszeile, mehrzeilige Anzeige, Abtasten von Kennzahlen und Raten alle `intervalMs` ohne Commit |
| `canonicalJson` | Kanonisches JSON (RFC 8785, [Wire-Protokoll](../wire-protokoll.en.md)) |

### Benannte Spaces, Claims und Mailbox

| Export | Inhalt |
| --- | --- |
| `snapshotSpace(host, spaceId, ctx)` | Bestätigter Zustand eines Space ohne Commit; `undefined`, wenn es ihn nicht gibt |
| `resolveSpaceId(tx, space)`, `spaceDoc(tx, space)` | Alias oder ID zu `spaceId`, Dokument eines Space im Commit |
| `Registry`, `RegistryState`, `NamedSpace`, `SpaceInfo`, `DEFAULT_ALIAS`, `UnknownSpaceError` | Register der Spaces, Dokumentfamilie benannter Spaces, Beschreibung eines Space (ein gelöschter behält mit `deletedAt` seine ID), Alias `default`, Fehler |
| `claims`, `Principal` | Namensraum `src/claims.ts` (u. a. `decideNotCommitted`, `NotCommitted`); `{ peerId, agentId? }` |
| `RequestExpired`, `IncarnationChanged`, `OperationCancelled` | Generation lässt die ID nicht mehr zu; Generation einer früheren Inkarnation; Request vor der Entscheidung abgebrochen |
| `argHash(method, args)`, `ClaimView`, `ClaimState` | Kanonischer Hash der Domänenargumente, Sicht und Zustand eines Claims |
| `principalId(principal)`, `MailboxPage`, `MailItem`, `MailboxState` | Kanonische Principal-ID, Seite, Eintrag und Zustand der Mailboxen |

### Dienst und Transport

| Export | Inhalt |
| --- | --- |
| `PROTOCOL_VERSION`, `METHODS`, `Method` | Protokollversion 1 und die Methoden des Dienstes |
| `DEFAULT_POLICY`, `RolePolicy`, `Identity`, `principalKey` | Standardrollen ([Wire-Protokoll](../wire-protokoll.en.md) Abschnitt 4), Recht einer Rolle, Identität, Owner-Schlüssel eines Principals |
| `Call`, `Reply`, `ErrorCode`, `Connection` | Aufruf- und Antwort-Umschlag, Fehlercodes, was ein Transport über eine Verbindung weiß |
| `MergeAdapter`, `MergeTypeNotExclusive` | lww-/set-Typen eines Space über seinen Replikations-Controller; exklusive Operation auf so einem Typ |
| `ServeOptions`, `SpaceServer`, `SocketTransport`, `ConnectOptions`, `RemoteOptions` | Optionen und Rückgaben von `serveSpace`, `socketTransport` und `connectSpace` |
| `RoutedServices`, `RoutedAttachment`, `RoutedCall` | Strukturtypen des pi-server-Adapters |

### Gate, Schlüssel, Enrollment und Supervisor

| Export | Inhalt |
| --- | --- |
| `Gate`, `GateOptions`, `PeerDirectory`, `PeerInfo`, `GroupRoles`, `NetbirdDirectoryOptions` | Rückgabe und Optionen von `startGate`, das Peer-Verzeichnis |
| `NetbirdDirectory`, `DirectoryDown` | Schicht A gegen die NetBird-API (`GET /api/peers`, zwischengespeichert); Verzeichnis nicht erreichbar |
| `GateIdentity`, `DEFAULT_GROUP_ROLES`, `rolesOf(groups, map)` | Principal ist die Peer-ID, Rollen kommen aus Gruppen; privilegierte Rollen erst nach Schlüsselbeweis |
| `ProvingService`, `ProvingOptions`, `AuthState`, `Challenge`, `AUTH_PROTOCOL`, `CHALLENGE_TTL_MS`, `DEFAULT_PRIVILEGED` | Schicht B: `challenge` und `prove` vor dem Dienst, Zustand je Verbindung, Challenge 30 s |
| `KeyDirectory`, `MemoryKeyDirectory`, `PeerKeyRec`, `Algorithm` | Schlüsselverzeichnis (im Speicher für Tests und Werkzeuge), Eintrag im Control Space, `ed25519` oder `ecdsa-p256` |
| `generateKey(algorithm, keyId)`, `Signer`, `signedBytes(challenge)`, `verifySignature` | Schlüsselpaar erzeugen, Signierer, signierte Bytes einer Challenge, Prüfung |
| `EnrollmentService`, `EnrollmentOptions`, `EnrollRec` | `enroll` und `enrollStatus` für Peers mit der Rolle `unpaired` |
| `createEnroll`, `bootstrapEnroll`, `revokePeerKey` | Verarbeitung im Supervisor, Token des ersten Admins, Schlüssel widerrufen |
| `newEnrollToken`, `hashToken`, `enrollQr`, `keyFingerprint` | 256-Bit-Token, SHA-256 des Tokens, Inhalt des QR-Codes (geheim, nie loggen), ID eines öffentlichen Schlüssels |
| `BootstrapClosed`, `CONTROL_SPACE`, `ENROLL_TTL_MS`, `UNPAIRED_ROLE`, `ENROLLABLE_ROLES` | Bootstrap bereits benutzt; Alias `control`, Tokenfrist 5 min, Rollenname, vergebbare Rollen |
| `SupervisorOptions`, `ControlAccess`, `ControlAccessOptions` | Optionen des `Supervisor`; Zugriffsregeln des Control Space (`Command`, `Result`, `PeerKey` nur für Admins) |
| `COMMAND_KINDS`, `CommandKind`, `CommandResult`, `RESULT_RETENTION_MS` | Eingebaute Commands `createEnroll`, `revokePeer`, `rotateKey`, ihr Ergebnis, Aufbewahrung 7 Tage |
| `RotationService`, `createRotationChallenge`, `rotateKeyIn`, `rotationBytes`, `RotationChallenge` | Serverseite der eigenen Schlüsselrotation |
| `GrantDenied`, `Grant`, `SignedGrant`, `verifyDetached` | Abgelehnter Grant, Grant und seine signierte Form, Prüfung einer abgetrennten Signatur |
| `FederationHostOptions`, `FederationConfig`, `RootConfig` | Optionen von `startFederationHost`, Konfigurationsdatei von `startConfiguredFederation`, `root`-Teil davon |
| `startQuarantineReplicas(ctx, configFile, factories, { pollMs? })` | Quarantänestart: öffnet nur Journale und Replikat-Listener seiner primary/sync-Spaces, bedient nichts |

### Recovery und Boot

| Export | Inhalt |
| --- | --- |
| `privateFile(path)` | Liest eine private Datei; Symlinks, fremde Besitzer und zu weite Rechte werden abgewiesen |
| `RegisterConflict`, `RegisterRecord`, `RegisterTlsClient`, `RegisterTlsIdentity` | CAS-Konflikt, Wert mit Version, Zugang zum TLS-Register |
| `RecoveryBlocked`, `AuthorityTransition`, `SignedAuthorityTransition`, `AuthorityRecord` | Autoritätswechsel und sein Eintrag im Register |
| `BootBlocked`, `HostBootState`, `SpaceBootPermit` | Boot-Guard: Sperre, Zustand eines Hosts, Erlaubnis je Space |
| `RecoveryCall`, `SignedRecoveryCall`, `recoveryBytes(call)` | Signierter Aufruf des privaten Recovery-Dienstes |
| `sshRecoveryTransport(target, timeoutMs?)` | Transport zu diesem Dienst über SSH |
| `startConfiguredRecovery(host, raw, ...)`, `PrivateRecoveryConfig` | Startet den privaten Recovery-Dienst aus der Konfiguration |
| `RecoveryJobs`, `RecoveryJob`, `DataRestoreRequest`, `RecoveryControllerOptions` | Journal und Typen von `RecoveryController` |
| `snapshotHash(state)`, `RestoreArgs`, `RestoreState` | Hash eines Space-Zustands, Argumente und Zustand eines Restore |
| `ControlRecoveryJobs`, `ControlRestoreRequest`, `ControlRestoreJob`, `ControlRecoveryOptions`, `ReauthorizeKey` | Journal und Typen von `ControlRecoveryController` |
| `MemberAuthorityAck`, `MemberTransitionOptions`, `MemberRecoveryOnlyConfig`, `RecoveryOnlyConfig` | Member-Übergang und Konfigurationen der Nur-Recovery-Starts |
| `RecoveryReceipts`, `ControlAck` | Dokument und Inhalt dauerhafter Control-Receipts |
| `signControlHostChange`, `verifyControlHostChange`, `ControlHostChange`, `SignedControlHostChange` | Wechsel des Control-Hosts bei gleicher Autorität, vom Recovery-Admin signiert |
| `recordControlHostChange`, `followControlHostChange`, `ControlHostChangeBlocked` | Eintrag im Register nach der Promotion; ein Host folgt ihm vor allem anderen beim Start |

### Replikation, Fencing und Sync-Spaces

| Export | Inhalt |
| --- | --- |
| `PrimarySyncConfig`, `PrimaryCommitIntent`, `PrimaryConfigIntent`, `PrimaryBootstrapIntent`, `PrimaryIntent`, `PrimarySyncAck`, `PrimarySyncPeer` | Konfiguration, Einträge der Hashkette, Standby-Bestätigung und -Schnittstelle |
| `bootstrapPrimarySync(raw, journal, ctx, o?)`, `captureStore(storage, ctx)` | Bestehenden, exklusiv geöffneten Store unter primary/sync bringen; vollständiger Inhalt mit Digest |
| `PromotionEvidence`, `CommitSealed`, `FenceProof`, `StandbyTarget` | Promotionsnachweis, versiegelter Commit, Fencing-Nachweis, Ziel von `setStandby` |
| `openSyncSpaces`, `SealedSyncSpace` | Öffnet jeden konfigurierten Space für sich; einer, der nicht öffnet, bleibt unbedient und gesperrt |
| `latestReplicaConfigNotice(journal, dataIncarnation)`, `ReplicaConfigNotice`, `SignedReplicaConfigNotice` | Notice des neuesten abgeschlossenen Übergangs und ihre Typen |
| `ReplicaTransportRefused`, `ReplicaPin` | Abgelehnter Replikat-Transport, gepinnter Host |
| `memoryFenceState()`, `NetcupServerPin`, `NetcupFenceState` | Fence-Zustand im Speicher, Pin eines Servers, Ablage des alten Autostarts |
| `ContainerFencingError`, `ContainerPin`, `CommandRunner`, `execRunner` | Fehler und Pin des Container-Adapters, Befehlsausführung ohne Shell |
| `ReplicationConflict`, `entryChangeId`, `EntryReplicationConfig`, `EntryReplicationRule`, `ReplicatedEntryChange`, `ReplicatedEntryView`, `EntryReplicationSnapshot`, `EntryReplicationOptions` | Typen und Helfer der Entry-Replikation |
| `ReplicationClockError`, `HybridClock` | Fehler und Wert der hybriden Uhr |
| `EntrySnapshotChunks`, `EntrySnapshotTransfers`, `EntrySnapshotMaintenance`, `EntrySnapshotMaintenanceJob`, `EntrySnapshotManifest`, `EntrySnapshotPage`, `EntrySnapshotImport` | Dokumente und Typen von Snapshot-Transfer und -Pflege |
| `EntryStreamCheckpoints`, `EntryStreamCursorConflict`, `EntryReplicationUnavailable`, `EntryStreamIdentity`, `EntryStreamDescription`, `EntryStreamPage`, `EntryStreamCheckpoint`, `EntryStreamResult` | Dokument, Fehler und Typen des Entry-Streams; `EntryReplicationUnavailable` ist der einzige wiederholbare Quellfehler |
| `EntryReplicationSource`, `EntryReplicationStep`, `EntryReplicationPumpOptions` | Quelle, Schritt und Optionen von `EntryReplicationPump` |

### Router, Delegation und Föderation

| Export | Inhalt |
| --- | --- |
| `DEFAULT_ROUTER_LIMITS`, `RouterLimits`, `RouterOptions`, `RouterCommandSpec`, `RouterCommand`, `RouterStep`, `RouterReceipt`, `TargetBinding`, `CommandState`, `RouterOperation`, `RouterJournal` | Grenzen, Optionen, Auftragstypen und Journal von `RouterController` |
| `RouterLeaseAuthority`, `RouterLease`, `SignedRouterLease` | Der Control-Host committet einen Lease, bevor er ihn signiert |
| `signDelegation`, `delegationForCall`, `DelegationDenied`, `Delegation`, `SignedDelegation`, `TargetRequest`, `SignedEpochNotice` | Delegation eines Aufrufs an einen Member und ihre Typen |
| `rpcDomain(call, principal)` | Domänenform eines Aufrufs, Grundlage des Argument-Hashs ([Wire-Protokoll](../wire-protokoll.en.md) Abschnitt 5) |
| `validateFederationPolicy`, `verifyFederationPolicy`, `FederationPolicy`, `FederationRule`, `FederationMember`, `FederationCompletionProfile`, `SignedFederationPolicy` | Prüfung und Typen der Routing-Policy |
| `hrw(value, ids)`, `writeMember`, `searchMembers`, `normalizeFederatedEntry` | Rendezvous-Hash, Ziel-Member eines Writes, Such-Member eines Templates, Normalform eines Entry |
| `RoutingConflict`, `MigrationRequired`, `MemberDrained`, `CapacityUnavailable`, `NoCapableMember` | Routing-Fehler |
| `FederationRouting`, `RoutingState`, `controlAlignmentBlocker` | Routing-Dokument und sein Zustand; Prüfung vor einem Control-Übergang |
| `FederationUnavailable`, `FederationPending`, `FederationIO`, `FederationOperation`, `FederationOperations`, `FederationRequest` | Fehler, Ein-/Ausgabeschnittstelle, Journal und Typen von `FederatedSpace` |
| `MembershipInstruction`, `MembershipProof`, `SignedMembership`, `signMembership`, `verifyMembership`, `MembershipJournal`, `MembershipTransport`, `memberReferencesIn` | Signierte Membership-Anweisungen, Journal, Transport, offene Referenzen eines Members |
| `CAPABILITY_LEASE_MS`, `CAPABILITY_HEARTBEAT_MS`, `MEMBER_STATUS_LEASE_MS` | 120 s, 60 s und 30 s des Directory |
| `FederationJournalLayout`, `validateJournalPartitions`, `operationPartition`, `parentJournalKey`, `partitionRouterId` | Festes Partitionslayout und seine Abbildung |
| `ProfileTransitions`, `RootErasures` | Journale von `ProfileTransitionController` und `RootHistoryErasure` |
| `ErasureArchive`, `checkErasureBarrier(register, spaceId, state, now?)`, `ErasureBarrier` | Archiveintrag; Sperre eines Space aus dem Löschzustand |
| `DistributedErasurePlan`, `ErasureParticipant`, `DistributedErasureDriver` | Plan, Teilnehmer und Treiber von `DistributedPrincipalErasure` |

### Läufe, Worker, Spaces und Deployment

| Export | Inhalt |
| --- | --- |
| `RunGateCommand`, `RunGateKind`, `RunGateState`, `RunGateEvidence` | Typen des RunGate im Core; `RunGateEvidence` ist der kompakte Nachweis aus einem wiederhergestellten Snapshot |
| `RunJournal`, `RunExporter`, `RunIdentity`, `RunMember`, `RunSpec`, `RunStatus` | Journal, Ergebnis-Leser je Laufart, Control-Identität eines Übergangs, Schnittstelle eines Members, Laufbeschreibung, Zustand |
| `RunGateInstruction`, `RunPin`, `RunPreparer`, `SignedRun`, `signRun`, `verifyRun` | Signierte Anweisungen an Members; `RunPreparer` ist registrierter Host-Code, nie ein Shell-Befehl |
| `WorkerJournal`, `WorkerKind`, `WorkerList`, `WorkerPin`, `WorkerSpec`, `SignedWorkers`, `verifyWorkers`, `workerCommands`, `abortableSleep` | Journal und Typen der Worker-Steuerung, Admin-Command `setWorkers`, abbrechbares Warten |
| `SpaceLifecycleJournal`, `SpaceAction`, `SpaceLifecycleRequest`, `SpaceLifecycleResult`, `SpaceLifecycleInstruction`, `SignedLifecycle`, `LifecyclePin` | Journal und Typen des Space-Lebenszyklus |
| `DeploymentState`, `DeploymentConfig`, `DeploymentPlan`, `DeploymentPorts`, `PlanStep` | Zustand und Typen des Deployment-Bootstrap |

### `phi-spaces/core`

Zustandsfunktionen sind Host-Code: Sie arbeiten auf einem `SpaceState` im Commit und sind über Space-RPC nicht erreichbar.

| Export | Inhalt |
| --- | --- |
| `Target`, `Probe`, `EntryRec`, `TxnRec`, `RegRec`, `WaiterRec`, `SpaceEvent`, `FanoutJob`, `RunGateRec` | Empfänger, Suchergebnis und die Datensätze im Space-Dokument |
| `DEFAULT_LEASE_MS`, `MAX_TIMER_MS`, `MAX_LIST`, `CHANGES_OVERHEAD` | 1 h, 2^31 − 1, größtes `limit` des Werkzeugs `space_list`, 160 Bytes Umschlag |
| `until(now, ms)`, `deadlineOf(now, timeout)`, `timerDelay(ms)` | Absolute Zeit ohne Überlauf, Timeout als Frist, sichere `setTimeout`-Verzögerung |
| `initialState()`, `migrate(v, from)`, `plain(v)`, `previewOf(s)` | Leerer Zustand, Migration, Kopie aus einem Draft, abgelöste Kopie für einen Probelauf |
| `seal(s)`, `beginCommit(s)`, `touch(s, now)`, `maintenanceStep(s, cost, now, cursor)` | Commit-Budget und Revision: abschließen, beginnen, Änderung vermerken, begrenzten Wartungsschritt reservieren |
| `limitsOf(s)`, `docBytes(s)`, `overheadBytes(s)`, `outboxBytes(s)`, `claimBytes(s)` | Wirksame Grenzen und Bytezähler |
| `gidOf(spaceId, id)`, `view(e, spaceId?)`, `streamIdOf(s)`, `deepEqual(a, b)` | Globale ID, Entry-Sicht, Strom-ID, tiefer Vergleich |
| `settle(s, now)`, `nextExpiry(s)`, `needsMaintenance(s, now)` | Abgelaufenes erledigen, nächster Ablauf, ob Wartung fällig ist |
| `assertNotArchived(s)`, `assertAdminIdle(s)` | Sperren für archivierte Spaces und laufende administrative Löschung |
| `announce(...)` | Transienter Write ([`PhiSpaces`](#phispaces)) |
| `createTxn`, `commitTxn`, `abortTxn`, `releaseTxn` | Transaktionen; `releaseTxn` bricht von der Hostseite ab, wenn sie noch aktiv ist |
| `addWaiter`, `cancelWaiter`, `parkOperation` | Geparkte Reads/Takes; `parkOperation` ist der Ausführungszustand eines blockierenden RPC |
| `listPage(...)` | Bytebegrenzte Seite von `list` |
| `importRestoredEntry`, `releaseRestoredEntry`, `fenceGatesForRestore`, `importRestoredGate` | Bausteine des Restore |
| `closeRegistrationsForRemoval(s, now)` | Schließt Registrierungen beim Entfernen eines Space |

### `phi-spaces/store/*`

| Export | Inhalt |
| --- | --- |
| `Ledger`, `memoryLedger()`, `StoredDoc`, `PutDoc`, `CommitSet` | Ablage bestätigter Dokumente und was ein Commit ihr übergibt; `memoryLedger` hält nichts |
| `StoreStats`, `HOST_CLOSED` | Schreibkennzahlen des Hosts, Meldung eines geschlossenen Hosts |
| `SqliteStoreOptions` | Unter anderem `memoryBudget`, `hotMs` und die Synchronität (FULL ist der Standard) |
| `FORMAT_VERSION`, `DEFAULT_MEMORY_BUDGET` | Dateiformat 2 (neuere werden abgewiesen, ältere migriert), 40.000 Datensätze im Speicher |
| `openFiles(path)`, `StoreFiles`, `hostOver(files, options)` | Datei als Besitzer öffnen, Host über geöffneten Dateien |
| `Compaction`, `LedgerReplication`, `StoreFaults` | Ergebnis von `compact`, was primary/sync an Batches tut, Fehlerinjektion für Tests |
