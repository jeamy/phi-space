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
- Der Laufzustand (`s.run`) liegt im Speicher: Ein Neustart des Hubs bricht einen Lauf ab.

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
- **Zugriff:** Läufe mit Websuche nur mit `CODEMODE_ADMIN_TOKEN`; normale Läufe bleiben für alle offen.
- **Nur Agenten suchen.** Die Websuche ist ein Werkzeug der Recherche-Agenten: Sie formulieren ihre Suchanfragen
  selbst, aus der Aufgabe heraus, um sie zu lösen. Es gibt kein Suchfeld für Besucher und keinen Auftrag, der eine
  vorgegebene Suchanfrage ausführt; eine Aufgabe wie „suche im Web nach xyz“ widerspricht dem Sinn der Plattform. Die
  Plattform ist kein Suchdienst: Fundstücke sind immer nur Zwischenschritt für Analyse und Antwort, nie selbst das
  Ergebnis eines Laufs.
- **Budget:** je Lauf in Tokens **und** Dollar; was zuerst erreicht ist, beendet den Lauf. Dazu Obergrenzen für Zahl
  und Tiefe der Aufträge.

## Stufen (jede einzeln getestet, mit Test-Modellen, eigener Commit)

1. **Auftragsbrett** als neuer Laufmodus neben den Generationen, für Code-Aufgaben: `implement`, `critique`, `revise`,
   `merge`. Der bisherige Modus und seine Tests bleiben unverändert.
2. **Planungsrunde:** `propose` und Bewertung der Vorschläge, bevor implementiert wird.
3. **Text-Aufgaben:** `draft`, `critique`, `revise`, `judge` mit Kriterienliste.
4. **Recherche:** `research` mit Websuche, hinter einem Schalter, mit den Schutzmaßnahmen oben.
5. **Oberfläche:** Spuren je Rolle, adressierte Kritik, Quellen an den Antworten, Budget-Anzeige.

Werkzeuge (Websuche) laufen über die Funktionswerkzeuge von pi-ai (`tools` im Kontext). Eine fertige Werkzeug-Schleife
hat pi-ai nicht, sie wird im Hub geschrieben. Ob codestral und haiku über den vorhandenen Zugang Werkzeugaufrufe
liefern, klärt eine kurze Probe; die kostet Tokens und läuft nur nach Freigabe.
