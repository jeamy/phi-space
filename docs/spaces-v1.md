# pi-spaces: aktueller lokaler Implementierungsstand

Stand: 2026-10-07, Quellen src/core.ts, src/client.ts, src/doc.ts, src/index.ts und lokale Tests.
Dies ist die lokale Bibliothek; Federation ist der [v3-Zielplan](federation-plan-v3.md).
Die historischen v1/v2-Planfassungen sind nicht verbindlich.

## Architektur und Datenmodell

Ein Harness-Prozess besitzt den Storage. Ein Space ist ein session-scoped Dokument pi-spaces.space, Version 4.
Mutationen lesen/ändern/schreiben es in einem Harness-Commit. Snapshot-Leseoperationen verwenden keinen Commit.
MemoryStorage ist flüchtig; JSONL ermöglicht persistente Wiederaufnahme innerhalb des Harness-Vertrags.
Der Storage und dessen Fehlervertrag bestimmen Dauerhaftigkeit, nicht die Space-API allein.

| Modul | Verantwortung |
|---|---|
| core.ts | reine Semantik mit explizitem now, Entries, Txns, Waiter, Notify, Ablauf und Limits |
| doc.ts | Space-Dokument und Migration |
| client.ts | JavaSpace/SpaceLike, blockierende Operationen, once-Hook, Snapshot-Lesen |
| index.ts | Agenten-Tools, Claims, Prompt, Reaper und Delivery |
| meter.ts | prozesslokale Zähler und Raten |
| canonical.ts | kanonische JSON-Kodierung für Feldvergleich |

SpaceState enthält nextId, entries, txns, regs, waiters, outbox, returned und limits.
EntryRec speichert type/types/fields, expires, writtenUnder, takenBy, readBy, owner und optionale Größe.
IDs sind lokal, keine globalen Member-IDs. Zeitpunkte sind absolute Millisekunden; FOREVER bleibt unverfallend.

## Operationen und Garantien

- write erzeugt einen neuen Entry. Keine Unique-Keys oder Upserts. Txn-Writes sind bis Commit unsichtbar.
- read/take warten auf ein Match bis Timeout; IfExists wartet nur bei von fremden Txns gesperrten Treffern.
- Templates vergleichen Feldwerte; fehlendes/null Feld ist Wildcard. ID-Templates sind implementiert.
- Take ohne Txn entfernt direkt; unter Txn reserviert es. Abort/Ablauf gibt die Reservierung zurück.
- Read unter Txn sperrt gegen fremde Takes. Commit macht Writes sichtbar und Takes dauerhaft wirksam.
- readAll ist ein lokaler Snapshot, älteste zuerst, maximal 1000 ohne Cursor. count/stats sind Snapshot-Gauges.
- notify liefert sequenznummerierte best-effort Events. Explizites Cancel unterdrückt ausstehende Bündel;
  natürlicher Ablauf kann ein Bündel noch ausgeben. Bestehende Abos verwenden aktuelle Rate-Limits.
- wait parkt einen Auftrag ohne blockierten Modellturn. Bedientes Take erhält eine Txn des Empfängers.
  Missglückte Delivery gibt sie frei; späterer Lease-Ablauf macht die Aufgabe wieder verfügbar.

Agenten-Tools: space_write, space_read, space_take, space_list, space_wait, space_notify, space_txn, space_lease.
Kein space_count-Tool. Blockierende Tool-Timeouts sind auf 60 s begrenzt; längeres Warten über space_wait.
Claims liegen task-scoped im gleichen Commit wie die Tool-Mutation/Entscheidung. Tool-Replay liefert das
gespeicherte Ergebnis; auch Txn-Begin/-Commit/-Abort und Lease-Aktionen besitzen Claims. Ein Host-Aufruf ohne
once-Hook besitzt keine automatische Replay-Deduplizierung. Externe Wirkungen sind nicht allgemein exactly-once.

## Ownership, Limits und Dienste

Conversations dürfen nur ihre eigenen Txns/Leases verwenden oder verändern. Fremde normale Entries sind les-/nehmbar.
Owner=null gehört Host-Code; es gewährt Agenten keine Txn-/Lease-Rechte. Host-Code ohne as darf alles verwalten.
64 KiB Entry/Handback, 128 Zeichen Typname, 16 Typen, 1000 Entries pro Owner, 10 000 global,
20 Abos/Waiter/Txns pro Owner. Host-Code ist von diesen Quoten ausgenommen, aber nicht von maxSpaceBytes.
maxSpaceBytes ist standardmäßig 64 MiB der JSON-Entry-Felder; kein Gesamtlimit für Claims, Outbox,
Dokument-/Storage-Bytes oder Node-RAM. Protokoll-/Mailbox-Quoten aus dem Federation-Plan sind nicht implementiert.

startService startet Reaper und Delivery. settle berücksichtigt Abläufe auch bei einer späteren Operation,
wenn kein Hintergrunddienst lief. Timer werden auf etwa 24,8 Tage gekappt und erneut gestellt.
Delivery ist pro Ziel serialisiert mit begrenzter Parallelität zwischen Zielen und Retry/Backoff.
Nichtnumerische Ziele werden weiterhin nicht als Remote-Mailboxes zugestellt.
Meter bleibt prozesslokal, Standardmeter gemeinsam; ein expliziter Meter kann einzelnen Harnesses zugeordnet werden.

## Historische Fehler-/Lückenkennungen

Die Kennungen bleiben für Verweise aus dem Plan erhalten; sie sind kein unveränderter Fehlerstatus.

| Kennung | Aktueller Status |
|---|---|
| B1 | behoben: Entry-ID im Template/Tools |
| B2 | behoben: Cancel sendet kein restliches Notify-Bündel |
| B3 | behoben: Rate-Limit-Änderung wirkt auf bestehende Abos |
| L1 | offen: echte Peer-Mailbox/Remote-Delivery fehlt |
| L2 | offen: Revision/Änderungsstrom fehlt |
| L3 | offen: globale Space-/Replikatidentitäten fehlen |
| L4 | offen: allgemeine Availability-Events nach Rücklauf fehlen |
| L5 | offen: allgemeine Batch-API fehlt |
| L6 | behoben: Txn-Tool-Claims vorhanden |
| L7 | teilweise behoben: Entry-Gesamtbytes begrenzt; interne Dokumente/Storage benötigen weitere Limits |
| L8 | offen: keine Range/in/Existenz-Templates |
| L9 | keine garantierte FIFO/Prioritätsordnung |
| L10 | behoben: Delivery-Parallelität zwischen Zielen |
| L11 | teilweise: eigener Meter möglich; keine automatische persistente Federation-Aggregation |
| L12 | byType zählt Haupttyp, nicht jeden Supertyp |
| L13 | offen: readAll ohne Pagination |
| L14 | externe pi-serverd/Handy-Einbindung nicht durch diese Beispieltests abgenommen |

## Leistung und Nachweise

Dokumentgröße, lineare Suche und Waiter-Scans beeinflussen Kosten. Kein belegter Durchsatz oder linearer
Speedup; Snapshot-Limits und JSON-Bytebudget sind keine RAM-/VPS-Mindestanforderungen.
Optimierungen wie Indizes, Sharding, Dirty-Flags und Remote-Protokoll benötigen eigene Implementierung/Tests.

Typecheck, Kern- und Beispielsuite werden lokal ausgeführt. Beispiele und tatsächlicher Nachweisumfang:
[examples.md](examples.md), [Testübersicht](../test/examples/README.md).
Federation, NetBird-Identität, Promotion und wissenschaftliche Modellqualität sind damit nicht nachgewiesen.
