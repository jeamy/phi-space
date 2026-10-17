# Phase 3: Replikatsteuerung (Promotion, degradeToSingle, setStandby)

Stand 2026-10-16. Umgesetzt mit Simulator-Adapter; die Abnahme ist durch F1/Gate 2 (realer
Fencing-Adapter) blockiert. Grundlage: [federation-plan-v3.md](federation-plan-v3.md) §5.3, §5.3.1 und §5.5,
Plan-Pakete 3.3–3.6 in [implementierungsplan-v3.md](implementierungsplan-v3.md). Code: `src/replica-control.ts`,
Konfigurationseinträge in `src/primary-sync.ts`, Tests in `test-replica-control.test.ts`.

## Konfigurationsübergänge als Einträge der Sync-Kette

Eine Änderung der Replikatkonfiguration ist ein eigener Eintrag (`version: 2`) der Hashkette des
`PrimarySyncJournal`. Er enthält:

- die neue Konfiguration und den Hash der vorherigen;
- eine Begründungs-ID, nämlich die Übergangs-ID;
- als einzige Änderung den Datenmarker.

`validateConfigTransition` erzwingt:

- gleiche Space- und Autoritäts-ID;
- `replicaConfigVersion` genau +1;
- die Epoche bleibt gleich oder steigt um 1; ein neuer Primary verlangt +1.

`durability: "single"` verlangt `standbyReplica: null`.

Jeder Journal-Zustand kennt die Konfiguration zu jeder Revision (`configAt`). Deshalb prüfen Standby,
Wiedereinspielung und Materialisierung jeden Eintrag gegen die Konfiguration, die vor ihm galt. Ein
Kandidat, der unter `single` versiegelt wurde, braucht beim Neustart kein Standby-ACK.

## Fencing (v3 §5.5)

`FencingAdapter` bietet `fence`, `verify` und `release(host, "quarantine")`. Boot-Zustände liegen nicht im
Adapter, sondern im unabhängigen Recovery-Register.

- `SimulatorFencing` meldet `kind: "simulator"`. Promotion und degradeToSingle lehnen ihn ab, außer ein Test
  setzt ausdrücklich `allowSimulator`. Für diese Ablehnung gibt es einen eigenen Test.
- `unconfiguredFencing(kind, provider)` ist der Platzhalter für Anbieter ohne Zugang. Jede Operation
  scheitert mit „not configured“.
- `NetcupFencing` (`src/netcup-fencing.ts`, `kind: "cloud"`) nutzt die SCP-REST-API von netcup; siehe
  [netcup-Adapter](#netcup-adapter).
- Die Boot-Übergänge laufen per CAS über das Register. Erneut versucht wird nur bei `RegisterConflict`; ein
  anderer Fehler bricht den Übergang ab.
  - `fenceHostBoot` setzt den Host auf `fenced` und alle Space-Berechtigungen auf `revoked`. Die Werte bleiben
    zur Prüfung erhalten.
  - `releaseHostToQuarantine` führt ausschließlich von `fenced` nach `quarantine`. Erst danach hebt der
    Adapter die Neustartsperre auf.
  - `active` setzt nur das Ende von `setStandby`.

## netcup-Adapter

Grundlage ist die je Benutzer ausgelieferte OpenAPI-Spezifikation der SCP-REST-API
(`https://www.servercontrolpanel.de/scp-core/api/v1`, Version 2026.1015, 63 Pfade). Endpunkte:

- `GET /servers/{id}`: Zustand und Autostart (`serverLiveInfo.state`, `serverLiveInfo.autostart`);
- `GET /servers/{id}/interfaces`: MACs;
- `PATCH /servers/{id}` mit `application/merge-patch+json` und genau einem Attribut je Aufruf; liefert 202
  und eine Aufgabe;
- `GET /tasks/{uuid}`: Aufgabenstatus.

Ablauf:

- **fence:**
  1. Prüft die festgelegte Identität: Host-ID → Server-ID und MAC, nur aus der lokalen Liste.
  2. Merkt sich den bisherigen Autostart-Wert und schaltet Autostart ab.
  3. Schaltet hart aus: `state: OFF` mit `stateOption=POWEROFF`.
  4. Liest den Server erneut. Ein Nachweis mit `restartLocked: true` entsteht nur bei genau `SHUTOFF` und
     Autostart aus.
  5. Aufgaben in `ERROR`, `CANCELED` oder `ROLLBACK` sowie 503 (Wartung) gelten als Fehlschlag.
- **verify:** fragt bei jedem Aufruf den Live-Zustand des Servers ab, den die lokale Liste zur Host-ID nennt.
  Die Server-ID im Nachweis wird nie verwendet.
- **release:** nur nach `quarantine`. Stellt den alten Autostart-Wert wieder her und schaltet ein.

Mit netcup heißt „Neustartsperre“: Autostart aus und `SHUTOFF` beobachtet. Wer Zugang zum SCP hat, kann den
Server trotzdem starten. Die eigentliche Sperre ist der Boot-Zustand `fenced` mit widerrufenen Berechtigungen
im Register.

Betrieb:

- Token und Aufrufe bleiben auf vpsc. Der Dienst `scripts/fencing-netcup-tls.mjs` (Teil von
  `npm run build:operations`) bietet `fence`, `verify` und `release` per mTLS an, nur für
  Operator-Zertifikate.
- Transitionshosts nutzen `TlsFencing` als schlanken Client.
- Der Dienst läuft als eigener Prozess neben dem Register; das Register selbst sieht den Token nie.
- Anmeldung per Device-Flow mit `scripts/netcup-login.py`, als Benutzer `mux` auf vpsc. Ergebnis ist ein
  Offline-Refresh-Token in `~/.config/pi-spaces-fencing/netcup.json` (0600).
- Keycloak rotiert den Refresh-Token. Dienst und Skript erneuern ihn deshalb nur unter derselben Sperrdatei
  `netcup.json.lock`.
- Der Token verfällt nach etwa 30 Tagen ohne Nutzung; regelmäßige Statusabfragen halten ihn aktiv.
  Widerruf im SCP-Konto unter „Kontosicherheit → Geräteaktivität“.
- Das SCP-Konto ist IP-beschränkt. Freigegeben sind die Adressen von vpsc: `2a02:c207:2252:8263:8000::`
  und `207.180.233.218`.
- Ausgerollt am 2026-10-16 als User-Dienst `pi-spaces-fencing.service` von `mux` auf vpsc (Linger an).
  Er lauscht auf `[::]:17423`, Konfiguration in `~/.local/share/pi-spaces-fencing/fencing.json`.
  - Serverzertifikat `CN=pi-spaces-fencing-server` aus der Operator-CA mit SAN `207.180.233.218`,
    `2a02:c207:2252:8263:8000::` und `pi-spaces-fencing`. Der Schlüssel wurde auf vpsc erzeugt; lokal wurde
    nur die Anfrage signiert.
  - Freigegeben ist nur das Operator-Zertifikat (`a8baf286…`).
  - ufw erlaubt 17423 nur von der Operator-Adresse `212.186.197.226`.
- Nicht verändernde Prüfung von lux27 aus:
  - `verify` für `nano-test` liefert `false`, weil nanoi `RUNNING` ist.
  - `verify` für `big` liefert `false`, weil `big` nicht in der Liste steht.
  - Das Reader-Zertifikat wird abgewiesen.
  - Der Dienst hat den Refresh-Token rotiert; die Kette blieb gültig.
- Festgelegtes Ziel ist nur nanoi: `nano-test` → Server 964249, MAC `2a:38:5f:38:de:22`. Server 730972 ist big
  und steht nie in der Liste.

## Berechtigungsprüfungen

- `assertSyncPrimary` ist `assertPrimary` für `primarySyncStorage`. Sie verlangt:
  - Host `active`;
  - eine aktive Primary-Berechtigung mit genau der Autorität, Epoche, Replikatversion und Durability der
    aktuellen Journal-Konfiguration.

  Solange externer und lokaler Stand auseinanderliegen, bleibt jeder Schreibzugriff gesperrt.
- `assertSyncStandby` ist `assertStandby` des Journals und verlangt dasselbe für die Rolle `standby`.
  Einzige Ausnahme: Den `setStandby`-Eintrag, der diesen Host als Standby nennt, bestätigt er auch in
  `quarantine`.
- `promote` prüft die Standby-Berechtigung ohne Quarantäne-Ausnahme. Ein freigegebener Standby mit
  veralteter Historie kann sich daher nicht selbst befördern.

## Schreibsperre während eines Übergangs

v3 §5.3.1, Schritte 1 und 7: Solange im Journal ein Übergang in `started` oder `locallyCommitted` steht, versiegelt
`PrimarySyncJournal.seal` keine fachliche Entscheidung.

- **Atomar:** Die Prüfung läuft in derselben SQLite-Transaktion wie das Versiegeln, also ohne Lücke zwischen dem
  Beginn eines Übergangs und seinem Konfigurationseintrag.
- **Erlaubt bleiben** nur die Konfigurationseinträge (`version: 2`) des Übergangs selbst.
- **Alle Schreibquellen:** Reaper, Agenten, Clients und Lease-Erneuerungen committen alle über den Storage und
  sind damit gemeinsam gesperrt.
- **Folge in pi-durable:** Der erste abgewiesene Commit vergiftet die laufende Harness-Sitzung. Der Übergang läuft
  also mit gestopptem Dienst auf dem rohen Storage, und auch ein neu gestarteter Dienst schreibt bis zum Abschluss
  nichts.
- **Nach `completed`:** Der Dienst wird neu geöffnet, und der Reaper holt abgelaufene Leases genau einmal nach.

Weitere Regeln:

- `beginTransition` erlaubt je Journal genau einen offenen Übergang. Dieselbe ID setzt fort, eine andere wird
  abgewiesen.
- Ein abgelehnter Übergang bleibt offen und sperrt den Space. Das betrifft etwa einen Simulator-Nachweis, falsche
  Versionen oder einen Primary, der während des Nachladens gefenct wurde. `abandonTransition(id)` beendet ihn,
  aber nur in `started` und nur, solange kein Konfigurationseintrag mit dieser ID versiegelt ist. Ein schon
  ausgeführtes `fenceHostBoot` am Gegenüber bleibt bestehen. Eine aufgegebene ID ist nicht wiederverwendbar.

## Boot-Guard und Wiederzulassung (3.6)

`installBootGuard` hat einen optionalen Hook `replicaConfig(spaceId)`, der die aktuelle Journal-Konfiguration
liefert.

- Für einen primary/sync-Space verlangt der Guard die Rolle `primary` dieses Hosts sowie Autorität, Epoche,
  Replikatversion und Durability genau wie im Journal.
- Eine `standby`-Berechtigung lässt weder Commits noch Lesezugriffe zu.
- Weicht die Journal-Konfiguration nach einem lokalen Übergang von der externen Berechtigung ab, ist nur dieser
  Space gesperrt.

`fenceHostBoot` widerruft alle Spaces des Hosts, ein Übergang lässt aber nur seinen eigenen Space wieder zu. Die
übrigen Spaces kommen einzeln zurück:

1. `readmitSpace` läuft auf der Operator- bzw. Supervisor-Seite. Es aktiviert nur eine widerrufene Berechtigung
   mit unveränderter Rolle und Dateninkarnation, und nur, wenn der Host `active` ist. Replizierte Rollen kommen nur
   über `promote`, `degradeToSingle` oder `setStandby` zurück.
2. Der Host übernimmt mit `installAdmittedPermit` genau diese externe Berechtigung in seine lokale Installation,
   nachdem er die Dateninkarnation geprüft hat.

Invariante: Ein Host, der gefenct werden kann, schreibt nie seinen eigenen Boot-Eintrag. Er liest ihn nur und
installiert lokal.

## Control Space auf primary/sync (3.8)

**Hauptstore als Sync-Store:** Ein Control-Host kann seinen ganzen Hauptstore als primary/sync betreiben
(`mainSync` in der Konfiguration). Die Kette deckt damit jeden Space dieses Stores ab; auf host-a sind das der
Standard-Space und der Control Space.

**Daemon:**

- `run` öffnet die Haupt-Harness über `primarySyncStorage`, nach Klärung eines offenen Kandidaten.
- `main-sync` ist das Werkzeug bei gestopptem Dienst: `bootstrap`, `status` mit Store-Prüfsumme, `degrade` und
  `set-standby`.
- `replica-listen` betreibt einen Control-Standby nur mit Journal und signiertem Listener; er bedient nichts.
- Andere Modi weisen einen Sync-Hauptstore ab, weil sie das Journal umgehen würden.

**Epochen:** Router-Lease, Epochen-Hinweis, Root-Prüfung, `hello` und Delegationsprüfer nehmen die
Control-Epoche aus dem Journal (`controlEpoch`, `boot.replicaConfig`). Das Space-Dokument behält seine
Anlage-Epoche; ohne das wäre nach `degradeToSingle` die Router-Lease ungültig.

**Geschwister-Spaces:** Ein Übergang zieht die Berechtigungen aller Spaces des Stores nach (`siblingSpaces`); jeder
behält seine eigene Dateninkarnation.

**Schritt 6, Sonderfall Control Space (v3 5.3.1):** Der Übergang ist ein Konfigurationseintrag im Journal, kein
Store-Commit. Sein Policy-Schritt folgt deshalb im ersten Commit danach, bevor der Host etwas bedient.

- **Abgleich beim Start:** `startConfiguredFederation` liest die letzte Transition des Journals
  (`lastConfigTransition`). Noch vor Grants, Router-Lease und Root führt `alignControlReplicaIn` sie aus.
  - Der Abgleich setzt den Marker `ControlReplicaMarker` (Transition, Epoche, Version, Vorgänger-Epoche, gleicher
    Primary) und erhöht in demselben Commit `policyVersion` einer installierten Routing-Policy.
  - Er ist idempotent je Transition. Ein Absturz zwischen Übergang und Abgleich wird beim nächsten Start
    abgeschlossen.
- **Lease über den Übergang:** Eine aufbewahrte oder noch lebende Router-Lease erneuert sich nur dann aus einer
  älteren Control-Epoche, wenn der Marker einen Übergang mit gleichem Primary (`degradeToSingle`, `setStandby`)
  aus genau dieser Epoche belegt. Router-Epoche und Lease-ID bleiben dabei gleich. Nach einem Primary-Wechsel
  erneuert sich keine alte Lease.
- **EpochNotice:** Der Root sendet die signierte `EpochNotice` des Supervisors je Transition an jedes aktive
  Member. Nach einem Root-Neustart sendet er sie erneut; das Member behält das Maximum.
- **Werkzeug:** `main-sync` lässt `degrade` und `set-standby` auch mit Routing-Policy zu. Es weist sie vorher ab,
  wenn eine offene Profilumstellung den Policy-Schritt später blockieren würde.
- **Laufende Operationen:** Bereits zugelassene Root-Operationen tragen ihre alte `policyVersion` weiter. Ein Member
  lehnt neue Anfragen mit alter Version ab, wie bei jeder anderen Policy-Änderung, etwa `addMember`.

**Grenzen:**

- **Promotion eines Control-Replikats** wird abgewiesen. big ist nie Fencing-Ziel, und für den Control-Host gäbe es
  nur einen Container-Fencing-Adapter. Außerdem fehlen dem neuen Host Root-Lease-Datei und eigene Router- und
  Host-Schlüssel.
- **Schritt 6** ist umgesetzt, lokal geprüft (`test-configured-root.test.ts`) und auf host-a echt gelaufen
  ([Nachweis](../test/evidence/step6-hosta-2026-10-17/README.md)). Dass die Marke am Member aus der `EpochNotice`
  stammt und nicht aus der ersten Delegation der neuen Epoche, ist dabei nicht unterscheidbar.
- **Kopplung:** Mit Standby braucht jeder Control-Write dessen ACK. Fällt der Standby aus, stehen Enrollments,
  Admin-Commands und Routing-Änderungen bis zu `degradeToSingle`.
- **Kein Rückweg:** Ein Bootstrap lässt sich nicht rückgängig machen. Zurück geht es nur über die Kopie vor der
  Migration, mit Verlust späterer Control-Writes, oder dauerhaft im Single-Betrieb mit wachsendem Journal.

**Messung auf der Kopie von host-a:** 114 Control-Commits in sechs Tagen, Revisionen von 1–3 KB. Das Journal-Budget
von 64 MiB reicht damit grob für Jahre.

**Geprüft** (`test-bootstrap.test.ts`, beide Backends) mit einem Control-artigen Hauptstore: Bootstrap,
`setStandby` an einen Listener, synchron bestätigte Control-Writes, `degradeToSingle` mit Geschwister-Space,
danach Epoche 2 in Berechtigungen, Boot-Guard und Router-Lease.

## ReplicaConfigNotice (v3 §5.3.1 Schritt 5)

Nach `promote`, `degradeToSingle` oder `setStandby` bietet der Primary die neue Replikatkonfiguration als
signierte Notice an. Code: `src/replica-notice.ts`.

**Erzeugen:** `replicaConfigNotice(journal, transitionId, dataIncarnation)` leitet den Inhalt deterministisch aus
dem Konfigurationseintrag des abgeschlossenen Übergangs ab. Ein Absturz zwischen `completed` und dem Abholen
verliert also nichts.

**Signieren:** `signReplicaConfigNotice` signiert mit dem Host-Schlüssel des neuen Primary.

**Übernahme:** `adoptReplicaConfigNotice` übernimmt die Notice auf Router-Seite in einem eigenen Control-Commit.

- **Prüfung:** Die Signatur muss vom genannten Primary stammen. Entscheidend ist aber das unabhängige Register:
  Der Primary muss dort `active` sein und eine aktive `primary`-Berechtigung mit genau Epoche, Version,
  Durability und Dateninkarnation der Notice haben. Eine solche Berechtigung entsteht nur durch einen gefencten
  Übergang. Ein gefencter alter Primary mit weiterhin enrolltem Schlüssel kommt deshalb nicht durch.
- **Wirkung:** Geändert werden in einem Commit nur:
  - `replication` und `target` (Host, Epoche, Dateninkarnation) des einen Members, dessen Space die Notice nennt;
  - die Replikatfelder der Sync-Primary-Regeln dieses Members;
  - `policyVersion + 1`.

  Der Validator verlangt, dass Primary-Regel und `member.replication` übereinstimmen. Die Platzierung einer
  Primary-Regel ist nur ihr Member; eine neue Replikatkonfiguration gilt deshalb nicht als Platzierungsänderung.
  Member holen die Policy bei jeder Delegationsprüfung live vom Control-Host und sehen die neue Version also
  sofort.
- **Wiederholung:** Dieselbe Version mit derselben Recovery-ID ist ein No-op. Abweichende oder ältere Notices
  werden abgewiesen; eine alte Policy setzt die lokale Durability nie zurück.
- **Profilübergänge:** Solange einer offen ist, wird nicht übernommen.

**Sperre auf Member-Seite (`ReplicaConfigPending`):**

- Delegationen tragen für replizierte Member `targetReplicaConfigVersion` aus der Member-Tabelle des Routers.
- Der `DelegationVerifier` mit Hook `replicaConfig` weist neue Arbeit mit `ReplicaConfigPending` ab, solange diese
  Version nicht der Journal-Konfiguration entspricht. Das deckt auch `setStandby` ab, das nur die Version erhöht.
- Folgeaufrufe bereits zugelassener Operationen laufen unter ihrer ursprünglichen Bindung weiter.
- Lokale Arbeit ist nicht betroffen.
- Nach der Übernahme gibt sich die Sperre ohne eigene Rückmeldung frei.

**Abholen:** Der Primary legt die Notice im Control Space ab, statt dass der Router ihn befragt. Der Router kennt
den neuen Primary ja erst nach der Übernahme.

- `latestReplicaConfigNotice(journal, dataIncarnation)` liefert die Notice des jüngsten abgeschlossenen Übergangs.
- Die Wire-Methode `replicaNotice` (`RemoteSpace.publishReplicaNotice`) ist gebaut wie `capabilityHeartbeat`: Sie
  verlangt einen aktuell bewiesenen Host-Schlüssel und einen Grant.
- `ReplicaNoticeBoard` speichert höchstens eine Notice je Space und Host, und nur die des bewiesenen Hosts selbst.

**Nativer Root (`configured-root.ts`):**

- Replizierte Member können `replicas` provisionieren, also weitere Replikat-Hosts mit Peer-ID, Schlüssel und
  Adresse.
- Der Heartbeat übernimmt vor jeder Statusrunde die veröffentlichten Notices (`adoptReplicaNotices`). Den
  Schlüssel des Absenders schlägt er in dieser Provisionierung nach.
- Der Transport löst die Adresse bei jedem Aufruf über das aktuelle Routing-Ziel auf. Nach der Übernahme gehen
  Aufrufe also an den neuen Primary.
- Ein gespeichertes Ziel auf einem provisionierten Replikat-Host gilt beim Neustart als provisioniert.
- Getestet mit zwei Loopback-Endpunkten: Vor der Übernahme geht der Status-Abruf an den alten Host, danach an den
  neuen, und auch nach einem Neustart des Root.

**Offen:**

- Promotion eines Control-Replikats mit Router-Wechsel (`routerEpoch` nach Ablauf der alten Lease); der Root lehnt
  einen Router-Epochenwechsel beim Wiederöffnen bisher ab.

## primary/sync-Spaces im Federation-Host

Nach v3 §7.2 („pro Space eine vollständige geordnete Commit-Historie“) und `ap3-primary-sync.md` läuft jeder
primary/sync-Space in einem eigenen Store. `openSyncSpace` (`src/sync-spaces.ts`) öffnet ihn:

- **Journal:** mit `self` und Standby-Prüfung gegen das Register.
- **Listener:** ein Replikat-Listener mit signiertem Transport auf der Overlay-Adresse, nur für die
  provisionierten Peer-IPs.
- **Auf dem Primary:**
  1. Der offene Kandidat wird geklärt.
  2. Eine Harness über `primarySyncStorage` wird geöffnet.
  3. Der Space wird mit fester Identität angelegt (`createSpace(..., { spaceId, incarnation })`). Der Standby
     erhält dieselbe ID und Dateninkarnation über die Replikation.
  4. Der Boot-Guard läuft mit `replicaConfig`.
- **Auf dem Standby:** keine Harness; er bedient keine fachlichen Aufrufe.
- **Notice:** `notice()` liefert die signierte Notice des letzten abgeschlossenen Übergangs.

`configured-runtime` liest diese Spaces aus `syncSpaces` in der Konfiguration. Speicher und Harness öffnet sie über
Fabriken, die der Daemon übergibt.

- `startFederationHost({ syncSpaces })` verteilt Aufrufe, deren `space` die ID oder den Alias eines solchen Space
  nennt, an einen eigenen `SpaceService` über dessen Harness. Dazu gehört ein eigener `DelegationVerifier` mit
  `replicaConfig`; `epochNotice` für diesen Space geht an dessen Prüfer.
- Der Host veröffentlicht die Notice im Takt des Capability-Heartbeats.
- Übergänge (`promote`, `degradeToSingle`, `setStandby`) laufen bei gestopptem Dienst dieses Space. Ein aktiver
  Host folgt beim nächsten Start dem Journal.
- **Quarantäne-Start:** Ein Host in `quarantine` startet nicht normal. `startQuarantineReplicas` öffnet dann nur
  Journale und Replikat-Listener seiner Sync-Spaces, ohne Gate, Dienst oder Harness, damit ein Primary `setStandby`
  gegen ihn ausführen kann. Wird der Host `active`, beendet sich der Daemon mit Hinweis. Der Operator lässt dann die
  übrigen Spaces wieder zu (`readmitSpace`) und startet normal; der normale Start übernimmt die aktiven externen
  Berechtigungen lokal.
- **Werkzeug:** Der Testbed-Daemon hat den Modus `sync` (`status` mit Materialisierung, `promote`, `degrade`,
  `set-standby`, `wipe`) für einen gestoppten Dienst sowie `sync-head` für einen lesenden Blick bei laufendem
  Dienst.
- **Echter Lauf im Daemon** am 2026-10-16 bestanden
  ([Nachweis](../test/evidence/phase3-daemon-sync-2026-10-16/README.md)). Die Router-Übernahme der Notice ist dabei
  nicht enthalten, weil host-a mit dem alten Bündel läuft.
- **Automatisierter Zyklus:** Der Treiber `test/testbed/scenarios/phase3-daemon-cycle.ts` führt alle
  Operator-Schritte aus, setzt nach Abbruch fort und wartet auf Journalzeilen statt auf feste Pausen. Echter Lauf
  am 2026-10-17 bestanden ([Nachweis](../test/evidence/phase3-daemon-cycle-2026-10-17/README.md)).
- **Verwaiste Sperre:** `owner.lock` enthält `boot_id` und Startzeit. Eine Sperre aus einem früheren Boot räumt
  der Daemon selbst; innerhalb desselben Boots gilt weiter die Prüfung durch den Operator.
- **Membership:** Anweisungen für einen Sync-Space gehen an einen `MemberLifecycle` über dessen eigenen Store.
- **Fehlerisolation:** Kann ein Sync-Space nicht öffnen, etwa weil sein Standby für einen versiegelten Kandidaten
  nicht erreichbar ist, bleibt nur dieser Space unbedient und gesperrt. Der Host und seine übrigen Spaces starten
  (`openSyncSpaces`).
- **Hintergrunddienste:** Für jeden bedienten Sync-Space laufen Reaper und Delivery auf dessen eigener Harness.
- **Epoche:** Der `DelegationVerifier` nimmt sie für replizierte Spaces aus der Journal-Konfiguration
  (`replicaConfig.primaryEpoch`), denn das replizierte Space-Dokument behält die Epoche seiner Anlage. Ohne das
  würde nach einer Promotion jeder neue delegierte Aufruf abgewiesen.
- **Dateninkarnation:** Ein replizierter Space hat genau eine, die beide Replikate teilen. `promote` und
  `degradeToSingle` verlangen die bisherige Inkarnation der Berechtigung; `setStandby` gibt dem Ziel dieselbe wie
  dem Primary.
- **Notice:** Das Brett nimmt eine Notice an, wenn sie mit genau dem bewiesenen Schlüssel der Verbindung signiert
  ist. Eine Zuordnung von Peer-ID zu Host-ID ist dafür nicht nötig; NetBird-Peer-IDs unterscheiden sich von
  Host-IDs.
- **Abhängigkeit vom Register:** Jeder Sync-Write prüft die Boot-Berechtigungen im unabhängigen Register auf vpsc,
  per Primary-Prüfung, Standby-Prüfung und Boot-Guard. Fällt das Register aus, stehen die Sync-Writes. Das ist
  gewollt: Ohne Register gibt es keinen Nachweis, dass dieser Host noch Primary ist.

Der Policy-Validator lässt jetzt Sync-Primary-Regeln zu, wenn der Member eine `replication` hat und Regel und
Member übereinstimmen. `lww` und `set` bleiben gesperrt, bis ihr öffentlicher Adapter (3.7) existiert.

Geprüft:

- `openSyncSpace` mit zwei Hosts auf Loopback: Replikation, kein Dienst auf dem Standby, Neustart,
  Boot-Guard-Sperre.
- Im Runtime-Test über das echte Gate mit Grant landet ein Aufruf an `sync-jobs` im eigenen Store.

Nicht geprüft ist ein Daemon-Lauf mit `syncSpaces` auf echten Hosts; der Fixture-Lauf vom 2026-10-16 lief neben
dem Daemon.

## Übergänge

Jeder Übergang wird unter seiner ID im Journal abgelegt (`started` → `locallyCommitted` → `completed`) und
an die Argumente gebunden. Dieselbe ID setzt nach einem Absturz fort:

- vor dem Versiegeln: Der Übergang beginnt neu.
- nach dem Versiegeln, aber vor dem Anwenden: Der versiegelte Eintrag wird einmal angewendet.
- zwischen lokalem Commit und Boot-CAS: Nur die Register-Schritte werden nachgeholt.

Eine wiederverwendete ID mit anderen Argumenten wird abgelehnt.

- **degradeToSingle** (auf dem Primary):
  1. Prüft den Fencing-Nachweis des Standby-Hosts.
  2. Setzt dessen Boot-Zustand auf `fenced`.
  3. Schließt den höchstens einen versiegelten Kandidaten lokal und genau einmal ab (`recoveredCommitted`).
  4. Schreibt die Single-Konfiguration mit Epoche und Version +1.
  5. Zieht die Primary-Berechtigung nach.
- **promote** (auf dem festen synchronen Standby):
  1. Prüft den Fencing-Nachweis des alten Primary und die eigene aktive Standby-Berechtigung.
  2. Setzt den alten Primary auf `fenced`.
  3. Materialisiert die angenommene Historie.
  4. Wird Primary mit neuer Epoche; der alte Primary bleibt als Standby eingetragen.

  Ohne erreichbaren Standby sind Sync-Schreibzugriffe gesperrt, bis `degradeToSingle` mit demselben
  Nachweis folgt. Es gibt keine implizite Single-Freigabe. Ein Kandidat des alten Primary, den der Standby
  nie angenommen hat, gehört nicht zur beförderten Historie.
- **setStandby** (auf einem Single-Primary):
  - Das Ziel muss in `quarantine` und leer sein; Ausnahme ist die Fortsetzung des eigenen unterbrochenen
    Nachladens.
  - Es spielt die gesamte Kette ab Revision 1 nach (`catchUp`) und bestätigt dann den neuen Sync-Eintrag.
  - Versiegelt und angewendet wird nur, solange die Primary-Berechtigung der vorherigen Konfiguration gilt.
  - Danach wird das Ziel aktiver Standby, dann folgt die Primary-Berechtigung.
  - Ein alter Primary mit eigenem abgezweigtem Kandidaten wird abgelehnt. Er muss leer neu eingerichtet
    werden; ein Snapshot-Bootstrap fehlt noch.

## Tests

`test-netcup-fencing.test.ts` prüft den Adapter gegen einen nachgebauten SCP-Zustandsautomaten:

- die Reihenfolge Identität, Autostart, Ausschalten;
- Wiederholung ohne erneutes Patchen;
- `verify` gegen falsche Server-ID im Nachweis, eingeschaltetes Autostart, falschen Typ und nicht
  festgelegte Hosts;
- Aufgabenfehler, Wartung, geänderte MAC und einen Server, der weiterläuft;
- Token-Rotation unter Sperrdatei;
- den mTLS-Dienst: Reader-Zertifikat abgewiesen, Operator erlaubt.

`test-replica-control.test.ts` umfasst 8 Fälle auf JSONL und SQLite:

- **Ablehnungen:** Simulator- und unkonfigurierte Adapter werden abgelehnt, ohne Zustand zu ändern;
  ebenso Nachweise für den falschen Host und wiederverwendete IDs.
- **degradeToSingle:** Ein versiegelter Kandidat wird lokal abgeschlossen. Ein Absturz vor dem Boot-CAS hält
  die Schreibsperre, und dieselbe ID schließt den Übergang ab.
- **Freigegebener Standby:** Ein Standby in Quarantäne mit veralteter Historie wird bei der Promotion
  abgewiesen.
- **setStandby:**
  - Ein Absturz vor dem Boot-CAS des Ziels lässt das Ziel in Quarantäne.
  - Ein gebrauchtes Ziel wird abgewiesen.
  - Nach dem Übergang ist der materialisierte Stand des neuen Standby identisch mit dem des Primary.
- **promote:**
  - Der abgezweigte Kandidat fehlt auf dem neuen Primary, und Sync-Schreibzugriffe bleiben ohne Standby
    gesperrt.
  - Nach degradeToSingle geht es weiter; der alte Primary mit seinem Fork wird als Ziel abgewiesen.
- **Fencing während des Nachladens:** Wird der Primary dabei gefenct, wird nichts versiegelt und das Ziel
  bleibt in Quarantäne.

## Grenzen

- Der netcup-Adapter hat nanoi am 2026-10-16 real abgeschaltet, geprüft und über Quarantäne wieder freigegeben
  ([Nachweis](../test/evidence/f1-netcup-2026-10-16/README.md)).
- Am selben Tag lief der ganze Zyklus mit echten Hosts
  ([Nachweis](../test/evidence/phase3-sync-2026-10-16/README.md)):
  - Primary nanoi, Standby 100, verbunden über den signierten Replikat-Transport;
  - Fork ohne ACK;
  - netcup-Fencing, `promote` und `degradeToSingle` auf 100;
  - Freigabe in Quarantäne und `setStandby` zurück zu nanoi;
  - am Ende identische Stände.

  Das ist ein Fixture-Lauf neben dem Federation-Daemon, nicht der produktive Space-Dienst. Die Abnahme von 3.3/3.4 (F1/Gate 2) verlangt
  diesen realen Lauf. Testziel ist nanoi
  ([testumgebung-big.md](testumgebung-big.md) §18). big ist nie Fencing-Ziel. Standby ist Host 100 im
  Heimnetz ([testumgebung-big.md](testumgebung-big.md) §19), nicht vpsc, das bereits Register und Fencing-Dienst
  trägt. Für 100 gibt es keinen Fencing-Adapter. Deshalb ist nur Promotion auf 100 nach Fencing von nanoi
  abnehmbar; `degradeToSingle` auf nanoi bleibt gesperrt.
- 3.6 ist im Kern umgesetzt (Guard-Hook, Standby-Sperre, Wiederzulassung je Space, Neustart). Den Hook mit dem
  Journal verbinden muss weiterhin, wer einen primary/sync-Space betreibt.
- Noch offen:
  - Veröffentlichen der Notice aus dem Federation-Daemon, sobald dort primary/sync-Spaces laufen;
  - authentifizierter Transport zwischen den Replikaten;
  - Control-Space-Sonderfall (3.8);
  - Snapshot-Bootstrap eines nicht leeren Ziels.
