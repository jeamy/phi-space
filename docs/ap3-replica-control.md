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
  - `ReplicaConfigNotice`;
  - authentifizierter Transport zwischen den Replikaten;
  - Control-Space-Sonderfall (3.8);
  - Snapshot-Bootstrap eines nicht leeren Ziels.
