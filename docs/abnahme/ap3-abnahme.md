# Phase 3: Abnahme-Matrix

Stand: 2026-10-18. **Phase 3 ist nicht abgenommen.** Diese Matrix gleicht jedes Abnahmekriterium mit den
vorhandenen Tests und echten Läufen ab. Maßstab ist der [Implementierungsplan](../implementierungsplan-v3.md):
v3 §11 Stufe 3 und alle Zeilen „3“ aus §12.1, real mit Fencing-Adapter.

**Einordnung** nach v3 §11 und §12:

- NetBird-, Plattform- und Fencing-Annahmen brauchen einen echten Lauf. Alles andere gilt mit persistenten lokalen
  Tests auf JSONL und SQLite als erfüllt. MemoryStorage allein ist kein Nachweis.
- **erfüllt:** Nachweis vorhanden, lokal und, wo nötig, real.
- **teilweise:** ein Teil der Erwartung ist nicht geprüft; der fehlende Teil ist genannt.
- **offen:** kein Nachweis.

Nachweise liegen unter `test/evidence/`, Tests unter `test/`.

## v3 §11 Stufe 3

| # | Kriterium | Lokal | Real | Stand |
|---|---|---|---|---|
| S1 | 10-min-Partition mit konkurrierenden Writes, Deletes und Erneuerungen konvergiert | `test-entry-replication`, `test-entry-replication-stream`, `test-merge-service` (Löschen und Erneuern über `lease`) | über den Dienst 656 s mit Writes, Deletes, Erneuerungen und Ablauf (`phase3-final-2026-10-18`); primary/sync 10 min (`phase3-partition-2026-10-17`) | erfüllt |
| S2 | Alter Put belebt keinen Tombstone wieder | `test-entry-replication`, `test-entry-compaction` (Tombstone mit älterem Put) | `ap3-overlay-2026-10-15`, `merge-run-2026-10-17` | erfüllt |
| S3 | Natürlicher Ablauf löscht keine neuere Erneuerung | `test-entry-renewal`, `test-entry-compaction` (Ablauf mit Erneuerung) | `ap3-overlay-2026-10-15` (Erneuerungen während der Partition) | erfüllt |
| S4 | Snapshot unter Last verliert nichts | `test-entry-snapshot-transfer` (gleichzeitige Writes bis zur Veröffentlichung), `test-bootstrap` (geänderter Store wird abgewiesen) | — (keine Overlay-Annahme) | erfüllt |
| S5 | Ohne Standby keine Bestätigung | `test-primary-sync`, `test-commit-sealed`, `test-replica-control` | `phase3-sync-2026-10-16`, `phase3-daemon-sync-2026-10-16`, `phase3-partition-2026-10-17` | erfüllt |
| S6 | Promotion ohne verifizierten Fencing-Nachweis, mit Marker-Adapter oder auf falschem Standby verweigert | `test-replica-control` (Simulator, unkonfigurierter Adapter, falscher Host, Standby in Quarantäne), `test-degrade-revoke` (ausgeschlossener Standby), `test-netcup-fencing` | netcup-`verify` (`f1-netcup-2026-10-16`) | erfüllt |
| S7 | Alter Router kann nach Lease-Ablauf nichts mehr delegieren | `test-delegation` (abgelaufene Lease, höhere Epoche), `test-configured-root` (Übernahme erst nach Ablauf) | `root-promotion-2026-10-17` | erfüllt |
| S8 | Bestätigte Ergebnisse bleiben nach Promotion erhalten | `test-not-committed` (bestätigter Request behält sein Ergebnis) | `phase3-partition-2026-10-17` (jeder entschiedene Write genau einmal), `phase3-daemon-sync-2026-10-16` | erfüllt |
| S9 | Alter Primary startet nach `release` nur in Quarantäne | `test-replica-control` (Quarantäne öffnet nur Replikat-Listener) | `phase3-daemon-sync-2026-10-16`, `phase3-partition-2026-10-17` | erfüllt |
| S10 | Ältere lww-Version wird nach Ablauf der Gewinnerversion nicht sichtbar | `test-entry-replication`, `test-entry-replication-stream` | `ap3-overlay-2026-10-15` | erfüllt |
| S11 | Standby-Ausfall sperrt Bestätigungen; `degradeToSingle` ohne Standby-Fencing wird verweigert | `test-replica-control`, `test-degrade-revoke` (ohne Nachweis und ohne `revokeStandbySpace` abgewiesen) | `degrade` mit netcup-Fencing in allen Sync-Läufen | erfüllt; der Widerruf der Space-Berechtigung zählt seit 2026-10-17 als Standby-Sperre (v3 §5.3.1 Schritt 2) |
| S12 | Policy mit primary-Member in expand- oder lww-Regel wird abgewiesen | `test-replica-control` (Policy-Validator) | — | erfüllt |

Weitere Inhalte der Stufe:

- Control Space auf primary/sync: `control-sync-hosta-2026-10-17`, `control-promotion-2026-10-17`.
- Router-Lease über sync-Commits: `step6-hosta-2026-10-17`.

## v3 §12.1, Zeilen „3“

| # | Fehlerablauf | Lokal | Real | Stand |
|---|---|---|---|---|
| K1 | Standby persistiert Batch, ACK verloren; Primary stirbt; danach `degradeToSingle` | `test-replica-control` (ACK verloren, Primary weg, Degrade: Kandidat genau einmal, Retry erhält das gespeicherte Ergebnis); `test-primary-sync` (`lostAck`) | — | erfüllt |
| K2 | Primary-Prozess stirbt nach Versiegeln vor Send, Reopen des ursprünglichen Storage; Standby unerreichbar; Fencing und Single | `test-replica-control` (Kandidat lokal abgeschlossen, genau einmal sichtbar), `test-primary-sync` (beschädigter Marker oder Hash blockiert) | `phase3-sync-2026-10-16` (`recoveredCommitted: [7]`) | erfüllt |
| K3 | Primary-Storage geht nach Versiegeln verloren; Standby lebt; Fencing und Promotion | `test-not-committed` (Negativclaim, `NotCommitted`, bestätigte bleiben) | `phase3-partition-2026-10-17` (Failover mit `NotCommitted`) | erfüllt |
| K4 | Take bestätigt, Antwort verloren, dann Promotion; Retry mit aktualisiertem Rahmen | `test-not-committed` (alter Rahmen `StaleEpoch`, neuer Rahmen liefert den gespeicherten Take ohne zweiten, andere Argumente `RequestConflict`) | — | erfüllt |
| K5 | Erststart ohne Boot-Berechtigung, veralteter Nachweis nach `setStandby`, Promotion in Quarantäne | `test-recovery` (Boot-Prüfung je Space), `test-replica-control` (Promotion in Quarantäne abgewiesen, Replikate nach `setStandby` gleich, Nachweis von vor der Freigabe autorisiert kein `degrade`) | `phase3-daemon-cycle-2026-10-17` | erfüllt |
| K6 | Entfernten Data Space auf Single umstellen, Control dabei offline | `test-delegation` (`ReplicaConfigPending` bis zur Übernahme), `test-replica-control` (Übernahme nur nach Register) | `root-hosta-2026-10-17` (Übernahme der Notice) | erfüllt; Control war im echten Lauf erreichbar |
| K7 | Control-Promotion ohne verfügbaren Standby, danach Ersatz einrichten | `test-replica-control` (nach Promotion ohne Standby bleiben Writes gesperrt), `test-control-host-change` | `control-promotion-2026-10-17`, `root-promotion-2026-10-17` | erfüllt |
| K8 | ACK-Verlust und Neustart während `setStandby`; altes Replikat kehrt zurück | `test-replica-control` (verlorene Bestätigung des Ziels: kein Write und kein zweiter Übergang, dieselbe ID schließt ab; altes Replikat kann nicht promovieren), `test-degrade-revoke` | `phase3-partition-2026-10-17` (abgebrochenes `set-standby` mit derselben ID fortgesetzt) | erfüllt |
| K9 | Erfolgreicher Request, Claim und Generation bereinigt, dann Promotion und alter Retry | `test-not-committed` (nach Ablauf von Ergebnisfrist und Zulassung: Klärung und Retry `RequestExpired`, keine neue Wirkung) | — | erfüllt |
| K10 | Unbekannter alter Request gegen verspäteten Original-Aufruf; Absturz nach Negativclaim | `test-not-committed` (Negativclaim zuerst: Original ohne Wirkung, auch nach Neustart; Original zuerst: Wirkung mit eigenem Claim, die Klärung findet ihn) | `phase3-partition-2026-10-17` | erfüllt |
| K11 | Zwei Spaces auf einem Host mit verschiedenen Replikatversionen; Übergang eines Space, danach Reboot beider Hosts | `test-replica-control` (Boot-Guard, Wiederzulassung je Space), `test-degrade-revoke` (anderer Space bleibt) | `phase3-partition-2026-10-17` (Hauptstore single neben `jobs-part` sync, Neustart beider Hosts) | erfüllt |
| K12 | Abbruch zwischen lokaler Promotion/degrade/`setStandby` und externem Boot-Abgleich | `test-replica-control` (alle drei: Absturz vor dem Boot-CAS, dieselbe ID setzt fort, `assertSyncPrimary` sperrt jeden Commit einschließlich Grants) | — | erfüllt |

## Betrieb (v3 §12 Integration, Recovery, Last)

| # | Punkt | Stand |
|---|---|---|
| B1 | Router-Delegation auf einen Sync-Space im laufenden Betrieb | real (`phase3-final-2026-10-18`): geroutete Writes durch Partition, Promotion, Degrade mit und ohne Adapter, Rückwege mit `set-standby` bei laufendem Root; Klärung beim Nachfolger nach Degrade (ursprüngliches Ergebnis) und nach Promotion (`NotCommitted`, Fork ohne Wirkung); das `ReplicaConfigPending`-Fenster nur lokal (`test-delegation`) | erfüllt |
| B2 | Ausfall eines NetBird-Agenten | real (`phase3-final-2026-10-18`): 120 s Agent aus auf dem Standby, Write versiegelt und danach entschieden, Daemon ohne Neustart | erfüllt |
| B3 | Erschöpfter Speicher | real (`phase3-final-2026-10-18`): volles Journal lehnt mit `ResourceExhausted` ab, Lesen und anderer Space gehen weiter; lokal `test-primary-sync`, `test-entry-replication`; ENOSPC nicht geprüft | erfüllt (Journal-Budget) |
| B4 | Prozessabbruch ohne Operatorschritt | real (`phase3-final-2026-10-18`): SIGKILL auf beiden Hosts, Sperre vom Daemon selbst geräumt (`processGone`); lokal `test-replica-control` | erfüllt |
| B5 | `degrade` ohne Fencing-Adapter im Sync-Werkzeug | real (`phase3-final-2026-10-18`): Kandidat lokal abgeschlossen, Host aktiv mit widerrufener Berechtigung, Rückweg per `wipe` und `set-standby`; lokal `test-degrade-revoke` | erfüllt |

## Offen für die Abnahme

- Befund aus dem Lauf vom 2026-10-18: Eine Member-Aufnahme (`addMember`), die nach Phase `committed` unterbrochen wird,
  läuft nicht weiter und blockiert weitere Mitgliedschaftsbefehle. **Lokal behoben, real nicht erneut geprüft.**
  - Fortgesetzt wurde schon vorher: Der Supervisor ruft offene Befehle jede Sekunde und nach einem Neustart erneut auf.
    Die Sperre weiterer Mitgliedschaftsbefehle bis zum Abschluss ist gewollt.
  - Dauerhaft scheitern konnte die Fortsetzung: Sie verteilte die beim Commit eingefrorene Policy. Stieg die Policy
    inzwischen (etwa durch die Übernahme einer ReplicaConfigNotice), lehnte ein Member mit neuerer Policy die ältere
    ab (`invalid installed policy transition`), bei jedem Versuch.
  - Jetzt verteilt die Fortsetzung von `add` und `remove` die aktuelle Policy an die aktuellen Members, je
    Policy-Version unter eigener Anweisungs-ID; `activate` bleibt unverändert wiederholbar. Ist die Policy neuer als
    beim Commit, erhält sie auch der neue Member.
  - Tests: `test-membership` (Unterbrechung nach `committed` und Freigabe der Sperre; `add` und `remove` nach neuerer
    Policy). Der Test für `add` scheitert mit dem alten Code genau an diesem Fehler.
  - Dass dies der Auslöser im echten Lauf war, ist nicht belegt. Ein dauerhaft unerreichbarer bestehender Member hält
    die Aufnahme weiterhin an; das ist gewollt, aber nur an fehlenden Ergebnissen erkennbar.
- Außerhalb der Abnahmekriterien: Boot- und Löschintegration des Sync-Journals
  ([ap3-primary-sync](ap3-primary-sync.md)).
