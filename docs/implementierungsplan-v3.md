# Implementierungsplan Federation v3

Stand: 2026-10-08. Setzt [federation-plan-v3.md](federation-plan-v3.md) (Vertrag) und
[betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md) (Betriebserweiterung) in
Arbeitspakete um. Grundlage ist der Codestand aus [spaces-v1.md](spaces-v1.md): Der Default-Space bleibt das
session-scoped Dokument `pi-spaces.space` v5; weitere Spaces liegen in der Familie `pi-spaces.named-space`.
`src/spaces.ts` stellt Registry/Identitäten bereit, `src/claims.ts` lokale Claims. Der erreichte Umfang und die
noch offenen Teile stehen in Abschnitt 7; kein einzelnes lokales Paket ersetzt eine vollständige Stufenabnahme.

Dieser Plan ist eine Reihenfolge, keine Zeitschätzung. Größen (S/M/L) sind relative Aufwände.

## 1. Ist der Plan bereit für die Implementierung?

**Teilweise.** Der Vertrag ist nach vier Konsistenzprüfungen in sich schlüssig genug, um mit den lokalen
Stufen zu beginnen. Die Stufen danach hängen an Entscheidungen und Nachweisen, die noch fehlen.

| Stufe | Bereit? | Was fehlt vor Beginn |
|---|---|---|
| 0 – Core-Rest | **ja** | nichts |
| 1 – benannte Spaces, lokales Protokoll | **ja** | nur F8 (entschieden: 24 h) und Startwerte aus F11 (bis Lasttest übernehmen) |
| 1b – Overlay, Identität, Enrollment, Restore | nach Stufe 1 | Entscheidungen getroffen (2026-10-08); offen sind die Nachweise für Gates 1, 3, 5, 6 |
| 2 – Router und expand | nach 1b | F9; Gate 4 (Lasttestwerte) |
| 3 – Replikation, Promotion | nach 2 | F1; Gate 2 (realer Fencing-Adapter) |
| 4 – weitere Clients | nach 2 | F12 bleibt zurückgestellt |
| Betriebserweiterung (Läufe, Worker, Spaces-Seite) | nach 2 | eigener Vertrag liegt vor; keine v3-Abnahme |

Ein Vorbehalt gilt für alle Stufen: Der Vertrag ist ungetestet. Wo die Implementierung einen Widerspruch
aufdeckt, wird zuerst `federation-plan-v3.md` korrigiert und dann weiterentwickelt, nicht umgekehrt.

## 2. Grundsätze für die Umsetzung

1. **Tests zuerst aus dem Vertrag.** Jedes Arbeitspaket beginnt mit den zugehörigen Fällen aus v3 §11 und
   §12.1 als fehlschlagende Tests. Ein Paket ist fertig, wenn diese Tests auf **persistentem** Storage
   (JSONL bzw. SQLite) grün sind; MemoryStorage allein genügt nicht (v3 §12).
2. **Core bleibt rein.** Neue Semantik (Revisionen, Claims, Budgets, Abschlussprofile) kommt als reine
   Funktionen mit explizitem `now` in `src/core.ts` oder neue reine Module. Transport, Kryptografie und
   Prozesse liegen außerhalb.
3. **Ein Commit, eine Wahrheit.** Space-Mutation, RPC-Claim, Revision, Mailbox-Event und Budgetreservierung
   entstehen im selben Harness-Commit. pi-durable erlaubt mehrere Dokumente in einem `Session.commit`; das wird
   in AP 0.3 als Erstes nachgewiesen.
4. **Keine neuen Abhängigkeiten ohne Rückfrage** (AGENTS.md). Ed25519/ECDSA, SHA-256 und Zufall kommen aus
   `node:crypto`; RFC 8785 existiert bereits in `src/canonical.ts`.
5. **Vertikale Schnitte.** Jede Stufe endet mit einem lauffähigen Beispiel (Sieb) auf dem neuen Pfad, nicht
   nur mit Bausteinen.
6. **Docs und Code gemeinsam.** `spaces-v1.md` wird bei jedem Paket mitgezogen; Typecheck und `npm test`
   nach jeder Änderung.

## 3. Vorab zu treffende Entscheidungen

| Frage | benötigt vor | Empfehlung im Plan | Wer |
|---|---|---|---|
| F2 Koordinator-Host | 1b | **entschieden:** VPS nach v3 4.1.1, NetBird-VM getrennt | Betreiber |
| F3 kein mTLS | 1b | **entschieden:** kein mTLS | Betreiber |
| F4 Challenge pro Verbindung | 1b | **entschieden:** pro Verbindung | Betreiber |
| F5 verlustbehafteter Control-Restore | 1b | **entschieden:** akzeptiert | Betreiber |
| F6 Uhrunsicherheit 2 s / Sperre 5 s / HLC 60 s | 1b | **entschieden**, NTP auf allen Hosts | Betreiber |
| F7 Grant 60 s, Lease 60 s/20 s | 1b | **entschieden** | Betreiber |
| F11 Startwerte Frame/Commit/Verbindungen | 1 (Startwerte), 2 (final) | **entschieden:** Startwerte übernommen, Lasttest bestätigt sie vor Stufe 2 | Implementierung |
| F9 Löschung pro Principal | 2 | Admin-Command in Stufe 2 | Betreiber |
| F1 Fencing-Adapter | 3 | Cloud-API des VPS-Anbieters | Betreiber |
| Neue Abhängigkeit `pi-server` (TCP/Unix-Transport) für pi-spaces | 1b | **entschieden:** Peer-Dependency, Transport hinter einem Interface; eingetragen erst mit AP 1.9 | Betreiber |

## 4. Arbeitspakete und Reihenfolge

### Phase 0 – Fundament (Stufe 0)

| AP | Inhalt | Größe | Ergebnis |
|---|---|---|---|
| 0.1 | **Persistente Testumgebung:** Hilfen zum Öffnen, Abbrechen und Wiederöffnen eines Harness auf JSONL und SQLite in `test/support/`; Fault-Injection-Punkte (vor/nach Commit, vor Antwort). | M | Basis für alle Crash-/Reopen-Abnahmen |
| 0.2 | **L7-Rest:** Byte-Messung für interne Dokumentteile (Outbox, Claims, Waiter, Regs) und Gesamt-Dokumentbytes; getrennte Limits. | M | `stats()` meldet Bytes je Kategorie; Limits greifen vor Mutation |
| 0.3 | **Machbarkeitsnachweis pi-durable:** (a) Mehrdokument-Commits sind bereits belegt: Tool-Claims (task-scoped) und Space-Dokument werden heute im selben Commit geschrieben; nur für Session-Familien erneut prüfen. (b) `defineDocFamily` mit `scope: "session"` je Space-Schlüssel und der **Übergang Singleton → Familie**: `checkRecordScope` weist Zugriffe ab, deren Token nicht zum persistierten Datensatz passt; vermutlich braucht v5 daher eine neue `kind` plus einmaligen Kopier-und-Retire-Commit statt eines `migrate`-Hooks. (c) Commit-Kosten bei 10 000 Entries in einem Dokument (Delta-Ops, Checkpoints). | M | Messbericht in `docs/VALIDIERUNG.md`; Migrationsweg für 1.1 festgelegt; bei (c) gegebenenfalls Aufteilung des Space-Dokuments |
| 0.4 | **L14:** pi-serverd des Nachbarprojekts lädt das Bundle nachweislich; Smoke-Test über Unix-Socket mit vorhandenem `sessions`-Dienst. | S | Einbindung abgenommen |
| 0.5 | **Remote-Testumgebung:** Docker-Container auf dem Server `big` (Runner, Koordinator, Standby, Members), Skript für Einrichtung, Start und Fehlerinjektion; `test/testbed/`, [testumgebung-big.md](testumgebung-big.md). | M | Tests und später Federation-Hosts laufen nicht auf dem Entwicklerrechner |

Reihenfolge: 0.1 und 0.3 zuerst und parallel; 0.3 kann die Datenmodell-Entscheidung in Phase 1 ändern.

### Phase 1 – Benannte Spaces und lokales Protokoll (Stufe 1)

Reihenfolge innerhalb der Phase entlang der Abhängigkeiten:

```
1.1 Doc v5/Familie ─► 1.2 Identitäten ─► 1.3 Revision/Changes ─► 1.5 Claims/Generationen ─► 1.8 SpaceService ─► 1.9 RemoteSpace
                                    └──► 1.4 Budgets/Seiten ───────┘            │
                                                                     1.6 Mailboxes ─┤
                                                                     1.7 Folgeaufträge/Abschlussprofile
```

| AP | Inhalt | Module | Größe |
|---|---|---|---|
| 1.1 | **Doc-Version 5 und benannte Spaces:** Der bisherige Singleton `pi-spaces.space` bleibt der Default-Space; weitere Spaces liegen in `defineDocFamily` mit der eigenen `kind` `pi-spaces.named-space` und Schlüssel `spaceId`. Registry-Dokument `pi-spaces.registry` für `hostId` und Alias → `spaceId`. Migration 4 → 5 erhält den Default-Bestand; bei der Registrierung entstehen seine **erzeugte** `spaceId` und Alias `default`. Keine Umdeutung des Singletons zur Familie und keine Kopiermigration (Entscheidung aus AP 0.3). | `doc.ts`, `core.migrate`, `client.ts` | M |
| 1.2 | **Identitäten:** `hostId`, `spaceId`, Dateninkarnation; lokale IDs = Inkarnation + Zähler; `gid = spaceId/localId`; `view()` liefert `gid`. | `core.ts` | S |
| 1.3 | **Revision und Änderungsstrom:** Revision pro Commit; begrenzter, persistenter Batch-Log je Space; `changes(afterRev, maxBytes)` lokal; Snapshot-Token mit Revision R und begrenzter Vorhaltung (`SnapshotExpired`). | neues `src/stream.ts` | L |
| 1.4 | **Budgets und Seiten:** `maxCommitBytes`, `maxEventBytes`; Reservierung für Commit **und** Abort vor jeder Txn-Erweiterung (v3 4.2); bytebegrenzte Seiten für `readAll`, Snapshot, `events`, `changes` mit Cursor ohne Lücken/Dubletten; bei zu kleinem Budget `ResponseBudgetTooSmall {requiredBytes}` ohne Cursor-/ACK-Fortschritt (v3 6.2 „Seitengrößen“). Ersetzt `MAX_LIST` ohne Cursor (L13). | `core.ts`, `stream.ts` | M |
| 1.5 | **RPC-Claims und Generationen:** Trennung fachliche Argumente / erneuerbarer Rahmen; Argument-Hash über kanonisches JSON nur der fachlichen Argumente; Claim `(principal, spaceId, generation, requestId)` im Space-Dokument und im selben Commit; Zustände `pending`, `pending/commitSealed`, `done`, `cancelled`; Fristen (24 h, Hash bis Ende Zulassungs- und Ergebnisfrist); `RequestConflict`, `RequestExpired`, `ResultExpired`, `IncarnationChanged`; signierte Generationen, an Principal/Space und Daten-/Autoritätsinkarnation gebunden (HMAC mit Host-Schlüssel genügt lokal); `pollOperation`, `cancelOperation` mit `targetRequest`. | neues `src/claims.ts` | L |
| 1.6 | **Mailboxes:** strukturierte Principals; Mailbox mit `mailboxEpoch`, `seq`, ACK nur zusammenhängender Präfixe, TTL 7 Tage plus Byte-Limit, Lückenmeldung; Outbox für Peer-Ziele wird Mailbox; `registrationClosed` als Event-Art vorbereiten. | neues `src/mailbox.ts`, `index.ts` Delivery | M |
| 1.7 | **Interne Folgeaufträge und Abschlussprofile:** Reaper/Settle mit dauerhaftem Cursor und Batches unter `maxCommitBytes`; Fanout-Folgeaufträge (v3 6.1 Punkt 8). Lokale `CompletionProfile`-Prüfung bei jedem Commit einer Take-Txn (`CompletionViolation`), in Stufe 1 als Übergangskonfiguration pro Space (v3 6.4); Policy ersetzt sie in 2.6. Das Sieb nutzt sie sofort. | `core.ts` | M |
| 1.8 | **Dienst `space` transportunabhängig:** Dispatcher mit den Methoden aus v3 6.2, Validierung, Rahmenprüfung (Autorität/Epoche als Platzhalter), Rechte-Grundmodell mit Test-Identitätsadapter. Kein Netzwerk. | neues `src/service.ts` | M |
| 1.9 | **`RemoteSpace`:** implementiert `SpaceLike` über einen abstrakten Transport; hält Request-ID und Argumente bis Abschluss; Polls; `maxClientWaitMs` → `OutcomeUnknown`. Erst In-Process-Transport, dann Unix-Socket über pi-serverd (Abhängigkeit siehe 6). | neues `src/remote.ts` | M |

**Abnahme Phase 1:** v3 §11 Stufe 1 und alle Zeilen „1“ aus §12.1, insbesondere: Take-Commit mit verlorener
Antwort liefert nach Reopen dasselbe Ergebnis; bekannter Pending-Request überlebt Generationsende;
fünf 64-KiB-Entries blättern ohne Lücke; Migrationsfixtures v4 → v5. Das Sieb läuft über `RemoteSpace` mit
In-Process-Transport gegen einen benannten Space und mit erzwungenem Abschlussprofil.

### Phase 1b – Netz, Identität, Control Space, Recovery (Stufe 1b)

Erst nach den Entscheidungen aus Abschnitt 3. Reihenfolge: Identität vor Control Space vor Recovery.

| AP | Inhalt | Größe |
|---|---|---|
| 1b.1 | **NetBird-Testumgebung und Testmatrix** v3 4.6 (Gate 5); Management-API-Rechte für Peer-ID-Abfrage; Ergebnisse in v3 4.6 nachtragen. | M |
| 1b.2 | **`space-gate`:** TCP nur auf Overlay-IP, Unix-Socket `0600`, Frame-/Verbindungs-/Handshake-Grenzen, Allowlist `serviceId: space`, nicht überschreibbarer Kontext an pi-serverd (explizite Authentifizierungsgrenze). | L |
| 1b.3 | **Identität Schicht A/B:** Peer-Auflösung mit 60-s-Cache; Challenge `{gateHostId, observedPeerId, connNonce, …}`; Ed25519 bzw. P-256; Schlüsselablage Android-Keystore und Desktop (`0600`) (Gate 6). | L |
| 1b.4 | **Control Space und Grants:** geschützte Typen (`PeerKey`, `Enroll`, `Command`, `Result`, …), Rollenmatrix v3 §9, Grants ≤ 60 s mit erneuter Prüfung vor dem Commit, `resolution`-Grant, Authority-ID. | L |
| 1b.5 | **Supervisor-Prozess:** lokaler Dienst je Host; Supervisor-Commands `createEnroll`, `revokePeer`, `rotateKey`; Bootstrap-Befugnis einmalig; `enroll`-RPC mit Prüfreihenfolge und Token nur im flüchtigen Puffer. | L |
| 1b.6 | **Recovery-Pfad:** Recovery Space über lokalen Socket, Out-of-Band-Zugang (SSH mit `command=`), unabhängiges Recovery-Register mit Compare-and-Set (Gate 1). | M |
| 1b.7 | **Restore:** Control-Restore 5.2.1 (Autoritätswechsel, `AuthorityTransition` je Member, Rechte neu freigeben) und Data-Restore 5.2.2 (serialisierter Übergang, historische Claims nur lesbar, alte Pending-Arbeit/Reservierungen aus aktiver Kopie entfernen, `restoredUnverified`/`releaseRestored`, `IncarnationChanged`, Control-/Boot-Abgleich); Router-Schritt 5.2.2/5 folgt in 2.1. Fencing zunächst über F15-Ausnahme nur im Single-Betrieb. | L |
| 1b.8 | **Boot-Merkmal (Grundform):** Versionierter `HostBootState` mit globalem Host-Zustand und eigenen Berechtigungen je Space, CAS über unabhängiges Register; Provisionierung installiert passende Autorität/Dateninkarnation. Ohne passenden Nachweis keine schreibende Arbeit des Space; Control-/Data-Restore aktualisieren den Nachweis. Zustände `fenced`/`quarantine` und Replikatwechsel folgen in 3.6. | M |

**Abnahme Phase 1b:** v3 §11 Stufe 1b und alle Zeilen „1b“ aus §12.1. Integrationsnachweis zuerst mit zwei
pi-serverd plus Gates auf localhost und Test-Identitätsadapter, dann in der echten NetBird-Umgebung.

### Phase 2 – Router und expand (Stufe 2)

| AP | Inhalt | Größe |
|---|---|---|
| 2.1 | **Router-Grundgerüst:** Command-Zustandsmaschine `accepted → applying → completed / failed / needsReview`, Journal mit Unterrequest-IDs, `recovering` nach Neustart. | L |
| 2.2 | **RouterLease und Delegation:** Lease beim Supervisor beantragt und von ihm signiert; Delegation mit `targetRequest`; Prüfung am Member (Signaturen, Authority, Epochen-Höchstwerte, Hash); `EpochNotice`; Delegationserneuerung für lange Operationen. | L |
| 2.3 | **Policy und Routing:** `FederationPolicy` mit Validierung (eine Regel pro Typ, Modusgrenzen, Default-Ziel); `local`, `expand by type`, HRW nur über den Feldwert, `capacity`/`capability` mit journalisierter Auswahl. | M |
| 2.4 | **`FederatedSpace`:** read/take sequenziell mit aufgelöstem Ausgang; `readAll`/`count` mit `allowPartial`/`waitForComplete`; Txn-Bindung und `RoutingConflict`; Waiter-Wettlauf. | L |
| 2.5 | **Membership-Lebenszyklus:** `addMember` mit Bestandsprüfung unter lokaler Sperre; `drain` mit Admission-Grenze; `freezeForRemoval`, `EmptyProof` inklusive Notify-Registrierungen und `registrationClosed`; `removeMember`, `MigrationRequired` für HRW. | L |
| 2.6 | **Policy-Abschlussprofile und Admin-Commands:** `completionProfiles` aus der Policy statt lokaler Konfiguration; `purgeTasks`, Löschung pro Principal (F9); `needsReview` für Unterrequests nach Data-Restore (5.2.2 Schritt 5). | M |
| 2.7 | **Capability-Verzeichnis und MemberStatus.** | S |
| 2.8 | **Simulator:** mehrere Harnesses, deterministische Latenz, Verlust, Duplikate, Partitionen, Uhrsprünge; Gegenmodell für Reservierungen und Requestzustände. Beginn parallel zu 2.1, weil 2.4/2.5 ohne ihn kaum abnehmbar sind. | L |
| 2.9 | **Lasttest** (Gate 4): 10 000 Entries, 3 Members; finale Werte für Frame, `maxCommitBytes`, Generationslaufzeit. | M |

**Abnahme Phase 2:** v3 §11 Stufe 2 und alle Zeilen „2“ aus §12.1; Sieb über drei Members mit HRW nach
`taskId` (Betrieb §6).

### Phase 2b – Betriebserweiterung (parallel zu Phase 3)

Voraussetzung ist Phase 2. Inhalt nach [betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md):

1. **Run-Controller:** Manifest, `startRun` idempotent, mehrteilige Vorbereitung unter Commit-Budget.
2. **RunGate-Barriere:** Eintrittssperre, ACK-Inhalt, `RunGateConflict`; `RunRecoveryView` mit Gate, Sperre,
   Steuerauftrag/Phase und stopped-Historie; `reconciling`/`needsReview` nach Restore, `resolveRunRecovery`
   mit vollständigen Views und Admin-Entscheidung statt automatischem Resume aus höchster Revision.
3. **Workerverwaltung:** `WorkerAssignment`-Entries, Supervisor-Abgleich, Generationen.
4. **Bootstrap-Script** (`--check`/`--apply`) mit Alias → ID, NetBird-Beitritt, Admin-Pairing zuerst.
5. **Mobile Spaces-Seite** im Nachbarprojekt: Verbindungsliste, Vorgänge, Lauf-Details.

**Abnahme:** Betrieb §7.4.

### Phase 3 – Replikation und Übernahme (Stufe 3)

| AP | Inhalt | Größe |
|---|---|---|
| 3.1 | **Stream-Import:** Snapshot plus `changes` auf ein Replikat; atomare Installation; Replikatoren mit engem Importpfad. | L |
| 3.2 | **primary/sync:** `CommitIntent` versiegeln vor Senden, höchstens ein Kandidat, Standby-ACK nur lückenlos, Neustartklärung; unbekannte IDs nach v3 6.2 prüfen: gültige erhaltene Generation, vollständige verlustfreie Historie, alte Schreibquellen ausgeschlossen, dauerhafter Negativclaim vor `NotCommitted`; Ablauf/Restore erlauben keine automatische Ersatzwirkung. | L |
| 3.3 | **Fencing-Adapter** für den gewählten Anbieter (Gate 2), `verify` unabhängig. | M |
| 3.4 | **Promotion** 5.3, **degradeToSingle** 5.3.1, `ReplicaConfigNotice`, Control-Sonderfall. | L |
| 3.5 | **`setStandby`** mit Schreibsperre und beidseitiger Bestätigung. | M |
| 3.6 | **Boot-Merkmal komplett:** Globale Zustände `fenced`/`quarantine`; Berechtigungen je Space für Rolle, Autorität, Dateninkarnation, Epoche, Replikatversion/Durability. Alle Rollen-/Versionswechsel gleichen alle weiter zugelassenen Replikate mit CAS und stabilem Übergang ab; lokale/externe Teilzustände sperren normale Writes/Grants. `quarantine → active` nur nach `setStandby`; mehrere Spaces und Reboot beider Replikate testen. | M |
| 3.7 | **lww/set:** HLC mit Persistenz, versionierte Tombstones, Lease-Versionen, Kausalstand und Kompaktierung. | L |
| 3.8 | **Control Space auf primary/sync umstellen.** | M |

Reihenfolge: 3.1 → 3.2 → (3.3 parallel) → 3.4 → 3.5/3.6 → 3.8. 3.7 ist unabhängig und kann nach 3.1 parallel
laufen.

**Abnahme Phase 3:** v3 §11 Stufe 3 und alle Zeilen „3“ aus §12.1, real mit Fencing-Adapter.

### Phase 4 – Weitere Clients (Stufe 4)

Desktop/CLI-Paket `pi-spaces-client` (RemoteSpace, TCP-Transport, Pairing); Browser-Gateway nur nach F12.

## 5. Kritischer Pfad und erste Schritte

Kritischer Pfad: 0.1/0.3 → 1.1 → 1.3 → 1.5 → 1.8 → 1b.2/1b.3 → 1b.4 → 2.1 → 2.2 → 2.4 → 3.1 → 3.2 → 3.4.

Konkret als Nächstes, in dieser Reihenfolge:

1. **AP 0.3:** Spike zu Mehrdokument-Commit, `defineDocFamily` und Commit-Kosten bei 10 000 Entries. Ergebnis
   entscheidet, ob das Space-Dokument in Phase 1 unverändert als ein Dokument bleibt.
2. **AP 0.1:** Persistenz- und Crash-Hilfen für Tests; erste Regression: heutiger Tool-Claim nach Reopen.
3. **AP 1.1 + 1.2:** Doc v5 als Familie mit Migration und `gid`; bestehende Tests müssen unverändert grün
   bleiben (Space `default`).
4. **AP 1.5** mit den Tests „Take mit verlorener Antwort nach Reopen“ und „Generationsende“ als erstem Ziel.
5. Parallel dazu die Entscheidungen F2–F7 und die Abhängigkeitsfrage aus Abschnitt 6 klären, damit Phase 1b
   ohne Wartezeit beginnen kann.

## 6. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| Ein großes Dokument pro Space | Commit-Kosten und Speicher wachsen mit Entries, Claims, Log | AP 0.3 misst früh; notfalls Claims/Log in eigene Familien-Dokumente |
| `pi-server` als neue Abhängigkeit von pi-spaces | AGENTS.md verlangt Rückfrage | Transport hinter Interface; Unix/TCP-Adapter im Nachbarprojekt oder als optionale Peer-Dependency |
| NetBird-Verhalten weicht von den Hypothesen ab | Grant-/Cache-Logik passt nicht | 1b.1 vor 1b.2–1b.4 |
| Android-Keystore ohne Ed25519 | Schicht B auf dem Handy | P-256 von Anfang an mit implementieren |
| Fencing-API des Anbieters ohne echte Neustartsperre | Stufe 3 nicht abnehmbar | Anbieterwahl mit F1 klären, bevor Phase 3 beginnt |
| Vertragsfehler zeigen sich erst im Code | Nacharbeit an mehreren APs | Abweichungen zuerst im Vertrag korrigieren; Abnahmefälle als ausführbare Tests pflegen |
| Umfang | v3 ist groß; viele Pakete der Größe L | nach Phase 1 und nach Phase 2 jeweils prüfen, ob Stufe 3 wirklich benötigt wird; Phase 2b kann früher Nutzen bringen |

## 7. Fortschritt

| AP | Stand | Abweichung / Befund |
|---|---|---|
| 0.1 | umgesetzt: `test/support/persistent.ts` (JSONL/SQLite, Absturz, Fehlerinjektion `failBeforeCommit`/`loseAnswer`), `test-persistence.test.ts` | Der erste Test fand einen Fehler: Claim-Replays gaben einen Draft-Proxy zurück, der nach dem Commit nicht lesbar ist („settled overlay“). Behoben in `client.ts` und den Tools (`core.plain`). Betraf auch das ausgelieferte Verhalten: Ein Tool-Replay nach Absturz meldete dem Modell einen Fehler statt des Ergebnisses; Regressionstest mit Agent auf JSONL/SQLite. |
| 0.2 | umgesetzt (Teil 1): `stats().bytes` je Teil (Einträge, Outbox, Claims, Waiter, Registrierungen, Txns, Gesamtdokument), Limits `maxClaimBytes` (32 MiB), `maxOutboxBytes` (8 MiB), `maxDocBytes` (128 MiB), laufende Byte-Summe der Claims (`rpc.bytes`), `test-budgets.test.ts` | Claims: eine neue Anfrage wird oberhalb des Budgets abgewiesen, bekannte bleiben beantwortbar; Entscheidungen (Ergebnisse) werden nie abgewiesen, damit keine Anfrage hängen bleibt. Outbox: Gegendruck (neue Subscriptions und Waits werden abgewiesen), nie Verlust von Ereignissen. Offen: Reservierung für Commit und Abort vor Txn-Erweiterung, `maxCommitBytes` und die bytebegrenzten Seiten (AP 1.4). |
| 0.3 | umgesetzt: `scripts/spike-durable.ts`, Ergebnis in [VALIDIERUNG.md](VALIDIERUNG.md#pi-durable-machbarkeit-ap-03) | Mehrdokument-Commits mit Familien sind atomar. Ein Familien-Token mit der `kind` des Singletons liest **still ein anderes, leeres Dokument**; daher keine Umdeutung des Singletons. `settle()` ersetzte bei jedem Commit das ganze Entry-Array; behoben (in place), Commit-Kosten bei 1000 Entries von etwa 48 ms auf 3–6 ms, Storage von 231 MB auf 0,7 MB. Restkosten wachsen linear mit der Entry-Zahl (AP 0.2). |
| 0.5 | umgesetzt: Remote-Testumgebung `test/testbed/`, [testumgebung-big.md](testumgebung-big.md) | Befund: Docker läuft auf dem Server rootless unter dem ssh-Benutzer, `root` erreicht keinen Daemon; das Skript läuft deshalb als dieser Benutzer. Produktionsnah: nur gebaute Artefakte (das mit der mobilen Runtime byte-identische Bündel, kompilierte Beispiele und Szenarien) gehen auf den Server, kein Quellcode; Image mit Produktionsabhängigkeiten, Benutzer `node`, read-only. Auf dem Server ausgeführt: `check`, `up`, Smoke, fünf Beispiele, `kill`, Szenario Primzahlsieb mit simuliertem Handy (`test/testbed/scenarios/sieve-mobile.ts`). Die Quelltests laufen lokal. Der erste Build deckte ein veraltetes `package-lock.json` auf (esbuild im Root fehlte); synchronisiert, nur esbuild-Einträge geändert. |
| 1.1 | umgesetzt: `src/spaces.ts`, Doc-Version 5 | Entscheidung nach 0.3: Der bisherige Singleton bleibt der Default-Space (Alias `default`, erzeugte `spaceId`); nur weitere Spaces liegen in der Familie `pi-spaces.named-space`. Keine Kopiermigration nötig. `startService` bedient auch später angelegte Spaces. Tools arbeiten weiter auf dem Default-Space. |
| 1.2 | umgesetzt | Lokale IDs `<präfix><inkarnation>-<zähler>` mit 8 Hex-Zeichen Inkarnation (bleiben einfache Wörter für Modelle und Parser); `gid` in jeder View. |
| 1.5 | umgesetzt: `src/claims.ts`, `test-claims.test.ts` | Offen: Signatur der Generationen (mit AP 1.8), Budgetreservierung für Commit/Abort (AP 1.4), Trennung des Rahmens tritt erst mit dem Dienst `space` sichtbar auf. |
| 1b.1 (Teil) | umgesetzt: NetBird-Server, Dashboard, nginx/TLS auf `spacebird.eibrain.org`, Setup (Gruppen, Keys, Policies), vier Agent-Peers; Ergebnisse in [testumgebung-big.md](testumgebung-big.md) Abschnitt 12 und in v3 4.6 | Befund: Kernel-WireGuard läuft auch unter rootless Docker. Offen: Zeitmessung für Gruppenwechsel und Peer-ID-Abfrage, Handy, die vier Ausfallzeilen der Matrix. |
