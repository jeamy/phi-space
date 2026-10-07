# Tests der Beispiele

Stand: 2026-10-07. Eingebauter Node-Test-Runner, keine neue Testbibliothek.
compat.ts bildet einen begrenzten Matcher-/Hook-Ausschnitt ab; vi.useFakeTimers ist ein Stub
und darf nicht als echte Zeitsteuerung interpretiert werden.

```bash
npm run typecheck
npm test
npm run test:examples
# Nested test details without the file-level runner summary:
node --experimental-strip-types test/examples/recovery.test.ts
```

| Datei | Tatsächlicher Umfang |
|---|---|
| workers.test.ts | eigener geskripteter Master/Worker-Ablauf mit echtem Space |
| blocking-tool.test.ts | lokale blockierende Operationen und Timeouts |
| chat.test.ts | eigener Faux-Chat und Notify-Muster |
| sensor-pipeline.test.ts | importierte collect/analyse/present-Funktionen |
| golomb.test.ts | BitSet, Linealvalidierung, Referenzen und manuell erzeugte Entries |
| arxiv-research.test.ts | eigener geskripteter Rechercheablauf, Feed-Parser |
| dark-energy-research.test.ts | eigener geskripteter Ablauf mit lokalen Fixtures |
| sieve.test.ts | echte Siebfunktionen, unabhängige Referenz, Konkurrenz, Rollback und JSONL-Reopen |
| cache.test.ts | echte Cache-Klasse, CAS-Konkurrenz, TTL, Rollback und JSONL-Reopen |
| recovery.test.ts | echte Golomb-Suche und Runner, JSONL-Reopen, Fehler-/Rollback-Fälle |

Neue Regressionen prüfen: tatsächlich gefundenes Ordnung-4-Lineal; persistenter abgeschlossener Lauf;
ein durch SIGKILL beendeter Unterprozess mit JSONL-Reservierung und anschließender erneuter Suche;
fremde runId beeinflusst Abschluss nicht; geänderte Run-Konfiguration wird abgewiesen; Fehler beim
Task-Abschluss gibt Aufgabe zurück und verwirft Ergebnisse; unsichere alte Checkpoints werden ignoriert;
gültiger Messwert nach ungültiger identischer Lieferung; atomare Presenter-Rückgabe; oversized Window;
vollständiger Abstract/Datum/Autoren; tatsächliche Forschungsrunner mit Faux und frischem JSONL;
fehlende Ergebnis-Txn und erfundene Zitationszahl abgewiesen; echter geskripteter Chat-Ring.

Die Runner-Tests verwenden die echten Produktionsprompts mit geskripteten Antworten. Dadurch wird die
Host-Orchestrierung geprüft, nicht ob ein echtes Modell die Prompts zuverlässig erfüllt. Es werden keine
kostenpflichtigen Modelle oder tatsächlichen arXiv-Netzrequests ausgeführt.

Alte Testnamen wie „vollständige Suche“ sind bei manuell erzeugten Entries kein eigenständiger Suchnachweis.
Keine Coverage-Prozentwerte, Performance-, Fuzz-, Mehrprozess- oder Federation-Abnahme vorhanden.
Der äußere npm-Runner kann nur Datei-Ergebnisse melden; daraus wird keine Gesamtzahl innerer Fälle abgeleitet.
Am 2026-10-07 wurden außerhalb der eingeschränkten Sandbox 158 innere Tests bestanden, ohne Fehler oder Skips.
Davon prüfen 7 neue Tests das Sieb und 8 neue Tests den lokalen Cache. Die Sieb-Referenz verwendet
unabhängige Probedivision; Lease-/TTL-Tests injizieren eine Uhr, statt den Fake-Timer-Stub zu verwenden.
Der Prozess-Crash-Test benötigt die Erlaubnis, einen lokalen Node-Unterprozess zu starten und zu beenden.
Unter einer Sandbox mit gesperrtem child_process ist dafür eine gezielte Freigabe erforderlich.
[Beispieldokumentation](../../docs/examples.md).
