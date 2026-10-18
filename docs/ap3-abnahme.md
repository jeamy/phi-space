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
| K1 | Standby persistiert Batch, ACK verloren; Primary stirbt; danach `degradeToSingle` | `test-primary-sync` (`lostAck`, Klärung mit dem Standby) und `test-replica-control` (Degrade nach Partition) | — | teilweise: ACK-Verlust gefolgt von Degrade fehlt als ein Ablauf |
| K2 | Primary-Prozess stirbt nach Versiegeln vor Send, Reopen des ursprünglichen Storage; Standby unerreichbar; Fencing und Single | `test-replica-control` (Kandidat lokal abgeschlossen, genau einmal sichtbar), `test-primary-sync` (beschädigter Marker oder Hash blockiert) | `phase3-sync-2026-10-16` (`recoveredCommitted: [7]`) | erfüllt |
| K3 | Primary-Storage geht nach Versiegeln verloren; Standby lebt; Fencing und Promotion | `test-not-committed` (Negativclaim, `NotCommitted`, bestätigte bleiben) | `phase3-partition-2026-10-17` (Failover mit `NotCommitted`) | erfüllt |
| K4 | Take bestätigt, Antwort verloren, dann Promotion; Retry mit aktualisiertem Rahmen | — | — | offen |
| K5 | Erststart ohne Boot-Berechtigung, veralteter Nachweis nach `setStandby`, Promotion in Quarantäne | `test-recovery` (Boot-Prüfung je Space), `test-replica-control` (Promotion in Quarantäne abgewiesen, Replikate nach `setStandby` gleich) | `phase3-daemon-cycle-2026-10-17` | teilweise: Ablehnung eines veralteten Nachweises durch `promote`/`degrade` nicht geprüft (`verify` allein schon) |
| K6 | Entfernten Data Space auf Single umstellen, Control dabei offline | `test-delegation` (`ReplicaConfigPending` bis zur Übernahme), `test-replica-control` (Übernahme nur nach Register) | `root-hosta-2026-10-17` (Übernahme der Notice) | erfüllt; Control war im echten Lauf erreichbar |
| K7 | Control-Promotion ohne verfügbaren Standby, danach Ersatz einrichten | `test-replica-control` (nach Promotion ohne Standby bleiben Writes gesperrt), `test-control-host-change` | `control-promotion-2026-10-17`, `root-promotion-2026-10-17` | erfüllt |
| K8 | ACK-Verlust und Neustart während `setStandby`; altes Replikat kehrt zurück | `test-replica-control` (Absturz vor dem Boot-CAS, Schreibsperre offener Übergänge, Fencing beim Nachladen), `test-degrade-revoke` | `phase3-partition-2026-10-17` (abgebrochenes `set-standby` mit derselben ID fortgesetzt) | teilweise: verlorene Bestätigung des Ziels nicht gezielt geprüft |
| K9 | Erfolgreicher Request, Claim und Generation bereinigt, dann Promotion und alter Retry | `test-not-committed` nur auf MemoryStorage, ohne Promotion | — | offen |
| K10 | Unbekannter alter Request gegen verspäteten Original-Aufruf; Absturz nach Negativclaim | `test-not-committed` (Negativclaim zuerst, Original danach ohne Wirkung) | `phase3-partition-2026-10-17` | teilweise: Original zuerst und Reopen nach dem Negativclaim fehlen |
| K11 | Zwei Spaces auf einem Host mit verschiedenen Replikatversionen; Übergang eines Space, danach Reboot beider Hosts | `test-replica-control` (Boot-Guard, Wiederzulassung je Space), `test-degrade-revoke` (anderer Space bleibt) | `phase3-partition-2026-10-17` (Hauptstore single neben `jobs-part` sync, Neustart beider Hosts) | erfüllt |
| K12 | Abbruch zwischen lokaler Promotion/degrade/`setStandby` und externem Boot-Abgleich | `test-replica-control` (alle drei: Absturz vor dem Boot-CAS, dieselbe ID setzt fort, `assertSyncPrimary` sperrt jeden Commit einschließlich Grants) | — | erfüllt |

## Betrieb (v3 §12 Integration, Recovery, Last)

| # | Punkt | Stand |
|---|---|---|
| B1 | Router-Delegation auf einen Sync-Space im laufenden Betrieb | teilweise: geroutete Writes mit Promotion (`root-hosta-2026-10-17`); `CommitSealed`, Partition und `NotCommitted` liefen nur mit Admin-Grants |
| B2 | Ausfall eines NetBird-Agenten | offen |
| B3 | Erschöpfter Speicher | lokal: Journal- und Historienbudgets weisen ab (`test-primary-sync`, `test-entry-replication`); real offen |
| B4 | Prozessabbruch ohne Operatorschritt | teilweise: Sperre eines früheren Boots räumt der Daemon selbst; dieselbe Boot-Sitzung braucht den Operator |
| B5 | `degrade` ohne Fencing-Adapter im Sync-Werkzeug | offen: nur als API (`revokeStandbySpace`) |

## Offen für die Abnahme

1. Lokale Tests: K1, K4, K5, K8, K9, K10.
2. Code: B4 (Sperre derselben Boot-Sitzung), B5 (Werkzeug).
3. Echter Lauf: S1 (10-min-Partition auf dem Merge-Pfad), B1, B2, B3.
