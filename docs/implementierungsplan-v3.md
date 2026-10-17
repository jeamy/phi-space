# Implementierungsplan Federation v3

Stand: 2026-10-16. Setzt [federation-plan-v3.md](federation-plan-v3.md) (Vertrag) und
[betrieb-und-mobile-steuerung.md](betrieb-und-mobile-steuerung.md) (Betriebserweiterung) in
Arbeitspakete um. Grundlage ist der [Implementierungsstand](implementierungsstand.md): Der Default-Space bleibt das
session-scoped Dokument `pi-spaces.space` v5; weitere Spaces liegen in der Familie `pi-spaces.named-space`.
`src/spaces.ts` stellt Registry/Identitäten bereit, `src/claims.ts` lokale Claims. Der erreichte Umfang und die
noch offenen Teile stehen in Abschnitt 7; kein einzelnes lokales Paket ersetzt eine vollständige Stufenabnahme.

Dieser Plan ist eine Reihenfolge, keine Zeitschätzung. Größen (S/M/L) sind relative Aufwände.

## 1. Ist der Plan bereit für die Implementierung?

**Stufen 0 bis 2 und die Betriebserweiterung sind umgesetzt; Stufe 3 ist begonnen.** Die Stufen 3 und 4
hängen an Entscheidungen und Nachweisen, die noch fehlen (Abschnitt 7 und [Phase-3-Stand](ap3-replikation.md)).

| Stufe | Bereit? | Was fehlt vor Beginn |
|---|---|---|
| 0 – Core-Rest | **ja** | nichts |
| 1 – benannte Spaces, lokales Protokoll | **lokal umgesetzt und geprüft** | Startwerte aus F11 benötigen weiterhin einen Lasttest |
| 1b – Overlay, Identität, Enrollment, Restore | **im F15-Modell abgenommen** ([Phase-1b-Abnahme](ap1b-abnahme.md)) | keine Promotion-/Replikationsfreigabe |
| 2 – Router und expand | **abgeschlossen** mit dokumentierter Ausnahme für Block 4 ([Phase-2-Abnahme](ap2-abnahme.md)), Gate 4 geschlossen | uneingeschränkte native Produktionsfreigabe nicht erklärt |
| 2b – Betriebserweiterung (Läufe, Worker, Spaces, Bootstrap, mobile Steuerung) | **umgesetzt** (B2–B10, [Betrieb §8](betrieb-und-mobile-steuerung.md#8-umsetzungsstand-und-reihenfolge-der-betriebserweiterung)) | eigener Vertrag, keine v3-Abnahme; Fälle 1, 5, 6 teilweise, 7 offen (Betrieb §7.6) |
| 3 – Replikation, Promotion | **begonnen**: Replikationsbausteine und synchroner Storage-Unterbau | F1; Gate 2 (realer Fencing-Adapter); Einbindung, Übergänge, Promotion |
| 4 – weitere Clients | nach 2 | F12 bleibt zurückgestellt; Admin-CLI `npm run bootstrap` existiert als Teil von 2b |

Die lokalen Stufe-1-Fälle sind automatisiert geprüft; der vollständige Federation-Vertrag ist weiterhin
nicht abgenommen. Wo die Implementierung einen Widerspruch
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
6. **Docs und Code gemeinsam.** `implementierungsstand.md` und `api.md` werden bei jedem Paket mitgezogen; Typecheck und `npm test`
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

Stand 2026-10-09: AP 1.1–1.9 lokal implementiert; Nachweise in [ap1-abnahme.md](ap1-abnahme.md).

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
| 1.8 | **Dienst `space` transportunabhängig:** Dispatcher mit den Methoden aus v3 6.2, Validierung, Rahmenprüfung (Autorität/Epoche als Platzhalter), Rechte-Grundmodell mit Test-Identitätsadapter. Der Paketumfang selbst enthält noch keinen Transport; dieser folgt in 1.9. | neues `src/service.ts` | M |
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

Aktueller Nachweis und noch offene Freigabepunkte: [Phase-2-Abnahme](ap2-abnahme.md).

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

**Stand 2026-10-16:** Punkte 1–3 und 5 sind umgesetzt; die Workerverwaltung verwendet signierte, je Host
abgerufene Zuweisungen statt Entries im Control Space. Das Bootstrap-Script plant und wendet Spaces und Worker an;
SSH-Provisionierung, NetBird-Beitritt und Pairing bleiben Voraussetzungen. Zusätzlich umgesetzt: Space-Lebenszyklus,
Alarmierung, Audit, Vorschau, Ergebnisexport und Zeitplan. Abnahmestand je Fall: Betrieb §7.6.
**Für später notiert, derzeit nicht angedacht:** feinere Rollen (`run-operator`, `worker-operator`) und
Zwei-Personen-Freigabe; sie verändern die Zugriffsregeln des Control Space und brauchen eine eigene Prüfung.

### Phase 3 – Replikation und Übernahme (Stufe 3)

Stand der Pakete (Details: [Phase-3-Stand](ap3-replikation.md), dort mit eigener Teilnummerierung):

| AP | Stand 2026-10-17 |
|---|---|
| 3.1 Stream-Import | Bausteine umgesetzt: Snapshot-Transfer, Stream-Cursor-Worker, Generationenpflege; reale zehnminütige NetBird-Partition als Komponentenlauf bestanden ([Nachweis](../test/evidence/ap3-overlay-2026-10-15/README.md)). Nicht in den Space-Dienst eingebunden |
| 3.2 primary/sync | Storage-Unterbau umgesetzt (Versiegeln, Hashkette, Standby-ACK, Neustartklärung); je primary/sync-Space ein eigener Store im Federation-Host (`openSyncSpace`, Verteilung im Host, Konfiguration `syncSpaces`), signierter Replikat-Transport; Sync-Primary-Regeln im Validator freigegeben; Daemon-Lauf auf nanoi und 100 bestanden ([Nachweis](../test/evidence/phase3-daemon-sync-2026-10-16/README.md)); Bootstrap bestehender Stores umgesetzt (`bootstrapPrimarySync`, auf host-a echt gelaufen); offen: öffentliches `commitSealed`, Negativclaims/`NotCommitted` nach 6.2 |
| 3.3 Fencing-Adapter | Schnittstelle nach v3 §5.5 umgesetzt ([Replikatsteuerung](ap3-replica-control.md)): Simulator nur mit ausdrücklicher Testfreigabe, netcup als „nicht konfiguriert“-Platzhalter. netcup-SCP-Adapter mit mTLS-Dienst gebaut und gegen eine nachgebaute API geprüft; Token und Dienst auf vpsc; realer Lauf (Abschalten, Prüfen, Freigabe in Quarantäne) gegen nanoi am 2026-10-16 bestanden ([Nachweis](../test/evidence/f1-netcup-2026-10-16/README.md)). Promotion mit echten Daten im Daemon-Lauf und im Root-Lauf bestanden. Für Single-Restore bleibt der SSH-Nachweis nach F15 |
| 3.4 Promotion, degradeToSingle | umgesetzt; echter Zyklus mit netcup-Fencing auf nanoi und Standby 100 als Fixture-Lauf bestanden ([Nachweis](../test/evidence/phase3-sync-2026-10-16/README.md)). `ReplicaConfigNotice` mit registergestützter Übernahme im Router und `ReplicaConfigPending` am Member umgesetzt. Abholen über das Notice-Brett im Control Space, Übernahme im Root-Heartbeat, Adressauflösung nach aktuellem Ziel. Echter Lauf mit nativem Root auf host-a bestanden ([Nachweis](../test/evidence/root-hosta-2026-10-17/README.md)). primary/sync-Spaces laufen im Federation-Daemon; der Validator lässt Sync-Regeln nur in der Variante `primary` für replizierte Members zu. Offen: degradeToSingle gegen einen Standby ohne Fencing-Adapter; `ReplicaConfigPending` und Übernahme nach `setStandby` nur lokal geprüft |
| 3.5 setStandby | umgesetzt (leeres Quarantäne-Ziel, vollständiges Nachladen); im echten Zyklus zurück zu nanoi geprüft; Schreibsperre für alle Quellen inklusive Reaper während offener Übergänge, Abbruch mit `abandonTransition`; Nachladen eines bootstrappten Stores (Bootstrap-Chunks mit Prüfsumme) umgesetzt |
| 3.6 Boot-Merkmal komplett | umgesetzt: `fenced`/`quarantine` per CAS; Boot-Guard bindet primary/sync-Spaces über `replicaConfig` an Rolle, Epoche, Replikatversion und Durability des Journals, `standby` ohne fachliche Zulassung; Wiederzulassung der übrigen Spaces eines gefencten Hosts je Space (`readmitSpace`/`installAdmittedPermit`); mehrere Spaces und Neustart geprüft |
| 3.7 lww/set | Baustein umgesetzt (HLC, versionierte Tombstones, Add-Wins, Lease-Erneuerung); offen: Kompaktierung, öffentlicher Adapter, Policy-Modi |
| 3.8 Control Space auf primary/sync | lokal umgesetzt: Bootstrap bestehender Stores, Hauptstore auf primary/sync (`mainSync`, `main-sync`, `replica-listen`), Control-Epoche aus dem Journal, Geschwister-Spaces; echter Lauf auf host-a bestanden: Bootstrap, zweimal setStandby/degradeToSingle mit Standby auf nanoi und netcup-Fencing, Ende `single` ([Nachweis](../test/evidence/control-sync-hosta-2026-10-17/README.md)); Schritt 6 (Policy-Abgleich, Lease über den Übergang, EpochNotice) umgesetzt und auf host-a mit Root und Policy echt gelaufen ([Nachweis](../test/evidence/step6-hosta-2026-10-17/README.md)); Promotion des Control-Replikats mit Container-Fencing und Host-Wechsel unter gleicher Autorität echt in beide Richtungen gelaufen ([Nachweis](../test/evidence/control-promotion-2026-10-17/README.md)); offen: Root zieht bei der Promotion nicht mit |

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

Der kritische Pfad ist bis 2.4 abgeschlossen; 3.1 und 3.2 liegen als geprüfte Bausteine vor. Als Nächstes stehen
die Einbindung der Replikation in den Space-Dienst, die Vervollständigung von 3.2 und vor allem die Entscheidung
F1 mit dem realen Fencing-Adapter (3.3) an; ohne ihn ist Promotion (3.4) nicht abnehmbar.

Phase 1b ist im geprüften F15-Modell abgenommen (Handy–big, NetBird-Ausfallmatrix und verteilte Live-Restores
eingeschlossen, [ap1b-abnahme.md](ap1b-abnahme.md)). Phase 2 ist mit der Ausnahme für Block 4 abgeschlossen
([ap2-abnahme.md](ap2-abnahme.md)). Die Betriebserweiterung ist umgesetzt und auf Gerät und Overlay geprüft.

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
| 0.2 | umgesetzt: getrennte Byte-Gauges und Quoten, Reservierungen für Claims und Txn-Abschlüsse | Neue Arbeit wird vor Mutation abgewiesen; ein langsamer Consumer erhält reservierte Abschluss-Events über dauerhafte Folgeaufträge. Näheres bei 1.4/1.7. |
| 0.3 | umgesetzt: `scripts/spike-durable.ts`, Ergebnis in [VALIDIERUNG.md](VALIDIERUNG.md#pi-durable-machbarkeit-ap-03) | Mehrdokument-Commits mit Familien sind atomar. Ein Familien-Token mit der `kind` des Singletons liest **still ein anderes, leeres Dokument**; daher keine Umdeutung des Singletons. `settle()` ersetzte bei jedem Commit das ganze Entry-Array; behoben (in place), Commit-Kosten bei 1000 Entries von etwa 48 ms auf 3–6 ms, Storage von 231 MB auf 0,7 MB. Restkosten wachsen linear mit der Entry-Zahl (AP 0.2). |
| 0.4 | umgesetzt: struktureller pi-server-Adapter und Einbau in `pi-termux-mobile/runtime/pi-serverd.mjs` | Das neu gebaute Bundle und der wirkliche Daemon auf isoliertem SQLite-State liefern `space` und bestehendes `sessions.list` über pi-client/Unix-Socket. Keine neue Abhängigkeit installiert. |
| 0.5 | umgesetzt: Remote-Testumgebung `test/testbed/`, [testumgebung-big.md](testumgebung-big.md) | Befund: Docker läuft auf dem Server rootless unter dem ssh-Benutzer, `root` erreicht keinen Daemon; das Skript läuft deshalb als dieser Benutzer. Produktionsnah: nur gebaute Artefakte (das mit der mobilen Runtime byte-identische Bündel, kompilierte Beispiele und Szenarien) gehen auf den Server, kein Quellcode; Image mit Produktionsabhängigkeiten, Benutzer `node`, read-only. Auf dem Server ausgeführt: `check`, `up`, Smoke, fünf Beispiele, `kill`, Szenario Primzahlsieb mit simuliertem Handy (`test/testbed/scenarios/sieve-mobile.ts`). Die Quelltests laufen lokal. Der erste Build deckte ein veraltetes `package-lock.json` auf (esbuild im Root fehlte); synchronisiert, nur esbuild-Einträge geändert. |
| 1.1 | umgesetzt: Doc v5, Registry und benannte Spaces | Default bleibt Singleton; persistentes v4-Fixture auf JSONL und SQLite beweist Erhalt von IDs, Ownership und uncommitted Daten beim Reopen. |
| 1.2 | umgesetzt: Host-/Space-ID, Inkarnation, `gid` | Registry und IDs überstehen Reopen; alte lokale IDs bleiben gültig. |
| 1.5 | umgesetzt: signierte Generationen und dauerhafte Pending-Ausführung | HMAC mit persistiertem Host-Schlüssel, Bindung an Principal, Space, Inkarnation und lokale Autorität. Claims behalten Argument-Hash und Ergebnisreservierung; Pending-Waiter behalten die nötigen fachlichen Ausführungsdaten separat. Reopen, Konflikt, feste Deadline und `ResultExpired` geprüft. `commitSealed` ist erst für primary/sync erforderlich (Stufe 3). |
| 1.6 | umgesetzt: Principal-Mailboxes | Byte-Seiten, ACK nur ausgelieferter zusammenhängender Präfixe, TTL höchstens 7 Tage, Byte-Limit, Gap und neue Epoche; `registrationClosed`. Unbestätigte verlorene Take-Events werden über begrenzte Wartung freigegeben; ACK ersetzt keinen Txn-Commit. |
| 1.7 | umgesetzt: begrenzte Wartung, Folgeaufträge und CompletionProfile | Durable Fortsetzung und Fanout-Cursor über Crash/Reopen; voller Consumer blockiert keinen reservierten Abschluss. Profile prüfen Result-Typ, Zuordnungsfelder und Anzahl bei jedem Commit; Sieb verwendet sie im benannten Space. |
| 1b.1 (Teil) | umgesetzt: NetBird-Server, Dashboard, nginx/TLS auf `spacebird.eibrain.org`, Setup (Gruppen, Keys, Policies), vier Agent-Peers; Ergebnisse in [testumgebung-big.md](testumgebung-big.md) Abschnitt 12 und in v3 4.6 | Befund: Kernel-WireGuard läuft auch unter rootless Docker. Offen: Zeitmessung für Gruppenwechsel und Peer-ID-Abfrage, Handy, die vier Ausfallzeilen der Matrix. |
| 1.4 | umgesetzt: Byte-Seiten und gemeinsame Commit-Budgets | UTF-8-Größe inklusive Antwortumschlag, Cursor bleibt bei zu kleinem Budget stehen; `readAll` ohne stillen 1000er-Abbruch. Txn-Erweiterungen reservieren Abschluss/Fanout; spätere Subscriptions aktualisieren die Reservierung. Limitabsenkung unter bestehende Verpflichtungen wird abgewiesen; mehrere Operationen in einer Storage-Txn teilen ein Budget. |
| 1.3 | umgesetzt: Revisionen, persistente Changes und unveränderliche Snapshot-Seiten | Ein Batch je Storage-Txn und Space, auch bei mehrfachem `spaceDoc`; interne Änderungen können leere Entry-Batches erzeugen. Tokens sind an Space/Strom, Query/Txn und Owner gebunden; TTL 60 s, 16 Snapshots und 64 MiB je Space, Reopen/Eviction → `SnapshotExpired`. Der vollständige Primary-Replikationsinhalt bleibt Stufe 3. |
| 1.8 | umgesetzt: Dispatcher mit allen Stufe-1-Methoden | Einschließlich `wait`, `notify`, `events`, `ack`; eigene Claims/Mailboxes und Txn-Ownership. `count`/`stats` und ihre Revision stammen aus demselben Snapshot. Ratenlimit je Peer, Pending-Limits je Principal und Peer; `hello` meldet Capabilities und Limits. Autorität/Epoche sind lokale Rahmenprüfungen; Schicht A/B gehört zu 1b. |
| 1.9 | umgesetzt: `RemoteSpace`, Socket- und pi-server-Transport | Stabile IDs/Argumentkopien bei Retry, Polls und echte Client-Frist auch bei hängendem Transport; `ResultExpired` bleibt ein Fehler. Alle SpaceLike-Funktionen einschließlich Mailboxes. Native Integration über vorhandene pi-server/pi-client-Pakete und gebauten Daemon nachgewiesen. |
| 1.9 (Socket) | umgesetzt: `serveSpace`/`socketTransport` | Frame-Grenze inklusive 8-Byte-Header; Multiplexing und Wiederverbindung. Reguläre Dateien, Symlinks und lebende Unix-Sockets werden nicht entfernt; nur bestätigte verwaiste Sockets, Cleanup nur des eigenen Inodes. TCP weiterhin Testtransport mit fest zugewiesener Identität; produktives Gate folgt in 1b. |
| 1b (Vorabtest) | umgesetzt: Szenario `sieve-remote` (`test/testbed/scenarios/sieve-remote.ts`), Host-Container im Netzwerk-Namespace ihrer NetBird-Agenten, `RemoteSpace.counters` | Der Dienst `space` über Unix-Socket und über das Overlay (TCP 7421 nur an der Overlay-Adresse) im produktionsnahen Testbed auf `big`: Primzahlsieb mit sterbenden Workern, Host-Kill und 10 s Netzunterbrechung (`partition`/`heal`), alle Prüfungen ok. Siehe [testumgebung-big.md](testumgebung-big.md) Abschnitt 13. Noch ohne Schicht A/B, Gate und RouterLease. |
| 1b.2/1b.3 | umgesetzt: Gate, Schicht A/B und persistente Komposition in `src/runtime.ts` | Zwei TCP-Gates mit getrennten persistenten Hosts und aktuellem Schlüsselverzeichnis über die Leitung geprüft. Android-Keystore auf dem realen Handy geprüft; zwei echte NetBird-Gates dauerhaft auf big. Handy–big, native Keystore-Identität und frische Formular-/QR-Payload-Kopplung bestanden. Vollständige fünfteilige NetBird-Ausfallmatrix bestanden, Zugriff wiederhergestellt und eigene Fault-Regeln entfernt. |
| 1b.4 | umgesetzt: geschützter Control Space, Enrollment und signierte Grants in `src/grants.ts` | Maximal 60 Sekunden, zwei Sekunden Zeitunsicherheit, Principal-/Schlüssel-/Scope-Bindung, Prüfung vor Mutation; Resolution führt keine Pending-Effekte aus. Aktuelle Rollen auch bei Txn-Commit/Lease-Renew. Privater Control-Signer und konfigurierter Start implementiert. Deployment mit getrennten Control-/Data-Hosts, Grants und Rotation über echtes Overlay geprüft. Verteilte Live-Restores und Handy-Bedienung bestanden; vollständige NetBird-Ausfallmatrix einschließlich Wiederaufnahme bestanden. |
| 1b.5 | umgesetzt: `createEnroll`, `revokePeer`, `rotateKey` im Supervisor, eigene Rotation mit alter/neuer Signatur | Kommandos und Result atomar, Rollen/Scope der Rotation bleiben erhalten, Data-Member kann eigenes Schlüsselmaterial rotieren, ohne Control-Daten zu lesen. Selbständiger Dienststart auf big installiert; echter createEnroll-/Rotationsablauf bestanden. Router-Journal später in Phase 2. |
| 1b.6 | umgesetzt und live geprüft: unabhängige CAS-Schnittstelle, SQLite-Register und signierter Autoritätswechsel | Konkurrierende Nachfolger, falsches Fencing und Rollback geprüft. Private Reader-/CAS- und signierte Recovery-Sockets, Forced-Command-Bridges und F15-Adapter implementiert. Register auf vpsc aktiv, Reader-/Operator-Trennung und Neustartpersistenz live geprüft; fest begrenztes Docker-/systemd-F15 und privater signierter SSH-Zugang bestanden. Verteilter Control-/Data-Live-Restore mit explizitem F15-Fencing bestanden. |
| 1b.7 | umgesetzt und persistent/live geprüft: begrenzte Restore-Funktionen, dauerhafter Cursor, historische Claims, Quarantäne und explizite Freigabe | Crash/Reopen auf JSONL und SQLite; keine Fortsetzung alter Pending-Arbeit, aktuelle Quoten und Fanout-Budgets. Data-Recovery-Journal, Admission-Sperre, Registry-Update, exakter ACK-/Boot-Abgleich und private RPC-Bindung implementiert. Control-Import schließt Bootstrap/Policy und setzt Epoche auf 1. ACK-Dienst/SSH-Kanal auf big installiert. Control-Controller, exklusiver Recovery-Start, Member-ACK-Replay und neue Adminfreigabe auf beiden Backends geprüft. Verteilter Live-Data-/Control-Restore einschließlich Member-ACKs und neuer Adminfreigabe bestanden. |
| 1b.8 | umgesetzt als Laufzeitbaustein: externe und lokal installierte Boot-Berechtigung je Space | Host-/Space-Zustand, Autorität, Inkarnation, Rolle und Epoche; Reads ebenfalls gesperrt, Registerversionen vor Commit erneut geprüft. Laufzeit verlangt den Guard. Provisionierter Start mit Socket, read-only SSH oder Register-TLS implementiert. Zwei produktionsnahe Daemons mit passendem externem/lokalem Boot-Nachweis auf big. Verteilter Live-Control-Restore mit gesperrtem altem Source und bestätigten Member-ACKs bestanden. |

| 2.1 | umgesetzt und persistent geprüft: `src/router.ts`, Command-Zustände, stabile Unterrequests, Recovery, Budgets, Restore-Review | Kein automatischer Zielwechsel; unklarer Ausgang bleibt offen oder `needsReview`; RouterLease/Delegation sind separat in 2.2 implementiert. |
| 2.2 | umgesetzt und persistent/TCP geprüft | signierte Lease, Original-Principal-Delegation, aktuelle Rechte, dauerhaftes Epoch-Fencing und gebundene Waiter-Erneuerung. |
| 2.3 | umgesetzt und persistent geprüft | atomare signierte Policy, unveränderliche HRW-/Typ-Platzierung, Capacity-/Capability-Auswahl und deklarierter Typkatalog. |
| 2.4 | umgesetzt und persistent/TCP geprüft | feste Routing-Pläne und Budgets, sequenzielle Takes, Teilabfragen, Txn-Bindung, journalisierter Waiter-Gewinner und Verlierer-Abort. Server-API; virtuelle öffentliche Space-Adresse ist keine automatische Folge. |
| 2.5 | umgesetzt und persistent/TCP geprüft | signierte Aufnahme/Drain/Freeze/Entfernung, gemeinsame lokale/Remote-Core-Sperren, EmptyProof und atomare Root-Referenzprüfung. |
| 2.8 | umgesetzt und geprüft: `test/support/federation-simulator.ts`, mehrere Harnesses, deterministische Latenz/Verlust/Duplikate/Partitionen/Uhrsprünge, Reservierungs-/Request-Gegenmodell | 45 neue Fälle in `test-router.test.ts`; kein Ersatz für echte Overlay-, Replikations- oder Lastabnahme. |
| 2.6 | umgesetzt und live abgenommen: Policy-Abschlussprofile, `purgeTasks`, `deletePrincipal`, kontrollierte Profilumstellung | [ap2-abnahme.md](ap2-abnahme.md) Blöcke 6–8 |
| 2.7 | umgesetzt: Capability-Verzeichnis und MemberStatus | Heartbeat nur über bewiesene Host-Schlüssel |
| 2.9 | umgesetzt und abgenommen: Lasttest und NetBird-Volllast, Gate 4 geschlossen | [ap2-gate4.md](ap2-gate4.md); Block 4 per Entscheidung abgeschlossen |
| 2b | umgesetzt: RunGate, Run-Controller, Remote-Members, Lauf-Recovery, Worker, Space-Lebenszyklus, Deployment-Bootstrap, mobile Steuerung, Alarmierung, Audit, Vorschau, Export, Zeitplan | [Betrieb §8](betrieb-und-mobile-steuerung.md#8-umsetzungsstand-und-reihenfolge-der-betriebserweiterung) und §7.6; Fall 3 über NetBird auf big, mobile Abnahme über WLAN und NetBird. Feinere Rollen für später notiert |
| 3.1 | Bausteine umgesetzt und geprüft: Entry-Replikation, gepagter Snapshot, Stream-Cursor, Generationenpflege; reale zehnminütige NetBird-Partition bestanden | [ap3-replikation.md](ap3-replikation.md); nicht in Dienst, Policy, Boot und Löschung eingebunden |
| 3.2 | Storage-Unterbau, signierter Transport, Spaces im Federation-Daemon und Bootstrap bestehender Stores umgesetzt; echte Läufe bestanden | [ap3-primary-sync.md](ap3-primary-sync.md); offen: öffentliches `commitSealed`, kein `NotCommitted` |
| 3.7 | Baustein umgesetzt: lww/set mit HLC, Tombstones, Add-Wins, Set-Lease-Erneuerung | Kompaktierung und öffentlicher Adapter offen |
| 3.3–3.6 | Replikatsteuerung umgesetzt; netcup-Fencing-Adapter real (F1/Gate 2); Promotion, Degrade, setStandby, Notice-Übernahme und Boot-Merkmal in echten Läufen geprüft | [ap3-replica-control.md](ap3-replica-control.md); offen: Degrade ohne Fencing-Adapter |
| 3.8 | Hauptstore auf primary/sync, Schritt 6 und Promotion des Control-Replikats umgesetzt; echte Läufe auf big bestanden | Root bei der Promotion offen |

Nachweise, genaue Grenzen und nächste Betriebsschritte: [Phase-1b-Abnahme](ap1b-abnahme.md).
