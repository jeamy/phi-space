# pi-spaces API

Stand: 2026-10-09. Diese Referenz dokumentiert die öffentliche TypeScript-API
des lokalen Clients `PiSpaces`, des Remote-Clients `RemoteSpace` und den
Servicevertrag. Sie beschreibt keine Federation-Garantie; dafür ist
[federation-plan-v3.md](federation-plan-v3.md) maßgeblich.

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

## `PiSpaces`

```ts
const space = new PiSpaces(harness, ctx, Date.now, meter, conversationId, {
  space: "optional-alias-or-spaceId",
});
```

Ohne `space` verwendet der Client den Default-Space. Ein gesetztes
`conversationId` aktiviert Ownership-Prüfungen; Host-Code lässt es weg.
`PiSpaces` erfüllt `SpaceLike`.

| Methode | Ergebnis | Semantik |
|---|---|---|
| `write(entry, txn?, lease?, { request? })` | `Lease` | Schreibt einen neuen Entry; unter `txn` zunächst unsichtbar. |
| `read(template, timeout, options?)` | `EntryView \| null` | Wartet auf einen sichtbaren Treffer. |
| `readIfExists(template, timeout, options?)` | `EntryView \| null` | Wartet nur auf die Auflösung kollidierender Transaktionen. |
| `take(template, timeout, options?)` | `EntryView \| null` | Entfernt sofort oder reserviert unter `txn`. |
| `takeIfExists(template, timeout, options?)` | `EntryView \| null` | Nichtblockierende Take-Variante, außer bei Locks. |
| `notify(template, options)` | `{ eventId, lease }` | Registriert lokale Zustellung oder Principal-Mailbox-Events. |
| `wait(template, options)` | `waiterId` | Parkt Read/Take für Conversation- oder Consumer-Zustellung. |
| `readAll(template?, options?)` | `EntryView[]` | Snapshot-Liste, älteste zuerst, alle Treffer, optionales Limit. |
| `readPage(template?, options?)` | `Page` | Bytebegrenzte Snapshot-Seite; mit `next` fortsetzen. |
| `changes(afterRev, options?)` | `Changes` | Sichtbare Commit-Batches nach einer Revision. |
| `count(template?, txn?)` | `number` | Sichtbare Treffer ohne Commit oder Warten. |
| `stats()` | `SpaceStats` | Punkt-in-Zeit-Gauges einschließlich Byte-Aufteilung. |
| `createTransaction(lease?, { request? })` | `Lease` | Erzeugt eine Transaktion. |
| `commit(txn, { request? })` / `abort(...)` | `void` | Schließt eine eigene Transaktion ab. |
| `renew(leaseId, ms, { request? })` / `cancel(...)` | Ablaufzeit / `void` | Erneuert bzw. beendet eigene Leases. |
| `issueGeneration(principal)` | Generation | Öffnet eine Claim-Generation. |
| `pollOperation(request)` / `cancelOperation(request)` | Claim-Status | Liest bzw. beendet eine bekannte Claim-Operation. |
| `events(principal, options?)` / `ack(principal, epoch, upTo, options?)` | Mailbox-Seite / ACK-Stand | Eigene Consumer-Mailbox, Präfix-ACK ist kein Txn-Commit. |
| `setCompletionProfiles(profiles)` | `void` | Nur Host-Code; Ergebnisvertrag vor Arbeit installieren. |
| `setLimits(partialLimits)` | `Limits` | Nur Host-Code: setzt Grenzen dieses Space. |

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

## Benannte Spaces und Hintergrunddienst

`createSpace(tx, alias, now)` erzeugt einen benannten Space im Harness-Commit;
`listSpaces(host, ctx)` listet Alias, `spaceId`, Inkarnation und Erzeugungszeit.
`startService(harness, ctx, { space? })` startet Reaper und lokale Event-
Zustellung. Ohne `space` überwacht es auch später erzeugte benannte Spaces.

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
`inProcessTransport(service, connection)` ist für lokale Tests;
`socketTransport({ path })` und `socketTransport({ host, port })` stellen
Unix- bzw. TCP-Verbindungen her. Der Server wird mit
`serveSpace(service, { listen: target, connection })` gestartet.

Vor der Nutzung ruft `RemoteSpace` `hello` auf, eröffnet eine Generation und
gibt jeder Mutation eine Request-ID. Bei verlorener Antwort wiederholt er mit
derselben Identität. `OutcomeUnknown` heißt deshalb nicht, dass die Wirkung
fehlgeschlagen ist: mit `pollOperation` dieselbe Request-ID weiter verfolgen
oder gezielt `cancelOperation` verwenden.

Der Service akzeptiert die Methoden `hello`, `generation`, `write`, `read`,
`take`, `pollOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `txn`,
`lease` und `changes`. Mutationen benötigen `{ generation, requestId }`.
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
`StaticIdentity` ist ein lokaler Konfigurations-/Testadapter. TCP allein bietet keine
Föderationsauthentisierung; die verbindungsgebundene Overlay-/Challenge-Schicht
bleibt offen.

## Fehler und Grenzen

`IllegalArgumentError`, `PermissionError`, `TransactionError`, `LimitError`
`CompletionViolation`, `MailboxEpochMismatch`, `InvalidAck`, `ResponseBudgetTooSmall`
und `ResourceExhausted` beschreiben lokale Semantik bzw. Budgetverletzungen.
Der Dienst serialisiert sie als Fehlercodes; der Remote-Client rekonstruiert
bekannte Fehlerklassen als `RemoteError` oder die spezielle lokale Klasse.
Ein maximaler Client-Wartezeitraum löst `OutcomeUnknown` aus, lässt die
Host-Operation aber weiterlaufen.

Die API garantiert keine FIFO-Auswahl und keine Exactly-once-Ausführung
außerhalb atomarer Space-Mutationen. Anwendungen müssen externe Effekte über
eine eigene Idempotenz-ID oder eine gemeinsame Transaktion absichern.
