# Terminaloberfläche für Spaces und Testbetrieb

Die TUI läuft auf dem Bedienrechner und verwendet dieselbe Serverkonfiguration wie
`test/testbed/testbed.sh`. Es werden keine neuen Abhängigkeiten installiert.

```sh
npm run tui
npm run tui -- --dry-run
npm run tui -- --service member-1
npm run tui -- --local-dir /tmp/mein-sieve-mobile
```

Vier Ansichten:

- **Spaces:** registrierte Spaces eines Containers, Typbalken, sichtbare/reservierte/uncommittete/abgelaufene
  Entries, JSON-Felder und Metadaten. Zusätzlich Transaktionen, Notify-Abos, Waiter, Outbox und Request-Claims.
  `s` wechselt Container, `←/→` den Fokus, `↑/↓` die Auswahl, `/` filtert und `i` die Objektart.
  `PgUp/PgDn` scrollt Details. Automatisches Aktualisieren alle drei Sekunden; `r` aktualisiert sofort.
- **Aktionen:** Serverprüfung, Initialisierung, Artefaktbau/-übertragung, Runner-/Federation-Container,
  Start/Stopp/Crash/Partition/Rejoin, die vorhandenen Artefakttests und die vier Sieb-Szenariophasen.
  Lokale Quelltests, Beispieltests, einzelne Testsuiten und Typecheck stehen in einem getrennten Menübereich.
- **Berichte:** Exit-Status und TAP-Zähler der TUI-Aufträge sowie die einzelnen fachlichen Checks aus
  `sieve-mobile/report.json`. Bei älteren Tests zählt Node-TAP Dateisuiten statt einzelner Assertions.
  Ein Bericht zu einer anderen Lauf-ID oder ohne passende `phone.json` gilt ausdrücklich als alt/unbestätigt.
- **Log:** laufende Ausgabe; `Enter` im Berichtsmenü öffnet das gespeicherte Protokoll. `PgUp/PgDn` scrollt.

`1`–`4` wählen Ansichten, `Tab` wechselt, `q` beendet. Die TUI stellt Terminalmodus und Cursor beim Beenden wieder her.
Sie startet beim Öffnen keine Container und überträgt keine Artefakte. Ohne laufenden Container oder installiertes
Inspektionsartefakt zeigt sie den konkreten Fehler. Nach Einführung der TUI muss die Dockerfile-Vorlage auf dem Server
mit `npm run testbed -- init --force` übernommen werden, wenn die vorhandene Dockerfile noch kein `COPY build/tools`
enthält. Anschließend liefert `up core` das neue Inspektionsartefakt aus. Vorhandene `.env` bleibt bestehen.

## Lesezugriff auf Spaces

`testbed inspect <dienst>` führt nur `tools/inspect.mjs /data` im vorhandenen Container aus. Der Inspector sucht
JSONL-Storages und Szenarioberichte bis vier Verzeichnisebenen unter `/data`. Symlinks werden nicht verfolgt.
Für jedes Storage kopiert er die Hauptdatei und Sidecars in ein privates temporäres Verzeichnis. Die Hauptdatei
muss vor/nach dem Kopieren identisch sein; Änderungen/Recovery-Fehler führen zu höchstens drei Versuchen.
Der Harness wird nur auf dieser Kopie geöffnet. Seine Recovery kann deshalb niemals das Original reparieren,
verkürzen oder durch einen zweiten Schreiber verändern. Die Kopie wird anschließend entfernt.

Die Anzeige ist eine Beobachtung bestätigter Daten, kein atomarer Snapshot über mehrere Storages/Hosts.
Bei fortlaufenden Änderungen kann das Lesen scheitern; die TUI behält dann die letzte erfolgreiche Ansicht und
markiert sie als veraltet. Pro Space werden höchstens 20.000 Objekte übertragen; Kürzungen sind sichtbar.
SQLite- und Memory-Storages benötigen einen künftigen Snapshot-Endpunkt im laufenden Dienst und werden hier nicht gelesen.

## Aktionen, Abbruch und Nachweise

Der erste reale Servereingriff benötigt eine Freigabe in der TUI. Stopp, Crash, `down` und Szenarien, die den
bisherigen Lauf ersetzen, besitzen zusätzliche Bestätigungen. Die Auswahl verwendet feste Befehle und Argumente,
keine frei eingegebenen Shellbefehle. Gleichzeitig läuft höchstens ein steuernder Auftrag in dieser TUI.
Die vorhandene Testumgebung hat weiterhin keine Sperre zwischen mehreren Bedienrechnern; gemeinsame Tests nicht parallel starten.

`x` beendet die lokale Prozessgruppe. Bei SSH-Arbeit kann der Serverprozess weiterlaufen: Der Ausgang bleibt
**unknown**, nicht „fehlgeschlagen“ oder „bestanden“. Danach Containerstatus prüfen und das Szenario auswerten.
Ein Container-Stopp ersetzt keine fachliche RunGate-Pause und kann laufende Arbeit unterbrechen.

Die TUI speichert `.json`-Auswertung und vollständiges `.log` unter `dist/tui-runs/` (git-ignoriert).
Status: `passed` nur für erfolgreiche tatsächlich ausgeführte Tests, `completed` für erfolgreiche Verwaltungsaktionen,
`failed` bei Fehler, `preview` bei Vorschau, `cancelled` bei lokalem Abbruch, `unknown` bei abgebrochenem Remote-Aufruf
oder unvollständig aufgezeichnetem früherem Auftrag. Vorschauen verbinden sich nicht mit dem Server und bauen nichts.

```sh
npm run tui -- --list-actions
npm run tui -- --action test-all --dry-run
npm run tui -- --action test-all --allow-remote
npm run tui -- --once --json --local-dir /tmp/mein-sieve-mobile
```

Die Menüeinträge zu Membership/Drain/Entfernung, RunGate-Pause, produktiver Laufsteuerung, Worker-Supervisor,
LLM-Agenten, Provisionierung/Pairing und Promotion/Restore bleiben gesperrt, bis deren Backends implementiert sind.
Auch Core-Mutationen wie Write/Take/Txn/Lease benötigen einen administrativen Remote-Steuerpfad; der Inspector ist
absichtlich kein zweiter Storage-Schreiber. Die leeren Federation-Container werden als Platzhalter bezeichnet.

Server-Artefakttests ersetzen keine lokalen Quelltests und keine Federation-/Fencing-Abnahme.

## Servernachweis vom 2026-10-08

Auf `big` wurde die Dockerfile um den Inspector aktualisiert und `test-all` über den TUI-Steuerpfad
ausgeführt: Smoke, fünf kompilierte Beispiele und das Sieb-Szenario bestanden. Der Runner nutzt
Node v22.23.3, `NODE_ENV=production`, UID 1000, schreibgeschütztes Root-Dateisystem, keine effektiven
Capabilities und `no-new-privileges`. Keine TypeScript-Quellen außerhalb der Abhängigkeiten.

Die echte TUI zeigte `default` und `sieve-a`, einen Lauf, acht Ergebnisse, neun entschiedene Claims
und alle sieben bestandenen Szenariochecks (168 Primzahlen). Container-Stopp/Start über die TUI
bestand; danach waren sämtliche Space-Objekte unverändert erhalten. Der Runner bleibt für die
Bedienung gestartet. Protokolle: `dist/tui-runs/`; zusammengefasster Nachweis:
`dist/testbed-proof/tui-big-2026-10-08.json`. Diese Ausführung prüft einen Container, keine Federation.
