# Das Leitungsprotokoll des Space-Dienstes

Stand: 2026-10-29 (R0 der [Rust-Portierung](../rust-portierung.en.md)). Diese Seite beschreibt, was ein zweiter
Space-Server sprechen muss, damit `RemoteSpace` (`src/remote.ts`) und die Projekte ihn nicht vom heutigen
unterscheiden. Maßgeblich ist der Code: `src/socket.ts` (Rahmen), `src/service.ts` (Umschlag, Rechte, Methoden),
`src/rpc-domain.ts` (Argument-Hash), `src/standalone.ts` (Kommandozeile).

Die Vektoren in `test/vectors/` zeigen jede Regel an einem Beispiel. `test/test-vectors.test.ts` hält sie mit dem Code
gleich; `npm run vectors` schreibt sie neu, wenn sich der Vertrag absichtlich ändert (dann auch diese Seite). Dabei bleiben
P-256-Signaturen, die noch gelten, und die Store-Dateien stehen; `npm run vectors -- --store` schreibt auch diese neu,
eine Änderung des Store-Schemas ebenso.

Nicht beschrieben sind die Methoden der Föderation, die Gate und Laufzeit vor dem Dienst beantworten (`challenge`,
`prove`, `enroll`, `grant`, `routerLease`, Instruktionen der Kontrollebene). Sie gehören zu R5 und R6.

## 1. Kommandozeile des Standalone-Dienstes

```
phi-space-server --store FILE|memory --listen unix:/path.sock|tcp:HOST:PORT [--peer ID]
```

- **Store:** `FILE` ist der eigene SQLite-Store (Abschnitt 10), `memory` ein Space im Speicher.
- **Peer:** Jede Verbindung ist der Peer `--peer` (Standard `local`) mit der Rolle `member`.
- **Bereitschaft:** Sobald der Dienst bedient, schreibt er genau eine Zeile auf stdout:
  `[phi-spaces] ready on <adresse> (store <FILE|memory>)`. Bei TCP-Port 0 steht dort der zugewiesene Port. Tests
  und Probe warten auf diese Zeile.
- **Ende:** SIGINT und SIGTERM schließen Dienst und Store; nach 3 s endet der Prozess in jedem Fall.
- **Hintergrund:** Abgelaufene Leases und Fristen werden zur fälligen Zeit erledigt, Ereignisse zugestellt
  (`startService` in `src/index.ts`).
- **Abweichende Nutzung:** Ohne `--store` oder `--listen` gibt es Exit-Code 2 und eine Nutzungszeile auf stderr.

## 2. Rahmen

| Regel | Wert |
|---|---|
| Rahmen | u32 Länge (big endian), u32 Aufruf-Id (big endian), dann `Länge` Bytes UTF-8-JSON |
| Größte Rahmen | `maxFrameBytes` = 262.144 Bytes einschließlich der 8 Bytes Kopf |
| Zu großer Rahmen | kündigt ein Rahmen mehr als `maxFrameBytes − 8` Bytes an, schließt der Server die Verbindung ohne Antwort |
| Parallelität | Aufrufe einer Verbindung laufen gleichzeitig; die Antwort trägt die Id ihres Aufrufs und kann in anderer Reihenfolge kommen |
| Aufrufe je Verbindung | höchstens 32 gleichzeitig (`maxInflightPerConnection`); darüber sofort `{"ok":false,"error":{"code":"ResourceExhausted",…}}` |
| Verbindungen | höchstens 64; eine weitere wird sofort geschlossen |
| Leerlauf | eine Verbindung ohne Verkehr wird nach 5 Minuten geschlossen |
| Unix-Socket | Datei mit Modus 0600. Eine verwaiste Socket-Datei wird ersetzt (Probe: Verbindung abgelehnt), ein lebender Server oder eine Nicht-Socket-Datei nicht. Beim Schließen entfernt der Server nur die eigene Datei (gleiches Gerät und Inode) |
| TCP | `setNoDelay`; kein TLS: die Adresse liegt im Overlay hinter dem Gate oder auf Loopback |
| Interner Fehler | wirft die Behandlung, antwortet der Server `Internal` mit dem Text `internal error`; Einzelheiten bleiben im Log |

Der Client (`socketTransport`) vergibt Ids ab 1, überspringt 0 beim Umlauf und schließt die Verbindung, wenn ein Aufruf
`requestTimeoutMs` überschreitet. Eine späte Antwort verwirft er.

## 3. Umschlag

```
Call  = { method, space?, request?: {generation, requestId}, frame?: {authorityId?, primaryEpoch?, grant?, delegation?, claimReceipt?}, args?: {...} }
Reply = { ok: true, result, claimReceipt? } | { ok: false, error: { code, message, requiredBytes? } }
```

**Ablauf** (`SpaceService.handle`, in dieser Reihenfolge):

1. Der Text ist länger als `maxFrameBytes`: `ResourceExhausted`. Kein JSON: `BadRequest`. Ein einzelnes Surrogat in
   einem Text oder Schlüssel wird U+FFFD (Abschnitt 6), bevor irgendetwas den Aufruf sieht, also auch vor dem Argument-Hash.
2. `method` fehlt oder ist kein Text: `BadRequest`. Unbekannte Methode: `UnsupportedMethod`. `args` kein Objekt:
   `BadRequest`.
3. **Identität** aus der Verbindung, nie aus dem Aufruf. Keine: `Unauthenticated`.
4. **Rate:** höchstens `maxCallsPerWindow` Aufrufe (1024) je Peer und Fenster (1000 ms); darüber
   `ResourceExhausted` ("the peer exceeded its call rate"). Die Tabelle fasst höchstens 10.000 Peers.
5. **Rolle** erlaubt die Methode nicht: `PermissionDenied`.
6. **`frame`:** Kein Objekt: `BadRequest`. Fremde `authorityId`: `AuthorityMismatch`. Andere `primaryEpoch`:
   `StaleEpoch`; `resolveOperation` darf eine frühere nennen.
7. **Request-Pflicht:** Die ändernden Methoden `write`, `read`, `take`, `cancelOperation`, `txn` (außer
   `action:"status"`), `lease`, `wait`, `notify`, `ack` und `batch` brauchen `request`; ohne: `BadRequest`.
8. **Space-Grenze:** Der Aufruf ist größer als `maxFrameBytes` des Spaces: `ResourceExhausted`.
9. **Antwort:** Die Methode läuft. Passt die Antwort nicht in den Rahmen: `ResourceExhausted`.

**Standard-Space:** `space` fehlt oder ist `"default"`. Ein unberührter Store legt ihn beim ersten `hello` an.

## 4. Identität, Rollen und Typen

Rollen (`DEFAULT_POLICY`):

| Rolle | Methoden |
|---|---|
| `admin` | alle |
| `host`, `member` | alle aus `METHODS` |
| `resolution` | `hello`, `pollOperation`, `resolveOperation`, `cancelOperation`, `txn`, `lease` |
| `observer` | `hello`, `generation`, `read`, `pollOperation`, `resolveOperation`, `cancelOperation`, `readAll`, `count`, `stats`, `spaces`, `changes`, `notify`, `events`, `ack` |
| `unpaired` | `hello`, `generation` |

**Typen:** Eine Rolle kann auf Typen beschränkt sein; Supertypen zählen mit. Mit Beschränkung gilt:

- Templates ohne Typ werden abgewiesen.
- `stats`, `spaces` und `changes` brauchen eine Rolle ohne Typgrenze.

Der Principal ist `{peerId, agentId?}`. Als Eigentümer erscheint er als `principalId` = `canonicalJson([peerId, agentId ?? null])`,
also `"[\"local\",null]"` (Vektoren: `crypto.json` → `derived.principalId`).

## 5. Request-Identität

- **Generation:** `generation` gibt eine aus. Sie lässt neue Request-Ids eine Stunde lang zu (`generationAdmitMs`).
  Ihre Form ist `g<32 hex>.<64 hex>`: Nonce, dann HMAC-SHA256 mit dem Signierschlüssel des Spaces über
  `canonicalJson({nonce, ...rec})`. Der Schlüssel wird als UTF-8-Text benutzt, nicht als die Bytes seiner Hex-Form
  (`crypto.json` → `generations`).
- **Request-Id:** wählt der Client, ein nicht leerer Text; eine Längengrenze setzen nur Rahmen und Claim-Speicher
  (`maxClaimBytes`). Mit derselben Generation und denselben Argumenten
  liefert eine Wiederholung die gespeicherte Antwort (Wirkung genau einmal). Mit anderen Argumenten kommt
  `RequestConflict`.
- **Gespeicherte Ergebnisse** bleiben 24 h (`claimResultMs`); danach `ResultExpired`.
- **Argument-Hash:** `digestJson({method, args})` über die Domänenform des Aufrufs (`src/rpc-domain.ts`). Beispiel:
  `take` mit `ifExists:true` heißt `takeIfExists`, `txn` heißt `txn.begin` usw. `resolveOperation` vergleicht ihn,
  Delegation und Router signieren ihn (`crypto.json` → `derived.argumentHash`).
- **Wiederholung im Client:** Nur ein Transportfehler wird wiederholt, mit derselben Identität (5 Versuche,
  Backoff 100 ms bis 2 s). Eine `ok:false`-Antwort ist eine Antwort und wird nie wiederholt.

**Offener Punkt:** Für `timeoutMs: null` setzt der Dienst den Standard 0 ein, `rpcDomain` aber −1. Ein
`resolveOperation` mit dem Hash aus `rpcDomain` passt dann nicht zum gespeicherten Request. `RemoteSpace` sendet
`null` nicht. Bis das geklärt ist, gilt für Rust: wie TypeScript.

## 6. Werte

| Wert | Form |
|---|---|
| Zeit | ms seit 1970 als JSON-Zahl; `FOREVER` = 9.007.199.254.740.991 (2^53 − 1) heißt „nie“ |
| Dauer (`leaseMs`, `timeoutMs`, `ms`, `txnLeaseMs`) | ganze Zahl ≥ 0 oder `"forever"`. Fehlend: Lease `ANY` (−1, der Space wählt: 1 h), Timeout `NO_WAIT` (0) |
| Template | `null` (alles) oder `{type?, fields?, id?}`. `type` passt auch auf Supertypen (`types`). Ein Feld mit `null` ist ein Platzhalter. Werte vergleichen tief |
| Entry (Antwort) | `{id, gid, type, types, fields, owner}`; `types` beginnt mit `type`; `gid` = `<spaceId>/<id>`; `owner` ist die principalId |
| Lease | `{id, expires}` |
| Ids | `e`, `t` und `n` mit Inkarnation und laufender Nummer, z. B. `e0a1b2c3d-4` |
| Stream | `streamId` = `<spaceId>:<incarnation>`, `rev` die Revision des Spaces |

**Texte sind wohlgeformt (R-D10):** Ein einzelnes Surrogat, etwa von einem `slice` mitten in einem Emoji, kommt nur als
Escape wie `\ud83d` auf die Leitung. Der Dienst ersetzt es durch U+FFFD, wie `String.prototype.toWellFormed`
(`wellFormed` in `src/service.ts`). So stehen in einem Store nur Texte, die jede Implementierung halten kann. Das gilt
am Eingang des Dienstes; Host-Code, der `PhiSpaces` direkt nutzt, muss selbst darauf achten. Ein Store mit so einem Wert
wird vom Rust-Store nicht geöffnet. Projekte kürzen Text mit `cutText` (`phi-spaces`).

Alle Zahlen sind IEEE-754-Doubles; ganze Zahlen über 2^53 kommen nicht vor. Kanonisches JSON (für Hashes und
Signaturen, nie für die Leitung selbst) folgt RFC 8785 (`canonical.json`):

- Schlüssel nach UTF-16-Codeeinheiten sortiert: `😀` vor `` vor `￿`.
- Zahlen in ECMAScript-Form: `1e+21`, `1e-7`, `100000000000000000000`, `-0` als `0`.
- Nicht-endliche Zahlen werden abgewiesen.
- U+2028 und U+007F bleiben unmaskiert.
- Ein unpaariges Surrogat wird als `\ud800` geschrieben. Das zeigt `canonical.json`, kommt aber nach Abschnitt 6 nicht
  mehr vor; was der Dienst daraus macht, steht dort unter `wellFormed`.

## 7. Methoden

`ändernd` heißt: braucht `request`. Die Antworten sind in `wire.json` an einem Lauf zu sehen.

| Methode | Argumente | Antwort |
|---|---|---|
| `hello` | `protocol: 1` (sonst `UnsupportedProtocol`) | `{protocol, hostId, spaceId, alias, incarnation, streamId, rev, authorityId, primaryEpoch, role:"single", principal, roles, features, limits, capabilities}` |
| `generation` | — | `{generation, admitUntil}` |
| `write` (ändernd) | `entry: {type, types?, fields}`, `leaseMs?`, `txn?`, `unique?: [Feldname]`, `transient?` | Lease. `unique`: Konflikt → `UniqueConflict` |
| `read` / `take` (ändernd) | `template`, `timeoutMs?`, `waitMs?` (≤ 25 s, Standard `maxPollMs`), `txn?`, `ifExists?`, `deadline?` | `{state:"done", entry\|null, locked?}` oder `{state:"pending", deadline}` |
| `pollOperation` | `targetRequest: {generation, requestId}`, `waitMs?` | ClaimView `{state, deadline, method, result?, locked?, error?, …}` |
| `resolveOperation` | `targetRequest`, `method`, `argumentHash`, `primaryEpoch` | ClaimView oder `{state:"notAdmitted", …}`; falscher Hash → `RequestConflict` |
| `cancelOperation` (ändernd) | `targetRequest` | ClaimView |
| `readAll` | `template`, `maxBytes?`, `limit?`, `cursor?`, `token?`, `txn?`; oder `chain: {head?, cursor?, nextField?, limit?, maxBytes?}` | `{items, next, rev, streamId, token?}` |
| `count` | `template`, `txn?` | `{value, rev, streamId}` |
| `stats` | — | Zahlen des Spaces und `process: {cpuMs, rssBytes, heapBytes, at}` |
| `batch` (ändernd) | `ops`: 1 bis 64 Schritte `begin`, `commit`, `abort`, `write`, `take`, `read`; jeder Schritt braucht das Recht seiner Methode | ein Ergebnis je Schritt |
| `spaces` | — | `[{spaceId, alias, createdAt}]` |
| `txn` (ändernd außer `status`) | `action: begin` mit `leaseMs?`; `commit`, `abort`, `status` mit `id` | `begin`: Lease; `{state:"committed"}`, `{state:"aborted"}`, `status`: `{state}` |
| `lease` (ändernd) | `action: renew` mit `id`, `ms`; `cancel` mit `id` | `{expires}` bzw. `{state:"cancelled"}`; unbekannt → `TransactionError` |
| `changes` | `afterRev`, `waitMs?`, `maxBytes?`, `streamId?` | `{streamId, batches:[{rev, at, ops}], next, rev, more}` oder `{resync:true, reason, streamId?}` |
| `notify` (ändernd) | `template`, `leaseMs?`, `txn?`, `handback?`, `consumer?` | `{eventId, lease}` |
| `wait` (ändernd) | `template`, `timeoutMs?`, `deadline?`, `take?` (Standard true), `txnLeaseMs?`, `handback?`, `consumer?` | `{id}` |
| `events` | `mailboxEpoch?`, `after?`, `waitMs?`, `maxBytes?`, `consumer?` | `{mailboxEpoch, events:[{seq, at, event}], next, more, gap?}` |
| `ack` (ändernd) | `mailboxEpoch`, `upTo`, `consumer?` | `{mailboxEpoch, acked}` |

**Lange Abfragen** (`pollOperation`, `changes`, `events`, `read`/`take` mit `waitMs`):

- Sie warten höchstens bis `waitMs`, nie über `maxPollMs` (25 s).
- Ohne `wakeOnCommit` schauen sie alle 50 ms nach.
- Mit `wakeOnCommit` wachen sie beim ersten Commit auf und schauen danach höchstens alle 25 ms; spätestens nach
  1 s schauen sie auch ohne Commit (für Entscheidungen, die ohne Commit kommen, etwa eine abgelaufene Frist).

**Seitenbudget:** `maxBytes` gilt höchstens bis `Rahmen − 21`, das Ergebnisbudget einer Operation bis `Rahmen − 64`.
Passt das nächste ganze Element nicht hinein, kommt `ResponseBudgetTooSmall` mit `requiredBytes`. Ist es größer als
der Rahmen selbst, kommt `ResourceExhausted`.

`consumer` muss, wenn angegeben, der eigene Principal sein; sonst `PermissionDenied`.

## 8. Fehlercodes

`code` ist Vertrag, `message` freier Text. `RemoteSpace` macht aus diesen Codes eigene Fehlerklassen; die übrigen
werden `RemoteError`.

| Code | Wann | Klasse im Client |
|---|---|---|
| `BadRequest` | Form der Argumente, ungültige Werte | `IllegalArgumentError` |
| `Unauthenticated` | Verbindung ohne Identität | `RemoteError` |
| `PermissionDenied` | Rolle oder Typgrenze | `PermissionError` |
| `UnsupportedMethod` / `UnsupportedProtocol` | unbekannte Methode, anderes `protocol` | `RemoteError` |
| `UnknownSpace` | `space` unbekannt | `RemoteError` |
| `AuthorityMismatch` / `StaleEpoch` | `frame` passt nicht | `RemoteError` |
| `RequestConflict` | Request-Id mit anderen Argumenten, falscher Argument-Hash | `RequestConflict` |
| `RequestExpired` | Generation unbekannt, fremd, abgelaufen oder falsch signiert | `RequestExpired` |
| `ResultExpired` | gespeichertes Ergebnis abgelaufen | `ResultExpired` |
| `IncarnationChanged` / `NotCommitted` | Request einer früheren Inkarnation oder Epoche | gleichnamig |
| `OperationCancelled` | Operation abgebrochen | `OperationCancelled` |
| `ResourceExhausted` | eine Grenze (Rahmen, Commit, Rate, Pending, Speicher) | `ResourceExhausted` |
| `ResponseBudgetTooSmall` | Seite zu klein für das nächste Element; `requiredBytes` | `ResponseBudgetTooSmall` |
| `SnapshotExpired` / `RevisionAhead` | Seiten-Token verfallen, Revision voraus | gleichnamig |
| `TransactionError` | Transaktion oder Lease unbekannt oder nicht aktiv | `TransactionError` |
| `CompletionViolation` | Abschlussprofil verletzt | `CompletionViolation` |
| `UniqueConflict` | `unique` findet einen anderen Entry | `UniqueConflict` |
| `MailboxEpochMismatch` / `InvalidAck` | Mailbox-Epoche, ACK über dem Stand | gleichnamig |
| `CommitSealed` | primary/sync: Commit versiegelt, nicht bestätigt; den Request weiter abfragen | `CommitSealedPending` |
| `MergeTypeNotExclusive` | exklusive Operation auf einem Merge-Typ | gleichnamig |
| `ReplicaConfigPending` / `StalePolicyVersion` / `RoutingConflict` / `MemberDrained` / `MigrationRequired` / `ProofRequired` | Föderation (R6) | |
| `Internal` | alles andere; Text immer `internal error` | `RemoteError` |

## 9. Grenzen

`DEFAULT_LIMITS` in `src/core.ts`, ein Space kann eigene haben (`hello` → `limits`):

| Grenze | Wert |
|---|---|
| `maxFrameBytes` | 262.144 |
| `maxEntryBytes` | 65.536 |
| `maxCommitBytes` | 196.608 |
| `maxEventBytes` | 163.840 |
| `maxTypeChars` / `maxTypes` | 128 / 16 |
| `maxRegsPerOwner`, `maxWaitersPerOwner`, `maxTxnsPerOwner` | je 20 |
| `maxSpaceBytes` | 64 MiB |
| `claimResultMs` / `generationAdmitMs` | 24 h / 1 h |
| `maxPollMs` (Dienst) | 25.000 |
| `maxPendingPerPrincipal` / `maxPendingPerPeer` (Dienst) | 32 / 128 |

## 10. Speicherdatei

Der eigene Store (`src/store/sqlite.ts`) hat diese Tabellen, alle `STRICT`:

- `store_meta(key, value)` mit `format_version` (heute 2), `store_id` und `commit_seq`.
- `documents(kind, key, version, value)`: ein Dokument je Zeile, `value` ist JSON-Text, `key` `""` für Dokumente
  ohne Schlüssel.
- `parts(kind, key, part, id, ord, value, at, grp, flag)`: ein Datensatz eines Teils je Zeile.

Dazu kommen die Indizes `parts_order`, `parts_at`, `parts_grp` und `parts_open`, WAL-Modus und eine Sperrdatei
`<datei>.owner` mit exklusiver Sperre, solange der Store offen ist.

Eine Datei mit Tabellen, aber ohne `store_meta`, wird abgewiesen, ebenso eine mit höherer Formatnummer.
`store.sql` ist eine solche Datei als SQL; `store.expected.json` zeigt, was das Lesen beantwortet.

## 11. Vektoren und Nachspielen

| Datei | Inhalt |
|---|---|
| `canonical.json` | Eingaben als JSON-Text mit kanonischer Form, SHA-256, `jsonBytes` und `JSON.stringify`-Text; Zahlen nach Bitmuster; ein unpaariges Surrogat |
| `crypto.json` | Generationen, Beweis und Grant mit Ed25519 (deterministisch) und P-256 (zufällig, nur verifizieren), Testschlüssel aus festen Geheimnissen, Fingerprints, Token-Hashes, Argument-Hashes |
| `wire.json` | eine Sitzung gegen `SpaceService.handleText`: Peer `local`/`member`, Uhr fest ab `t0` und vom Skript bewegt, kein Hintergrunddienst |
| `store.sql` / `store.expected.json` | eine Store-Datei nach einer solchen Sitzung und die Antworten einer lesenden Sitzung (Uhr `t0 + 5000`) |

**Ersetzte Zufallswerte:** In `wire.json` stehen Platzhalter `<hostN>`, `<spaceN>`, `<incarnationN>`, `<generationN>`
und `<mailboxN>`, nummeriert nach erstem Auftreten. Jeder taucht zuerst in einer Antwort auf. Ein Nachspieler lernt
den echten Wert aus dieser Antwort und setzt ihn in die folgenden Aufrufe ein. `stats.process` wird `"<process>"`.

**Vergleich für eine zweite Implementierung:** Antwort für Antwort nach dem Ersetzen, ohne `error.message`. Dazu
muss ihr Server die Uhr von außen setzen lassen (R3: `--test-hooks`).
