# Lokale Validierung

Stand: 2026-10-07. Dieser Bericht beschreibt den geprüften lokalen Arbeitsstand, keine Produktionsabnahme.

| Prüfung | Ergebnis |
|---|---|
| npm run typecheck | bestanden |
| npm test | Kern-, Integrations-, Persistenz-, Spaces- und Claims-Tests bestanden (108) |
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

## Ergänzung AP 1.1–1.9 (2026-10-09)

Aktueller Nachweis: [ap1-abnahme.md](abnahme/ap1-abnahme.md). Typecheck und TypeScript-Build bestanden;
184 Kern-/Integrations-/TUI-/AP-/pi-server-Tests und 158 Beispieltests bestanden ohne Skips.
Echter pi-serverd mit neu gebautem Bundle, temporärer SQLite-Datenbank und Unix-Socket geprüft;
Sessions weiter nutzbar, Space-RPC ohne explizite Konfiguration abgewiesen. Remote-Sieb im benannten
Space nach Host-SIGKILL/Reopen: 10 Ergebnisse, 168 unabhängig geprüfte Primzahlen, keine Rest-Txns.
Die untenstehenden Messungen vom 2026-10-07 sind historische Einzelbefunde; sie wurden nicht als
Performance-Abnahme des neuen Arbeitsstands wiederholt.

## pi-durable-Machbarkeit (AP 0.3)

Messung am 2026-10-07 mit `node --experimental-strip-types scripts/spike-durable.ts <N>` auf dem
Entwicklungsrechner (Node 22, lokale SSD). Einzelläufe, keine Statistik; Richtwerte, keine Abnahme nach Gate 4.

**Semantik:**
- Ein Commit über ein Familien-Dokument und einen Singleton ist atomar; ein Fehler rollt beide zurück.
- Ein Familien-Token mit derselben `kind` wie ein persistierter Singleton liefert **ohne Fehler** ein anderes,
  leeres Dokument. Der Singleton darf deshalb nicht einfach als Familie weitergeführt werden.
- Kopieren in eine neue `kind` plus `retireDoc` im selben Commit funktioniert und übersteht Reopen.

**Kosten eines Space-Dokuments** (Entries mit etwa 230 Byte Feldern; Befüllen in Commits zu 500 Writes):

| Entries | Backend | Befüllen | 1 Write | Take, erster Treffer | Take, letzter Treffer | Storage | Reopen + Snapshot |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1000 vor Korrektur | JSONL | 20 s | 48 ms | 48 ms | 86 ms | 231 MB | 3,5 s |
| 1000 | JSONL | 0,7 s | 3,3 ms | 2,6 ms | 10 ms | 0,7 MB | 35 ms |
| 1000 | SQLite | 0,6 s | 5,8 ms | 2,6 ms | 10 ms | 0,7 MB | 13 ms |
| 4000 | JSONL | 9,9 s | 8,9 ms | 6,3 ms | 31 ms | 1,8 MB | 56 ms |
| 4000 | SQLite | 10,3 s | 8,5 ms | 7,0 ms | 30 ms | 1,8 MB | 22 ms |
| 10 000 | JSONL | 68 s | 19,8 ms | 12,3 ms | 81 ms | 3,9 MB | 98 ms |
| 10 000 | SQLite | 66 s | 17,6 ms | 12,3 ms | 78 ms | 4,0 MB | 40 ms |

Die Korrektur: `settle()` und das Txn-Ende ersetzten bei jedem Commit ganze Arrays im Dokument-Draft; pi-durable
speicherte dadurch jedes Mal den vollständigen Space. Jetzt wird nur entfernt, was tatsächlich abläuft.

**Folgerung:** Die Kosten wachsen linear mit der Entry-Zahl. Bei 10 000 Entries (dem Lasttestziel aus v3 §12)
kostet ein einzelner Write knapp 20 ms und ein Take mit spätem Treffer etwa 80 ms. Treiber sind die
Gesamtbyte-Summe in `write`, der Scan in `settle` und die lineare Template-Suche über Draft-Proxys. Gegenmaßnahmen
(laufende Bytegrenzen sind inzwischen umgesetzt; Ablauf-Index und Typindex bleiben Optimierungsoptionen) gehören
vor die Lasttests von Gate 4.

## Automatische mobile Bundle-Aktualisierung

Im Nachbarprojekt pi-termux-mobile wurde der Android-Debug-Build mit dem neuen preBuild-Schritt erfolgreich
ausgeführt. Geprüft wurden die Übereinstimmung des Bibliotheksbundles in Source-Ausgabe, mobiler Runtime und
APK sowie die enthaltenen Sieb-/Cache-Module und die Prüfsumme von runtime.bin/rootfs.bin.
Eine unveränderte erneute Vorbereitung erzeugt dieselbe Prüfsumme und erhält die Asset-Zeitstempel.
Die gebündelten Sieb-/Cache-CLI-Programme laufen lokal; vier Remote-Provisionierungsregressionen bestehen,
einschließlich Hash-Änderung bei geänderten, hinzugefügten und entfernten Beispielmodulen.

Dies belegt Build, Verpackung und lokale Ausführung. Installation/Re-Extraktion auf einem echten Handy und
Übertragung an einen Remote-Host wurden dabei nicht ausgeführt; die vorhandenen Update-Freigaben bleiben bestehen.

Die tatsächlichen Forschungsrunner wurden mit Faux-Modellen, lokalen Daten und JSONL ausgeführt; reale Modelle
und arXiv-Netzrequests waren nicht Teil dieser Abnahme. Referenzwerte und Datenvertrag wurden gegen
[OEIS A003022](https://oeis.org/A003022) und die
[arXiv-API-Dokumentation](https://info.arxiv.org/help/api/user-manual.html) abgeglichen.

Keine gemessene Performance-/Skalierungs-, Coverage-, Mehrhost- oder wissenschaftliche Qualitätsabnahme.
Details: [Beispielverträge](examples.md), [Tests](../test/examples/README.md).
