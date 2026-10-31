# Beispieldokumentation

Stand: 2026-10-07. Diese Dokumente beschreiben lokale Beispiele und klar gekennzeichnete Entwürfe.
Die [verbindliche Übersicht](../../examples.en.md) enthält Aufrufe und den aktuellen Nachweisumfang.

| Lernschritt | Dokument | Inhalt |
|---|---|---|
| 1 | [Master/Worker](../sieve.en.md) | segmentiertes Primzahlsieb, transaktionale Tasks und Wiederaufnahme |
| 2 | [IoT-Pipeline](../iot.en.md) | Take unter Txn, Fork/Join, Validierung, Deduplizierung, atomarer Report |
| 3 | [Chat](../chat.en.md) | Notify, adressierter Ring, Stoppen der Verarbeitung |
| 4 | [Golomb](../golomb.en.md) | tatsächliche DFS, Konkurrenz, Task-Recovery und Suchlaufidentität |
| 5 | [arXiv](../arxiv.en.md) | Modell-Workflow, serverseitige Txn-Prüfung, Grenzen der Datengrundlage |
| 6 | [Cache](../cache.en.md) | lokaler atomarer Cache mit TTL/CAS; nicht repliziert |
| Hintergrund | [Historische Referenzen](../../_attic/HISTORISCHE-REFERENZEN.en.md) | Linda/JavaSpaces und Unterschiede zum Projekt |
| Korrekturprotokoll | [Implementierungsanalyse](../../_attic/IMPLEMENTIERUNGS-ANALYSE-V2.en.md) | behobene Befunde und verbleibende Grenzen |

Alle ausführbaren Beispiele liegen in [examples/](../../../examples/).
Tests: [test/examples/README.en.md](../../../test/examples/README.en.md).
Federation, HRW und LWW-Replikation sind implementiert ([Implementierungsstand](../../implementierungsstand.en.md)), werden aber von diesen Beispielen
nicht benutzt. `RemoteSpace` ist der RPC-Unterbau gegen einen einzelnen Space-Dienst;
das Remote-Sieb-Szenario liegt im Testbed, nicht in diesen Beispielseiten.

Es gibt keine gemessenen Speedup- oder Durchsatztabellen. „Geskriptet getestet“ bezeichnet feste
Modellantworten mit echtem lokalem Space, nicht die Qualität eines realen LLMs.
