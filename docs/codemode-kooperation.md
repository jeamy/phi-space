# Codemode-Chat: Kooperation der Agenten (Konzept, 2026-10-20)

Ziel: Agenten lösen Probleme **gemeinsam**: nicht nur Programmieraufgaben, sondern auch Fragen, deren Ergebnis ein Text,
eine Analyse oder ein Plan ist. Sie recherchieren, analysieren, schlagen vor, entwerfen, kritisieren und führen
zusammen. Koordiniert wird nur über den Space, nach dem Linda-Prinzip, ohne Takt.

## Stand heute

- Ein Lauf ist eine Folge von **Generationen**. Innerhalb einer Generation arbeiten alle Agenten parallel und sehen
  einander nicht. Erst die nächste Generation sieht die Versuche, ihre Testergebnisse und die Notizen.
- Die Rollen sind **reparieren, verbessern, neuer Ansatz**. Jeder Beitrag merkt sich, auf welchem er aufbaut
  (`basedOn`). Im Lauf `#test-golomb11c` übernahm codestral 54 % des Vorlage-Codes, haiku schrieb mit 17 bis 23 %
  Übernahme fast neu.
- Es fehlen Kritik zwischen Agenten, das Zusammenführen von Teillösungen, ein gemeinsamer Plan, Recherche und
  Aufgaben ohne Programmcode.
- Der Laufzustand lag im Speicher: Ein Neustart des Hubs brach einen Lauf ab. Seit 2026-10-20 überstehen Läufe einen
  Neustart (Abschnitt „Dauerhafte Läufe“).

## Kern: Arbeitsaufträge im Space

Statt Generationen hält der Space **offene Aufträge**. Ein freier Agent nimmt sich einen (`take` unter einer
Transaktion, wie die Bewerter heute), erledigt ihn, schreibt das Ergebnis und **erzeugt Folgeaufträge**. Weil der
ganze Laufzustand aus Einträgen im Space besteht, übersteht ein Lauf einen Neustart.

| Eintrag | Inhalt |
|---|---|
| `WorkItem` | `kind`, `inputs` (ids), `blockId`, `depth`, `claimedBy?`; die Arten stehen unten |
| `Finding` | Fundstück einer Recherche: Quelle (URL), Auszug, wer |
| `Proposal` | Vorschlag: Ansatz oder Plan, mit Begründung |
| `Critique` | Kritik an einem Eintrag: `target`, `addressedTo`, konkrete Punkte |
| `Answer` | Entwurf einer Antwort (Text-Aufgaben) |
| `CodeCandidate` / `CodeScore` | wie heute (Code-Aufgaben) |

Alle Einträge tragen `blockId` und Herkunft (`inputs`, Autor, Modell, Verbrauch).

| Auftrag | Was der Agent tut | erzeugt typischerweise |
|---|---|---|
| `research` | sucht Daten, Quellen | `Finding` → `analyze` |
| `analyze` | wertet Fundstücke oder Versuche aus | `Proposal` |
| `propose` | schlägt Ansätze vor; andere bewerten sie | `draft` / `implement` für die besten |
| `draft` | schreibt eine Antwort aus Vorschlägen und Fundstücken | `Answer` → `critique` |
| `implement` | schreibt Code (Code-Aufgaben) | `CodeCandidate` → Bewertung → `critique` |
| `critique` | prüft einen Beitrag kritisch, adressiert an den Autor | `Critique` → `revise` |
| `revise` | überarbeitet mit der Kritik | neue Version → `critique` |
| `merge` | führt zwei Teillösungen zusammen | neue Version |
| `judge` | Abschlussprüfung nach Kriterienliste (Text-Aufgaben) | fertig, oder `revise` |

Ein Lauf endet, wenn die Aufgabe gelöst ist (Code: Testfälle; Text: die Prüfer stimmen zu), das Budget erschöpft ist
oder Stop gedrückt wird. Die Abwertung durch einen Menschen bleibt das letzte Wort.

## Sicherheit und Kosten

- **Budget je Lauf:** Obergrenze in Tokens oder Dollar, aus der bestehenden Verbrauchserfassung. Dazu Obergrenzen für
  die Zahl der Aufträge und ihre Tiefe; asynchrone Aufträge vervielfachen sich sonst.
- **Websuche:** Jede Anfrage schickt Aufgabentext an einen Dritten. Ein Werkzeug, das beliebige URLs abruft, ist auf
  einem öffentlichen Hub ein SSRF-Einfallstor (localhost, nano, Docker, NetBird, LAN). Darum: nur Suchergebnisse
  (Titel, Auszug, URL), oder Abruf nur mit Sperre privater Adressbereiche, Größen- und Zeitgrenzen. Dazu ein
  Tageslimit für Suchanfragen.
- **Prompt-Injection:** Inhalte aus dem Netz gelangen zu allen nachfolgenden Agenten. Sie werden im Prompt als
  nicht vertrauenswürdige Daten gekennzeichnet und sind nie Anweisung.
- **Bewertung von Texten:** Es gibt keine Sandbox-Wahrheit. Bewertende Modelle lassen sich leicht schmeicheln und
  austricksen. Darum gibt der Mensch eine Kriterienliste vor, mehrere Prüfer müssen zustimmen, und die Abwertung durch
  den Menschen bleibt möglich.

## Entscheidungen (2026-10-20)

- **Websuche:** normale Webrecherche ohne API-Schlüssel, über die HTML-Ergebnisseite von DuckDuckGo
  (`html.duckduckgo.com`). Das ist inoffiziell: Bei vielen Anfragen kann DuckDuckGo blocken, und eine Layout-Änderung
  erfordert eine Anpassung. Dazu ein Tageslimit für Suchanfragen.
- **Zugriff:** Läufe mit Websuche nur nach dem Admin-Login (`CODEMODE_ADMIN_PASSWORD` in der `.env`); normale Läufe bleiben für alle offen.
- **Nur Agenten suchen.** Die Websuche ist ein Werkzeug der Recherche-Agenten: Sie formulieren ihre Suchanfragen
  selbst, aus der Aufgabe heraus, um sie zu lösen. Es gibt kein Suchfeld für Besucher und keinen Auftrag, der eine
  vorgegebene Suchanfrage ausführt; eine Aufgabe wie „suche im Web nach xyz“ widerspricht dem Sinn der Plattform. Die
  Plattform ist kein Suchdienst: Fundstücke sind immer nur Zwischenschritt für Analyse und Antwort, nie selbst das
  Ergebnis eines Laufs.
- **Budget:** je Lauf in Tokens **und** Dollar; was zuerst erreicht ist, beendet den Lauf. Dazu Obergrenzen für Zahl
  und Tiefe der Aufträge. Läufe von Besuchern (ohne Admin-Login) haben immer ein Token-Budget, höchstens
  `CODEMODE_RUN_BUDGET_TOKENS` (Standard 300 000); alle Besucher-Läufe einer Adresse zusammen höchstens
  `CODEMODE_TOKENS_PER_IP_DAY` Tokens am Tag (Standard 1 000 000, im Speicher des Hubs gezählt).

- **Text-Aufgaben (Stufe 3):** Kriterien sind ein optionales Feld; bleibt es leer, schreibt der Prüfer-Agent sie aus
  der Frage, sichtbar im Block. Drei Agenten prüfen diese Kriterien und stimmen je Kriterium ab (behalten, berichtigen,
  streichen); die Mehrheit entscheidet. Anlass: Im Lauf `#test-text-himmel2` enthielt ein Kriterium einen falschen Fakt.
  Eine Antwort ist angenommen, wenn mindestens zwei Prüfer (nie der Autor) jedes Kriterium als erfüllt bewerten und
  jedes mit einem wörtlichen Zitat aus der Antwort belegen, oder wenn ein Mensch 👍 „Passt“ gibt. Ist im Lauf ein
  anderes Modell als das des Autors, muss mindestens ein zustimmender Prüfer es nutzen (`crossNeeded` an der Antwort);
  ein Prüfauftrag wartet bis zu `CODEMODE_CROSS_WAIT_S` Sekunden (Standard 300) auf einen solchen Agenten.
  Unterbrechen geht auf drei Wegen: 👍 (angenommen, der Lauf endet), 👎 (abgewertet) und ■ (abbrechen); jeweils mit
  optionaler Begründung, die als Notiz an die Agenten geht.
- **Wiederverwendung:** Angenommene Antworten und der beste Code eines Blocks bleiben als `CodeEarlier` im Space,
  länger als die Einträge der Räume (`CODEMODE_EARLIER_DAYS`, Standard 30 Tage, höchstens 1000). Bei einer neuen,
  ähnlichen Aufgabe bekommen die Agenten sie als Material („früher angenommen, prüfe, ob es hier passt“). Eine Annahme
  durch einen Menschen gilt nur im eigenen Raum: Ein 👍 kann jeder geben, es darf die Agenten anderer Räume nicht
  erreichen.

## Stufen (jede einzeln getestet, mit Test-Modellen, eigener Commit)

1. **Auftragsbrett** als neuer Laufmodus neben den Generationen, für Code-Aufgaben: `implement`, `critique`, `revise`,
   `merge`. Der bisherige Modus und seine Tests bleiben unverändert.
2. **Planungsrunde:** `propose` und Bewertung der Vorschläge, bevor implementiert wird.
3. **Text-Aufgaben:** `draft`, `critique`, `revise`, `judge` mit Kriterienliste.
4. **Recherche:** `research` mit Websuche, hinter einem Schalter, mit den Schutzmaßnahmen oben. Umgesetzt (2026-10-20):
   Bei einer neuen Aufgabe recherchiert die Hälfte der Agenten zuerst. Jeder schreibt bis zu drei Suchanfragen selbst,
   der Hub sucht bei DuckDuckGo (`server/search.ts`, nur Suchergebnisse: Titel, URL, Auszug; keine Seite wird
   abgerufen, also kein SSRF), der Agent hält mit Quellenangabe fest, was hilft (`CodeFinding`). Planung, Entwürfe und
   Kritik bekommen die Fundstücke als nicht vertrauenswürdige Daten. Nur mit Admin-Login; Tageslimit
   `CODEMODE_SEARCH_PER_DAY` (Standard 100). Der Abruf läuft über `node:https`: `fetch` sendet Kopfzeilen, auf die
   DuckDuckGo mit einer Bot-Abfrage (HTTP 202) antwortet.
5. **Oberfläche:** Spuren je Rolle, adressierte Kritik, Quellen an den Antworten, Budget-Anzeige.

Die Websuche braucht keine Werkzeugaufrufe des Modells (pi-ai hat keine fertige Werkzeug-Schleife): Der Agent schreibt
seine Suchanfragen als Text, der Hub führt sie aus und gibt die Ergebnisse im nächsten Aufruf zurück. Das funktioniert
mit jedem Modell, auch ohne Unterstützung für Funktionswerkzeuge.

## Dauerhafte Läufe (2026-10-20)

Ein Lauf übersteht einen Neustart des Hubs und läuft danach weiter. Alles, was er weiß, liegt im Space:

- `CodeRun` je aktivem Lauf: Startparameter, Verbrauch, Fortschritt (höchstens sekündlich, unter einer Transaktion
  ersetzt). Beim Start setzt der Hub jeden Lauf mit `CodeRun` fort (`resumeRuns`). Ein Stopp durch einen Menschen
  entfernt `CodeRun` sofort, ein Herunterfahren nicht.
- `BoardState` je Lauf auf dem Auftragsbrett: Phase (Recherche, Planung, Bewertung, Arbeit) und Zähler. Ein
  Phasenwechsel schreibt den neuen Zustand und die Aufträge der neuen Phase in einer Transaktion.
- Übernommene Aufträge: Ein Agent nimmt einen Auftrag und schreibt ihn als übernommen zurück, in einer Transaktion.
  Nach einem Neustart sind übernommene Aufträge wieder offen.
- Folgeaufträge (`followup`): Ein Beitrag hinterlässt einen Auftrag, der auf sein Urteil wartet und dann Kritik oder
  Zusammenführung anlegt. Fehlt das Urteil, stößt er die Bewerter an (nach einem Absturz kommt ein Beitrag erst
  zurück, wenn die Transaktion des alten Bewerters abläuft).
- Generationen: Die abgebrochene Generation läuft nach dem Neustart noch einmal.

Grenze: Modellaufrufe, die beim Neustart gerade liefen, sind verloren und werden wiederholt; das kostet Tokens. Wer
während eines Laufs Dateien in `server/` ändert, startet den Dev-Server neu und bezahlt diese Wiederholungen.

## Korrekturen nach dem Review (2026-10-21)

- **Urteile von nano:** Der Hub holt jedes `CodeScore` von nano sofort in seinen eigenen Space (`imported`), auch
  eines, das nach der Wartezeit von 90 s oder nach einem Neustart des Hubs kommt. Vorher lagen sie nur auf nano: Ein
  spätes Urteil erreichte den besten Code nicht, und jeder Snapshot las bis zu 1000 Urteile samt Code über den Socket.
  Ein Kandidat, den ein Bewerter auf nano gerade hält, wird nicht mehr aufgegeben.
- **Fehlgeschlagene Aufträge:** Ein Auftrag, dessen Modellaufruf scheitert, kommt später noch einmal dran (höchstens
  dreimal). Sind die Modellaufrufe des Tages verbraucht, endet der Lauf als „Budget verbraucht“ statt als „idle“.
- **Lesereihenfolge:** `readAll` liefert die ältesten Einträge zuerst. Fundstücke werden deshalb ganz gelesen und erst
  nach dem Sortieren gekürzt, damit die neuesten die Agenten erreichen.
- **Grenze der Umsetzung:** Phase, Zähler und die Agenten selbst leben weiter im Speicher eines Hub-Prozesses; der
  Space ist Journal und Warteschlange. Nur die Bewerter auf nano arbeiten entkoppelt über den Space.
