# Lokale Validierung der Beispielkorrekturen

Stand: 2026-10-07. Dieser Bericht beschreibt den geprüften lokalen Arbeitsstand, keine Produktionsabnahme.

| Prüfung | Ergebnis |
|---|---|
| npm run typecheck | bestanden |
| npm test | Kern- und Integrationstests bestanden |
| npm run test:examples | 158 Tests bestanden, keine Fehler/Skips; Ausführung mit freigegebenen Unterprozessen |
| Sieb-/Cache-Regressionen | 7 Sieb- und 8 Cache-Tests; unabhängige Primzahlreferenz, Konkurrenz, Rollback, Lease/TTL und JSONL-Reopen |
| gezielter SIGKILL-/JSONL-Test | Reservierung nach Prozessverlust vorhanden, uncommitted Ergebnis unsichtbar; nach Recovery erneut korrekt gesucht |
| npm run example | geskripteter Job wurde geschrieben und genommen |
| npm run example:pipeline | zwei Fenster/Reports; fehlende Quelle, Duplikat und ungültiger Wert korrekt sichtbar |
| npm run example:chat | geskripteter Ring 0–9 beendet |
| npm run example:golomb -- 4 --workers 2 | selbst gefundenes [0,1,4,6], Länge 6, Validator ohne Fehler |
| npm run example:sieve -- 1001 4 | 168 Primzahlen in [1,1001) |
| npm run example:cache | versionsgebundener Ersatz durch Bob, anschließende Löschung und Miss |
| lokale Dokumentdateiverweise | keine fehlenden Zielpfade |
| git diff --check | ohne Whitespace-Fehler |

Die tatsächlichen Forschungsrunner wurden mit Faux-Modellen, lokalen Daten und JSONL ausgeführt; reale Modelle
und arXiv-Netzrequests waren nicht Teil dieser Abnahme. Referenzwerte und Datenvertrag wurden gegen
[OEIS A003022](https://oeis.org/A003022) und die
[arXiv-API-Dokumentation](https://info.arxiv.org/help/api/user-manual.html) abgeglichen.

Keine gemessene Performance-/Skalierungs-, Coverage-, Mehrhost- oder wissenschaftliche Qualitätsabnahme.
Details: [Beispielverträge](examples.md), [Tests](../test/examples/README.md).
