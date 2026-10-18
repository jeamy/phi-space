# Codeanalyse `src/` — Logikfehler, Duplikate, toter Code, Optimierung

Datum: 2026-10-18 (überprüft und nachgezogen am selben Tag)
Umfang: gesamtes `src/`-Verzeichnis (14809 Zeilen in 87 `.ts`-Dateien)
Methode: drei parallele Tiefenanalysen (Core-Semantik, Service/Transport/Federation, Recovery/Membership/Control),
danach eine zweite Prüfung jedes Befunds gegen Code, pi-durable und Spezifikation (`docs/federation-plan-v3.md`).

Jeder Punkt trägt einen Status:

- **behoben** — bestätigt und im Code korrigiert (mit Regressionstest, wo angegeben),
- **abgeschwächt** — der Befund trifft zu, der Schweregrad oder der Mechanismus war falsch beschrieben,
- **kein Fehler** — die ursprüngliche Annahme war falsch oder das Verhalten ist beabsichtigt,
- **offen** — bestätigt, bewusst noch nicht umgesetzt (Begründung im Punkt).

Datei:Zeile-Belege beziehen sich auf den Stand vor den Korrekturen.
Nach den Korrekturen: `npm run typecheck` sauber, `npm test` 754 Tests (753 bestanden, 1 optionaler Fall
übersprungen, keine Fehler), `npm run check:branding` grün.

---

## Ursprünglich „Kritisch“

### 1. `migrate` verliert `runGates` und `archived` — abgeschwächt, behoben

`src/core.ts:157-189`

Die Felder fehlten tatsächlich. Falsch war die Annahme, dass `migrate` bei jedem Reopen läuft: pi-durable ruft
`migrate` nur auf, wenn die gespeicherte Version kleiner als die Definitionsversion ist
(`materializeDocumentValue` in `pi-durable/dist/documents.js`). `Space` und `NamedSpace` stehen auf Version 5,
und `runGates`/`archived` existieren nur in v5-Dokumenten. Ein normales Reopen verliert nichts; die Lücke wäre
erst beim nächsten Versionssprung zu Datenverlust geworden (latent, nicht akut).

**Behoben:** `migrate` übernimmt `runGates` und `archived`.
Test: `test-core` „migrate keeps run gates and the archive marker“.

### 2. `finish` kann nach `delete s.txns[id]` werfen — abgeschwächt, Ursache behoben

`src/core.ts:827-848`

Ein „inkonsistenter Zwischenzustand“ entsteht nicht: jede Operation läuft in einem `host.commit`, ein Wurf
verwirft den gesamten Entwurf. Das tatsächliche Risiko ist Liveness: Wirft das `registrationClosed`-Event bei
jedem Versuch, scheitert jedes Commit/Abort der Transaktion — und weil `settle` am Anfang fast jeder Operation
läuft, kann eine abgelaufene Transaktion den ganzen Space blockieren. Dasselbe gilt für `registrationClosed`/
`timeout` in `expire` und für die Publish-Events in `finish`.

Im Normalbetrieb kann das Event nicht zu groß sein: `notify` und `addWaiter` prüfen
`handback + EVENT_OVERHEAD ≤ maxEventBytes` sowie jedes passende Entry. Die eigentliche Ursache war
`setLimits`: Ein nachträglich gesenktes `maxEventBytes` wurde nicht gegen bestehende Registrierungen und
Waits geprüft.

**Behoben:** `setLimits` lehnt ein gesenktes `maxEventBytes` ab, solange eine bestehende Registrierung oder ein
Wait damit ein zu großes Event erzeugen könnte. Test: `test-core` „a lower event limit is refused …“.

---

## Ursprünglich „Hoch“

### 3. `expire` setzt Watermark zu hoch bei Budget-Erschöpfung — abgeschwächt, behoben

`src/core.ts:458-476`

Der Wert `at` liegt über dem echten Minimum der verbliebenen Dead-Entries. Praktisch folgenlos, weil die Zeit
monoton ist und beim nächsten `settle` dieselbe Transaktion (gleiches `expires`) wieder das Minimum ist; ein
Sweep mit `at' < at` kommt nicht vor. `nextExpiry` lieferte aber `at` statt des frühesten verbliebenen Ablaufs.

**Behoben:** Watermark = `min(Minimum der Lebenden, Ablauf des ersten nicht entfernten Dead-Entries)`.
Test: `test-core` „an expiry sweep cut short by the commit budget …“.

### 4. `policy?.completionProfiles.some` — abgeschwächt, kein Fix nötig

`src/core.ts:800`

`completionProfiles` ist im Typ `FederationPolicy` Pflicht (`routing-semantics.ts:52`), der Absturz ist nur
hypothetisch. **Die ursprüngliche Empfehlung, die Vorabprüfung zu streichen, war falsch:** Sie verhindert gerade,
dass `assertMemberTake` (ohne try/catch, `core.ts:818`) für Entries ohne Abschlussprofil aus `serve` wirft.
Sie bleibt.

### 5. `refreshReservations` ist O(Txns × Entries × (Regs + Waiters)) — behoben

`src/core.ts:274-287`

**Behoben:** Ein einziger Durchlauf über die Entries verteilt die Publish-Kosten auf die (höchstens zwei)
beteiligten Transaktionen; `publishCost` läuft je Entry einmal statt je Transaktion. Damit O(Entries × (Regs +
Waiters)) statt zusätzlich × Txns.

**Behoben (inkrementell, exakt):** Die vorgeschlagene reine Delta-Rechnung auf `t.reserved` wäre nicht äquivalent
gewesen (`reserved` ist ein Maximum, keine Summe). Exakt ist dagegen: Jede Kostensteigerung einer Transaktion
läuft über `reserve` (Writes, Takes) oder über `refreshReservations` (Subscriptions); `reserved` liegt daher nie
unter der vollen Nachzählung. Eine Transaktion, die die neue Registrierung bzw. der neue Wait nicht berührt
(kein passendes eigenes Entry, keine Registrierung unter ihr), behält genau `reserved`. Nachgezählt werden nur die
berührten Transaktionen und solche ohne Reservierung (ältere Dokumente). Die Limitprüfungen laufen für alle.
Test: `test-core` „subscriptions keep every transaction's completion reservation at the full recount“
(randomisiert, vergleicht gegen die alte vollständige Nachzählung; eine Mutation, die berührte Transaktionen
nicht nachzählt, schlägt fehl).

### 6. Hot-Pfad `write` serialisiert den Entry mehrfach — behoben

`src/core.ts:540-568`

**Behoben:** `write` misst die View einmal und reicht die Größe an `checkEventSize` und `publishCost` weiter;
`publishCost` läuft einmal statt zweimal; `preflightFanout` baut eine View für alle Kandidaten-Events (dort nur
gemessen, nie gespeichert). `notifyWrite` erzeugt weiterhin eine View je ausgelöstem Event: Diese Events werden
dauerhaft in Outbox/Mailbox abgelegt, ein gemeinsam referenziertes Objekt in einem Dokument-Draft wäre riskant.

### 7. Identischer `changeRequest`-Hash doppelt — behoben

`src/service.ts:414` / `435`

**Behoben:** Helper `changeRequestHash(principal, request)` in `service.ts`.

### 8. `pageAfter` ist O(n²) pro Seite — behoben

`src/entry-replication.ts:319-327`

**Behoben:** Kumulative obere Schranke (jedes Event und jede Position mit Komma, `positions`-Schlüssel immer
mitgezählt). Das exakte Frame wird nur serialisiert, wenn die Schranke nicht mehr passt; keine Array-Kopien pro
Event. Das Ergebnis ist identisch mit der alten Version (die Schranke liegt nie unter der exakten Größe).

### 9. `importSnapshotPage` ist O(Pages × History) — behoben, soweit semantisch möglich

`src/entry-replication.ts:401-418`

**Behoben:** Beim Seitenimport werden bereits gestagte Seiten nicht mehr je Import kanonisiert und gehasht. Ihre
Kette wurde bei der Aufnahme geprüft und ist im Ledger (`chainHash`, `nextOffset`) gebunden; nachgeprüft werden
nur Verkettung, Offsets und die Übereinstimmung mit dem Ledger. `finishSnapshotImport` prüft die vollständige
Kette wie bisher.

**Bewusst geblieben:** Die Prüfung jeder neuen Seite zusammen mit allen gestagten Events gegen den aktuellen
logischen Zustand (`append`). Sie ist Semantik, nicht Overhead: Der logische Zustand kann sich zwischen zwei Seiten
durch lokale Writes ändern, und Konflikte über Seitengrenzen (z. B. eine wiederverwendete Request-ID) müssen schon
beim Seitenimport abgelehnt werden (`test-entry-snapshot-transfer`). Dieser Anteil bleibt O(Seiten × Historie).

### 10. Reihenfolgeabhängiger Target-Vergleich — teilweise kein Fehler, behoben

`src/federation-rpc.ts:45`

**Behoben:** Vergleich über `canonicalJson`. Ein konkreter Fehlerfall wurde nicht nachgewiesen, die
Abhängigkeit von der Schlüsselreihenfolge war aber real.

**Kein Fehler:** `routing-semantics.ts:186` vergleicht `keyFields`, ein String-Array. `canonicalJson` sortiert
keine Arrays; die vorgeschlagene Umstellung hätte nichts geändert.

---

## Ursprünglich „Mittel“

### 11. `intervalOf` ignoriert `r.minIntervalMs` — kein Fehler

Beabsichtigt, siehe Kommentar `core.ts:579`: „read from the limits when needed, so changing it also affects
existing subscriptions“. `minIntervalMs` ist ein Flag (nur für Konversationen gesetzt).

### 12. `assertMemberRenew` blockiert unter „draining“ auch Lease-Verkürzung — behoben

`src/member-admission.ts:130-139`

`renew` gilt für Entries, Transaktionen, Registrierungen und Waits. Laut Spezifikation sind „unbegrenzte
Lease-Verlängerungen keine Abschlussarbeit“ — Verkürzen war unnötig gesperrt.

**Behoben:** Transaktionen bleiben an ihre Abschlussgrenze gebunden; Entry-, Registrierungs- und Wait-Leases
dürfen während drain verkürzt, aber nicht verlängert werden. Test: `test-core` „while draining, entry leases …“.

### 13. `claims.sweepCursor` ist toter Code — abgeschwächt, behoben

Kein vergessenes Feature: Der Kommentar (`claims.ts:185`) begründet, warum kein Cursor geführt wird. Das
`delete` räumt ein Feld früherer Versionen auf (jetzt kommentiert). Real war das Sortieren aller Claim-Keys pro
`settle`.

**Behoben:** Erst filtern, dann nur die abgelaufenen Keys sortieren.

### 14. Toter Zweig in Deadline-Prüfung — kein Fehler

`!Number.isFinite(d) && d !== FOREVER || d < 0` bindet als `(!isFinite(d) && d !== FOREVER) || d < 0` und lehnt
`NaN` und `Infinity` ab. Redundant ist nur `d !== FOREVER`; wirkungslos ist der Zweig nicht.

### 15. `mailbox.bytes` serialisiert die ganze Mailbox pro Append — abgeschwächt, behoben

Neuberechnung und Subtraktion in `expireBox` folgen derselben Formel und waren nicht widersprüchlich. Real war
O(Mailbox) pro Event (bis 8 MiB).

**Behoben:** `appendMail` führt die Bilanz fort. Test: `test-core` „the mailbox byte tally matches …“.

### 16. `queueEvent`-Backlog-Check — behoben

**Behoben:** Helper `pendingFanout`: `canonicalJson(consumer)` einmal, keine `slice`-Kopien.

### 17. `expire` macht `splice(indexOf(e))` — behoben

**Behoben:** Ein `prune`-Durchlauf über eine Menge der entfernten Entries. Registrierungen und Waits bleiben bei
`splice` (je Owner begrenzt).

### 18. Rate-Limiter iteriert bei jedem Call die ganze Map — behoben

**Behoben:** Der eigene abgelaufene Eintrag wird direkt zurückgesetzt; die übrigen werden beim Anlegen eines
neuen Peers höchstens einmal pro Fenster gefegt, und immer, bevor eine volle Tabelle ablehnt.
Test: `test-ap1` „AP1 call rate table frees lapsed windows …“.

### 19. `checkTypes` prüft nur `some()` — kein Fehler, Folge dokumentiert

Beabsichtigt und getestet (`service.ts:43`, `test-service` „types per role including the supertypes“). Die Folge
stand aber nirgends: Weil der Schreibende die Supertypen selbst angibt, kann eine Rolle mit Grant auf `Job`
`{type: "X", types: ["Job"]}` schreiben. Typ-Grants sind keine Integritätsgrenze für Subtypen. Federation-Members
erzwingen dagegen die exakt deklarierten Supertypen (`member-admission.ts:57-60`).

**Dokumentiert** in `docs/api.md` (Abschnitt Dienst/Policy).

### 20. `epochForSpace` vor der `space`-Validierung — behoben

Harmlos (ein Wurf landet in `handle` und wird ein Fehler-Reply), aber unsauber. **Behoben:** `space` wird vor dem
Aufruf validiert.

### 21. Interne Fehlermeldungen gehen ungefiltert an den Client — behoben, erweitert

Der Befund nannte nur `socket.ts:96`. Der Hauptpfad war `SpaceService.error` (`service.ts:545`): Jeder nicht
klassifizierte Fehler ging mit `e.message` an den Peer.

**Behoben:** Beide Stellen senden `"internal error"` und protokollieren den Fehler serverseitig
(`console.error`). Klassifizierte Fehler behalten ihre Meldungen.

### 22. Kein Replay-Schutz für signierte Recovery-Calls — abgeschwächt, behoben

Der Socket liegt in einem privaten Verzeichnis (0700); ein „abgefangener“ Call setzt lokalen Zugriff voraus.
Die vorgeschlagene `requestId`-Sperre wäre falsch gewesen: `requestId` wird legitim wiederverwendet
(`ack:${recoveryId}` in `configured-recovery.ts`, idempotente Wiederholung in `test-operations`).

**Behoben:** Ein verifizierter, exakt gleicher signierter Call (Algorithmus, Signatur, Call) bekommt innerhalb
seines Gültigkeitsfensters die Antwort des ersten Aufrufs; der Handler läuft nur einmal. Nur verifizierte Calls
werden gemerkt (höchstens 4096). Eine neu signierte Wiederholung wird wie bisher ausgeführt.
Test: `test-operations` „out-of-band recovery answers a replayed signed call …“.

### 23. Operator-`controlAck` umgeht Host-Key-Prüfung — kein Fehler

Operator- und Supervisor-Key sind die gepinnten Vertrauensanker des Recovery-Sockets. Die erneute
`host-key:`-Prüfung gilt nur der Rolle `host`, weil genau dieser Key die Signatur getragen hat
(`recovery-service.ts:27-29`). Übersehen hatte der Befund, dass auch der Supervisor `controlAck` aufrufen darf.

### 24. `assertMemberTake` lässt txn-lose Takes im `draining` zu — kein Fehler

Spezifikation (`federation-plan-v3.md`, drain): „Ohne passendes Profil darf während drain keine neue verarbeitende
Take-Txn starten; reine destruktive Takes zum autorisierten Leeren bleiben möglich.“ Profilierte Aufgaben ohne
Transaktion lehnt `core.ts:612` ohnehin ab (`CompletionViolation`).

---

## Ursprünglich „Gering / Toter Code / Redundanz“

### 25. `sha256(canonicalJson(v))`-Helper dupliziert — behoben

**Behoben:** `digestJson(v)` in `canonical.ts`. Die Form kam nicht in 9, sondern in 23 Dateien vor (die
ursprüngliche Liste übersah u. a. `membership`, `federated-space`, `federation-journals`, `federation-references`,
`routing-semantics`, `data-admin`, `restore`, `claims`, `entry-replication`). Alle nutzen jetzt den zentralen
Helper (zusammen mit dem neuen Replay-Schutz 24 Dateien); `createHash` bleibt nur dort importiert, wo andere
Hashes gebildet werden.

### 26. Serialisierungs-Helper dreifach — behoben

**Behoben:** `src/json.ts` bündelt die Varianten, jede unter einem Namen, der ihre Validierung benennt:
`jsonCopy` (nachsichtig, `JSON.stringify`-Regeln, funktioniert auf Dokument-Drafts), `canonicalCopy` (lehnt nicht
endliche Zahlen ab), `strictJsonCopy`/`assertPlainJson` (nur reines, endliches JSON) und `jsonBytes`. `core`,
`claims`, `stream`, `router`, `routing-semantics`, `federation-policy`, `profile-transition`, `root-erasure`,
`data-admin`, `primary-sync` und `entry-replication` nutzen sie; jede Stelle behält ihre bisherige Semantik
(einzige Abweichung: `router`/`data-admin` messen `undefined` jetzt als 0 Bytes statt zu werfen).
`structuredClone` in `federated-space`/`distributed-erasure` bleibt: Es erhält `undefined`, was dort gewollt ist.

### 27. Fence-State-Persistenz doppelt — behoben

**Behoben:** `atomicJsonFile` in `src/json-file.ts`, genutzt von `fileFenceState` und `ContainerFencing`. Eine
korrupte Datei ergibt eine klare Fehlermeldung statt eines `SyntaxError`. Locking ist nicht nötig: je Host läuft
ein Fencing-Dienst.

### 28. Doppelte Frame-Längenmessung — behoben (nur `service.ts`)

**Behoben** in `handleText`. `remote.ts:152` misst nur einmal; dort war nichts doppelt.

### 29. `default:` im dispatch-Switch unerreicht — kein Fix

Defensiver Default gegen eine künftige Abweichung zwischen `METHODS` und Switch; bleibt.

### 30. Redundante Partition-Prüfung — kein Fehler

`partitions > 1 && routers.some(r => r.journalId === o.router.journalId)` ist eine echte Validierung: Mit
`partitionRouters` darf der Haupt-Router nicht zugleich ein Partitions-Router sein. Der Befund setzte voraus, was
die Prüfung erst sicherstellt.

### 31. Release-Defaults können falschen Zustand restaurieren — behoben (fail-closed)

**Behoben:** `NetcupFencing.release` und `ContainerFencing.release` brechen ohne gespeicherten Fence-Zustand ab,
statt `autostart=true` bzw. `unless-stopped` zu raten; gestartet wird dann nichts, die Sperre bleibt. Produktiv
nutzen beide Zustandsdateien, `fence` speichert den Vorzustand immer vor der Änderung; der Abbruch betrifft nur
eine verlorene oder gelöschte Zustandsdatei. Dann stellt der Operator den Eintrag wieder her oder setzt den Wert
bewusst von Hand. Tests in `test-netcup-fencing` und `test-container-fencing`.

---

## Ergänzungen der zweiten Prüfung

- `setLimits` prüfte ein gesenktes `maxEventBytes` nicht (Ursache von Punkt 2) — behoben.
- `SpaceService.error` gab nicht klassifizierte Fehlertexte weiter (Erweiterung von Punkt 21) — behoben.
- Die Mailbox-Bilanz (Punkt 15) braucht keinen Rückfall auf eine Neuberechnung: `bytes` gehört seit der
  ersten Mailbox-Version (Commit `f7bcfd5`) zu jeder Mailbox.

---

## Später gefundene Befunde (A–O)

Diese 15 Punkte standen in den drei Subagenten-Reports, wurden aber bei der ersten Konsolidierung nicht in die
31-Punkte-Liste aufgenommen. Jeder wurde gegen den aktuellen Code geprüft; fünf waren berechtigt, mehrere der
vorgeschlagenen Fixes hätten Prüfungen geschwächt.

### Behoben

#### A. `rotation.ts:39-40` — `core.probe`-Rückgabewerte ignoriert — behoben (Härtung)

Ein Fehlschlag ist heute nicht erreichbar: Beide Entries wurden im selben Commit als sichtbar gelistet, und
Control-Space-Entries werden bei einem Restore nicht als `restoredUnverified` markiert. Würde ein Take dennoch
verfehlen, blieben alter und neuer Schlüssel gleichzeitig aktiv. **Behoben:** Beide Takes müssen `found` liefern,
sonst `PermissionError`. Test: `test-auth` „key rotation refuses when an entry it listed cannot be consumed …“.

#### B. `fencing.ts:11` — fehlendes `durability` — behoben

Projektweit gilt ein fehlendes `durability` als `sync` (`durabilityOf`, `boot.ts:24`); F15 behandelte es als
„nicht sync“. Alle Permit-Erzeuger (`permitFor`) setzen den Wert, betroffen wären nur handgebaute Permits.
**Behoben:** Ein `primary`-Permit ohne `durability` wird wie `sync` abgelehnt (fail-closed). Für `local` ist der Wert
bedeutungslos. Test: `test-auth` „F15 fencing treats a primary permit without durability as sync …“.

#### G. `entry-replication.ts` `applyErasures` — Befund veraltet, realen Rest behoben

Die beschriebene Fixpunkt-Schleife mit `at`-Map existiert nicht mehr. Real war: Für jedes Event wurden Principal
und Change-ID jedes Erase-Events erneut kanonisiert. **Behoben:** einmal je Erase-Event vorberechnet.

#### L. `core.ts` `overheadBytes` — behoben (wichtigster Punkt)

Der große Posten war `jsonBytes(s.mailboxes)`: Bei jedem Write wurden alle Mailboxen (je bis 8 MiB) serialisiert.
**Behoben:** `mailboxesBytes` rechnet je Box die Metadaten mit leerem Event-Array plus die exakte Bilanz `bytes`
(Punkt 15) — gleiches Ergebnis, O(Boxen) statt O(Mailbox-Bytes). Die übrigen Posten (Outbox, Regs, Waiters, Txns)
sind durch Owner-Quoten bzw. `maxOutboxBytes` begrenzt und bleiben. Test: `test-core` „the document overhead
counts mailboxes exactly …“.

#### O. `core.ts` `MAX_LIST` — behoben (Doku)

Es ist die Schema-Grenze des Agent-Tools `space_list` (`index.ts`), kein Host-Limit. Eine Umbenennung bräche die
öffentliche API (`core.MAX_LIST`). **Behoben:** Kommentar am Export.

### Berechtigt, bewusst nicht geändert

- **E.** `member-transition.ts` scannt Claims/Generationen je Schritt von vorn (O(n²) über die Transition). Jeder
  Schritt summiert aber ohnehin alle Entries (`s.entries.reduce`) für die Budgetprüfung; ein Cursor allein bringt
  wenig. Selten (nur bei einer Authority-Transition).
- **H.** `append` baut `known`/`requests` über die ganze Historie: dieselbe Grenze wie Punkt 9. Ein persistenter
  Index würde das Dokument stark vergrößern; ein Speicher-Cache greift nicht, weil der Draft-State je Commit neu ist.
- **J.** `timedOut` in `federated-space.ts`: O(Members × Kandidaten) bei wenigen Members, ohne messbaren Nutzen.

### Kein Fehler (vorgeschlagener Fix wäre falsch oder schädlich)

- **C.** `run-controller.start`: Idempotenz ist an die commandId gebunden, ein anderer Befehl ist ein Konflikt —
  dasselbe Muster wie bei RunGates (`core.ts:1213`, Test „case 8“). Der Fix würde die Befehlszuordnung aufweichen.
- **D.** `member-transition.ts`: Die Vorprüfung (Zeile 35) wirft bei gleicher `recoveryId` und abweichender
  `authorityId`. Optional wäre dieselbe Prüfung zusätzlich im Commit, als Schutz zwischen Snapshot und Commit.
- **F.** `boot.ts`: Der zweite Register-Read ist die Versionsprüfung „unverändert während des Lesens“; ohne ihn
  lässt sich keine Änderung erkennen. Beide Reads sind bereits gebündelt (`readRegisterRecords`).
- **I.** `federated-space.ts:340`: Bewusstes Neulesen des Routing-States nach dem `await` des Schritts; der State
  ändert sich auch außerhalb von `serial` (Replica-Notices, Membership). Einmaliges Lesen schwächte die Bindungsprüfung.
- **K.** `replica-control.ts:270`: Wächst `head` während des Catch-ups, sollen die neuen Revisionen mit übertragen
  werden; ein fester Endwert ließe das Ziel zurück.
- **M.** `stats().returned`: `stats` ist als Stand „nach dem Settle“ dokumentiert; `settle` gäbe genau diese Entries
  zurück. Kein Mischen zweier Bedeutungen.
- **N.** `remote.ts` `sealedWait`: Kommentiert und beabsichtigt — die Anfrage ist evtl. noch nicht zugelassen, ein
  Poll fände sie nicht; nur der erneute Call mit derselben Request-Identität trifft den Claim.

### Niedrig / bewusst (nicht einzeln aufgeführt)

- `core.ts` `leased` — drei lineare `find`-Scans pro `renew`/`cancel`; Lease-Operationen sind selten. (Die frühere
  Angabe `maxEntries=10000` ist überholt: der Standard ist inzwischen unbegrenzt, `FOREVER`.)
- `core.ts` zirkulärer Import core ↔ paging ↔ claims — funktioniert unter ESM, strukturell unschön.
- `netcup-fencing.ts` Lock-Spinning mit TOCTOU — nur bei stale-Lock (mtime > 60 s), niedrig.
- Sync-I/O in Fence-Pfaden — selten, niedrig.

## Prioritätenübersicht (nach Prüfung)

| Status | Punkte |
|---|---|
| behoben | 1, 2 (Ursache), 3, 5, 6, 7, 8, 9 (soweit semantisch möglich), 10, 12, 13, 15, 16, 17, 18, 20, 21, 22, 25, 26, 27, 28, 31, A, B, G (realer Rest), L, O |
| kein Fehler / beabsichtigt | 4, 11, 14, 19 (dokumentiert), 23, 24, 29, 30, C, D, F, I, K, M, N |
| berechtigt, bewusst nicht geändert | E, H, J |

Kein Punkt erreicht nach der Prüfung die Stufe „kritisch“. Offen ist keiner; E, H, J und die seitenweise
Konfliktprüfung in Punkt 9 bleiben mit Begründung so.
