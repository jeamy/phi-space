# Phase 3: Abnahme-Matrix

Stand: 2026-10-18. **Phase 3 ist nicht abgenommen.** Diese Matrix gleicht jedes Abnahmekriterium mit den
vorhandenen Tests und echten Läufen ab. Maßstab ist der [Implementierungsplan](implementierungsplan-v3.md):
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
| S1 | 10-min-Partition mit konkurrierenden Writes, Deletes und Erneuerungen konvergiert | `test-entry-replication` (zehn simulierte Minuten), `test-entry-replication-stream` (bidirektional nach Partition) | lww/set: 600 s als Komponentenlauf (`ap3-overlay-2026-10-15`), über den Dienst nur 130 s (`merge-run-2026-10-17`); primary/sync: 10 min über den Dienst (`phase3-partition-2026-10-17`) | teilweise: 10-min-Partition auf dem produktiven Merge-Pfad fehlt |
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
| B1 | Router-Delegation auf einen Sync-Space im laufenden Betrieb | teilweise: geroutete Writes mit Partition und Promotion real (`root-hosta-2026-10-17`, Lauf vom 2026-10-18); der Router konnte offene Schritte nach Promotion oder Degrade nicht klären und beendete Writes im `ReplicaConfigPending`-Fenster endgültig, seit 2026-10-18 behoben und lokal geprüft (`test-delegation`); real offen |
| B2 | Ausfall eines NetBird-Agenten | offen |
| B3 | Erschöpfter Speicher | lokal: ein volles Journal lehnt vor dem Versiegeln mit `ResourceExhausted` ab, Lesen und kleinere Writes gehen weiter (`test-primary-sync`; bis 2026-10-18 sperrte es die Session); Historienbudget der Merge-Replikation (`test-entry-replication`); real offen; ein voller Datenträger (ENOSPC) wird nicht geprüft |
| B4 | Prozessabbruch ohne Operatorschritt | lokal erfüllt: Der Daemon räumt eine Sperre, deren Prozess nachweislich fehlt (früherer Boot, oder kein Prozess mit ihrer PID und Startzeit; `test-replica-control`); real offen |
| B5 | `degrade` ohne Fencing-Adapter im Sync-Werkzeug | umgesetzt: `sync` mit `op: degrade, revokeStandbySpace: true` für primary/sync-Spaces (nicht für `main-sync` mit Geschwister-Spaces); real offen |

Außerhalb der Abnahmekriterien, aber offen: Boot- und Löschintegration des Sync-Journals
([ap3-primary-sync](ap3-primary-sync.md)).

## Offen für die Abnahme

Echter Lauf: S1 (10-min-Partition auf dem Merge-Pfad), B1, B2, B3, dazu B4 und B5 real.
