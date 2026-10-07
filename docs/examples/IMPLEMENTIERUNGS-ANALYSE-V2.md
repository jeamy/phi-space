# Implementierungsanalyse: korrigierter Stand

Stand: 2026-10-07. Der Dateiname bleibt für bestehende Verweise erhalten.
Die frühere Sammlung uneinheitlicher Codekopien und Leistungszahlen ist durch die
[verbindliche Beispielübersicht](../examples.md) und die einzelnen aktuellen Dokumente ersetzt.

| Befund | Korrektur | Verbleibende Grenze |
|---|---|---|
| Golomb-Task ohne Txn | Task, Ergebnisse und Abschluss unter Txn; Abort bei Fehler | Recovery bei Prozessabbruch benötigt Lease-Ablauf bzw. CLI-Neustart |
| nextA2 ohne gesicherte Lösungen | keine partiellen Cursor; Abschlussbelege erst nach Commit | Sucharbeit eines offenen Tasks wird wiederholt |
| vermischte Suchläufe | runId, unveränderliche Konfiguration, gefilterte Abschlüsse | ein Master/Storage-Prozess; keine Federation |
| CPU-Speedup durch mehrere async Worker behauptet | kooperative DFS und korrigierte Beschreibung | echte CPU-Parallelität nicht implementiert |
| ungültiges erstes Sensor-Duplikat | validieren vor kollisionsfreier Deduplizierung | bei gültigem Konflikt gewinnt erster Wert |
| destruktive Summary-Präsentation | Take/Report unter gemeinsamer Txn | externe Exporte separat |
| abgeschnittenes Sensorfenster | mehr als 1000 Readings abweisen | keine allgemeine Pagination |
| Forschungsoutputs ohne Txn | Ergebnis-Tools prüfen reservierte Aufgabe/Owner/Txn | Modellinhalte bleiben prüfbedürftig |
| alte Recherchemarker als neuer Erfolg | nur frische leere Verzeichnisse | automatischer Research-Resume fehlt |
| erfundene Bibliometrie | Zitationsmetriken unbekannt; Guards; vollständige Autoren/Datum/Abstract | keine zusätzliche Zitationsdatenquelle |
| Tests spiegeln eigenen Workflow | Regressionen rufen tatsächliche Runner/Funktionen auf | ältere Skriptsuite bleibt zusätzlicher Semantiktest |
| Sieb und Cache ohne Code | segmentiertes Sieb und atomarer Cache; eigene Funktions-/Recovery-Tests | lokaler Harness; keine Replikation oder CPU-Parallelität |
| uneinheitliche Specs/Links | Dokumente konsolidiert, lokale Verweise geprüft | echte Modell-/Mehrhost-Abnahme weiterhin offen |

Die Korrekturen werden durch typecheck, Kern- und Beispielsuite geprüft.
[recovery.test.ts](../../test/examples/recovery.test.ts) enthält gezielte Fehlerfälle.
Keine Behauptung, dass jede hypothetische Ausfallsequenz oder jede wissenschaftliche Aussage geprüft ist.
[Zur Übersicht](README.md).
