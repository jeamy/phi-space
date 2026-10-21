# Codemode-Chat: alles im Space (Architektur, 2026-10-21)

Grundsatz: **Alles ist Space.** Prozesse reden nur über einen Space miteinander. Kein Prozess hält Zustand, den ein
anderer braucht oder der einen Neustart überleben muss; jeder Prozess kapselt eine Rolle und kennt nur einen
`SpaceLike` (lokal über den Unix-Socket, in Produktion über TCP). Fällt ein Prozess aus, laufen seine Transaktionen und
Leases ab, die Arbeit erscheint wieder im Space, und ein anderer Prozess derselben Rolle übernimmt.

## Was als Zustand gilt und was nicht

Zustand ist alles, was eine Entscheidung trägt oder einen Neustart überleben muss: Aufgaben, Beiträge, Urteile, der
beste Code, Läufe, Aufträge, Verbrauch, Grenzen, Anmeldungen. Das liegt im Space.

**Kein Zustand** sind Betriebsmittel eines Prozesses, die mit ihm entstehen und vergehen: offene Sockets und
WebSocket-Clients, Entprell-Timer für das Senden von Snapshots, Sandbox-Plätze eines Prozesses, die geladene
Modell-Registry samt Zugangsdaten. Sie bleiben im Prozess.

## Prozesse

| Prozess | Datei | Rolle |
|---|---|---|
| space | `server/space-host.ts` | trägt den einen Space (SQLite), stellt ihn über `serveSpace` bereit (`CODEMODE_LISTEN`) |
| web | `server/index.ts` | Next.js, REST, WebSocket; liest Räume aus dem Space, schreibt Befehle hinein |
| judge | `server/judge-host.ts` | nimmt `CodeCandidate` in einer Transaktion, schreibt `CodeScore` (und `CodeBest`) in derselben |
| agents | `server/agent-host.ts` | übernimmt Agentenplätze eines Laufs, arbeitet Aufträge ab, schreibt Aufgaben-Prüfregeln und Kriterien |
| model | `server/model-host.ts` | führt jeden Modellaufruf aus (einziger Prozess mit Zugangsdaten), hält die Grenzen im Space |

Alle anderen Prozesse verbinden sich über `CODEMODE_SPACE` (`unix:/tmp/codemode-space.sock` oder `tcp:host:3800`).
Jeder Prozess meldet sich mit einem `Process`-Eintrag (Rolle, Host, CPU, Speicher), dessen Lease er alle 10 s
verlängert; die Systemleiste zeigt, was läuft. Lokal startet `npm run dev` / `npm start` alle Prozesse (wie
`swarm-shards.sh` im help-site). Wo welcher Prozess in Produktion läuft (big, nano), ist nur Konfiguration und wird in
Stufe 4 mit dir festgelegt.

## Muster

- **Arbeit nehmen:** `take` in einer Transaktion. Lange Arbeit (ein Modellaufruf, eine Bewertung) verlängert die
  Lease der Transaktion; das Ergebnis wird in derselben Transaktion geschrieben, dann `commit`. Ein Absturz rollt alles
  zurück, der Auftrag erscheint wieder: genau einmal, ohne „schon erledigt?“-Prüfungen.
- **Warten:** blockierendes `take`/`read` mit Timeout, oder `changes(rev, {waitMs})` als Long-Poll. Wartezeiten
  bleiben unter dem Aufruf-Timeout des Clients (gemessen: ein Warten länger als `callTimeoutMs` scheitert als
  „outcome unknown“).
- **Sperren:** ein Eintrag als Mutex: `take` in einer Transaktion, prüfen, schreiben, zurückschreiben, `commit`
  (z. B. `CodeRoom` für Aufgabe, Lauf und Löschen eines Raums).
- **Genau einer:** `unique` beim Schreiben (z. B. höchstens ein `CodeRun` je Raum), wirkt auch gegen offene
  Transaktionen.
- **Zähler mit Ablauf:** je Ereignis ein Eintrag mit Lease (Modellaufrufe je Minute und Tag, Websuchen); gezählt wird
  mit `count`.
- **Ids:** zufällig (Kollisionen zwischen Prozessen), passend zu den Mustern der API.

## Bestandsaufnahme: Zustand im Speicher heute

| Ort | Zustand | wird zu | Stufe |
|---|---|---|---|
| hub `Session` | `task`, `blockId` | neuester `CodeTask` des Raums | 2 |
| | `best` | `CodeBest`, vom Bewerter in seiner Transaktion gepflegt | 1 |
| | `answer` | aus `TextAnswer`, `TextJudgement`, `CodeAccept` abgeleitet | 2 |
| | `run`, `abort`, `runParams`, `runTail`, `runSave` | `CodeRun`, `BoardState`; Stopp nimmt `CodeRun` | 2 |
| | `deleted` | Bewerter prüft `CodeTask` in seiner Transaktion | 1 |
| | `buckets` (Grenzen je Minute) | offen, siehe unten | 3 |
| | `remotePending`, `poller`, `polling`, `judging` | entfällt: ein Space, Bewerter nehmen direkt | 1 |
| | `seq` | zufällige Ids | 1 |
| | `tail`, `bestTail` | Sperre über `CodeRoom`, Transaktion des Bewerters | 1–2 |
| | `loading`, `lastUsed`, Sitzungstabelle | entfällt: Räume werden bei Bedarf gelesen | 2 |
| | `clients`, `pushTimer`, `pushing` | Betriebsmittel von web, bleiben | – |
| hub | `#rr`, `#remoteDownUntil`, `#importing`, `#importTimer` | entfällt (ein Space) | 1 |
| | `#ipSpend` | `Spend`-Einträge je Adresse und Tag | 3 |
| board.ts | Kopie von `BoardState`, `busy`, `end`, `capped`, `tail` | `BoardState` (in der Transaktion des Auftrags), `AgentBusy` mit Lease, Ende durch Entfernen von `CodeRun` | 2 |
| hub (Generationen) | Schleife je Generation, `#idle` | Aufträge je Zug, eine Schranke je Generation wartet auf die Urteile | 2 |
| llm.ts | `on`, `allowedLabels` | `CodeAdmin`, bei jedem Aufruf gelesen | 3 |
| | Zähler je Minute und Tag | `LlmCall`-Einträge mit Lease | 3 |
| | Aufrufe in Arbeit und Warteschlange | Anzahl Schleifen je model-Prozess (Betriebsmittel) | 3 |
| search.ts | Tageszähler | `SearchCall`-Einträge mit Lease | 3 |
| index.ts | `adminSessions` | `AdminSession`-Einträge mit Lease | 3 |
| | Anfragegrenzen je IP | offen, siehe unten | 3 |
| | `runsByIp` (▶) | `ExecRun`-Einträge | 3 |
| runner.ts | ▶ läuft im web-Prozess | judge nimmt `ExecRequest`, schreibt `ExecEvent` der Reihe nach, web liest mit | 3 |
| hub `setTask` | Prüfregel, Kriterien, drei Kriterien-Prüfer, `testRule` laufen im web-Prozess | `TaskRequest`, von agents erledigt; web wartet blockierend auf den `CodeTask` | 2 |

## Offene Punkte

- **Anfragegrenzen je IP:** Ein Eintrag je HTTP-Anfrage hieße ein Commit je Anfrage (jeder Commit kostet O(Einträge),
  siehe help-site). Vorschlag: als Schutz der Verbindung behandeln, wie die Grenze offener Sockets (Betriebsmittel von
  web), nicht als Zustand. Entscheidung in Stufe 3.
- **Snapshotgröße über das Netz:** Ein Snapshot liest alle Einträge eines Raums (ein `readAll` ohne Typ). Liegt der
  Space auf einem anderen Rechner, geht das über den Socket. Messen in Stufe 4, dann entscheiden (z. B. Code nur auf
  Abruf).
- **Platzierung in Produktion:** Space auf nano, Hauptteil auf big wie im help-site; die Bewerter auf nano oder big.
  Festlegen in Stufe 4.

## Stufen

Jede Stufe hält die App lauffähig, wird getestet und einzeln committet; gepusht wird nach Rückfrage.

1. **Ein Space, eigene Prozesse für space, judge, web.** `space-host.ts` trägt den Space; die Bewerter laufen in
   `judge-host.ts` und pflegen `CodeBest`; nano-Import, Zurückholen und Wartezeiten entfallen; web verbindet sich über
   `CODEMODE_SPACE`. Ein Starter für alle Prozesse (`npm run dev`, `npm start`) und ein Test-Harness, das die Prozesse
   startet. *Bleibt im Speicher:* die Raumdaten des Hubs, Läufe und Modell-Grenzen (Stufen 2–3). *Docker* läuft erst
   wieder mit Stufe 4.
2. **Läufe und Agenten im Space.** `agent-host.ts` und `model-host.ts`; Auftragsbrett und Generationen ohne
   Koordinator; Aufgaben mit Prüfregel und Kriterien über `TaskRequest`; der Hub verliert seine Sitzungstabelle.
3. **Grenzen, Anmeldungen, ▶.** Modell- und Suchgrenzen, Budget je Adresse, Admin-Sitzungen, ▶ über den judge-Prozess.
4. **Betrieb.** Docker (Images und Dienste je Rolle), Skripte, Hilfe, README; Platzierung big/nano.

## Stand nach Stufe 1 (2026-10-21)

Umgesetzt: `space-host.ts`, `judge-host.ts`, `launch.ts` (`npm run dev` / `npm start`), `space.ts` (Verbindung,
`Process`-Einträge, Lease-Verlängerung) und `results.ts` (bester Code und Archiv in der Transaktion dessen, der sie
ändert). Der nano-Shard, sein Import und das Zurückholen sind entfallen; jeder Bewerter-Prozess nimmt direkt aus dem
einen Space. Ein Bewerter hinterlässt während der Bewertung einen `CodeJudging`-Merker, damit die Kachel sichtbar
bleibt, solange der Kandidat in seiner Transaktion steckt. Der web-Prozess folgt dem Änderungsstrom
(`changes` als Long-Poll) und schickt neue Snapshots, auch wenn ein anderer Prozess geschrieben hat. Die Tests starten
Space und Bewerter als echte Prozesse (`tests/stack.ts`); der web-Teil läuft im Testprozess, bis Stufe 2 die
Modell-Agenten in eigene Prozesse holt.

Erkenntnisse aus der Umsetzung:

- **Ein wartendes `take` eines Clients liegt dauerhaft im Space**, samt Transaktion, und übersteht sogar einen
  Neustart des Space. Ein Prozess, der beendet wird, muss seine offenen Transaktionen abbrechen, sonst fängt sein
  verwaister Warteaufruf den nächsten Kandidaten und hält ihn bis zum Ablauf der Lease fest.
- **Grenzen gelten je Besitzer.** Alle Prozesse verbinden sich als derselbe Peer; der Space-Host hebt deshalb die
  Obergrenzen für Transaktionen, Warteaufrufe und Registrierungen je Besitzer an. Die Größengrenzen bleiben: ein Eintrag
  höchstens 64 KiB, ein Commit höchstens 192 KiB. Code wird darum auch nach seiner JSON-Größe begrenzt (40 kB), damit
  Urteil, bester Code und Archiv in einen Commit passen.
- Über den Socket nennt der Fehler „ahead of this stream“ keine Revision; die aktuelle Revision liefert jede
  erfolgreiche Leseanfrage auf den Änderungsstrom.

**Bleibt im Speicher (Stufen 2 und 3):** die Sitzungstabelle des Hubs mit `task`, `blockId`, `best` (jetzt nur ein
Abbild von `CodeBest`), `answer`, Lauf und Abbruch; die Läufe selbst (Auftragsbrett und Generationen im web-Prozess);
Modell-Grenzen, Suchzähler, Budget je Adresse, Admin-Sitzungen, Anfragegrenzen; ▶ läuft noch im web-Prozess.
**Docker** startet noch den einzelnen Server von vorher und funktioniert erst mit Stufe 4 wieder.

## Stand nach Stufe 2a und 2b (2026-10-21)

**2a:** Ein Kandidat trägt die eigene Aufgabe nicht mehr mit; der Bewerter liest sie aus dem `CodeTask` (Fälle und Code
zusammen sprengten sonst die Eintragsgrenze). `CodeBest` nennt nur noch das Urteil (Beitrag, Zeit); den Code hat das
Urteil (sonst passte ein Commit des Bewerters bei großem Code nicht mehr). Ein Commit über den Grenzen gilt nicht mehr
als abgelaufene Transaktion. Prüfungen auf Einträge, die eine andere Transaktion halten kann, warten (`HELD_WAIT_MS`):
ein gehaltener Eintrag ist für `NO_WAIT` und `count` unsichtbar.

**2b:** `server/run.ts` und `server/agent-host.ts`. Läufe mit Skript-Agenten im Generationen-Modus leben ganz im Space:
`CodeRun` (je Raum `unique`, zugleich Sperre des Laufs), `AgentSlot` je Agent (ein Agenten-Prozess hält ihn in einer
erneuerten Transaktion), `WorkItem` (`turn` je Zug, `barrier` je Generation), `AgentBusy` (vor dem Nehmen geschrieben),
`CodeRunDone` (wie er endete). Jeder Auftrag ist eine Transaktion: Auftrag nehmen, Beitrag schreiben, `CodeRun`
fortschreiben, Folgeaufträge schreiben, Commit. Wer keine Aufträge und keine beschäftigten Agenten mehr sieht, nimmt
`CodeRun` und schreibt die Schlusszeile; Stopp im web-Prozess tut dasselbe. Ein Auftrag, der scheitert, kommt bis zu
dreimal wieder, danach zählt er als erledigt (sonst wartete seine Generation ewig). Die Schranke einer Generation sieht
nach 1, 2, 4, 8, dann alle 10 s wieder nach (jeder Blick ist ein Commit). Ein Snapshot liest den Lauf zuerst, damit ein
als beendet gezeigter Lauf seine Schlusszeile mitbringt.

Werte: Lease von Platz und Auftrag 60 s (`CODEMODE_AGENT_LEASE_MS`), höchstens 16 Agenten je Prozess
(`CODEMODE_AGENT_SLOTS`), drei Versuche je Auftrag.

**Bleibt bis 2c/2d im web-Prozess:** Läufe mit Modell-Agenten (Generationen und Auftragsbrett), Text-Aufgaben, das
Schreiben von Prüfregeln und Kriterien beim Anlegen einer Aufgabe, die Modell-Grenzen.
