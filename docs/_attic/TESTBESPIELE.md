# Beispiel- und Abnahmeplan

Stand: 2026-10-07. Aktuelle Implementierungen: [examples.md](../examples.md).
Zukünftige Infrastruktur: [Föderationsplan v3](../federation-plan-v3.md).

| Bereich | Heutiger Nachweis | Zusätzliche zukünftige Abnahme |
|---|---|---|
| Master/Worker | echtes Sieb, unabhängige Referenz, Lease-Recovery und JSONL | Multi-Member-Routing, CPU-Skalierung |
| Sensor-Pipeline | lokale atomare Analyst-/Presenter-Schritte und Rollback | persistente Collector-Recovery, Fensterplanung |
| Chat | tatsächlicher Faux-Ring, Notify-Semantik | reales Modell, getrennte Hosts und Reconnect |
| Golomb | tatsächliche kleine Suche, JSONL-Reopen, Task-Rollback | höhere Ordnungen, CPU-Parallelität, gemessene Skalierung |
| arXiv | Parser-Fixtures, tatsächliche geskriptete Runner | reale API-/Modellläufe, unabhängige Quellenprüfung |
| Cache | lokaler Ersatz/CAS, TTL, Rollback und JSONL-Reopen | Merge, Tombstones, Partition/Resync und replizierte Leases |

## Regeln für Aussagen und Metriken

„Implementiert“ bedeutet vorhandener Code, „lokal getestet“ einen ausgeführten passenden Test,
„geplant“ einen Zielvertrag. Faux-Modelltests belegen Orchestrierung und Space-Zustände, keine Recherchequalität.
Keine gemessenen Durchsatz-, Speedup-, Coverage- oder Verfügbarkeitsquoten vorhanden.
Performanceziele werden erst nach Messung mit Hardware, Datenmenge, Konfiguration und Versionsstand als
Ergebnisse dokumentiert. VPS-Größen im Plan sind Schätzungen, keine Benchmarks.

Take-Reservierungen dürfen nach Abort/Ablauf wiederkehren. Genau einmal fachlich erledigte externe Arbeit
braucht einen Idempotenz-/Wirkungszielvertrag. Transaktionen sind lokal auf einen Member begrenzt.
Ein Entry-TTL ist kein Retry-Mechanismus; Write ist ohne deklarierte zukünftige Upsert-Semantik keine Mutation.

## Tests

```bash
npm run typecheck
npm test
npm run test:examples
```

Details: [Testübersicht](../../test/examples/README.md),
[Beispielindex](../examples/README.md), [Historie](../examples/HISTORISCHE-REFERENZEN.md).
Federation-Tests sind Voraussetzungen späterer Planstufen, keine bereits bestandenen Beispieltests.
