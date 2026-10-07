# Lokales segmentiertes Primzahlsieb

Stand: 2026-10-07. Implementierung: [sieve.ts](../../examples/sieve.ts).
Tests: [sieve.test.ts](../../test/examples/sieve.test.ts). Kein Modell oder Netzwerk erforderlich.

```bash
npm run example:sieve -- 1001 4
```

Berechnet 168 Primzahlen im Halbintervall [1,1001). Erstes Argument: exklusive Obergrenze;
zweites Argument: Workerzahl (1–32). Die CLI verwendet frischen MemoryStorage.
Mehrere async Worker koordinieren sich in einem Harness; sie bieten keine CPU-Parallelität.

## Aufgaben und Wiederaufnahme

`prepareSieveRun(host, config)` speichert unveränderliche Konfiguration und disjunkte SieveTasks
mit runId/taskId in einem gemeinsamen Commit. Wiederholte oder konkurrierende Vorbereitung desselben
Laufs erzeugt keine zusätzlichen Tasks; geänderte Konfiguration wird abgewiesen.
`processSieveTask(space, runId)` nimmt einen Task unter Txn, berechnet sein Segment und schreibt
SieveResult unter derselben Txn. Commit entfernt Task und veröffentlicht Ergebnis gemeinsam.
Ein Fehler führt zu Abort; eine verlassene Reservierung wird nach Txn-Lease-Ablauf wieder verfügbar.
Die Tasks selbst haben FOREVER-Leases: Entry-TTL ist kein Retry-Mechanismus.

`collectSieveResults(space, config)` verlangt genau ein Ergebnis je erwarteter taskId und prüft
Bereich und sortierte, eindeutige Zahlenfolge. Ein Gesamtcount würde fehlende oder doppelte
Segmente nicht zuverlässig erkennen. Der Collector validiert nicht gegen absichtlich falsche Primzahlen.
Basisprimzahlen reichen bis sqrt(end−1); die Tests vergleichen unabhängig mit Probedivision.

Die exportierten Funktionen erlauben JSONL-Storage und Wiederaufnahme unter identischer runId.
Getestet sind Lease-Ablauf einer verlassenen Reservierung, anschließend JSONL-Reopen und vollständige
Aggregation ohne Neuseeding. Dies ist kein eigener SIGKILL-Prozesstest für das Sieb.

## Grenzen

- 0 ≤ start < end ≤ 10.000.000, Blockgröße 1–4096, höchstens 1000 Blöcke pro Lauf;
- maximal 128 Läufe je Store; keine automatische Bereinigung abgeschlossener Läufe;
- JSONL wird durch einen Harness verwaltet; kein gemeinsamer Store für unabhängige Prozesse;
- lokale Tests für Referenzresultate, Konkurrenz, Rollback, fehlende/doppelte Ergebnisse und Byte-Limits;
- keine Performance-, Mehrhost- oder Federation-Abnahme.

In einer späteren Federation müssen Task und Ergebnis in derselben Member-Txn liegen.
Siehe [v3-Plan](../federation-plan-v3.md). Weitere Minimalmuster:
[workers.ts](../../examples/workers.ts), [blocking-tool.ts](../../examples/blocking-tool.ts).
[Zur Übersicht](README.md).
