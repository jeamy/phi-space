# Codemode-Chat: Architektur um einen gemeinsamen Space (Stand 2026-10-21)

## Zweck und Stand

Der gemeinsame Zustand der Anwendung liegt in einem phi-spaces-Space. Jeder Prozess hat eine Rolle und spricht mit den
anderen nur über `SpaceLike`, lokal über einen Unix-Socket, zwischen Hosts über TCP. Prozesslokale Ressourcen dürfen
neu entstehen; was einen Neustart überstehen muss, steht im Space.

**Umgesetzt bis Stufe 2d** (Commit `4011b0c` und die Korrekturen vom 2026-10-21):

- eigene Prozesse für space, web, judge, agents und model;
- Prüfen in Transaktionen;
- Generationen und Auftragsbrett als Arbeit im Space (`server/run.ts`), mit Recherche, Planungsrunde, Textaufgaben und
  deren Prüfern;
- alle Modellaufrufe im model-Prozess (LlmCall/LlmResult), auch das Anlegen einer Aufgabe (TaskRequest/TaskReady an
  einen agents-Prozess);
- Verbrauch der Besucher als Spend-Einträge;
- Modellwahl des Admins über `CodeAdmin`.

Der web-Prozess ruft keine Modelle mehr auf und fährt keine Läufe. `server/board.ts` ist entfallen.

**Stufe 3, umgesetzt:**
- gemeinsame Zähler für Modellaufrufe und Websuchen (`server/quota.ts`);
- Admin-Sitzungen im Space;
- ▶ im judge-Prozess (`server/exec.ts`).

Die Anfragegrenzen bleiben bewusst je web-Prozess (siehe „Leistung und Deployment“).

**Stufe 4, umgesetzt:** Docker mit einem Container je Rolle, die Profile `nano` und `big` und beide zusammen als lokale
Testumgebung (siehe „Betrieb mit Docker“). Offen sind die Entscheidungen zum Produktivbetrieb (Wiederherstellung,
Aufbewahrung, Kapazität).

Die Garantien unten trennen das heutige Verhalten von nötigen Korrekturen. Daten in den Space zu legen ergibt allein
weder eine genau einmalige Ausführung bei einem externen Anbieter noch einen konsistenten Snapshot noch eine atomare
Budgetprüfung.

## Zustand und prozesslokale Ressourcen

Zum gemeinsamen Zustand gehören:

- Aufgaben, Beiträge, Urteile und Verweise auf das beste Ergebnis;
- Läufe, Arbeitsaufträge und Aufgabenanfragen;
- Verbrauch und die Wahl des Admins.

Prozesslokale Kopien davon müssen sich aus dem Space wiederherstellen lassen und dürfen keine Arbeit selbst freigeben.
Die Sitzung des web-Prozesses liest den aktiven Block bei jedem Zugriff aus dem Space.

Prozesslokal sind:

- offene Sockets und WebSocket-Clients;
- Timer für Snapshots;
- Sandbox-Plätze;
- geladene Modellregister und Zugangsdaten;

Ihr Verlust beim Neustart ist erwartet. Zugangsdaten kommen aus der Konfiguration des Deployments, nie aus dem Space.

Eine lokale Grenze für Nebenläufigkeit oder Anfragen gilt **je Prozess**. Eine Grenze für die ganze Installation braucht
gemeinsame Koordination.

## Prozesse und Verbindungen

Pfade sind relativ zu `codemode-chat/`, soweit nicht anders angegeben.

| Prozess | Datei | Rolle |
|---|---|---|
| space | `server/space-host.ts` | Hält den Space auf SQLite und bietet ihn über `serveSpace` unter `CODEMODE_LISTEN` an. |
| web | `server/index.ts`, `server/hub.ts` | Next.js, REST und WebSocket. Liest Räume, legt Blöcke an, startet und stoppt Läufe (CodeRun), schreibt TaskRequests und ExecRequests und streamt deren Ereignisse. |
| judge | `server/judge-host.ts`, `server/exec.ts` | Nimmt `CodeCandidate` in einer Transaktion, schreibt `CodeScore`, den neuen besten Code und das Archiv in derselben. Führt ▶ aus (`ExecRequest`). |
| agents | `server/agent-host.ts`, `server/run.ts`, `server/task-agent.ts` | Nimmt die Slots der Läufe und arbeitet deren Aufträge ab; erledigt TaskRequests (Prüfregel, Kriterien und deren Prüfung). |
| model | `server/model-host.ts`, `server/context.ts` | Der einzige Prozess, der Modelle aufruft und Zugangsdaten braucht. Baut den Kontext aus dem Space, veröffentlicht `ModelInfo`, wendet `CodeAdmin` an, schreibt `Spend`. |

Clients verbinden sich über `CODEMODE_SPACE`, etwa `unix:/tmp/codemode-space.sock` oder `tcp:host:3800`.

`server/launch.ts` startet standardmäßig alle fünf Rollen; `CODEMODE_ROLES` wählt die Rollen eines Hosts. In
`codemode-chat/` startet `npm run dev` die Entwicklungsprozesse, `npm start` die Produktionsprozesse. Der Launcher
startet den Space zuerst und startet unerwartet beendete Kinder neu.

Jeder Prozess hält einen `Process`-Eintrag mit Rolle, Prozesskennung und Hostdaten (CPU, Speicher; keine Auslastung).
Die Lease beträgt 30 s und wird alle 10 s erneuert; die Systemleiste zeigt daraus die Anwesenheit.

Es darf derzeit nur **einen** model-Prozess geben: jeder ersetzt beim Veröffentlichen den `ModelInfo`-Eintrag des anderen.

## Muster für Transaktionen und Koordination

**Nehmen und veröffentlichen**
- Einen Arbeitseintrag in einer Transaktion nehmen, die Arbeit tun, Ergebnis und Folgeeinträge schreiben, committen.
- Lange Arbeit erneuert die Lease der Transaktion.
- Bricht die Transaktion ab oder läuft sie aus, wird alles zurückgenommen, und der Eintrag ist wieder da, solange er
  selbst noch lebt.

**Externe Wirkung**
- Die Transaktion macht nur die Änderungen im Space atomar. Eine HTTP-Anfrage oder ein bezahlter Modellaufruf lässt sich
  nicht zurücknehmen.
- Nach einem Absturz kann Arbeit erneut laufen. Feste Aufrufkennungen und aufbewahrte Ergebnisse verringern
  Wiederholungen, garantieren aber keine genau einmalige Ausführung beim Anbieter.

**Warten**
- Blockierendes `take`/`read` oder `changes(rev, {waitMs})`.
- Wartezeiten des Servers bleiben unter dem Aufruf-Timeout des Clients (30 s), mit Luft für den Transport.
- Ein Timeout beim Client lässt das Ergebnis offen; er beweist nicht, dass eine Änderung fehlschlug.

**Gesperrte Einträge**
- Normale Lese- und Zählaufrufe sehen keine Einträge, die eine andere Transaktion genommen hat.
- Auch ein Lesen in einer Transaktion hält den Eintrag bis zu deren Ende fest: ein `take` ohne Warten geht daran vorbei.
  Der Judge liest die CodeTask seines Kandidaten so; das Löschen eines Blocks wartet deshalb auf sie (`takeExisting`),
  statt sie zu übergehen.
- `readIfExists`/`takeIfExists` mit `HELD_WAIT_MS` (10 s) warten auf einen gesperrten Treffer, liefern aber auch `null`,
  wenn die Wartezeit abläuft.
- `readExisting` (`server/space.ts`) unterscheidet die beiden Fälle: `null` heißt dann wirklich weg, eine Sperre über die
  Wartezeit hinaus wirft `StillHeld`.
- Der Judge nutzt das für die CodeTask seines Kandidaten: der Kandidat geht zurück, statt ohne Urteil zu verschwinden.
- `readRun` und `blockTask` nutzen es auch.
  - Ein Agent, dessen Lauf länger gesperrt ist, wartet weiter, statt seinen Slot aufzugeben.
  - Ein Auftrag, der daran hängt, geht ohne Fehlversuch zurück.
- Im Hub nutzen `#runNow`, Stop und 👍 es ebenfalls.

**Sperreinträge**
- Ein gemeinsamer Lock entsteht, wenn ein Eintrag in einer Transaktion genommen und mit den geschützten Änderungen
  zurückgeschrieben wird. Alle Schreiber müssen dasselbe Protokoll und dieselbe Reihenfolge einhalten.
- `CodeRun` ist der Lock eines Laufs, `CodeBest` der des besten Codes eines Blocks.
- `RoomLock` (`unique` je Raum) ist der Lock der Blöcke eines Raums und des Laufstarts.
  - `#exclusive` im Hub nimmt ihn in einer erneuerten Transaktion, führt die Operation aus und schreibt ihn zurück.
  - Ein anderer web-Prozess wartet bis zu 60 s darauf.
  - Die Schreibvorgänge der Operation liegen außerhalb der Transaktion des Locks: er serialisiert, macht die Operation
    aber nicht atomar.

**Eindeutigkeit**
- `unique`, etwa auf `CodeRun.session` oder `LlmCall.callId`, verhindert widersprüchliche Schreibvorgänge, auch in offenen
  Transaktionen.
- Es schützt Einträge, nicht beliebige mehrstufige Geschäftsregeln oder Wirkungen beim Anbieter.

**Verbrauch**
- Abgeschlossene Aufrufe bekommen eigene Verbrauchseinträge (Spend). Ein beim Abschluss verbrauchter Anfrageeintrag
  taugt nicht als Zähler.
- Erst zählen und dann starten ist keine atomare Zulassung.

**Kennungen:** Kennungen sind über Prozesse hinweg kollisionsfest (Zufallsanteil). Logische Aufrufkennungen bleiben über
Wiederholungen stabil.

Ein wartendes `take` bleibt im Space, auch wenn der Client die Verbindung verliert oder der Space neu startet, bis seine
Frist oder seine Transaktion endet. Ein geordnetes Herunterfahren bricht offene Transaktionen ab, damit verwaiste Wartende
keine spätere Arbeit nehmen. Nach einem harten Absturz hilft nur der Ablauf der Lease.

## Läufe

`server/run.ts` und `server/agent-host.ts` setzen beide Laufarten mit diesen Einträgen um:

| Eintrag | Zweck |
|---|---|
| `CodeRun` | Der aktive Lauf eines Raums (`unique` je Raum): Parameter, angezeigte Info, Fortschritt je Generation oder Zustand des Bretts (`board`: Phase, offene Aufträge der Phase, Zähler, Verbesserungsrunden, zusammengeführte Paare, Obergrenze erreicht) und die Zahl der offenen Aufträge (`pending`). Zugleich der Lock des Laufs. |
| `AgentSlot` | Ein Slot je Agent; ein agents-Prozess hält ihn in einer erneuerten Transaktion, solange er als dieser Agent arbeitet. |
| `WorkItem` | Ein Auftrag: Zug (`turn`) und Barriere (`barrier`) bei Generationen; Recherche, Vorschlag, Abstimmung, Umsetzung, Kritik, Überarbeitung, Zusammenführung, Prüfung und Folgeauftrag auf dem Brett. Mit Fälligkeit, Versuchen und Frist. |
| `AgentBusy` | Nur noch für Läufe von vor `pending`: ein getrennt geleaster Marker, geschrieben bevor ein Agent einen Auftrag nimmt. |
| `CodeRunDone` | Wie der letzte Lauf eines Raums endete. |

**Ablauf eines Auftrags.** Eine Transaktion nimmt den Auftrag, fragt den model-Prozess, schreibt das Ergebnis, ändert
`CodeRun` und schreibt die Folgeaufträge. Den Phasenwechsel des Bretts macht, wer den letzten Auftrag einer Phase
erledigt, in derselben Transaktion. Hat der Lauf sein Budget verbraucht, öffnet das Brett keine neue Phase mehr, und die
offenen Aufträge laufen leer aus.

**Laufende.**
- `pending` zählt die geschriebenen, noch nicht erledigten Aufträge. Es ändert sich in denselben Commits, die Aufträge
  schreiben und abschließen; ein wartender Auftrag, der zurückgeht, bleibt gezählt.
- Ein Agent, der nichts mehr findet, beendet den Lauf unter dessen Lock, wenn `pending` 0 ist und kein Auftrag sichtbar
  ist. Ein Auftrag, den ein anderer Agent gerade hält, zählt also mit.
- Busy-Marker braucht es dafür nicht; ein wartender Agent schreibt keine mehr.
- Läufe von vor `pending` enden wie bisher: kein sichtbarer Auftrag, kein Busy-Marker.
- Scheitert eine Barriere dreimal, endet der Lauf mit einem Vermerk in seiner Info.

**Barriere.** Sie wartet, bis alle Züge ihrer Generation erledigt und alle abgegebenen Beiträge beurteilt sind, und öffnet
dann die nächste Generation.
- Sie schaut nach 2 und dann alle 4 s wieder nach; jedes Nachsehen ist ein Commit.
- Sind alle Züge erledigt, wartet sie auf die Urteile höchstens `CODEMODE_VERDICT_WAIT_S`. Ohne diese Variable ist das
  die Höchstzeit eines Judges plus 150 s, bei Textantworten 10 min.
- Danach geht sie ohne die fehlenden Urteile weiter und vermerkt das in der Info des Laufs, etwa wenn kein judge-Prozess
  läuft oder ein Urteil verloren ging.
- Der Folgeauftrag eines Beitrags auf dem Brett hat dieselbe Frist.

**Obergrenze und Tiefe.** Das Brett nimmt höchstens `max(12, Agenten × Generationen × 4)` Aufträge und folgt höchstens 12
Ebenen tief. Prüfer und Folgeauftrag eines abgegebenen Beitrags sind von der Obergrenze ausgenommen: sie sind durch den
Beitrag begrenzt (zwei Prüfer, ein Folgeauftrag), und ohne sie bliebe eine bezahlte Antwort unbeurteilt.

**Judge und Sandbox.** Die Sandbox hält den Thread des Judges, solange ein Fall läuft; in dieser Zeit erneuert er nichts.
Seine Lease ist deshalb standardmäßig die höchste Zeitgrenze einer Aufgabe (`CODEMODE_MAX_TIMEOUT_S`) plus 30 s.

**Leases und Slots.** Die Leases von Slot und Auftrag betragen standardmäßig 60 s (`CODEMODE_AGENT_LEASE_MS`). Ein
agents-Prozess hat bis zu 16 aktive Slots (`CODEMODE_AGENT_SLOTS`). Das ist eine Grenze je Prozess.

Aufträge mit `onlyBy` (Züge, die Eröffnungsaufträge des Bretts) warten auf den Slot ihres Agenten. Übersteigen die Agenten
aller Läufe die Slots aller agents-Prozesse, bleiben solche Aufträge liegen. Die Seite sagt nach 15 s im Vermerk des Laufs,
wie viele Agenten auf einen Slot warten.

**Fehler eines Auftrags.**
- Ein abgefangener Fehler erlaubt **drei Versuche insgesamt**, jeweils mit einer neuen Aufrufkennung.
- Danach zählt der Auftrag als erledigt, ohne abzugeben.
- Ist das Tagesbudget der Modelle verbraucht, endet der Lauf als „Budget verbraucht“.
- Harte Abstürze während eines Modellaufrufs zählen über `ItemStart`: nach zwei wird der Auftrag aufgegeben.

## Modellaufrufe, Kontext und Budgets

**Aufruf durch einen Agenten.** Ein Agent schreibt `LlmCall` außerhalb seiner Transaktion, mit einer festen `callId` aus
Auftrag und Versuch und `unique` darauf. Das `LlmResult` nimmt er in seiner Transaktion, in Schritten von höchstens 20 s,
insgesamt höchstens `CODEMODE_MODEL_WAIT_S` (Standard 600 s). Bricht die Transaktion ab, bleibt das Ergebnis für den
nächsten Versuch liegen. Gibt der Agent das Warten auf, nimmt er seinen noch nicht abgeholten `LlmCall` zurück, damit
niemand eine Antwort bezahlt, die keiner abholt.

**Ausführung im model-Prozess.**
- Er nimmt `LlmCall` in einer Transaktion (Lease 120 s, erneuert), baut den Kontext mit `server/context.ts`, ruft das
  Modell und schreibt `LlmResult` (aufbewahrt 10 min).
- Für einen Besucher schreibt er im selben Commit einen `Spend`-Eintrag mit Tageskennung (aufbewahrt 26 h).
- Anfragen leben so lange wie die Wartezeit plus 60 s.

**Doppelte Kosten.** Das vermeidet viele doppelte Aufrufe, garantiert aber nicht, dass eine Wiederholung nichts kostet: ein
Anbieter kann einen Aufruf abschließen und berechnen, bevor der model-Prozess abstürzt, ohne sein Ergebnis zu committen.
Dafür braucht es Idempotenz beim Anbieter oder eine ausdrückliche Regel für ungewisse Ergebnisse.

**Kontext einer Generation.** Rolle und Ziel eines Zugs werden beim Öffnen der Generation festgelegt. Den übrigen Kontext
(Versuche, Notizen, abgelehnte Beiträge, bestes Ergebnis) liest der model-Prozess erst beim Aufruf. Agenten derselben
Generation können also verschiedenen Kontext sehen. Gleicher Startkontext für alle bräuchte einen unveränderlichen
Generationskontext oder versionierte Verweise.

**Modellinfo und Admin.** `ModelInfo` veröffentlicht die verfügbaren Modelle, `CodeAdmin` die Wahl und den Schalter des
Admins. Der model-Prozess liest beides alle 10 s und vor jedem echten Aufruf. Das ist keine harte Garantie für 10 s bei
Störungen.

**Aufgabe anlegen.**
- Der web-Prozess schreibt einen `TaskRequest` mit Frist (`CODEMODE_MODEL_WAIT_S`, für alle Aufrufe zusammen) und den
  Daten des Aufrufers.
- Ein agents-Prozess, der bis zu zwei Anfragen gleichzeitig bearbeitet, fragt nach der Frist kein Modell mehr und
  antwortet mit dem, was er hat. Kriterien bleiben dann ungeprüft, eine Prüfregel entfällt.
- Der web-Prozess wartet bis zur Frist plus 60 s.
- Die Aufrufe eines Besuchers zählen gegen sein Tagesbudget. Ist es verbraucht, lehnt der web-Prozess die Aufgabe vor dem
  ersten Aufruf ab.

**Verbrauch buchen.**
- `metered` (`server/llm.ts`) zählt im model-Prozess jeden bezahlten Aufruf, auch wenn die Arbeit danach scheitert: eine
  leere Antwort, Code, den `sourceProblem` ablehnt, eine Recherche ohne Treffer nach der ersten Anfrage.
- Ein `LlmResult` trägt diesen Verbrauch auch bei einem Fehler.
- Der Agent bucht ihn auf den Lauf im Commit, der das `LlmResult` nimmt, ob erfolgreich oder nicht. So wird jeder Aufruf
  genau einmal gebucht, auch über Abbrüche und Wiederholungen.
- Für einen Besucher schreibt der model-Prozess `Spend`, sobald Verbrauch anfiel; Anlegen einer Aufgabe eingeschlossen.
- Die Kostenanzeige eines Blocks enthält Beiträge, Recherche, Kritiken, Vorschläge, Stimmen, Urteile (aktiver Block) und
  die Arbeit des Prüfer-Agenten.

**Laufbudget: Zulassung vor dem Aufruf.**
- Vor jedem Modellaufruf eines Auftrags (`ask` in `run.ts`) prüft eine eigene, sofort committete Transaktion unter dem
  Lock des Laufs: gebuchter Verbrauch plus die Reservierungen der laufenden Aufrufe muss unter dem Budget liegen (Tokens
  und Dollar).
- Dann reserviert der Aufruf seine Schätzung in `CodeRun.reserved`, geführt je Auftrag. Die Schätzung ist der
  Durchschnitt der bisher gebuchten Aufrufe des Laufs, vor dem ersten 4000 Tokens und keine Dollar.
- Jede Buchung des Auftrags gibt seine Reservierung frei. Ein Auftrag, der nach einem Absturz zurückkommt, findet seine
  Reservierung wieder und geht ohne neue.
- Reicht das Budget nicht, weil andere Aufrufe laufen, wartet der Auftrag 2 s; das zählt nicht als Fehlversuch. Erreicht
  der gebuchte Verbrauch allein das Budget, endet der Lauf als „Budget verbraucht“.
- Überschreitung: höchstens die Schätzung eines Aufrufs plus deren Fehler. Ohne Budget (Admin ohne Grenze) entfällt die
  Zulassung.

**Grenzen, wie sie heute gelten (festgelegt am 2026-10-21):**
- *Laufbudget:* hart bis auf die genannte Überschreitung, für den ganzen Lauf über alle Prozesse.
- *Tagesbudget einer Adresse* (`CODEMODE_TOKENS_PER_IP_DAY`):
  - weich. Der model-Prozess prüft die `Spend`-Summe vor dem Aufruf, ohne zu reservieren.
  - Überschreitung höchstens um die Aufrufe, die gleichzeitig laufen (`CODEMODE_MODEL_PARALLEL` × model-Prozesse).
  - Ein Tag ist der UTC-Kalendertag (`today()`).
- *Aufrufe je Minute und Tag* (`CODEMODE_LLM_PER_MIN`, `CODEMODE_LLM_PER_DAY`): hart und gemeinsam für alle
  model-Prozesse.
  - `takeQuota` (`server/quota.ts`) lässt je Grenze eine Nutzung nach der anderen zu, unter einem `QuotaLock`.
  - Jede zugelassene Nutzung ist ein `QuotaUse`-Eintrag, gezählt je Minute und je UTC-Tag in derselben Transaktion.
  - Eine volle Minute wartet auf die nächste, ein voller Tag ist ein Fehler („daily model budget used up“).
  - Gezählt wird vor dem Aufruf; ein Aufruf, der dann scheitert, zählt mit.
- *Websuchen je Tag* (`CODEMODE_SEARCH_PER_DAY`): ebenso, als gemeinsamer Zähler über alle model-Prozesse und Neustarts.
- *Admin-Sitzungen:*
  - Sie sind `AdminSession`-Einträge mit der Lebensdauer der Sitzung (12 h).
  - Der Eintrag enthält den SHA-256 des Cookies, nicht das Cookie.
  - Jeder web-Prozess erkennt sie, ein Neustart behält sie, ein Logout beendet sie überall.

**Offen:**
- Ungewisse Kosten nach einem Absturz: Stirbt der model-Prozess nach der Antwort des Anbieters und vor seinem Commit,
  wird der Aufruf wiederholt und doppelt bezahlt, aber nur einmal gebucht. Dafür bräuchte es Idempotenz beim Anbieter.

## Interaktives Ausführen (▶)

- **web-Prozess:**
  - Er schreibt eine `ExecRequest` (Raum, Beitrag, optionaler Aufruf).
  - Er nimmt die `ExecEvent`-Einträge des Laufs in der Reihenfolge ihrer Nummer und streamt sie als NDJSON.
  - Schließt die Seite die Anfrage (Stop), schreibt er `ExecStop`.
  - Ein ▶ zur Zeit je Adresse zählt er lokal.
- **judge-Prozess:**
  - Er nimmt Anfragen in einer eigenen Schleife, wenn einer seiner zwei Runner frei ist; die Prüfungen laufen getrennt
    davon.
  - Code und Aufgabe liest er selbst aus dem Space (`execTarget` in `room.ts`): Quelltext und große Fälle passen zusammen
    nicht in einen Eintrag.
  - Die Ereignisse schreibt er gebündelt alle 100 ms, oder früher ab 32 KiB.
  - `ExecStop` bricht den Lauf ab. Solange er läuft, hält er einen `ExecRun`-Eintrag.
- **Kein Judge:** Nimmt keiner die Anfrage in 10 s, zieht der web-Prozess sie zurück und antwortet mit 503.
- **Judge verstummt:** Bleiben die Ereignisse aus, endet der Stream nach der Höchstdauer eines Laufs plus 30 s mit einem
  Fehler.
- **Kein Wiederanlauf:** Ein Lauf, dessen Judge stirbt, wird nicht wiederholt; er ist interaktiv und bewertet nichts.

## Snapshots, Aufbewahrung und Wiederherstellung

Der web-Prozess folgt `changes` per Long-Poll und schickt entprellte Snapshots.

- **Lesen:** Ein Snapshot besteht aus mehreren typisierten, begrenzten Lesevorgängen. Er begrenzt den mitgeschickten
  Quelltext, der Rest wird je Beitrag nachgeladen.
- **Konsistenz:** Diese Lesevorgänge bilden keinen atomaren Snapshot, ein gleichzeitiger Commit kann eine gemischte
  Ansicht ergeben. Dass der Lauf vor den Nachrichten gelesen wird, hilft der normalen Anzeige des Laufendes, ergibt aber
  keine allgemeine Konsistenz.
- **Entscheidung offen:** Für die Oberfläche ausdrücklich „schließlich konsistent mit erneutem Abruf“ wählen oder ein
  Leseprotokoll bauen, das eine Revision festhält. Vor weiterer Optimierung Bytes, Anzahl der Abfragen und Latenz über TCP
  messen.

Einträge eines Raums leben standardmäßig 24 h (`CODEMODE_TTL_HOURS`); 0 behält sie bis zum Löschen. Ablauf einzelner
Einträge ist nicht dasselbe wie Inaktivität des Raums: Aufgaben, Urteile, Verweise auf das beste Ergebnis und die Arbeit
eines Laufs können zu verschiedenen Zeiten ablaufen.

| Ausfall | Grenze der Wiederherstellung heute |
|---|---|
| Absturz eines Arbeitsprozesses | Nicht committete Übernahmen kommen nach Ablauf der Transaktion zurück; ein anderer Prozess macht weiter, solange die nötigen Einträge bestehen. Externe Arbeit kann sich wiederholen. |
| Neustart des Space mit intakter SQLite-Datei | Der Zustand wird wieder geöffnet; Clients verbinden sich neu, Leases und Fristen bestimmen, was verfügbar bleibt. Läufe gehen weiter (getestet). |
| Space-Host nicht erreichbar | Alle Rollen hängen am selben Space und können nichts Gemeinsames tun. |
| Verlust des Speichers oder Ausfall länger als die Aufbewahrung | Transaktionen allein stellen verlorenen oder abgelaufenen Zustand nicht wieder her; es braucht Backup, Restore und eine Aufbewahrungsregel. |

Vor dem Produktivbetrieb festlegen:

- welche Unterbrechungsdauer unterstützt wird; davon hängt ab, wie lange Abhängigkeiten aktiver Läufe und Einträge zur
  Deduplizierung aufbewahrt werden;
- wie mit Verweisen umgegangen wird, deren Ziel abgelaufen ist;
- wie verwaiste Anfragen aufgeräumt werden.

Hochverfügbarkeit des Space selbst ergibt sich nicht aus der Aufteilung in Prozesse.

## Offene Korrekturen

**1. Budgets:** siehe „Grenzen, wie sie heute gelten“ und „Offen“ oben.

**2. Laufende Modellaufrufe bei Stop.** Ein Aufruf, den der model-Prozess beim Stop schon ausführt, läuft zu Ende und wird
bezahlt; sein Ergebnis holt niemand ab. Abbrechen ließe er sich nur mit einem Abbruchsignal an den Anbieter.

**3. Mehrere model-Prozesse** ersetzen sich gegenseitig den `ModelInfo`-Eintrag; mehr als einer geht derzeit nicht.

**Erledigt am 2026-10-21:**
- Harte Abstürze zählen:
  - Ein Judge hinterlässt beim Sterben während der Prüfung einen `JudgeStart`-Marker. Nach zwei solchen bekommt der
    Kandidat ein gescheitertes Urteil.
  - Ein Agent hinterlässt `ItemStart` während eines Modellaufrufs. Nach zwei solchen wird der Auftrag aufgegeben.
  - Ein geordnetes Ende entfernt die Marker.
- Der `CodeJudging`-Marker wird erneuert, solange der Judge prüft.
- Agenten ohne freien Slot zeigt die Seite nach 15 s im Vermerk des Laufs an.
- Verbrauch eines erfolgreichen Aufrufs, dessen Auftrag danach an etwas anderem scheitert, wird mit dem Fehlschlag gebucht.
- Laufende aus dauerhaftem Fortschritt (`pending`).
- Abgelaufenes Warten gilt nicht mehr als „weg“ (`readExisting`/`takeExisting`).
- Aufräumen beim Stop:
  - Ein Auftrag, der nach dem Ende seines Laufs zurückkommt, wird entfernt.
  - Der model-Prozess führt keinen Aufruf eines beendeten Laufs mehr aus.
- Keine Busy-Marker im Leerlauf.

## Migrationskarte

| Bereich | Stand / was bleibt | Stufe |
|---|---|---|
| Aktiver Block im Hub | Wird bei jedem Zugriff aus dem Space gelesen. | 2d ✓ |
| Bester Code | `CodeBest` verweist auf ein Urteil; Neuberechnung nach Veto unter dem `CodeBest`-Lock. | 2a ✓ |
| Antwort einer Textaufgabe | Abgeleitet aus `TextAnswer`, `TextJudgement` und `CodeAccept`. | 2d ✓ |
| Läufe, Stop, Parameter | `CodeRun`; Generationen und Brett im agents-Prozess. | 2b–2d ✓ |
| Laufende und Fehler | Fristen für Urteile; Ende aus `pending` unter dem Lock des Laufs; Stop räumt auf. | 2d ✓ |
| Aufgabe anlegen | `TaskRequest`/`TaskReady` mit Frist und Daten des Aufrufers. | 2d ✓ |
| Raumsperre | `RoomLock` im Space; `#exclusive` nimmt ihn. | 2d ✓ |
| Modellwahl des Admins | `CodeAdmin`; der model-Prozess ist der einzige Aufrufer. | 2c ✓ |
| Grenzen je Minute und Tag | `QuotaLock`/`QuotaUse`, gemeinsam für alle model-Prozesse. | 3 ✓ |
| Verbrauch der Besucher | `Spend`; weich (siehe „Grenzen, wie sie heute gelten“). | 3 ✓ (weich) |
| Tageszähler der Suche | Gemeinsamer Zähler (`QuotaUse`, Schlüssel `search`). | 3 ✓ |
| Admin-Sitzungen | `AdminSession`-Einträge mit Lease. | 3 ✓ |
| HTTP- und Raumgrenzen | Bewusst je web-Prozess (Schutz der Verbindung, kein Kontingent). | 3 ✓ |
| Interaktives Ausführen (▶) | Judge nimmt `ExecRequest`, schreibt geordnete `ExecEvent`s; web folgt, `ExecRun` verfolgt. | 3 ✓ |
| WebSocket-Clients, Push-Timer | Bleiben prozesslokal. | — |
| Docker | Ein Dienst je Rolle, Skripte, Hilfe, README; Profile `nano`/`big`, lokale Testumgebung. | 4 ✓ |

## Leistung und Deployment

- **Lokale und globale Grenzen.**
  - Die Anfragegrenzen bleiben bewusst je web-Prozess: die Anfragen je Minute und Adresse (`CODEMODE_REQ_PER_MIN`), die
    Login-Versuche, die Grenzen je Raum (Läufe, Aufgaben, Hinweise und Ähnliches je Minute) und ein ▶ zur Zeit je Adresse.
  - Sie schützen den Prozess und seine Verbindung, sie sind kein Kontingent. Mehr web-Prozesse erhöhen ihre Summe.
  - Was Geld kostet, ist gemeinsam begrenzt: Modellaufrufe, Websuchen, Lauf- und Tagesbudget.
- **Gleicher Peer.** Alle Prozesse verbinden sich als derselbe Peer. Der Host hebt dafür die Grenzen je Eigentümer
  (Transaktionen, Wartende, Registrierungen) an. Für den Produktivbetrieb Kapazität und Trennung der Rollen festlegen.
- **Größengrenzen.** 64 KiB je Eintrag und 192 KiB je Commit gelten weiter. Quelltext ist zusätzlich auf 40 kB als JSON
  begrenzt. Die ganze Transaktion budgetieren, mit Urteil und Archiv, nicht nur den Quelltext.
- **Platzierung.** Space auf nano und die meiste Rechenarbeit auf big ist ein Vorschlag. Judge-Platzierung, Dienste je
  Rolle, Neustartregeln, Speicher und Wiederherstellung werden in Stufe 4 entschieden.

## Betrieb mit Docker

Ein Image (`codemode-chat/docker/Dockerfile`, Ziel `production`) enthält alle Rollen; ohne Befehl startet es alle in einem
Container (`server/launch.ts`). `docker/docker-compose.yml` startet stattdessen einen Container je Rolle.

| Profil | Container | Rechner |
|---|---|---|
| `nano` | `space` (SQLite im Volume `codemode-space-data`, TCP 3800), `judge-nano` | nano: hält den Zustand |
| `big` | `web` (3700), `judge-big`, `agents`, `model` (als einziger mit Zugangsdaten) | big: macht die meiste Arbeit |
| `dev` | `codemode-chat-dev`: alle Rollen in einem Container, Quellen eingebunden, Neustart bei Änderungen | Entwicklung |
| `test` | `codemode-chat-test`: die Testsuite | — |

Die Rollen sprechen nur über den Space miteinander, per TCP. Auf zwei Rechnern setzt big `CODEMODE_SPACE=tcp:<nano>:3800`,
und nano veröffentlicht den Space auf seiner internen Adresse (`CODEMODE_SPACE_BIND`). Der Socket hat kein TLS und behandelt
jede Verbindung als Prozess des Chats: nie auf einer öffentlichen Schnittstelle.

Skripte in `codemode-chat/package.json`: `docker:nano:*`, `docker:big:*`, `docker:prod:*` (beide Profile auf einem
Rechner), `docker:local:*`, `docker:dev:*`, `docker:test`.

**Lokale Testumgebung big/nano auf einem Rechner:**
- `npm --prefix codemode-chat run docker:local:up` startet beide Profile unter dem Projektnamen
  `phi-spaces-codemode-local`: web auf Port 3710, Space nur auf 127.0.0.1:3810.
- Alle Rollen sprechen über TCP im Docker-Netz mit dem Space, genau wie zwischen den echten Rechnern.
- Die Systemleiste zeigt die Rechner „big“ und „nano“; die Container von nano bekommen 2 CPUs (`NANO_CPUS`).
- Damit lassen sich Ausfälle durchspielen: `docker restart` des Space (der Zustand von nano), `docker kill` eines Judges oder
  des agents-Prozesses.
- Netzlatenz zwischen den beiden simuliert sie nicht.
- Geprüft am 2026-10-21:
  - Ein Skript-Lauf mit 3 Agenten wurde von Judges beider Seiten beurteilt (4 Urteile von big, 2 von nano).
  - Nach einem Neustart des Space-Containers waren alle Beiträge noch da, die Prozesse verbanden sich selbst wieder, und
    ein neuer Beitrag wurde beurteilt.

## Stufen und Verlauf

Jede Stufe soll die Anwendung lauffähig halten, getestet und einzeln committet sein. Pushes nur nach Rückfrage.

1. **Ein Space, eigene Prozesse für space, judge und web: umgesetzt.**
   - `space-host.ts`, `judge-host.ts`, `launch.ts`, `space.ts` und das transaktionale Ergebnis/Archiv in `results.ts`.
   - `CodeJudging` hält einen Beitrag sichtbar, solange sein Kandidat genommen ist.
2. **Läufe und Agenten im Space: umgesetzt.**
   - 2a: Aufgabendaten raus aus den Kandidaten, Quelltext raus aus `CodeBest`.
   - 2b: Generationen, Slots und Barrieren.
   - 2c: der model-Prozess.
   - 2d: Brett, Text, Recherche und das Anlegen von Aufgaben im agents- und model-Prozess.
   - Korrekturen vom 2026-10-21: Frist der Barriere, Urteile ohne gespeichertes Ergebnis zählen für den Lauf, gesperrte
     CodeTask beim Judge, Prüfer jenseits der Obergrenze, Budget und Frist beim Anlegen einer Aufgabe, Rücknahme
     aufgegebener Aufrufe.
   - Weitere Korrekturen vom 2026-10-21:
     - Laufende aus `pending`;
     - Sperren über die Wartezeit hinaus gelten nicht als Löschung;
     - Stop räumt Aufträge und wartende Aufrufe ab.
   - Raumsperre über den Space (`RoomLock`).
   - Offen bleiben die Korrekturen oben.
3. **Grenzen, Sitzungen und interaktives Ausführen: umgesetzt.** Gemeinsame Zähler, Admin-Sitzungen und ▶ im
   judge-Prozess.
4. **Betrieb: teilweise umgesetzt.** Docker je Rolle, Profile `nano`/`big`, lokale Testumgebung, systemd-Beispiel mit
   `launch.ts`. Offen: Neustartregeln über `restart: unless-stopped` hinaus, Backup und Restore des Volumes,
   Aufbewahrungsfristen, Kapazität je Rolle.

Hinweise aus der Migration:

- Ein geordnetes Herunterfahren muss offene Transaktionen abbrechen, auch wartende `take`s; die Verbindung zu trennen reicht
  nicht.
- Der Socket-Fehler „ahead of this stream“ enthält keine Revision; erfolgreiche Lesevorgänge des Änderungsstroms liefern
  die aktuelle.
- Tests starten Space und Arbeitsprozesse mit `tests/stack.ts`. Fake-Modellteams kommen aus `tests/fakes.ts` über
  `CODEMODE_LLM_MODULE`, nur mit `CODEMODE_TEST=1`. `FakeCall` hält den gesehenen Kontext fest, `FakeGate` kann einen
  Aufruf anhalten.
- Diese Tests beweisen keine genau einmalige Ausführung bei einem echten Anbieter.

## Prüfprioritäten

Getestet sind:

- Neustart aller Prozesse während eines Laufs (Brett und Generationen);
- gestoppter Lauf über einen Neustart;
- Tod eines judge- oder agents-Prozesses;
- Fehlversuche und verbrauchtes Tagesbudget;
- Barriere ohne Urteile;
- Obergrenze des Bretts;
- Budget und Frist beim Anlegen einer Aufgabe;
- ein `CodeRun`, das länger als `HELD_WAIT_MS` gesperrt bleibt: alle Agenten bleiben, der Lauf endet einmal;
- Stop, während Aufrufe laufen und warten: keine Aufträge bleiben zurück, der wartende Aufruf wird nicht gemacht;
- abgelehnte Ausgaben buchen ihren Verbrauch auf den Lauf und auf die Adresse;
- überlappende Agenten überschreiten das Laufbudget nicht;
- eine Operation wartet, solange ein anderer Prozess den Lock des Raums hält;
- ein Kandidat nach zwei toten Judges, ein Auftrag nach zwei toten agents-Prozessen (Marker vorgegeben);
- der Prüf-Marker überdauert seine erste Lease;
- Agenten ohne Slot werden angezeigt;
- ein gemeinsamer Zähler lässt bei gleichzeitigen Anfragen aus drei Clients genau seine Nutzungen zu;
- eine Admin-Sitzung gilt in einem zweiten web-Prozess und endet dort mit dem Logout;
- ▶ läuft im judge-Prozess, Stop beendet ihn dort, ohne Judge kommt 503.

Der frühere Fall „Busy-Marker läuft ab, während seine Transaktion lebt“ entfällt mit `pending`.

Noch ohne Test, jeweils mit der zugehörigen Korrektur einzuführen:

- Ein Anbieter antwortet, bevor der Prozess ohne Commit stirbt; Wiederholung und ungewisse Kosten folgen der festgelegten
  Regel.
- Wiederherstellung nahe an den Aufbewahrungsfristen.
- Mehrere web-Prozesse ändern denselben Raum gleichzeitig mit echten Operationen (der Test hält den Lock nur von außen).

Standardprüfungen: im Wurzelverzeichnis `npm run typecheck` und `npm test`, für die Anwendung zusätzlich
`npm --prefix codemode-chat run typecheck` und `npm run test:codemode-chat`.
