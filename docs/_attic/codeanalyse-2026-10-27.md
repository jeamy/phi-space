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

## Offen (dokumentierte Risiken/Gelegenheiten, bewusst nicht angefasst)
- `SocialSwarmHub` God-Class (1.8k Zeilen): `#remote*`-Shard-Logik extrahierbar.
- `hub.ts snapshot()` liest 11 Typen komplett pro Push; Snapshot-Cache pro Revision oder readPage mit Budget wäre der Hebel.
- `#syncRemoteShard`/`#pageScan` (help-site) lesen alle Posts statt gezielter Zählung/Seiten – kommentierte Fallbacks bis History-Index steht.
- `takeAll(tmpl)` als Bibliotheks-Operation statt `while (await take(tmpl, NO_WAIT))` (7× in den Projekten) – bräuchte eigenen RPC.
- `#remoteCall`-Timeout neben `RemoteSpace.callTimeoutMs` (beides, defensiv).
- `help-site/dist/` enthält generierte Artefakte neben den Quellen (Build-Output im Checkout).
- Driftende Kopien markdown.ts/palettes.ts/ws.ts/theme.ts/launch.ts ~1.2k Zeilen (Antwort zu Zusammenfassung siehe Bericht).
