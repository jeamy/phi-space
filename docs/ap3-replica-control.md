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
- `unconfiguredFencing(kind, provider)` ist der Platzhalter für netcup und andere Anbieter. Jede Operation
  scheitert mit „not configured“. Endpunkte werden erst mit echten Zugangsdaten eingetragen; diese liegen auf
  vpsc, nicht auf nanoi und nicht im Repository.
- Die Boot-Übergänge laufen per CAS über das Register. Erneut versucht wird nur bei `RegisterConflict`; ein
  anderer Fehler bricht den Übergang ab.
  - `fenceHostBoot` setzt den Host auf `fenced` und alle Space-Berechtigungen auf `revoked`. Die Werte bleiben
    zur Prüfung erhalten.
  - `releaseHostToQuarantine` führt ausschließlich von `fenced` nach `quarantine`. Erst danach hebt der
    Adapter die Neustartsperre auf.
  - `active` setzt nur das Ende von `setStandby`.

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

- Die Abnahme von 3.3/3.4 verlangt einen realen Adapter (F1/Gate 2). Testziel ist nanoi
  ([testumgebung-big.md](testumgebung-big.md) §18). big ist nie Fencing-Ziel. Der Standby-Platz ist noch
  festzulegen: vpsc trägt bereits das Register, ein Standby dort würde beide Ausfälle koppeln.
- 3.6 ist nur teilweise umgesetzt:
  - `installBootGuard` erlaubt weiterhin nur die Rollen `local`/`primary` und vergleicht nur `primaryEpoch`.
  - Replikatversion und Durability werden nur über `assertSyncPrimary` im Sync-Storage-Pfad durchgesetzt.
- Noch offen:
  - Pausieren aller Schreibquellen einschließlich Reaper;
  - `ReplicaConfigNotice`;
  - authentifizierter Transport zwischen den Replikaten;
  - Control-Space-Sonderfall (3.8);
  - Snapshot-Bootstrap eines nicht leeren Ziels.
