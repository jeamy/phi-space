# U0 – Bestand und Grenzwerte für die Umstellung ohne pi-durable (2026-10-22)

Arbeitspaket U0 aus [umstellung-ohne-pi-durable.md](umstellung-ohne-pi-durable.md): Bestandsaufnahme, Ausgangstests,
Lastprofil und vorgeschlagene Grenzwerte. Noch nichts am Code geändert außer dem Werkzeug `scripts/durable-imports.mjs`.

## 1. Stand

| Punkt | Wert |
|---|---|
| Commit | `f0fba2c` (Branch `codemode`); im Arbeitsbaum zusätzlich der Abbruch laufender Modellaufrufe beim Stop (`codemode-chat/server/llm.ts`, `model-host.ts`, Tests), noch nicht committet |
| Node | 22.23.1 (Linux x64); Docker-Image `node:22-bookworm-slim`; mobile Laufzeit verlangt Node ≥ 22.19 und nutzt `node:sqlite` schon |
| Datenträger | Projekt auf ext4; `/tmp` ist tmpfs (für Messungen der Dauerhaftigkeit ungeeignet) |
| pi-durable | `@earendil-works/pi-durable` und `@earendil-works/chord` mit `*` in `package.json` |

## 2. Ausgangstests

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | ohne Fehler |
| `npm test` (Root) | 765 Tests: 764 bestanden, 0 fehlgeschlagen, 1 übersprungen, 62 s |
| übersprungen | „a read-only copy of a real control store bootstraps and replays with identical content“: braucht `PHI_SPACES_BOOTSTRAP_COPY` (Kopie eines echten Kontrollspeichers) |
| `npm run test:pi-server` | 2 von 2 bestanden |
| `npm run test:codemode-chat` | 111 von 111 (letzter voller Lauf vor diesem Bericht) |

## 3. Importgraph

Erzeugt mit `node scripts/durable-imports.mjs` (Markdown) bzw. `--json`; erfasst `src`, `examples`, `test`, `scripts`,
`help-site` und `codemode-chat`. Ein Import gilt als transitiv, wenn eine Datei über beliebig viele lokale Imports eine
direkt importierende Datei erreicht.

| Bereich | direkt pi-durable | nur chord | davon nur Typen | nur transitiv |
|---|---|---|---|---|
| `src` | 39 | 10 | 21 | 38 |
| `test` | 54 | 2 | 2 | 61 |
| `examples` | 13 | 0 | 0 | 0 |
| `help-site` | 15 | 5 | 4 | 6 |
| `scripts` | 1 | 0 | 0 | 1 |
| `codemode-chat/server` | 1 (`space-host.ts`) | 0 | 0 | 15 |

Insgesamt 348 Dateien, 140 direkt, 124 nur transitiv.

### 3.1 Verwendete Namen

| Gruppe | Namen (Anzahl Dateien) | Bedeutung für den Ersatz |
|---|---|---|
| Kontext (chord) | `Context` 45, `BACKGROUND_CONTEXT` 54, `awaitWithContext` 2 | Abbruch-/Fristkontext in fast jeder Schnittstelle; Entscheidung D1 |
| Deltas (chord) | `apply` 3, `applyImmutable` 1 | Anwenden gespeicherter Dokumentdeltas (Erasure, Replikation) |
| Harness | `Harness` 78 (`Harness.open` 90 Aufrufe, meist Tests), `createRegistry` 71, `defineExtension` 3, `defineTool` 2, `section` 1 | Host-Erzeugung; Agent-Erweiterung nur in `src/index.ts` und Beispielen |
| Session/Transaktion | `Session` 10, `Tx` 8, `ConversationId` 1 | aufgerufen: `commit` 111, `tx.doc` 143, `snapshot` 69, `watchDoc` 11, `tx.retireDoc` 2, `close` 3, `conversation` 1 |
| Dokumente | `defineDoc` 17, `defineDocFamily` 16 | 33 Dokumentarten (Abschnitt 4) |
| Speicher | `MemoryStorage` 41, `openNodeSqliteStorage` 26, `openNodeJsonlStorage` 18, `Storage` 8, `StorageWrite` 4, `StorageRejected` 1, `DocumentId`/`DocumentRecord`/`Seq` je 1 | Backends; Speicherebene wird teils direkt benutzt (3.2) |
| dynamisch | `import("@earendil-works/pi-durable")` 14, Speicher-Subpfade 2 | in Laufzeit-/Konfigurationscode und Tests |

### 3.2 `Once`

`Once` (`src/client.ts`) hat genau einen Nutzer: die Agent-Werkzeuge in `src/index.ts` (`onceFor`). Sie schreiben das
task-gebundene Dokument `phi-spaces.claim` im selben Commit wie die Änderung am Space. Das ist der in Plan-Abschnitt 6
genannte Bruch: Sobald Space und Agent in getrennten Speichern liegen, ist das nicht mehr atomar. Er betrifft nur das
künftige Agent-Paket; der eigenständige Dienst braucht `Once` nicht.

### 3.3 Transaktionen über mehrere Dokumentarten

Dateien, deren Transaktionen mehr als eine Dokumentart berühren (statisch erhoben über `tx.doc(…)`, `spaceDoc(…)`,
`registry(tx)`/`hostKey(tx)`; je Datei, nicht je Commit). Mit Teilablage müssen diese Änderungen in **einer**
SQL-Transaktion landen; die Liste ist Eingabe für den Commit-Vertrag von U2, wo je Commit bestätigt wird:

| Datei | Dokumentarten |
|---|---|
| `src/client.ts`, `src/spaces.ts` | Registry, Space/NamedSpace |
| `src/index.ts` | Claim (Task), Registry, Space |
| `src/run-controller.ts` | RunJournal, Space |
| `src/recovery-controller.ts`, `src/control-recovery.ts` | Recovery-/Control-Jobs, Registry, Space |
| `src/control-ack.ts` | RecoveryReceipts, Space |
| `src/space-lifecycle.ts` | SpaceLifecycleJournal, Registry, Space |
| `src/data-admin.ts` | DataAdminJournal, Space |
| `src/supervisor.ts` | SupervisorJobs, Space |
| `src/workers.ts` | WorkerJournal, WorkerState |
| `src/router.ts` | RouterJournal, RouterCommands |
| `src/federation-references.ts` | FederationJournalLayout, FederationOperations, RouterCommands, RouterJournal, Space |
| `src/federated-space.ts` | FederationJournalLayout, FederationOperations, FederationRouting, MembershipJournal, ProfileTransitions |
| `src/membership.ts` | FederationRouting, MembershipJournal, MemberTransitions, ProfileTransitions, Space |
| `src/profile-transition.ts` | FederationOperations, FederationRouting, MembershipJournal, ProfileTransitions, Space |
| `src/federation-policy.ts` | ControlReplicaMarker, FederationRouting, ProfileTransitions, Space |
| `src/replica-notice.ts` | FederationRouting, ProfileTransitions, Space |
| `src/capability-directory.ts` | FederationRouting, Space |
| `src/delegation.ts` | ControlReplicaMarker, DelegationEpochs, Space |
| `src/root-erasure.ts` | ErasedEntryDigests, FederationJournalLayout, FederationOperations, RootErasures, RouterCommands, RouterJournal |
| `src/entry-replication.ts` | EntryReplicaPeers, EntryReplicas, EntrySnapshotChunks, EntrySnapshotMaintenance, EntrySnapshotTransfers, EntryStreamCheckpoints |

### 3.4 Kopplungen unterhalb der Dokumentschnittstelle

Diese Stellen hängen nicht nur an `tx.doc`, sondern am Speicherformat oder an Speicher-Interna von pi-durable:

| Datei | Kopplung | Zielpaket |
|---|---|---|
| `src/primary-sync.ts` | repliziert `StorageWrite`-Batches (Speicherdeltas von pi-durable) als Primary/Sync-Journal | U4: eigenes Deltaformat des neuen Speichers |
| `src/erasure-sqlite.ts` | SQL direkt auf Schema v1 von pi-durable (`documents`, `document_revisions`), wendet Deltas mit chord an | U2: Wartung des eigenen Speichers; alter Pfad nur noch im Legacy-Werkzeug (U5) |
| `scripts/migrate-namespace.mjs` | Offline-Kopie eines pi-durable-SQLite v1 | U5: Legacy-Werkzeug |
| `src/commit-sealed.ts` | `StorageRejected` als Fehlersignal des Speichers | U2: eigener Fehlertyp |
| `src/dashboard.ts`, TUI | öffnen JSONL-/SQLite-Speicher selbst | U6 |
| `src/index.ts` | Agent-Tools, Task-Dokument `phi-spaces.claim`, Zustellung an Conversations | U1: Trennung; U6: separates Agent-Paket |
| `codemode-chat/server/space-host.ts` | `Harness.open`, `MemoryStorage`, `openNodeSqliteStorage`, `createModels` | U3: erster echter Nutzer des eigenen Dienstes |

## 4. Dokumentkatalog

Alle `defineDoc`/`defineDocFamily` in `src`, Beispielen und Hilfeseite (Familie: viele Dokumente einer Art mit
Schlüssel). „Teil“: Teilablage in U2 nötig, weil das Dokument mit der Last wächst.

| Art | Version | Bereich | Datei | Familie | Bemerkung |
|---|---|---|---|---|---|
| `phi-spaces.space` | 5 | session | `src/doc.ts` | nein | Space; Basis alle 500 Deltas, Migration; **Teil** |
| `phi-spaces.named-space` | 5 | session | `src/spaces.ts` | ja | benannte Spaces, wie oben; **Teil** |
| `phi-spaces.registry` | 1 | session | `src/spaces.ts` | nein | Aliase, Space-Identitäten, Host-Schlüssel |
| `phi-spaces.claim` | 1 | task | `src/index.ts` | nein | Agent-Task-Claim; geht ins Agent-Paket |
| `phi-spaces.router-journal` / `router-command` | 1 | session | `src/router.ts` | ja | Router-Journal und einzelne Kommandos |
| `phi-spaces.delegation-epochs`, `control-replica-marker` | 1 | session | `src/delegation.ts` | ja | |
| `phi-spaces.federation-routing` | 1 | session | `src/federation-policy.ts` | ja | |
| `phi-spaces.federation-operations` | 1 | session | `src/federated-space.ts` | ja | |
| `phi-spaces.federation-journal-layout` | 1 | session | `src/federation-journals.ts` | ja | |
| `phi-spaces.membership-journal`, `member-transitions` | 1 | session | `src/membership.ts` | ja | |
| `phi-spaces.data-admin` | 1 | session | `src/data-admin.ts` | ja | |
| `phi-spaces.deployment` | 1 | session | `src/deployment.ts` | nein | |
| `phi-spaces.entry-replica`, `entry-replica-peers` | 2 / 1 | session | `src/entry-replication.ts` | ja | Migration bei `peers` |
| `phi-spaces.entry-stream-checkpoints` | 1 | session | `src/entry-replication-stream.ts` | ja | |
| `phi-spaces.entry-snapshot-transfers`, `-chunk`, `-maintenance` | 1 | session | `src/entry-replication-transfer.ts` | ja | |
| `phi-spaces.profile-transitions` | 1 | session | `src/profile-transition-doc.ts` | ja | |
| `phi-spaces.root-erasures`, `erased-entry-digests` | 1 | session | `src/root-erasure-doc.ts` | ja | |
| `phi-spaces.control-recovery-receipts` | 1 | session | `src/control-ack.ts` | nein | |
| `phi-spaces.control-recovery-jobs` | 1 | session | `src/control-recovery.ts` | nein | |
| `phi-spaces.recovery-jobs` | 1 | session | `src/recovery-controller.ts` | nein | |
| `phi-spaces.supervisor-jobs` | 1 | session | `src/supervisor.ts` | nein | |
| `phi-spaces.run-controller` | 1 | session | `src/run-controller.ts` | nein | |
| `phi-spaces.space-lifecycle` | 1 | session | `src/space-lifecycle.ts` | nein | |
| `phi-spaces.worker-assignments`, `worker-supervisor` | 1 | session | `src/workers.ts` | nein | |
| `phi-spaces.example-cache-version`, `example-sieve-runs` | 1 | session | `examples/` | nein | Beispiele |
| `phi-spaces.research-validation` | 1 | task | `examples/research-support.ts` | nein | Agent-Beispiel |
| `phi-spaces.help-web-admin` | 1 | session | `help-site/server/admin/admin-controller.ts` | nein | Hilfesystem |

### 4.1 Inhalt des Space-Dokuments

`SpaceState` (`src/core.ts`) hält in **einem** Dokument: `entries`, `txns`, `regs`, `waiters`, `outbox`, `returned`,
`nextId`, `limits`, `spaceId`, `incarnation`, `rpc` (Claims und Generationen), `stream` (Änderungsverlauf),
`completionProfiles`, `mailboxes`, `jobs`, `releaseQueue`, `maintenance`, `primaryEpoch`, `acceptedAuthorityId`,
`authorityTransition`, `authorityCounters`, `restore`, `restoredClaims`, `invalidGenerations`, `runGates`, `archived`,
`erasureEpoch`, `adminMaintenance`, `snapshotEpoch`, `membership`.

## 5. Lastprofil (gemessen am Codemode-Chat)

Lokale Docker-Testumgebung (big/nano, alle Rollen über TCP), 9,5 Stunden überwiegend Leerlauf, dazu einige Läufe:

| Teil des Space-Dokuments | Größe |
|---|---|
| `rpc` (45 171 Claims mit Ergebnis) | 27,1 MB |
| `stream` (Änderungsverlauf, Grenze `maxLogBytes` 4 MB) | 4,2 MB |
| `entries` (die eigentlichen Daten) | 0,06 MB |
| ganze Basis (alle 500 Deltas vollständig geschrieben) | 31,4 MB |

- Claims nach Methode: `txn.begin` 9 793, `lease.renew` 10 533, `take` 8 461, `txn.abort` 8 288, `readIfExists` 4 123,
  `write` 3 821. Fast alles Leerlauf: Warteschleifen (Transaktion, wartendes `take`, Abbruch alle 5 s) und
  Lease-Erneuerungen. Im Mittel rund 600 Bytes je Claim (`rpc.bytes` 27 118 868, der Wert der Grenzprüfung).
- Rate: in den Stunden reinen Leerlaufs (23 bis 4 Uhr) rund 2 500 Claims pro Stunde, also etwa 1,5 MB pro Stunde; mit
  den Läufen und Neustarts am Abend bis 12 000 pro Stunde.
- Folge: Bei 24 h Aufbewahrung (`claimResultMs`) erreicht reiner Leerlauf die Grenze `maxClaimBytes` (32 MB) nach etwa
  21 h (Gleichgewicht ≈ 36 MB), mit etwas Last früher (in dieser Umgebung nach etwa 12 h). Danach lehnt der Space neue
  Anfragen ab.
  Unter Last (rund 140 Einsendungen) lief der Space-Prozess dauerhaft bei 100 % CPU (Basis schreiben, lineare Suche),
  Clients liefen in Zeitüberschreitungen.
- Ursache ist das Speichermodell (ein Dokument je Space, vollständige Basis, lineare Suche im Speicher), nicht SQLite.

### 5.1 Vergleichsmessung: SQLite mit einer Zeile je Eintrag

`node:sqlite`, WAL, 20 000 Einträge zu 2 KB; ein Commit = ein Eintrag schreiben, einen entnehmen, einen Claim ablegen:

| Profil | ext4 (Projektplatte) | tmpfs |
|---|---|---|
| `synchronous=NORMAL` | 1,3 ms je Commit (≈ 770/s) | 0,04 ms |
| `synchronous=FULL` | 27,7 ms je Commit (≈ 36/s) | 0,04 ms |
| Zählen über Index (Typ, Raum) | – | 0,03 ms |

Die Grenze setzt das `fsync` je Commit. Für FULL ist deshalb ein gebündelter Commit nötig (mehrere Space-Commits in
einer SQL-Transaktion mit einem `fsync`, Bestätigung aller erst danach).

## 6. Vorgeschlagene Grenzwerte (zur Freigabe)

| Grenzwert | Vorschlag | Messung in |
|---|---|---|
| Commit-Latenz, ein Space-Commit, Profil NORMAL | p95 ≤ 5 ms, p99 ≤ 20 ms | U2 |
| Commit-Latenz, Profil FULL mit Bündelung | p95 ≤ 50 ms bei ≥ 300 Commits/s | U2 |
| Schreibvolumen je Commit | proportional zu den geänderten Einträgen/Claims; keine Vollbasis eines Space | U2 |
| Kapazität | 10 000 Einträge je Space, 100 Spaces, 150 000 Claims (24 h Leerlauf des Chats mit Reserve) | U2/U7 |
| Matching | `take`/`read` über Typ und Felder ohne Vollscan (Index) | U2 |
| Speicher des Space-Prozesses | ≤ 300 MB RSS beim Kapazitätsprofil | U7 |
| Start (Wiederöffnen) beim Kapazitätsprofil | ≤ 2 s bis bereit | U2/U7 |
| RPO | 0 für bestätigte Commits im Profil FULL innerhalb des getesteten Ausfallmodells | U7 |
| RTO lokal (Prozess neu) | ≤ 5 s | U7 |
| Plattformen | Linux x64 Node ≥ 22.19 (nativ und Docker), Android/Termux Node ≥ 22.19 | U2/U6 |

## 7. Zielzuordnung

| Heute (pi-durable) | Ziel |
|---|---|
| `Harness.open` + `createRegistry` + `registry.install(spaces)` | `openSpaceHost({ store })` in `src/host.ts` (U1 Typ, U2/U3 Implementierung); Tests über eine gemeinsame Fixture |
| `Session.commit(fn)` | `SpaceHost.commit(fn)` mit serieller Warteschlange und gebündeltem `fsync` |
| `tx.doc(Def)`, `tx.doc(Family, key, seed)`, `tx.retireDoc` | `StoreTx.doc`/`retire` mit eigenen Dokumentdefinitionen (`src/store/documents.ts`) |
| `Session.snapshot` | konsistenter Lese-Snapshot (SQLite-Lesetransaktion) |
| `Session.watchDoc` | Wecksignal nach Commit, Registrierung vor erster Prüfung |
| Space-Dokument als Ganzes | Teilablage: Einträge, Claims, Generationen, Änderungsverlauf, Mailboxes je eigene Zeilen; der Rest (Grenzen, Identität, Zähler, Txns) als Kopfzeile |
| `MemoryStorage` | `src/store/memory.ts` (nur Tests) |
| `openNodeSqliteStorage` / `openNodeJsonlStorage` | `src/store/sqlite.ts`; JSONL entfällt (nur noch Legacy-Leser U5) |
| `checkpointWhen` / Basis alle 500 Deltas | entfällt für Space; kleine Journale weiter als ganze Werte |
| `StorageWrite`-Replikation (`primary-sync.ts`) | eigenes Deltaformat aus der Teilablage (U4) |
| `erasure-sqlite.ts` | Wartung des eigenen Speichers (U2) |
| chord `Context` / `BACKGROUND_CONTEXT` | Entscheidung D1 |
| Agent-Teile von `src/index.ts`, `Once` | separates Paket (U1 trennen, U6 paketieren); `Once` dort nur auf eigenen Dokumenten |
| `examples/` (13 direkte Importe) | auf den eigenen Host umstellen (U3), Agent-Beispiele ins Agent-Paket (U6) |
| `help-site` (15 direkt pi-durable, 5 nur chord) | eigene Anwendung mit eigenem Speicher und Admin-Dokument: Umstellung in U6 |

## 8. Offene Entscheidungen

- **D1 – chord: entschieden (2026-10-22): eigener Kontext.** Ein eigener Kontext (Abbruchsignal und Frist) ersetzt
  `Context`/`BACKGROUND_CONTEXT` von `@earendil-works/chord` in U1; das Anwenden von Deltas (`apply`) bekommt eine eigene
  Implementierung. Das Paket wird damit frei von `@earendil-works/*`.
- **D2 – Grenzwerte: entschieden (2026-10-22):** die Vorschläge in Abschnitt 6 gelten.
- **D3 – Standardprofil: entschieden (2026-10-22):** FULL mit gebündeltem Commit ist Standard; NORMAL nur ausdrücklich
  gewählt.
- **D5 – Byte-Budgets:** Die 32 MiB für Claims sind ein Teilbudget des Gesamtdokuments (128 MiB), das heute ganz im
  Speicher liegt und als Basis ganz geschrieben wird (`DEFAULT_LIMITS`, [ap2-gate4](abnahme/ap2-gate4.md): „keine
  24-Stunden-Dauermessung“). Mit Teilablage liegen Claims als Zeilen auf der Platte; ihre Grenzen werden in U2 neu
  festgelegt (Anzahl und Bytes auf der Platte statt Anteil eines Dokuments im Speicher).
- **D4 – Claims im Chat: entschieden (2026-10-22):** Aufbewahrung bleibt 24 h (Vertrag); die Zeilenablage trägt sie.

## 9. Nächster Schritt

U1: eigene Typen für Host, Speichertransaktion und Dokumente einführen, pi-durable dahinter als Übergangsadapter,
alle Tests unverändert grün; danach U2 mit Teilablage und gebündeltem Commit.
