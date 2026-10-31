# Golomb-Lineal: lokale kombinatorische Suche

Stand: 2026-10-07. Implementierung: [golomb.ts](../../../examples/golomb.ts).
Ein Prozess mit mehreren asynchronen Worker-Schleifen und einem Space im SQLite-Store (`<dir>/space.sqlite`). Keine Federation und keine
Parallelisierung auf mehrere CPU-Kerne.

## Mathematischer Vertrag

Ein normalisiertes Lineal hat ganzzahlige Marken 0 = a1 < a2 < ... < an; alle n(n−1)/2 positiven
paarweisen Differenzen müssen verschieden sein. Seine Länge ist die letzte Marke.
Leere/einmarkige Listen akzeptiert der allgemeine Hilfsvalidator als triviale Fälle; Suchergebnisse
werden zusätzlich auf die angeforderte Markenanzahl und Übereinstimmung von Länge und Marken geprüft.

Korrekte optimale Längen, Quelle: [OEIS A003022](https://oeis.org/A003022):

| Ordnung | Länge | Ordnung | Länge |
|---|---:|---|---:|
| 2 | 1 | 7 | 25 |
| 3 | 3 | 8 | 34 |
| 4 | 6 | 9 | 44 |
| 5 | 11 | 10 | 55 |
| 6 | 17 | 11 | 72 |
| 12 | 85 | 13 | 106 |

Beispiel [0,1,4,9,11] misst zehn Distanzen: 1,2,3,4,5,7,8,9,10,11; die Distanz 6 fehlt.
Aus der Anzahl verschiedener Distanzen folgt L ≥ n(n−1)/2. Diese Zähluntergrenze ist
weder eine generelle Obergrenze noch ein Beweis einer asymptotischen optimalen Länge n²/2.

Die CLI nutzt eine bekannte optimale **Länge als inklusive Suchgrenze** und für Early Exit.
Referenzpositionen werden nicht als Suchergebnis eingespeist. Summary.bestPositions stammt ausschließlich
aus gefundenen Ergebnissen, andernfalls null. Bei explizit kleinerer Grenze ist „kein Lineal gefunden“
ein zulässiges Resultat. Keine Aufzählung aller optimalen Lineale: es werden streng verbessernde Kandidaten
gesammelt; Early Exit kann andere optimale Lösungen und noch offene Tasks auslassen.

## Suche und Zustände

Der Master legt eine unveränderliche GolombRun-Konfiguration an. Standard-runId enthält Ordnung und
maximale Länge. Änderungen der Partitionierungsparameter bei derselben runId werden abgewiesen.
GolombSearchTask trägt runId, taskId, Ordnung, Grenze und einen Bereich für die zweite Marke a2.
Mirror-Symmetrie erlaubt die Einschränkung erster Abstand ≤ letzter Abstand.
DFS verwirft wiederholte Distanzen mit BitSet und Kandidaten, die die beste Länge nicht verbessern.

Worker nehmen nur Tasks ihres Laufs unter einer Txn. Die Lease beträgt 120 s, wird bei kooperativen
DFS-Unterbrechungen nach Bedarf erneuert. Die Suche gibt regelmäßig den Event Loop frei; das erlaubt Timer
und konkurrierende Host-Arbeit, erzeugt aber keinen CPU-Speedup durch mehrere Worker.
Ergebnisse und GolombTaskDone werden unter derselben Txn geschrieben und gemeinsam committed.
Fehler führen zu Abort; ein Prozessabbruch lässt die Reservierung bis Lease-Ablauf bestehen.

Master zählt nur Abschlüsse der passenden runId. Monitor/Validator der CLI werden auf den aktuellen Lauf
bezogen. completedNodes summiert nur bereits committed abgeschlossene Tasks, nicht laufende DFS-Arbeit.
Validator läuft nach den Worker-Schleifen und prüft die tatsächlich erzeugten Lineale.
Ein früher Optimalfund beendet die Suche; verbleibende Tasks können im Zustand bleiben und werden bei
vorhandenem Abschlussmarker nicht neu verarbeitet.

## Wiederanlauf und Checkpoints

Die CLI darf allein den Storage besitzen. Beim Öffnen desselben Verzeichnisses werden aufgegebene Txns
vor dem Enumerieren der Tasks abgebrochen; danach überspringt der Master bereits committed abgeschlossene
Tasks. Ein allgemeiner Library-Aufrufer muss ebenfalls alte aktive Reservierungen vor Master-Neustart
auflösen und darf nicht zwei Master für denselben Lauf starten.

Teilfortschritt innerhalb einer DFS wird nach einem Absturz **erneut berechnet**. Alte nextA2-Dateien werden
ignoriert: sie enthalten keinen atomaren Beleg für bereits gesicherte Lösungen.
`--checkpoint <prefix>` erzeugt nach dem Commit getrennte JSON-Abschlussbelege pro Lauf und Task, über
temporäre Datei plus Rename. Der Space ist die maßgebliche Quelle; diese Belege erlauben keinen partiellen
DFS-Resume. Ein Dateifehler nach Commit verliert kein Space-Ergebnis, kann den CLI-Lauf jedoch mit Fehler beenden.

Ein CLI-Neustart mit geändertem workers-Wert kann die Task-Konfiguration ändern und wird dann abgewiesen.
Andere Grenzen besitzen eine andere runId. Alte, unmarkierte Entries werden nicht als neue Run-Ergebnisse gezählt.

## Aufruf und Grenzen

```bash
npm run example:golomb -- 4 --workers 2
node --experimental-strip-types examples/golomb.ts 4 --workers 2 --dir /tmp/golomb-state
node --experimental-strip-types examples/golomb.ts 4 --workers 2 --dir /tmp/golomb-state
```

Ordnung 2–25, workers 1–64, positive ganzzahlige Länge. Hohe Ordnungen sind keine Laufzeitzusage.
Die Suche wächst stark; keine Produktionsbenchmarks vorhanden. Snapshot-Listen sind auf 1000 Entries begrenzt;
für lange Läufe fehlt eine allgemeine Pagination. BitSet-Clones und rekursive Suche begrenzen die Leistung.

[recovery.test.ts](../../../test/examples/recovery.test.ts) führt eine echte Ordnung-4-Suche aus,
validiert das Ergebnis, öffnet den SQLite-Store erneut und prüft Task-Rollback, alte Checkpoints und geänderte Konfiguration.
Die ältere golomb.test.ts prüft überwiegend Hilfsfunktionen und manuell erzeugte Entries; ihre Testnamen allein
sind kein Suchnachweis. Keine Mehrprozess-/GPU-/Federation- oder Skalierungsabnahme.
[Zur Übersicht](../README.en.md).
