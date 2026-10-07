# Beispieldokumentation

Stand: 2026-10-07. Diese Dokumente beschreiben lokale Beispiele und klar gekennzeichnete Entwürfe.
Die [verbindliche Übersicht](../examples.md) enthält Aufrufe und den aktuellen Nachweisumfang.

| Lernschritt | Dokument | Inhalt |
|---|---|---|
| 1 | [Master/Worker](sieve.md) | segmentiertes Primzahlsieb, transaktionale Tasks und Wiederaufnahme |
| 2 | [IoT-Pipeline](iot.md) | Take unter Txn, Fork/Join, Validierung, Deduplizierung, atomarer Report |
| 3 | [Chat](chat.md) | Notify, adressierter Ring, Stoppen der Verarbeitung |
| 4 | [Golomb](golomb.md) | tatsächliche DFS, Konkurrenz, Task-Recovery und Suchlaufidentität |
| 5 | [arXiv](arxiv.md) | Modell-Workflow, serverseitige Txn-Prüfung, Grenzen der Datengrundlage |
| 6 | [Cache](cache.md) | lokaler atomarer Cache mit TTL/CAS; Replikation geplant |
| Hintergrund | [Historische Referenzen](HISTORISCHE-REFERENZEN.md) | Linda/JavaSpaces und Unterschiede zum Projekt |
| Korrekturprotokoll | [Implementierungsanalyse](IMPLEMENTIERUNGS-ANALYSE-V2.md) | behobene Befunde und verbleibende Grenzen |

Alle ausführbaren Beispiele liegen in [examples/](../../examples/).
Tests: [test/examples/README.md](../../test/examples/README.md).
Die Federation, RemoteSpace, HRW und LWW-Replikation sind geplant; kein Beispiel testet sie bereits.

Es gibt keine gemessenen Speedup- oder Durchsatztabellen. „Geskriptet getestet“ bezeichnet feste
Modellantworten mit echtem lokalem Space, nicht die Qualität eines realen LLMs.
