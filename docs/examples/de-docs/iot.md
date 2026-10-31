# Sensor-Pipeline

Stand: 2026-10-07. Implementierung: [sensor-pipeline.ts](../../../examples/sensor-pipeline.ts).
Lokaler, deterministischer Host-Code mit verschiedenen Conversation-IDs als Owner; kein LLM und keine Federation.

## Datenvertrag

| Typ | Felder | Lease |
|---|---|---|
| Window | id, sources[] | FOREVER |
| Reading | source, window, ts, kind, value | 24 h |
| Done | source, window | 24 h |
| Summary | window, stats, missing[], duplicates, rejected | FOREVER |
| Report | window, text | FOREVER |

`openWindow` erzeugt einen Auftrag. `collect` schreibt Werte und anschließend Done.
Mehrere Analysten konkurrieren um Window. Ein Analyst reserviert es unter einer Txn, wartet auf Done pro Quelle
mit gemeinsamer Deadline und schreibt die Summary unter derselben Txn. Commit verbindet Verbrauch und Ergebnis.
Ein simuliert abgestürzter Analyst lässt die Txn auslaufen; das Window wird wieder verfügbar.

`present` reserviert eine Summary ebenfalls unter Txn und schreibt den Report unter derselben Txn.
Ein Write-Fehler bricht ab und gibt die Summary zurück. Externe Datei-/Netzwirkungen sind nicht Teil dieser Txn.

## Validierung und Grenzen

Ungültige Werte werden vor Deduplizierung verworfen. Erst ein endlicher Zahlenwert belegt die Identität
`[source, kind, ts]`; kollisionsfreie JSON-Kodierung ersetzt die mehrdeutige Verkettung mit Doppelpunkten.
Unter gültigen Duplikaten gewinnt der zuerst gelesene Wert. Unterschiedliche gültige Werte mit derselben
Identität werden nicht zusammengeführt; der nachfolgende wird als Duplikat gezählt.

Je Fenster maximal 1000 sichtbare Readings. Größere Fenster werden vor der Aggregation mit Fehler abgewiesen,
die Reservierung wird abgebrochen; es wird kein still gekürztes Ergebnis geschrieben. Der Sammler muss solche
Fenster aufteilen. Done bedeutet, dass eine Quelle keine weiteren Werte für dieses Fenster liefert. Verspätete
Writes nach Done sind außerhalb dieses Protokolls; die Datenliste ist ein lokaler Snapshot und keine globale
Transaktion über die Collector-Eingaben.

Statistik je kind: Anzahl, Minimum, Maximum, arithmetischer Mittelwert auf zwei Dezimalstellen gerundet.
Quellen ohne Done bis Deadline landen in missing; bereits vorhandene gültige Werte dieser Quellen zählen mit.
Fehler außerhalb eines erwarteten Txn-Ablaufs werden weitergegeben. Keine Alerts, kontinuierliche
Fensterplanung oder persistente Collector-Recovery implementiert.

## Aufruf und Nachweis

```bash
npm run example:pipeline
npm test
npm run test:examples
```

`integration.test.ts` prüft konkurrierende Analysten, Lease-Rücklauf und fehlende Quelle.
Die Beispielsuite importiert echte Pipeline-Funktionen. `recovery.test.ts` prüft ungültiges erstes Duplikat,
Report-Rollback und die Größenbegrenzung. Keine gemessenen Throughput-/Speedup-Werte.
[Zur Übersicht](../README.en.md).
