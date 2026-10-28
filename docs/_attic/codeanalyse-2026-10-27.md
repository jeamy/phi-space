# Codeanalyse 27.10.2026: Kern, Store, codemode-chat, help-site, spaces-mmo

Fortsetzung der Analyse vom 18.10. (`codeanalyse-src-2026-10-18.md`). Status der umgesetzten Punkte.

## Behoben

**Logiklücken**
- L1: `serve()` fing `reserve`/`assertMemberTake`-Fehler nicht – ein voller Waiter ließ fremde Operationen scheitern. Jetzt `ResourceExhausted` → `deferMaintenance`, wie im Mailbox-Pfad (Test in test-core).
- L2: `Watch` meldete den Abort-Listener nie ab (Leak pro blockierendem Read/Take). `finish()` räumt ihn jetzt (Test in test-own-store).
- L3: `SpaceLike.changes` kennt `waitMs`; `PhiSpaces.changes` long-pollt über `commitSignal`. Casts in hub.ts/gateway.ts entfernt.
- L4: "locked" läuft durch: Claim→Service-Reply→RemoteSpace. Neues optionales `SpaceLike.probe(tmpl, timeout, {take})` → `{entry, locked}`; Feature-Flag `read.locked` im hello. `existing()`/`readExisting` in codemode-chat, spaces-mmo, examples/cache nutzen es statt der Zeitheuristik.
- L5: `UniqueConflict` als eigener Fehler mit ErrorCode, über Service/Remote abgebildet; alle `/unique/i`-Regexe in codemode-chat ersetzt. `TransactionError` statt Textmatch in judge-host/model-host; `historyGone` in swarm.ts/hub.ts/gateway.ts prüft `SnapshotExpired`/`RevisionAhead` instanceof.
- L6: `sqlite.ts drain()` wartet auf Idle-Signal statt 1-ms-Busy-Loop.

**Optimierungen**
- O1: `s.outboxBytes` als Running-Tally statt `jsonBytes(s.outbox)` pro Zugriff (Mutationsstellen aktualisieren, Reset-Stellen löschen → lazy Recompute).
- O2: `listPage` ruft `standing()` nur einmal pro Entry, View nur bei Treffer.
- O3: `op()` committet nur noch wenn das Dokument fehlt (wie readPage).
- O4: `snap()`/`watch()` lesen die Registry einmal (`idAndRegistry`).
- O5/D2: `entryBytes(s)`-Helper, vier Stellen zusammengezogen.
- O6: `entryChangeId` statisch importiert (Merge-Call).
- O7: `due()`-Statement geht durch `#prep` (Cache nach SQL-Text).

**Toter Code**
- `createContextKey`, `withCancel` (context.ts), `PAGE_OVERHEAD` (core.ts), `isSyncStore` (sync-store.ts), `JsonObject` (types.ts), `deadline = r.deadline` in op() entfernt.
- Unterprojekte: `llmAvailable`, `levelName`, `TickerFields` entfernt.

**Doppelter Code**
- D1: `deepFreeze` einmal in host.ts (exportiert), sqlite.ts importiert.
- D3: `dropWaiter(s, w)`-Helper.
- D4: `partAt` in host.ts/sqlite.ts statt duplizierter Path-Reduce.
- D5: `end()`/`revoke()` in draft.ts zusammengezogen.
- D6: `DEFAULT_POLICY` host/member → `METHODS`.
- D7: sqlite close/abandon nutzen gemeinsame Schlusssequenz (idle waiters aufgelöst in beiden Wegen).
- D8: `allowed(id,'resolveOperation')` läuft einmal (im Feld gehalten).

**Unterprojekte**
- `Gateway`: modelChars/modelNames/protoIcons sind Instanzfelder statt Modul-Globals (Instanzen teilen keinen Zustand mehr).
- `#currentRev` nutzt `readPage().rev` statt Binärsuche über Fehlermeldungen.

## Nachtrag 27.10.2026, zweiter Durchgang

**Umgesetzt**
- Space-Helfer in der Bibliothek (`src/space-client.ts`, aus `phi-spaces`): `parseTarget` (ersetzt fünf Kopien des
  Adress-Parsers, `parseListen` in `standalone.ts` ist dieselbe Funktion), `connectSpace`, `readExisting`/`takeExisting`/
  `StillHeld`, `peek`, `takeAll`, `awaitWork`, `keepAlive`. Die Werte je Projekt (Wartezeit 10 s bzw. 2 s, Timeouts,
  Trace von spaces-mmo) setzen die `server/space.ts` der Projekte ein. Ohne `read.locked` beim Server (`UnsupportedOperation`)
  fällt der Helfer auf readIfExists/takeIfExists zurück. Test: `test/test-space-client.test.ts`.
- `ws.ts` einmal als `phi-spaces/ws` (`src/ws.ts`), das Nachrichtenlimit als Option (spaces-mmo 600/min, sonst 120); die
  drei Kopien sind weg. Entscheidung 3 in `spaces-mmo/docs/README.md` ist entsprechend geändert.
- Kopien, die bleiben müssen (Next.js bündelt nichts außerhalb des Projekts; `env.ts` löst Pfade von seinem Ort auf):
  `client/lib/palettes.ts`, `client/lib/markdown.ts`, `server/env.ts` – `test/test-shared-copies.test.ts` vergleicht sie.
- `takeAll`: die sieben `while (await take(…, NO_WAIT))`-Schleifen in codemode-chat rufen den Helfer.
- codemode-chat `snapshot()`: Seiten, die sich verbinden oder laden (viele auf einmal nach einem Neustart des
  Web-Prozesses), bekommen bei gleicher Space-Revision (vor den Lesezugriffen gelesen) höchstens 2 s lang denselben
  Snapshot; danach wird er freigegeben. Ein Push kommt, weil sich etwas geändert hat, und baut seinen eigenen (ohne
  zusätzliche Revisionsabfrage) – die Kosten je Push sind also unverändert, begrenzt durch die `limit`s aus dem ersten
  Durchgang. Die CodeTask-Zeilen liest `session()` einmal für den Snapshot mit. Die Grenzprüfungen und das Löschen
  eines Blocks lesen weiter frisch (mehrere Prozesse).
- spaces-mmo `Gateway.#follow`: der Start liest alle Typen seitenweise (`readPage`, 256 KiB je Seite) statt mit
  unbegrenztem `readAll`.
- help-site: der Remote-Shard-Teil von `SocialSwarmHub` ist `RemoteShard` (`server/social/remote-shard.ts`). Dabei
  behoben: der Beitritt las die Revision erst nach den Posts (Änderungen dazwischen gingen verloren), jetzt gilt die
  Revision der ersten Seite; und `readAll` mit `limit: 4000` lieferte die *ältesten* 4 000 Posts (Eintragsreihenfolge),
  bei einem größeren Shard kamen so alte Posts in den Index. Jetzt werden alle Seiten (je höchstens 256 KiB) gelesen und
  nur die letzten 4 000 behalten.
- Reste aus D1/D3: `deepFreeze` einmal in `store/types.ts` (auch `disk-map.ts` hatte eine Kopie), das letzte
  `s.waiters.splice` in `core.ts` nutzt `dropWaiter`.
- Doku-Fehler: `SpaceLike.probe` liest standardmäßig (`take: true` nimmt), der Kommentar sagte das Gegenteil.
- Test `swarm-retention` („history has moved past the hub's cursor“) warf noch einen einfachen `Error`; seit L5 erkennt
  der Hub nur `SnapshotExpired`/`RevisionAhead`, der Test wirft jetzt `SnapshotExpired`.

**Bewusst offen, mit Grund**
- `takeAll` als eigener RPC: müsste durch Claims/Idempotenz, Member-Admission, Gate-Rollen, Replikation und die
  Feature-Aushandlung (nano und big werden nicht gleichzeitig aktualisiert). Die Aufrufer löschen meist 0–2 Einträge.
- `#remoteCall` (help-site, jetzt `RemoteShard.call`): nicht doppelt – `RemoteSpace` begrenzt nur den einzelnen Versuch
  und wiederholt; die Gesamtzeit gegen einen toten Shard begrenzt erst dieser Timeout.
- `#syncRemoteShard`: ein `count` je `replyTo` wären Hunderte Aufrufe statt einer Leserunde beim Beitritt; geblieben ist
  das Lesen (jetzt in Seiten).
- `#pageScan`: Fallback, bis der History-Index steht (so kommentiert).
- `existsOrHeld()` in spaces-mmo: nach L4 überflüssig, die `StillHeld`-Zweige sind kurz.
- `formatStatus`/`formatWidget`/`watchLive`, `LiveMirror`, `runTupleBasics`, `SWARM_CLAIM_RESULT_MS`: von Tests,
  Beispielen oder der Doku genutzt.
- Die Liste der 72 nur intern genutzten Exporte (`out-dead.txt`) liegt nicht vor; ohne Werkzeug (knip/ts-prune) nicht
  zuverlässig nachzuprüfen.
- `help-site/dist/` ist nicht eingecheckt (`help-site/.gitignore`), dort ist nichts zu tun.
- `theme.ts`/`ThemeControls.tsx` und `launch.ts` bleiben je Projekt verschieden (Sprache, `prefers-color-scheme`, Rollen).

## Offen nach dem ersten Durchgang (Stand vor dem Nachtrag)
- `SocialSwarmHub` God-Class (1.8k Zeilen): `#remote*`-Shard-Logik extrahierbar.
- `hub.ts snapshot()` liest 11 Typen komplett pro Push; Snapshot-Cache pro Revision oder readPage mit Budget wäre der Hebel.
- `#syncRemoteShard`/`#pageScan` (help-site) lesen alle Posts statt gezielter Zählung/Seiten – kommentierte Fallbacks bis History-Index steht.
- `takeAll(tmpl)` als Bibliotheks-Operation statt `while (await take(tmpl, NO_WAIT))` (7× in den Projekten) – bräuchte eigenen RPC.
- `#remoteCall`-Timeout neben `RemoteSpace.callTimeoutMs` (beides, defensiv).
- `help-site/dist/` enthält generierte Artefakte neben den Quellen (Build-Output im Checkout).
- Driftende Kopien markdown.ts/palettes.ts/ws.ts/theme.ts/launch.ts ~1.2k Zeilen (Antwort zu Zusammenfassung siehe Bericht).
