# arXiv-Recherche: Datenvertrag und Workflow

Stand: 2026-10-07. Implementierungen:
[arxiv-tool.ts](../../examples/arxiv-tool.ts),
[arxiv-research.ts](../../examples/arxiv-research.ts),
[dark-energy-research.ts](../../examples/dark-energy-research.ts),
[research-support.ts](../../examples/research-support.ts).

## Quellenvertrag

Die öffentliche [arXiv-API](https://info.arxiv.org/help/api/user-manual.html) liefert Atom-Metadaten.
Der Parser gibt versionlose arxivId, Titel, Jahr, ursprüngliches published-Datum, vollständige authorNames,
Kurzformat authors, Kategorien, primäre Kategorie und vollständigen Abstract aus.
Die Autoren-Kurzzeichenfolge dient nur zur Darstellung; Netzwerke verwenden authorNames.
Ein Abstract ist kein Paper-Volltext. Zitationszahlen, Referenzgraph und H-Index werden nicht geliefert.

Pro Prozess sind Requests serialisiert und mindestens 3,1 s auseinander; Fetch hat 30 s Timeout.
Mehrere Prozesse teilen diesen Limiter nicht. Die Suche liefert 1–25 Ergebnisse pro Aufruf, keine Pagination.
Der Regex-Parser ist für das verwendete Atom-Format ausgelegt, nicht für beliebiges XML. HTTP-Fehler werden
weitergegeben; es gibt keinen garantierten Wiederholungs-/Backoff-Vertrag. Eingaben/Antworten sind Fremddaten,
keine Anweisungen. Prompt-Markierungen verhindern Halluzinationen oder Prompt Injection nicht vollständig.

## Einfache Pipeline

Drei Collector-Conversations sammeln bibliografische Paper-Entries und melden CollectorDone.
Eine Prüfung read-before-write ist keine atomare Deduplizierung; überlappende Sammler können Duplikate erzeugen.
Nach allen Abschlüssen oder Collector-Timeout schreibt der Host AnalyzeTask.
Analyst reserviert die Aufgabe via space_wait, schreibt Analysen und PresentTask unter derselben Wait-Txn.
Commit macht Ausgaben sichtbar und verbraucht den Auftrag. Presenter reserviert PresentTask,
schreibt Report ebenfalls unter dessen Txn und committet.

## Dark-Energy-Pipeline

Crawler → Host → ClassifyTask → ClassifiedPaper + ClassificationDone → Host → SummarizeTask →
PaperSummary + SummarizationDone → Host → AnalyzeTask → AnalysisResult + Analysis(order=99) →
Host → PresentTask → Presentation. Optional UserQuery → QueryResponse.

Der Host wartet auf committed Abschlussmarker; ein Ergebnis-Write allein gilt nicht als abgeschlossene Phase.
Der Monitor ist periodischer Host-Code, kein autonomer LLM-Agent.
Ohne klassifizierte Paper wird die Zusammenfassung übersprungen und als solche markiert.

PaperSummary muss basis=abstract und citationCount=null tragen. Schätzwerte werden abgewiesen.
CitationAnalysis muss unbekannte Zitationsrangliste und Graph als null mit unavailable-Grund ausgeben.
Bekannte Zitationskennzahlen in AuthorNetwork werden abgewiesen. Auswertbar sind Counts und Koautorenschaften
**innerhalb des gesammelten Korpus**, keine Aussage über die gesamte Literatur oder vollständige Autorenlaufbahnen.
Monatsverteilungen verwenden published; ohne Datum bleibt die Information unbekannt.
Dashboard-JSON ist ein Datenartefakt, kein implementiertes interaktives Dashboard.

## Atomarität und frische Läufe

Die gemeinsamen Ergebnis-Tools prüfen aktive Txn, Owner und passenden reservierten Aufgabentyp.
Missing txn wird serverseitig abgewiesen. Validierung ist task-scoped persistent, damit ein Replay eines bereits
erfolgreichen Tool-Writes auch nach Txn-Commit sein vorhandenes Claim-Ergebnis abfragen kann.
Die eigentliche Mutation prüft weiterhin die Transaktion; ein erster Write nach deren Ablauf scheitert.
Ergebnis und Aufgabe sind nur innerhalb des lokalen Space-Commits atomar. Report-/Dashboard-Dateien werden
danach separat exportiert und sind nicht Teil der Space-Transaktion.

Jeder Start fordert ein frisches leeres Verzeichnis und legt exklusiv einen Marker an. Automatischer
Research-Resume ist nicht implementiert. Vorhandenes JSONL bleibt zur Inspektion erhalten; ein neuer Start
damit scheitert früh. Auch neue Conversations können dadurch keine alten Done-Marker als Erfolg übernehmen.

Timeouts sind Workflow-Grenzen, keine Belege für vollständige Forschung. Jede Phase benötigt ihren bestätigten
Abschluss. Bei Timeout endet der Runner mit Fehler und erhält den Zustand zur Inspektion; nachfolgende Phasen
werden nicht aus unvollständigem Material gestartet. Listenlimits (100–500 je Prompt)
und feste Suchlimits begrenzen den Korpus; ≥80 % Literaturabdeckung ist nicht nachgewiesen.
Auch ein Quellenlink belegt weder die Richtigkeit einer Modellzusammenfassung noch die Existenz erfundener IDs.
Die Guards prüfen bekannte strukturierte Kennzahlen, nicht beliebige Aussagen im freien Markdown.

## Aufruf und Tests

```bash
# Requires model credentials, network and approval
npm run example:arxiv -- "Thema" --dir /tmp/fresh-arxiv-run
npm run example:dark-energy -- "Thema" --dir /tmp/fresh-dark-run --query "Frage"
# No real model or API calls
npm run test:examples
```

Die Runner sind als runArxivResearch/runDarkEnergyResearch importierbar. Tests injizieren Modelle,
Pollintervalle und Fristen. recovery.test.ts startet die tatsächlichen Runner mit Faux-Modellen und JSONL,
prüft Berichte, frische Verzeichnisse und Ergebnis-Guards. Es wird kein Paper tatsächlich aus dem Netz geladen.
Ältere Suites bauen eigene Prompts/Workflows nach. Echte Modellläufe, bibliometrische Qualität,
Faktenvalidierung und produktiver Betrieb sind nicht abgenommen.
[Zur Übersicht](README.md).
