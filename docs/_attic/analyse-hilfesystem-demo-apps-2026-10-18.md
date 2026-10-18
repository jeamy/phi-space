# Hilfesystem und Demo-Apps: erneute Implementierungsprüfung

Stand: 18. Oktober 2026. Basis: Commit `44a924a35422fd903b6f93694f5593cc1e6c2b7b` **einschließlich des vorhandenen, nicht eingecheckten Arbeitsstands**. Insbesondere `help-site/` und die bisherige Analyse waren unversioniert; Root-Code und Dokumentation enthielten bereits Änderungen.

## 1. Ergebnis und Geltungsbereich

Die ursprüngliche Prüfung widerlegte die Aussage „alle 23 Befunde vollständig umgesetzt und durch automatisierte Tests verifiziert“ in der [bisherigen Analyse](analyse-hilfesystem-und-demo-apps.md). **Umsetzungsstatus: 23 von 23 Befunden erledigt (F01–F23). Der aktuelle Umsetzungsstand mit Nachweisen und Grenzen steht in Abschnitt 7.** Die Erledigt-Markierungen beziehen sich auf die dort beschriebenen Fixes und lokalen Nachweise. Die Abschnitte 2–6 dokumentieren die Ausgangsbefunde und die damals vorhandene Evidenz; ihre Zeilenangaben und historischen Offen-Markierungen sind keine erneute Beschreibung des jetzt geänderten Codes. Die ausdrücklich benannten Nachweis- und Betriebsgrenzen bleiben bestehen.

Die höchsten Prioritäten der Ausgangsprüfung waren (inzwischen erledigt):

1. Parallel eingereichte Chatnachrichten erhalten dieselbe Sequenznummer; die Snapshot-Auflösung blendet anschließend eine davon aus.
2. Der Markdown-Renderer bleibt bei nicht unterstützten Überschriften und bestimmten Textzeilen in einer Endlosschleife.
3. Admin-Replay rekonstruiert nach Controller-Neustart einen Erfolgsstatus ohne Ergebnis; Crashfenster, konkurrierende Befehle und die Bindung an Befehlsargumente sind weiterhin unzureichend abgesichert.
4. Geplante Run-Aktionen haben im Hilfesystem keinen Ausführungsloop. Auch persistierte Worker-Zuweisungen werden beim Start nicht automatisch angewendet.
5. Enrollment-Tokens im Web-Login verlieren ihre Ablauf- und Rollenbindung; ein festes Standardpasswort bleibt als Fallback aktiv.

Untersucht wurden HTTP-/WebSocket-Server, AdminController, SocialSwarm, Chat-Hub und Chat-Engine, Stufen v1–v6, Markdown/Suche/Artikelnavigation, Corpus-Build sowie die Root-Beispiele und deren Tests. Die Untersuchung ist eine statische Prüfung mit gezielten lokalen Reproduktionen und vorhandenen Tests. Sie ist keine vollständige Sicherheitszertifizierung, keine Browser-E2E-Abnahme und keine Abnahme des produktiven Servers oder externer Hosts. Es wurden keine Live-Modelle aufgerufen.

### Evidenzklassen und Prioritäten

- **R:** lokal reproduziert, mit tatsächlichen Implementierungen oder begrenztem Kindprozess.
- **S:** aus aktuellem Code und Aufrufpfad nachgewiesen; der konkrete Fehlerablauf wurde nicht separat ausgeführt.
- **L:** klar abgegrenzte Architektur-, Betriebs- oder Testlücke, keine Behauptung eines bereits beobachteten Produktionsausfalls.
- **P1:** vor belastbarer Mehrbenutzer-/Betriebsfreigabe beheben; **P2:** Korrektheit oder Wartbarkeit wesentlich betroffen; **P3:** Bereinigung/Präzisierung.

## 2. Logikfehler und funktionale Lücken

### F01 — P1 / R: Sequenzvergabe verliert Nachrichten in der Anzeige

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/examples/shared/chat-core.ts:368`, `:404`, `:860`, `:342`.

`nextSeqForThread()` liest den bisherigen Maximalwert außerhalb der schreibenden Transaktion. Zwei `submitMessage()`-Aufrufe können denselben Wert lesen. Auch zwei Antwort-Worker teilen sich keinen Sequenz-Lock. Die Transaktionen schützen jeweils Msg plus ChatTask, aber nicht die gemeinsame Sequenzvergabe. `resolveMessagesForThread()` verwendet anschließend eine Map mit `seq` als Schlüssel und überschreibt gleich nummerierte Nachrichten.

**Reproduktion:** Ein leerer Thread, dann `Promise.all()` über zwei Submits verschiedener Autoren und Request-IDs. Ergebnis: `sequences=[1,1]`, zwei physische Msg-Einträge, nur **eine** Nachricht im Snapshot. Es handelt sich um Anzeige-/Historienverlust, nicht um das Löschen des zweiten Space-Eintrags. Forks und LLM-Historie übernehmen die beschädigte Sicht.

**Maßnahme:** Thread-Sequenz über atomar fortgeschriebenen Zähler oder reservierten Thread-Eintrag vergeben; dieselbe Regel für Benutzer- und Antwortnachrichten verwenden. Doppelte Sequenzen als Integritätsfehler behandeln. **Abnahme:** konkurrierende Submits und Worker, alle Msg-IDs genau einmal sichtbar, streng eindeutige Sequenzen.

### F02 — P1 / R: Markdown-Parser macht bei bestimmten Zeilen keinen Fortschritt

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/client/lib/markdown.ts:48`, `:73`, `:85`, `:158`.

Überschriften werden nur mit ein bis drei `#` erkannt. Der Absatzparser verweigert aber jede Zeile, die nach Whitespace mit `#` oder `|` beginnt. Wenn auch kein Tabellen-/Überschriftenzweig passt, bleibt `i` unverändert. Die äußere Schleife hängt und fügt fortlaufend leere Absätze hinzu.

**Reproduktion:** Die Eingaben `#### Heading`, `| orphan` und `#invalid` wurden jeweils in einem separaten Node-Prozess nach 600 ms mit `ETIMEDOUT` beendet. Damit kann ein einzelner neuer oder fehlerhaft formatierter Hilfeartikel das Rendern blockieren. Die Suche im aktuellen Corpus ergab für diese konkreten Muster keinen Treffer; der Fehler ist dennoch direkt reproduzierbar.

**Maßnahme:** Fortschrittsgarantie in jedem Parserzweig; H4–H6 unterstützen oder als Text ausgeben, ebenso nicht erkannte Tabellenzeilen. **Abnahme:** kurze deterministische Tests für diese Eingaben, eingerückte Überschriften und EOF ohne Leerzeile.

### F03 — P1 / R+S: Admin-Idempotenz speichert kein wiederherstellbares Ergebnis

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/admin/admin-controller.ts:146`, `:448`, `:725`, `:729`.

`op.result` existiert nur in RAM. Der langlebige `Result` enthält `commandId`, `kind`, `state`, `requestedBy` und Zeit, aber weder Ergebnis noch Argumente. Die Rekonstruktion setzt `args: {}` und kein `result`. Ein Retry wird trotzdem als abgeschlossen zurückgegeben.

**Reproduktion:** Controller initialisieren, `createSpace` ausführen, Controller schließen, neuen Controller über demselben Harness initialisieren, identischen Befehl wiederholen: erstes Ergebnis vorhanden, zweites Ergebnis fehlt, Status bleibt `completed`. Das isoliert die Rekonstruktion; ein Prozesskill/SQLite-Reopen wurde für diesen Befund nicht durchgeführt.

Weitere offene Teilprobleme:

- „Pre-persist operation“ ist nur ein Kommentar: vor Ausführung wird ausschließlich die RAM-Map verändert. Zwischen Wirkung und Result-Write liegt ein Crashfenster.
- Ein paralleler Retry mit Status `sending` wird erneut ausgeführt; es gibt keine gemeinsame laufende Promise/Claim.
- Eine wiederverwendete ID mit anderem `kind`/anderen `args` liefert den alten Erfolg statt eines Konflikts.
- Beim Boot gewinnt der erste gefundene Result-Eintrag. Nach `failed` und später `completed` derselben ID kann der ältere Fehler gewinnen.
- `readAll(..., {limit: 10_000})` liest die ältesten Treffer; spätere abgeschlossene Befehle fehlen beim Wiederaufbau.

Einzelne darunterliegende Controller besitzen eigene Idempotenz und begrenzen damit manche Auswirkungen. Das macht die WebAdmin-Garantie nicht vollständig, insbesondere für Enrollment und Rotation.

**Maßnahme:** dauerhaftes Befehlsjournal mit Argument-Hash, Ergebnis, Zustandsübergängen und definierter Wiederaufnahme; gleiche ID mit anderem Inhalt zurückweisen. **Abnahme:** Restart-Replay mit identischem Ergebnis, paralleler Retry, Fehler-dann-Erfolg, mehr als 10.000 Befehle und injizierter Fehler zwischen Effekt und Ergebnisjournal.

### F04 — P1 / R+S: `scheduleRun` wird ohne Ausführungsloop nicht wirksam

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/admin/admin-controller.ts:666`; `src/run-controller.ts:243`, `:317`, `:343`; Vergleich `src/runtime.ts:209`.

Der WebAdmin legt Zeitpläne an, startet aber keinen Loop, der `pending()` und `advance()` aufruft. `overview()` verwendet `list()`, was Zeitpläne nicht ausführt. Der vorhandene Capability-Timer publiziert lediglich Heartbeats. Im Föderationsruntime existiert der entsprechende Loop bereits; das Hilfesystem verwendet ihn nicht.

**Reproduktion:** Run starten, bereits fälliges Pause-Schedule anlegen: Status `running`. Explizites `runController.advance(runId)` ändert ihn auf `paused`.

**Maßnahme:** serialisierten, stoppbaren Advance-Loop anbinden, inklusive Fehleranzeige. **Abnahme:** geplantes Pause/Resume ohne weiteren Benutzerbefehl, nach Restart sowie bei vorübergehendem Fehler.

### F05 — P1 / S: Worker-Sollzustand wird nach Neustart nicht automatisch aktiviert

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/admin/admin-controller.ts:177` ff., `:276`, `:584`, `:625`, `:712`; `src/workers.ts:110`, `:200`.

`initialize()` konstruiert `WorkerSupervisor`, ruft jedoch weder initial `reconcile()` noch `startWorkerSupervisor()` auf. Reconcile geschieht nur bei bestimmten Admin-Befehlen. Persistierte Assignments können deshalb in der Übersicht existieren, ohne dass nach Server-Neustart Worker laufen.

**Maßnahme:** initiale und periodische Abstimmung mit sauberem Shutdown. **Abnahme:** Assignment speichern, Server neu öffnen, Fortschritt ohne erneutes Setzen der Worker nachweisen.

### F06 — P1 / S: Web-Enrollment ignoriert Ablauf und zugewiesene Rolle

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/admin/admin-controller.ts:91`, `:302`, `:467` ff.

`createEnroll` speichert den Token zusätzlich in einem `Set<string>`. `login()` prüft nur die Mitgliedschaft in diesem Set und verbraucht den Token. Die 600.000-ms-Lease des `Enroll`-Eintrags, `allowedPeerId`, Rolle und Scope werden dabei nicht geprüft. Jeder akzeptierte Token erzeugt dieselbe WebAdmin-Session. Ohne Neustart bleibt ein unbenutzter Token im Set auch nach Ablauf des Space-Eintrags nutzbar; nach Neustart ist dagegen das ganze Set verloren.

**Maßnahme:** Web-Login-Tokens vom Peer-Enrollment trennen oder vollständig gegen langlebigen, zeitlich und fachlich gebundenen Zustand prüfen. **Abnahme:** abgelaufener Token abgelehnt, Nicht-Admin-Enrollment verleiht keine Adminrechte, genau einmaliger Verbrauch auch bei Konkurrenz und Restart.

### F07 — P1 / S: Unsicherer Default und inkonsistente Schlüsselidentität nach Neustart

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/admin/admin-controller.ts:88`, `:109`, `:125`, `:496`.

Ohne Konfiguration wurde damals ein festes Standardpasswort akzeptiert (seitdem entfernt: der Controller generiert jetzt ein zufälliges Secret bzw. erwartet `PHI_SPACES_ADMIN_PASSWORD`). Das ist besonders relevant, sobald der Server über einen Proxy veröffentlicht wird. Zusätzlich erzeugt jede Controller-Instanz einen neuen privaten Schlüssel unter derselben anfänglichen Key-ID `web-admin-key-1` und schreibt erneut einen aktiven PeerKey. Die Rotation widerruft alte Records nur bei explizitem Rotationsbefehl; der Bootpfad tut dies nicht.

**Maßnahme:** außerhalb eines ausdrücklich eingeschränkten Demo-Modus fehlende Zugangskonfiguration ablehnen; Identität persistent oder eindeutig mit geregelter Ersetzung führen. **Abnahme:** zwei Boots über gleichem Store ohne doppelte aktive Key-ID mit verschiedenen öffentlichen Schlüsseln; Startkonfiguration ohne Passwort explizit behandeln. Dies ist eine Prüfung des WebAdmin-Wrappers, keine Aussage, dass die Kern-Föderationsauthentifizierung gebrochen sei.

### F08 — P2 / R: Presence-Replay kann die bestehende Anwesenheit entfernen

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/examples/shared/chat-core.ts:174` ff.

`joinOrRefreshPresence()` löscht die alte Lease und vorhandene Presence-Einträge, bevor es den idempotenten Write mit RequestRef versucht. Dessen `updatedAt` wird bei jedem Aufruf neu berechnet. Ein Retry derselben Request-ID kann deshalb nach der Löschung mit „request ... was used for different arguments“ scheitern.

**Reproduktion:** zweimal identischer Join-Aufruf: Request-Konflikt, danach null Presence-Einträge. Bei identischem Zeitwert ist zusätzlich die Interaktion mit dem Replay einer inzwischen entfernten Lease zu berücksichtigen.

**Maßnahme:** Replay vor Seiteneffekten auflösen; Erneuerung/Ersetzung atomar und mit stabiler Request-Nutzlast modellieren. **Abnahme:** identischer Retry erhält Anwesenheit, paralleler Join hinterlässt genau einen gültigen Eintrag.

### F09 — P2 / S: Chat-Frontend erneuert seine Presence nicht

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/client/components/SpaceChatWorkbench.tsx:74`; `help-site/server/space-chat/stage-runner.ts:251` ff.

Der Browser sendet bei `onopen` genau einen Join. Es gibt keinen `participant.heartbeat`; der 1,5-s-Timer lädt nur Snapshots. Damit läuft die 30-s-Lease auch bei geöffnetem Chat ab. Die Effect-Abhängigkeiten enthalten nur `sessionId`; ein Wechsel von Teilnehmer oder aktivem Thread aktualisiert die registrierte Presence nicht. Ein Reconnect nach Verbindungsverlust fehlt ebenfalls.

**Maßnahme:** Presence-Lifecycle mit Heartbeat, Metadatenaktualisierung und Reconnect. HTTP-Polling nur als definierter Fallback. **Abnahme:** sichtbare Anwesenheit nach mehr als einer Lease, korrekter Thread-/Teilnehmerwechsel, Netzwerkunterbrechung.

### F10 — P2 / R: Abgeschlossene Subagent-Suche verliert Zuordnung und Frage

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/examples/shared/chat-core.ts:700`, `:973`, `:1019`.

Nach Verarbeitung ist der SearchTask verbraucht. SearchResult enthält zwar `parentThreadId`, die Snapshot-Zwischenstruktur übernimmt dieses Feld aber nicht. Die ursprüngliche Frage wird im Ergebnis nicht persistiert. Die Ausgabe fällt deshalb auf Thread `main` und die technische Search-ID als Frage zurück.

**Reproduktion:** Suche aus Thread `t`; Snapshot: `parentThreadId='main'`, `question='search:task:t:search'`.

**Maßnahme:** Herkunft und Frage im langlebigen Ergebnis erhalten und im Snapshot lesen. **Abnahme:** Darstellung und Stage-Mirror behalten den tatsächlichen Ursprung auch nach Reopen.

### F11 — P1 / S: Chat-Tasks können nach Fehler oder Neustart dauerhaft liegenbleiben

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/space-chat/stage-runner.ts:34`, `:44` ff., `:274` ff.; `help-site/examples/shared/chat-core.ts:746`, `:832` ff.

Der Hub verarbeitet Tasks ereignisgetrieben nach Nachrichteneingang oder neuen Alarmen. Es gibt keinen allgemeinen Queue-Drain für vorhandene ChatTasks. Scheitert ein Reply-Commit oder wird der Prozess nach Submit beendet, liegt der zurückgegebene Task bis zu einem weiteren passenden Ereignis weiter im Space. Beim Alarm wird nur für neu getriggerte Jobs verarbeitet; ein Fehler beim ersten Task bricht die gesamte Schleife ab, während Jobs bereits `triggered` sein können.

Der LLM-Aufruf läuft zudem innerhalb einer 30-s-Transaktion ohne Lease-Erneuerung oder hier gesetztes Zeitbudget. Ein langsamer Provider kann das Commit scheitern lassen, obwohl die externe Leistung bereits bezahlt wurde. Die 400-ms-Intervalle warten nicht auf den vorherigen Tick.

**Maßnahme:** persistente Taskverarbeitung unabhängig vom HTTP-/WS-Aufruf, ein kontrollierter Scheduler, begrenzte Laufzeiten und explizite Fehler-/Retry-Strategie. **Abnahme:** einmalig fehlschlagender Generator/Commit, Prozess-Reopen mit pending Tasks und langsame Antwort; keine zusätzliche Nutzernachricht nötig.

### F12 — P2 / S: Gleichzeitiges Session-Anlegen erzeugt getrennte Hub-Zustände

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/space-chat/stage-runner.ts:64–115`.

Zwischen Prüfung von `#sessions` und dem abschließenden `set()` liegen mehrere awaits. Zwei erste Zugriffe können beide eine Engine erzeugen und seeden. `createSpace` verhindert gegebenenfalls doppelte Spaces, aber nicht zwei Client-Sets/Engines. Der spätere Map-Eintrag verdrängt den früheren; bereits angehängte Clients können anschließend vom Broadcast ausgeschlossen sein.

**Maßnahme:** pro normalisierter Session-ID eine gemeinsame Initialisierungs-Promise. **Abnahme:** parallele Erstzugriffe/WS-Attach liefern dieselbe Engine und dasselbe Client-Set, Seed genau einmal.

### F13 — P2 / S: Stage-Mirror ist weder atomarer Ersatz noch vollständige Zustandskopie

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/space-chat/stage-runner.ts:126–202`.

Das Mirroring löscht Typen nacheinander und schreibt anschließend einzelne Einträge. ChatTask/SearchTask werden nicht geleert, obwohl Thread/Msg ersetzt werden. Pending Tasks werden aus dem Snapshot nicht wiederhergestellt. TimerLocks werden entfernt, aber für kopierte pending ScheduledJobs nicht rekonstruiert; der Alarmticker kann sie deshalb vorzeitig auslösen. Der Server-Ticker und Browserzugriffe können während des Imports Zwischenstände sehen.

Die Heuristik `msgId.includes(':fork:')` hält zudem jede Nachricht mit diesem Textstück für eine virtuelle Projektion. Da Request- und Thread-IDs in realen Msg-IDs vorkommen, können legitime Nachrichten entfallen.

**Maßnahme:** entweder ausdrücklich unveränderliche Berichtskopie mit vollständigem Schema oder atomar aktivierte, ausführbare Wiederherstellung einschließlich Aufgaben und Restlaufzeiten. Projektionen strukturell kennzeichnen. **Abnahme:** zweiter Lauf, Fehler mitten im Import, pending Alarm, konkurrierender Zugriff und echte ID mit `:fork:`.

### F14 — P2 / S: Swarm-Fehler werden als vollständige leere Ergebnisse ausgegeben

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/social/swarm.ts:1458`, `:1476`, `:1511`.

Shard-Leseausfälle werden mit `.catch(() => [])` zu leeren Trefferlisten. `feed.more` setzt trotzdem `exhausted` allein nach Seitenlänge. Fällt ein Shard aus, kann der Browser „keine weiteren Beiträge“ erhalten, obwohl Beiträge fehlen. Agenten-/KI-Listen besitzen ebenfalls kein Unvollständigkeitsmerkmal.

**Maßnahme:** Teilfehler und Vollständigkeit im Antwortschema führen; bei unbekannter Vollständigkeit kein endgültiges `exhausted`. **Abnahme:** Shard während Scrollback ausfallen lassen, nach Wiederkehr Fortsetzung ohne ausgelassene Beiträge.

### F15 — P2 / S: Swarm-Scrollback liest große Historien weiterhin vollständig

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** dieselben Stellen wie F14; `src/core.ts:942` ff.

Template-Filter reduzieren Treffer und Transportdaten, sind aber kein Sekundärindex. `feed.more` liest bis zu einer Million Posts je Shard, filtert/sortiert im Server und gibt erst danach 10–200 zurück. Die anderen Listen lesen bis zu 100.000 Treffer. Das erzeugt wiederholte lineare Scans und große Zwischenarrays. Bei Überschreiten der Limits fehlen neuere Treffer, weil `readAll` die ältesten zuerst liefert.

**Maßnahme:** Cursor-/Byte-basiertes Paging mit zur Sortierung passendem Zugriffspfad; Grenzen und Unvollständigkeit sichtbar machen. **Abnahme:** tiefe Seiten mit begrenztem Speicher-/Transferbedarf sowie Datenbestand oberhalb des Limits. Die alte Aussage „O(N)-Full-Scans beseitigt“ ist falsch; der neue Codekommentar benennt den verbliebenen Scan bereits korrekt.

### F16 — P2 / S: Swarm reserviert fehlerhafte Batches bis zum Lease-Ablauf

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/social/swarm.ts:786–819`.

`txn` wird im try angelegt. Der catch schläft, kann die Transaktion aber nicht mehr explizit abbrechen. Ein Fehler vor Commit hält bis zu vier Tasks bis zum 45-s-Lease-Ablauf reserviert. Fehler in `#afterPostCommit` werden im selben catch behandelt, obwohl das Commit bereits erfolgreich war; die nachgelagerten Effekte haben dort keine dauerhafte Wiederholungswarteschlange.

**Maßnahme:** Transaktionszustand außerhalb des try führen, vor Commit abbrechen und nach Commit eigene verlässlich wiederholbare Effekte verwenden. **Abnahme:** injizierter Write-/Commit-/Postcommit-Fehler mit kontrollierten Task- und Cachezuständen.

### F17 — P2 / S: WebSocket-Implementierung hat weiter Protokoll- und Ressourcenlücken

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/ws.ts:50–196`; `help-site/server/index.ts:487` ff.

Fragmentierte Texte werden inzwischen unterstützt, aber unmaskierte Client-Frames werden akzeptiert; RSV-Bits, Version, unerwartete Continuations, Control-FIN/-Länge und ungültiges UTF-8 werden nicht vollständig validiert. Besonders relevant: `fragParts` ist nur durch die Summe der Payload-Bytes begrenzt. Beliebig viele leere Fragmente lassen das Array wachsen; `reduce()` über alle Fragmente wird bei jedem Frame wiederholt. Auch Socket-Backpressure wird beim Senden nicht behandelt.

Beim Upgrade wird `attachWebSocket()` ohne Rejection-Behandlung gestartet. Die Hub-Handler werden erst nach asynchronem Session-Aufbau registriert, während Frames bereits geparst werden können. Frühe Clientnachrichten können dadurch verloren gehen.

**Maßnahme:** Fragmentanzahl und Gesamtbytes inkrementell begrenzen, Verbindungszustand strikt validieren, Eingänge bis zur Handlerbereitschaft puffern und ausgehende Warteschlangen begrenzen. **Abnahme:** echte Frames gegen den Parser, einschließlich Nullbyte-Fragmentserie, früher Join, langsamer Client und fehlgeschlagene Initialisierung. Ein Fake-WsConnection-Test genügt dafür nicht.

### F18 — P2 / S: Artikelwechsel kann veraltete Inhalte unter neuem Titel anzeigen

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/client/App.tsx:174–189`.

Der Artikel-Fetch hat weder AbortController noch Generation-/Pfadprüfung beim Abschluss. Antwort A kann nach Antwort B eintreffen und deren Markdown überschreiben. `response.ok` wird nicht geprüft; ein Fehlertext kann als Artikel gerendert werden. Eine catch-Behandlung mit nutzbarer Fehlermeldung fehlt.

**Maßnahme:** Request abbrechen oder Abschluss an den aktuellen Pfad binden, Fehlerzustand darstellen. **Abnahme:** künstlich verzögerte Antworten bei Artikel-/Sprachwechsel, 404 und Netzfehler.

### F19 — P1 / L: Öffentliche Demo-Endpunkte haben keine ausreichende Ressourcenbegrenzung

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/server/index.ts:212` ff., `:306` ff., `:321` ff.; `help-site/server/llm.ts:77` ff.; `help-site/server/space-chat/stage-runner.ts:24`.

Öffentlich erreichbar sind Session-Anlage, Stage-Läufe, Uploads und globales Umschalten des LLM-Modells. Credentials aktivieren das Modell standardmäßig. Chat-Anfragen können damit externe Kosten auslösen. Uploads sind pro Datei auf 2 MiB begrenzt, jedoch ohne Gesamtkontingent/Retention; Sessions bleiben in RAM und im Store. Stage-Läufe haben keine globale Parallelitätsbegrenzung. Dies sind Grenzen für einen öffentlich angebotenen Dienst, nicht automatisch Fehler eines absichtlich offenen lokalen Beispiels.

**Maßnahme:** öffentliche Demo-Policy explizit machen: Kontingente, Sitzungs-/Upload-Lifetime, Stage-Semaphor, Budget für Modellaufrufe, Berechtigung für globale Konfiguration. **Abnahme:** Limitüberschreitung führt zu definierter Antwort ohne Ressourcenwachstum; LLM bleibt in Tests explizit aus.

### F20 — P2 / S: Sieve-Exporter prüft schwächer als die lokale Ergebnissammlung

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `examples/sieve.ts:125–161`.

`collectSieveResults()` verlangt genau einen Treffer pro Task, korrekte Bereichsgrenzen und eine aufsteigend sortierte, gültige Zahlenfolge. `SIEVE_EXPORTER` wählt dagegen den ersten Treffer des ersten passenden Members und zählt dessen `primes`; Duplikate, widersprüchliche Member-Ergebnisse und falsche Bereiche werden nicht abgewiesen. `complete` bedeutet hier nur, dass alle Task-IDs irgendeinen Treffer besitzen.

**Maßnahme:** gemeinsame Ergebnisvalidierung verwenden und eine explizite Regel für gleiche bzw. widersprüchliche Resultate mehrerer Members definieren. **Abnahme:** falscher Bereich, Duplikat, Konflikt zwischen Members, fehlende Task-ID. Dies ist kein Beleg für einen falschen Primzahlalgorithmus; es betrifft die Export-Vertrauensgrenze.

### F21 — P2 / S: Thread- und Fork-Eingaben haben keine ausreichenden Invarianten

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**Belege:** `help-site/examples/shared/chat-core.ts:231–305`.

`createThread` bindet Idempotenz an RequestRef, nicht an eindeutige `threadId`. Unterschiedliche Requests können dieselbe fachliche ID mehrfach anlegen. `forkThread` prüft weder die Existenz des Parents noch gültige Fork-Grenzen oder Zyklen. Die Auflösung bricht Zyklen still mit einer leeren Liste ab. Außerdem ist das Default-`createdAt` für normale Threads ein fester historischer Wert; neue Live-Threads erhalten dadurch keinen tatsächlichen Erstellzeitpunkt.

**Maßnahme:** fachliche Eindeutigkeit und Parent-/Sequenzinvarianten atomar prüfen; für Live-Erstellung `now()` verwenden und deterministische Zeit nur in Fixtures setzen. **Abnahme:** doppelte IDs, fehlender Parent, Selbstfork/Zyklus, negative/nicht ganzzahlige Grenze, echte zeitliche Sortierung.

## 3. Toter Code und Duplikation

### F22 — P3 / Compilerbeleg: konkrete ungenutzte Symbole

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

Zusätzlich zur normalen Typprüfung wurde `tsc -p help-site/tsconfig.json --noEmit --incremental false --noUnusedLocals --noUnusedParameters` ausgeführt. Im Untersuchungsbereich meldet es:

| Datei | Symbol / Befund | Einordnung |
|---|---|---|
| `examples/sieve.ts:8` | Import `Space` | entfernbarer Import |
| `help-site/examples/v4-gated-auth/run.ts:22` | Import `FOREVER` | entfernbarer Import |
| `help-site/examples/v5-federated-cluster/run.ts:10` | Import `createSpace` | entfernbarer Import |
| `help-site/client/components/AdminSpacesView.tsx:26` | `selectedSpaceInspect` wird gesetzt, nie gelesen | wirkungsloser State; Setter bei `:170` entfernen oder Anzeige daran anbinden |
| dieselbe Datei `:36`, `:38` | `setSieveStart`, `setSieveBlock` | Werte werden verwendet, Setter nicht; keine vollständig tote Sieve-Konfiguration |
| `App.tsx`, `AdminSpacesView.tsx`, `LlmModelPicker.tsx`, `SpaceChatWorkbench.tsx` | Default-Import `React` | bei automatischer JSX-Runtime ungenutzt |
| `help-site/server/social/swarm.ts:709`, `:719`, `:725` | Parameter `agent` | Signaturbereinigung oder fehlende Personalisierung prüfen |

Der zusätzliche Compilerlauf meldet auch Symbole in `src/`; diese werden hier nicht als gesonderte Hilfesystem-Befunde gezählt. Ein nicht importiertes CLI-Skript ist nicht automatisch toter Code. `react-shim.ts` ist im aktuellen Baum nicht mehr vorhanden; der frühere Befund ist insoweit geschlossen. Die sechs Stage-Runner sind eingebunden und nicht pauschal zu löschen.

### F23 — P2 / S: fachliche Duplikation driftet bereits auseinander

**Status: Erledigt.** Umsetzung und gezielter Nachweis siehe [Abschnitt 7.1](#71-nachweis-je-befund); verbleibende Nachweis- und Betriebsgrenzen siehe [Abschnitt 7.3](#73-aktuelle-prüfung-und-verbleibende-grenzen).

**HTTP/WS-Aktionen:** `help-site/server/index.ts:239` ff. und `server/space-chat/stage-runner.ts:239` ff. implementieren Thread/Fork/Submit/Alarm/Presence separat. Alarm-Defaults unterscheiden sich (2.000/3.000 ms), Presence-Namen ebenfalls. Unbekannte Aktionen enden ohne Fehler als Snapshot bzw. `{ok:true}`. Empfehlung: transportneutraler validierter Command-Dispatcher, getrennte Transportadapter; dieselben Parameter-/Fehlerfälle über beide Wege prüfen.

**Sieve-Resultate:** gemeinsamer Exporter und Config-Normalisierung sind bereits eingebunden. Die noch doppelte Ergebnisprüfung besitzt aber unterschiedliche Semantik (F20). Keine erneute vollständige Orchestrierungs-Neuschreibung nötig.

**Corpus-Build:** `help-site/package.json` führt `prebuild` aus; `build-web.ts` ruft anschließend erneut `buildCorpus()` auf. Zweifache Generierung im normalen Build ist redundant. Generierte `corpus/de|en`, `public/help` und `dist/public/help` sind dagegen absichtliche Ausgaben, keine unabhängig zu pflegenden Quellkopien. Änderungen gehören in Seed-/Faktendateien.

**Zwei UI-Auslieferungen:** Next-App und esbuild-Standalone teilen `HelpApp`, besitzen aber unterschiedliche Start-/Assetpfade. Der Test erzeugt Standalone-Artefakte; der Next-Produktionstest erwartet einen vorhandenen `.next`-Build. Das ist keine vollständige Abnahme eines sauberen Produktionsbuilds. Einen kanonischen Buildpfad plus klar bezeichneteten Testfallback festlegen.

**Root-Tests:** Einige ältere Chat-/Recherchetests definieren eigene Faux-Pipelines statt die Runner vollständig zu importieren. Diese Tests bleiben als Semantiktests nützlich, beweisen allein aber nicht die aktuelle CLI-Verdrahtung. `test/examples/recovery.test.ts` prüft inzwischen tatsächliche Runner und schließt einen Teil dieser Lücke. Diese Unterscheidung muss bei Aussagen zur Testabdeckung erhalten bleiben.

## 4. Neubewertung der bisherigen Erledigt-Aussagen

| Bisheriger Punkt | Aktueller Befund |
|---|---|
| Like ohne Target / CompletionProfile | Ack-Write vorhanden; ursprünglicher fehlender Ergebnis-Write geschlossen. Keine umfassende Batch-Fehlerabnahme daraus ableiten (F16). |
| Vorzeitige Post-/Like-Cacheupdates | `postCommit`-Callbacks vorhanden. Fehler nach Commit und Batch-Rollback separat offen. |
| Alle Alarme abarbeiten | Schleife vorhanden; nicht ausreichend bei Workerfehler, Neustart und überlappenden Ticks (F11). |
| Presence-Ablauf korrekt | lokale Expiry-Map vorhanden; Browser erneuert nicht und Join-Replay entfernt Presence (F08/F09). |
| WebSocket vollständig | Continuations vorhanden, Protokoll-/Ressourcenlücken bleiben (F17). |
| Admin-Keyrotation | Widerruf im Rotationszweig vorhanden; Boot-Identität und atomare Rotation bleiben gesondert zu prüfen (F07). |
| Admin-Replay nach Restart | nur Status rekonstruiert, Ergebnis fehlt; Garantie weiterhin offen (F03). |
| Full-Scans beseitigt | lediglich Template-Filter ergänzt; große Scans/Materialisierung bleiben (F15). |
| O(1)-Fork | kein physisches Kopieren im Fork-Write; Lesen/Snapshot ist nicht O(1). Sequenz- und Validierungsfehler bleiben (F01/F21). |
| Stage-Spiegelung echt | reale Berichtsdaten werden importiert; keine vollständige/atomare Zustandskopie (F13). |
| Sieve vereinheitlicht | gemeinsamer Exporter/Normalizer vorhanden, Validierung driftet (F20). |
| React-Shim / alte Namen / CLI-Verknüpfung | Shim entfernt, `SpaceChatEngine` verwendet, CLI- und Doku-Verknüpfungen vorhanden. Weitere ungenutzte Symbole separat F22. |
| Links / Suchnormalisierung | interne Ankerbehandlung und ß-Normalisierung vorhanden. Kein Beleg für vollständige Markdown-Abdeckung (F02). |
| Dynamische Testports | vermeidet feste Portkollisionen; „Kollisionen ausgeschlossen“ ist zu stark, wenn ein freier Port geschlossen und später neu gebunden wird. |
| Run-Guards | URL-Decoding/resolve verbessert; Symlink-Gleichheit folgt daraus nicht automatisch. Node normalisiert normale CLI-Pfade bereits; die alte Begründung zu relativen Pfaden war zu pauschal. |
| Vergleichsdokumente / 23 von 23 | redaktionelle Aktualisierung ist keine umfassende Implementierungs-/Betriebsabnahme. |

Die alte Datei enthält außerdem doppelte Kapitel 3.1/3.2, sowohl offene als auch erledigte Fassungen und absolute `file://`-Links. Sie bleibt zur Nachvollziehbarkeit erhalten, ist aber mit diesem Bericht als überholt gekennzeichnet.

## 5. Verifikation dieser Prüfung

Alle Modellaufrufe wurden durch `PHI_SPACES_LLM=0` deaktiviert. Vorhandene Dependencies wurden verwendet, keine installiert. Die Hilfesystemtests generieren lokale Corpus-/Standalone-Buildartefakte und starten lokale Testserver; die Tests schließen diese wieder.

| Prüfung | Ergebnis / Aussagegrenze |
|---|---|
| `npm run typecheck` | erfolgreich |
| `./node_modules/.bin/tsc -p help-site/tsconfig.json --noEmit --incremental false` | erfolgreich |
| zusätzliche `--noUnusedLocals --noUnusedParameters` | meldet die oben aufgeführten Symbole; erwarteter Diagnosefehlschlag, kein normaler Typecheck-Fehler |
| `PHI_SPACES_LLM=0 npm --prefix help-site test` | **5 Tests bestanden**, inklusive vorhandener Next-Produktionsartefakte und lokalem Zwei-Shard-Test |
| `PHI_SPACES_LLM=0 npm run test:examples`, ohne Sandbox-Einschränkungen | **158 Tests, 60 Suites, alle bestanden** |
| `PHI_SPACES_LLM=0 npm test`, ohne Sandbox-Einschränkungen | **731 Tests: 730 bestanden, 1 übersprungen, 0 fehlgeschlagen**, Laufzeit rund 78 s |
| begrenzte lokale Reproduktionen | F01, F02, F03, F04, F08, F10 bestätigt |

Übersprungen wurde der Bootstrap-Test mit einer realen Control-Store-Kopie, weil `PHI_SPACES_BOOTSTRAP_COPY` nicht gesetzt war. Es wurde keine reale Store-Kopie beschafft oder verändert.

Der erste eingeschränkte Beispieltestlauf meldete zwei fehlgeschlagene Testdateien (`golomb`, `recovery`); der uneingeschränkte Wiederholungslauf war grün. Der erste eingeschränkte Root-Lauf lieferte ebenfalls Fehler/stockenden Fortschritt und endete am gesetzten 180-s-Timeout (Exit 124). Diese Ergebnisse dürfen ohne Einzelursachenanalyse nicht als Produktregressionen ausgegeben werden. Maßgeblich sind hier die separat aufgeführten Wiederholungsläufe und gezielten Reproduktionen.

Die fünf Hilfesystemtests belegen vor allem normale Abläufe: Corpus-Schema/-Anker, sequenzielle Stufen, HTTP/Admin-Happy-Path, vorhandenen Next-SSR-Build und Zwei-Shard-Verhalten. Sie prüfen **nicht** die oben reproduzierten Parallelitäts-/Replayfehler, Browser-Heartbeats oder echte WebSocket-Frame-Grenzfälle. Stufe v2 verwendet geordnetes Close/Reopen; das ist kein Stromausfall- oder harter Prozessabbruchnachweis.

Die Reproduktionen wurden mit einem temporären Skript `/tmp/phi-spaces-help-review.mjs` ausgeführt. Logs dieser Sitzung liegen unter `/tmp/phi-spaces-review-*.log`; sie sind lokale, nicht dauerhaft versionierte Hilfsartefakte. Die konkreten Eingaben und Resultate sind deshalb zusätzlich bei jedem R-Befund dokumentiert.

## 6. Empfohlene Umsetzung und Abnahme

1. **Daten-/Anzeigeintegrität:** F01/F02/F03/F08 zuerst schließen. Die sechs lokalen Reproduktionen als kleine, gezielte Regressionstests übernehmen; Testfälle sollen beobachtbares Verhalten prüfen.
2. **Ausführungs- und Wiederanlaufpfade:** F04/F05/F11/F12 schließen. Lebenszyklus des Servers zentralisieren: Start, Recovery, Worker-/Scheduler-Loops, Stopp und Fehlerzustände.
3. **Zugangs- und Ressourcenvertrag:** F06/F07/F17/F19 vor öffentlicher Betriebsfreigabe lösen. Öffentliche Demoaktionen von globalen Admin-/Kostenentscheidungen unterscheiden und Grenzen technisch erzwingen.
4. **Korrekte Inspektion:** F10/F13/F14/F15/F18/F20/F21 schließen. Teilfehler und unvollständige Ergebnisse müssen sichtbar bleiben; keine Erfolgsanzeige ohne passenden Nachweis.
5. **Bereinigung und Doku:** F22/F23 bearbeiten. Erst anschließend ältere Erledigt-Markierungen mit konkreten Testnamen und Ergebnissen aktualisieren. Änderungen an Kernverträgen und Demo-Einschränkungen getrennt dokumentieren.

Eine erneute Freigabe sollte pro Befund Codeänderung, spezifischen Regressionstest und verbleibende Grenzen nennen. Ein grüner Gesamttestlauf allein ersetzt die fehlenden Fehlerpfadtests nicht.

## 7. Schrittweise Umsetzung vom 18. Oktober 2026

Umgesetzt wurden zuerst Datenintegrität und Parser, anschließend Admin-Journal und Lebenszyklen, dann Transport-/Ressourcengrenzen, Historienabfragen und Bereinigung. Bereits vorhandene Änderungen im Arbeitsbaum wurden erhalten. Es wurden keine Dependencies installiert, keine Modelle aufgerufen und keine externen Dienste veröffentlicht. Änderungen an laufenden fremden Test-/Demo-Prozessen gehörten nicht zu dieser Umsetzung.

### 7.1 Nachweis je Befund

| Befund | Status | Umsetzung | Gezielter Nachweis |
|---|---|---|---|
| F01 | Erledigt | `ThreadSequence` je Thread; exklusiver transaktionaler Take, Msg/Task und neuer Zählerstand gemeinsam committed. Atomare optionale `write(..., {unique})`-Prüfung schützt die Erstanlage auch bei konkurrierenden Engines und über RPC. Anzeige dedupliziert nach Msg-ID; alte Sequenzkollisionen bleiben sichtbar und erscheinen als `integrityIssues`. | Zwei Engines, acht parallele Submits, zwei Antwortworker, paralleler Retry, abgebrochener Write ohne verbrauchte Sequenz, Fork-Sequenz; lokaler/RPC-Singleton einschließlich reserviertem Entry; alte Kollision bleibt sichtbar. |
| F02 | Erledigt | H1–H6 und eingerückte Überschriften; unbekannte Blockzeilen werden als Text konsumiert. | `#### Heading`, `| orphan`, `#invalid`, Einrückung und EOF im tatsächlichen Renderer. |
| F03 | Erledigt | Hostinternes dauerhaftes Befehlsjournal mit kanonischer Argument-/Principal-Bindung, Ergebnis und Zuständen; gemeinsame laufende Promise je ID und serialisierte Web-Befehle. Keine 10.000er-Abschneidung. Enrollment und Rotation committen Wirkung und Ergebnis atomar. Unterbrochene andere Befehle werden als `needsReview` angezeigt; keine automatische Neuausführung. Fehlgeschlagene IDs bleiben terminal. | Ergebnisgleichheit bei Parallelität und SQLite-Close/Reopen, Konflikt bei anderen Argumenten, Wiederaufbau von 10.001 Commands, unterbrochener Befehl löst keine neue Wirkung aus. |
| F04 | Erledigt | Serialisierter Run-Advance-Loop, erster Durchlauf beim Start, Wiederholung alle 250 ms nach Abschluss; Fehler je Run isoliert und im Overview sichtbar. Shutdown wartet auf laufenden Durchlauf. | Fällige Pause wird ohne weiteren Nutzerbefehl wirksam. |
| F05 | Erledigt | Initiales Reconcile und periodischer WorkerSupervisor; persistente Control-Schlüssel halten die Pin-Identität stabil. Shutdown stoppt Loops vor Harness-Close. | Persistiertes Assignment ist nach Controller-Reinitialisierung ohne `setWorkers` aktiv. |
| F06 | Erledigt | Peer-Enrollment und Web-Login getrennt. Web-Login akzeptiert ausschließlich das konfigurierte Passwort; kein Peer-Token verleiht Web-Adminrechte. Die langlebigen `Enroll`-Einträge behalten Hash, Rolle, Peer-Bindung und Lease für das eigentliche Enrollment-RPC. | Member-Token wird im Controller und HTTP-Login abgelehnt. Keine zusätzliche RAM-Tokenliste mehr. |
| F07 | Erledigt | Kein Passwort-Fallback in Controller, UI oder Compose. Ohne Konfiguration bleibt Web-Login deaktiviert; Compose verlangt ein Passwort. Admin-/Control-Schlüssel werden im privaten Host-Dokument aufbewahrt. Rotation ersetzt Schlüssel und widerruft Vorgänger in einem Commit. Journal-Ergebnisse werden mit AES-GCM gespeichert. | Gleicher Public Key nach SQLite-Reopen; genau ein aktiver Admin-Key vor/nach parallelem Rotations-Replay; altes Standardpasswort abgelehnt. |
| F08 | Erledigt | Presence-Ersetzung unter einem Space-Mutex und einer Transaktion; fachliches Replay vor Löschung, stabile Fingerprint-Prüfung. | Zwei Engines mit gleichem Join, identischer Lease und genau einem Entry; abweichender Retry entfernt nichts. |
| F09 | Erledigt | Gemeinsamer Client-Lifecycle mit 10-s-Refresh, vollständigen Metadaten und 1,5-s-Reconnect. Effect reagiert auf Session, Teilnehmer und Thread; HTTP-Polling nur bei fehlender WS-Verbindung. | Tatsächlicher Lifecycle-Helfer mit kontrollierten Timern über mehr als eine Lease, Metadatenwechsel, Disconnect und Cleanup. Kein Browser-E2E-Nachweis. |
| F10 | Erledigt | `SearchResult` speichert Frage und Parent; Snapshot übernimmt beide auch ohne SearchTask. | Abgeschlossene Suche aus Thread `t` behält Ursprung und Frage bei neuer Engine. |
| F11 | Erledigt | Hub lädt bestehende Sessions; kontrollierter Queue-Drain unabhängig von HTTP/WS, keine überlappenden Scheduler-Durchläufe. Abgebrochene Tasks werden erneut verarbeitet. Modellzeitbudget höchstens 20 s mit AbortSignal; Antworttransaktion 60 s, Sequenzreservierung erst nach Antwortgenerierung. Reminder-Replay verwendet denselben langlebigen Job. | Pending Task vor Hub-Close, Wiederaufnahme und einmaliger Commitfehler; langsamer Generator wird abgebrochen und deterministisch abgeschlossen. SQLite-Stufe prüft Alarm nach Reopen. |
| F12 | Erledigt | Gemeinsame Initialisierungs-Promise je normalisierter Session-ID. | Parallele Erstzugriffe liefern exakt dasselbe Session-Objekt; Seed erfolgt nur einmal. |
| F13 | Erledigt | Explizit unveränderliche Berichtskopie statt ausführbarer Wiederherstellung. Gesamter Stage-Snapshot inklusive Pending-/Such-/Timerdaten als `ChatReport` gespeichert; Thread/physische Msg für Inspektion. Ersatz in einem Host-Commit, keine ausführbaren Tasks/Timer im Spiegel. Projektionen besitzen `projectionOf`, keine ID-Substring-Heuristik. | Zweimaliger tatsächlicher Stage-Lauf, konstante Nachrichtenzahl, sechs sichtbare v1-Nachrichten; Mutationen auf Berichtssession abgewiesen. |
| F14 | Erledigt | Historienabfragen berücksichtigen alle konfigurierten Shards, auch während Cooldown. Ein Ausfall liefert `complete:false`, `exhausted:false`, Fehler und unveränderte Cursor. UI zeigt Fehler und behält bisherige Ergebnisse. | Injizierter Shard-Ausfall, abgewiesene Seite, anschließender Retry liefert wieder die jüngsten Treffer. |
| F15 | Erledigt | Dauerhafter verketteter Post-Index, atomar mit jedem Post geschrieben. Cursor je Shard; maximal 512 geprüfte Knoten und 200 Ausgabe-Posts. Merge setzt bei nicht ausgewählten Treffern fort. Dieselbe Abfrage für Feed, Agent und KI; Filteransichten besitzen Fortsetzung. Migration alter Posts ist in begrenzten Commits wiederaufnehmbar und bis Abschluss nicht als fertiger Index sichtbar. | Zwei-Shard-Seiten ohne fehlende/doppelte IDs; Migration über mehrere Commits, injizierter Abbruch und Wiederaufnahme ohne doppelte Indexknoten. Keine Million-Post-Lastabnahme. |
| F16 | Erledigt | Transaktion außerhalb des try geführt; Fehler vor Commit aborten sofort. Seit dem Durable-Batch-Umbau stehen Follow-up-SwarmTasks direkt atomar mit dem Post im Abschlusscommit; bestehende `PostEffect`-Einträge werden weiterhin abgearbeitet. Cacheupdates erst nach Commit; kein nachgelagerter Fehler wiederholt den ursprünglichen Post. | Injizierter Fehler im Post-/Follow-up-Abschluss: Reservierungen wieder freigegeben, kein Phantompost, genau ein ursprünglicher Post, Folgeantwort und konsistenter Historienindex. Ergänzende Commit-/Recovery-Nachweise siehe Abschnitt 7.4. |
| F17 | Erledigt | Strikte Handshake-/Mask-/Opcode-/FIN-/RSV-/UTF-8-/Close-Prüfung; 1 MiB Nachricht, 1.024 Fragmente, begrenzte Eingangsqueue und Socket-Schreibpuffer. Frühe Frames bleiben bis Handlerbereitschaft gepuffert; Handler laufen geordnet. Attach-Rejections schließen Verbindung. | Echte codierte Frames über Duplex: früher Text, Fragmentierung, unmaskiert, unerwartete Continuation, fragmentiertes Controlframe, ungültiges UTF-8, Serie leerer Fragmente; ausgehender Backpressure und fehlerhafter Handshake. |
| F18 | Erledigt | Abbruch-/Invalidierungsfunktion für Artikel-Fetch; `response.ok` und sichtbarer Fehlerzustand. Auch ein Fetcher, der Abort ignoriert, kann alte Inhalte nicht mehr veröffentlichen. | Verzögerte Antworten B vor A, 404 und Netzfehler im tatsächlichen Loader. Kein Browser-E2E-Nachweis. |
| F19 | Erledigt | Explizite Aktivierung von Live-LLM, gemeinsames Budget von sechs Aufrufen/min, zwei gleichzeitig und 400 Ausgabetokens/Aufruf. Globale Modelländerung benötigt Admin+CSRF. Session-/Space-/Client-/WS-/HTTP-Limits, einstündige Session-Gültigkeit, serialisierte Stage-Läufe. Uploadquote 64 MiB/256 Dateien, 24-h-Ablauf und serialisierte Aufnahme. | 64 parallele Session-Anlagen, 65. abgewiesen; parallele Uploadquote und Retention; HTTP-401/403 für Modelländerungen; LLM in sämtlichen Tests aus. Kein echter kostenpflichtiger Provider-Test. |
| F20 | Erledigt | Gemeinsame `validateSieveResult`-Prüfung für Collector und Exporter. Genau ein Ergebnis je Task und Member; identische Repliken akzeptiert, widersprüchliche Member-Ergebnisse abgewiesen. | Ungültiger Bereich, doppelte Ergebnisse, identische Mehrmember-Ergebnisse und bestehende Sieve-Beispieltests. |
| F21 | Erledigt | Atomar eindeutige Thread-ID, fachliches Replay mit Eingabeprüfung, reale Erstellzeit. Fork benötigt vorhandenen Parent, ganzzahlige nichtnegative Grenze innerhalb der Historie und neue ID. Unveränderliche Parent-Verweise verhindern nachträgliche Zyklen; Altzyklen werden als Fehler gemeldet. | Doppelte IDs unter Parallelität, anderer Request, fehlender Parent, negative/gebrochene/zu große Grenze, gültiger Fork und korrekte erste eigene Sequenz. |
| F22 | Erledigt | Aufgeführte Imports, wirkungsloser Inspect-State und unbenutzte Setter entfernt; feste Sieve-Werte bleiben explizite Konstanten. Unbenutzte Swarm-Parameter und durch Vereinheitlichung entfallene Wrapper entfernt. | Zusätzlicher noUnused-Lauf meldet keine Dateien in `help-site/` oder `examples/sieve.ts`; vorhandene separate Core-Warnungen werden nicht als bereinigt ausgegeben. |
| F23 | Erledigt | Ein transportneutraler Command-Dispatcher; einheitliche Defaults und Fehler für unbekannte Aktionen. Sieve-Prüfung gemeinsam. Ein Corpus-Build im npm-/Docker-Buildpfad. Standalone nutzt ausschließlich eigene Assets; Next hat einen ausdrücklich gewählten Auslieferungsmodus. Produktionsprüfung baut vorher frisch. | HTTP-Fehlerfall und Dispatcher-Test, tatsächliche Stufen v1–v6, gemeinsame Sieve-Tests, frischer Next-Build mit SSR-Test. Alte Faux-Pipelines bleiben als Semantiktests bezeichnet. |

Die neuen spezifischen Tests liegen in [`help-site/tests/regressions.test.ts`](../../help-site/tests/regressions.test.ts); bestehende HTTP-/Stufen-/Shard-Tests in [`help-site/tests/help-site.test.ts`](../../help-site/tests/help-site.test.ts) wurden um tatsächliche Zugriffs- und Dispatcher-Fehlerfälle ergänzt. Der aktuelle Betriebsvertrag einschließlich Limits und `needsReview` steht in der [Hilfesystem-README](../../help-site/README.md#runtime-contract-and-restart). Die optionale atomare Unique-Prüfung ist in der [API](../api.md) beschrieben.

### 7.2 Ergänzende Korrekturen aus der Umsetzung

Im während der Arbeit bereits anderweitig veränderten `src/core.ts` war eine neue Expiry-Watermark-Optimierung vorhanden. Ein nach Reopen unbekannter Watermark wurde wie `Infinity` behandelt; dadurch unterblieb der erste notwendige Entry-Sweep. Korrigiert wurden ausschließlich der kalte Erstscan und die Behandlung unbekannter Watermarks beim Import. Ein gezielter Test rekonstruiert einen gespeicherten Zustand ohne Cache und prüft dessen Ablauf.

Der bestehende Reaper-Integrationstest nahm außerdem an, dass mehrere asynchrone Setup-Schritte sicher unter einer 150-ms-Lease bleiben. Unter paralleler Testlast lief die Lease bereits vor der ersten Assertion ab; bei fehlgeschlagener Assertion fehlte das Cleanup. Der Test verwendet jetzt eine kontrollierte semantische Uhr, wartet per reiner Snapshot-Inspektion auf den Hintergrund-Reaper und räumt im finally auf.

### 7.3 Aktuelle Prüfung und verbleibende Grenzen

Die folgenden Ergebnisse gelten für die Umsetzung, nicht für die historische Prüfung in Abschnitt 5:

| Prüfung | Ergebnis |
|---|---|
| Root-Typecheck `npm run typecheck` | erfolgreich |
| Help-Typecheck `tsc -p help-site/tsconfig.json --noEmit --incremental false` | erfolgreich |
| Hilfesystemtests mit `PHI_SPACES_LLM=0` | 26 Tests: 25 bestanden, 1 bewusst ausgelassener separater Next-Produktionsfall |
| `PHI_SPACES_LLM=0 npm --prefix help-site run test:production` | frischer Corpus-/Standalone-/Next-Build erfolgreich; anschließender Next-SSR-Test bestanden |
| `PHI_SPACES_LLM=0 npm run test:examples` | 158 Tests, 60 Suites, alle bestanden |
| `PHI_SPACES_LLM=0 npm test -- --test-concurrency=4` | 731 Tests: 730 bestanden, 1 Bootstrap-Kopie-Test übersprungen, 0 Fehler |
| Zusätzlicher noUnused-Diagnoselauf | keine Befunde im Hilfesystem/Sieve; 13 bereits vorhandene Befunde in separaten Core-Dateien |

Logs der lokalen Läufe: `/tmp/phi-spaces-fixes-help-final.log`, `/tmp/phi-spaces-fixes-production.log`, `/tmp/phi-spaces-fixes-examples-final.log`, `/tmp/phi-spaces-fixes-root-final.log` und `/tmp/phi-spaces-fixes-unused.log`. Diese temporären Dateien sind keine dauerhaft versionierte CI-Evidenz. Frühere Läufe hatten Fehler durch den inzwischen korrigierten kalten Expiry-Cache, den zeitabhängigen Reaper-Test und eine strengere Sieve-Fehlermeldung; die Tabelle nennt die danach ausgeführten erfolgreichen Läufe.

Die Umsetzung schließt die beschriebenen Anwendungsfehler mit den genannten lokalen Nachweisen. Sie ist weiterhin **keine** Browser-E2E-, Container-, Produktiv-, Multi-Host-, Stromausfall- oder kostenpflichtige Provider-Abnahme. Docker-Dateien wurden angepasst, aber keine Container gebaut oder gestartet. Der Bootstrap-Test mit echter Store-Kopie bleibt ohne `PHI_SPACES_BOOTSTRAP_COPY` bewusst übersprungen.

Bewusste Grenzen: `needsReview` verlangt bei unklarem Ausgang eine fachliche Prüfung statt einer Exactly-once-Behauptung über mehrere Controller hinweg. Stage-Spiegel sind Berichte und keine ausführbaren Backups. Die erstmalige Historienmigration benötigt für das Sortieren linearen Speicher; im Space selbst bleiben ID-Probes und Commitkosten von der Entry-Zahl abhängig. Ein Upload-Retentionlauf entfernt nur generierte Dateien und erfolgt beim nächsten Upload; Chatverläufe werden bei Session-Ablauf nicht automatisch gelöscht und zählen weiter zum Kontingent. Die Modellbudgetgrenzen sind lokale Prozessgrenzen, kein mandantenübergreifendes Abrechnungssystem.

### 7.4 Nachtrag: echte Durable-Batches im SocialSwarm-Worker

**Status: Erledigt (Implementierung und lokale Prüfung).** Kein Deployment und keine Lastabnahme des produktiven 34k-Entry-Stores.

Die bisherige logische Space-Transaktion war kein Storage-Batch: jeder `PhiSpaces.take`/`write`/Transaktionsaufruf öffnete separat `host.commit`. Insbesondere benötigte `appendHistory` drei solcher Aufrufe pro Post; Post, Kanalzähler, Outbox und Taskreservierung kamen hinzu. Damit blieb die Dokumentserialisierung trotz mehrerer Tasks pro Space-Transaktion im Hot Path.

Umgesetzt in [`batch.ts`](../../help-site/server/social/batch.ts) und [`swarm.ts`](../../help-site/server/social/swarm.ts):

1. Ein Dispatcher reserviert bis zu vier Tasks in **einem** Durable-Commit. Er verwendet weiterhin `core.createTxn` und `core.probe`, also die normalen Reservierungs-, Lease- und CompletionProfile-Regeln. Die Transaktion gilt 45 Sekunden.
2. Text-, Zielpost- und Modellvorbereitung laufen **außerhalb** des Durable-Callbacks. Höchstens ein Modellaufruf pro Batch; die Worker-Wartezeit ist auf 20 Sekunden begrenzt. Ein nicht kooperativer Custom-Provider kann danach weiterlaufen, sein verspätetes Ergebnis wird aber nicht veröffentlicht.
3. Ein zweiter Durable-Commit schreibt alle Posts/Likes, History-Knoten und Folgeaufträge, ersetzt den History-Head einmal und jeden betroffenen Kanalzähler einmal und führt `core.commitTxn` aus. Die atomare Commit-Bytegrenze bleibt wirksam. Es wird weder direkt an der Entry-Liste vorbei geschrieben noch die Completion-Prüfung umgangen.
4. Neue Follow-up-SwarmTasks stehen direkt im Abschlusscommit, statt einen weiteren Outbox-Durchlauf zu benötigen. Vorhandene `PostEffect`-Entries bleiben kompatibel und werden über den alten Pfad geleert. Feed-Caches und Antwortbeobachter werden erst nach erfolgreichem Abschluss aktualisiert/gestartet. Doppelte Likes im selben Batch werden erkannt.
5. Fachliche Fehler rollen den gesamten Abschluss zurück und lösen einen expliziten Abort der Reservierung aus. Bei Byteüberschreitung halbiert sich die Batchgröße bis auf eins; ein weiterhin fehlerhafter Task wird nicht bestätigt und mit Warnung erneut versucht. Ein Storage-Fehler vergiftet weiterhin die Session; nach gescheiterter Bereinigung stoppt der Worker, statt unbestätigt weiterzuschreiben. Wiederöffnung/Recovery ist dann erforderlich.
6. Eine Snapshot-Vorprüfung verhindert normale Leerqueue-Commits. Zwischen erfolgreichen Batches liegt ein 25-ms-Yield, bei leerer Queue eine 500-ms-Pause. Snapshot-Scans sind weiterhin nicht kostenlos.

Gezielte Nachweise in [`swarm-batch.test.ts`](../../help-site/tests/swarm-batch.test.ts):

| Prüfung | Nachweis |
|---|---|
| Echte Storage-Bündelung | Vier Tasks einschließlich Post, History, Zählern und Folgeauftrag: **genau zwei `Storage.commit`-Aufrufe**, also 0,5 Worker-Commits pro Task bei vollem Vierer-Batch. |
| Tatsächlicher Dispatcher | Ein initialisierter Hub verarbeitet vier gemeinsam eingestellte Posts mit genau zwei Worker-Commits, vier sichtbaren Feed-Posts und ohne neue `PostEffect`-Entries. |
| Atomarität/Completion | Fehlendes Ergebnis verwirft sämtliche Posts, History-Knoten und Zähler; Abort gibt alle vier Tasks frei, Wiederholung erzeugt genau vier Posts. |
| Byte-Limit | Vier große Posts überschreiten das Commitbudget ohne sichtbare Teilresultate; dieselben Tasks lassen sich nach Abort einzeln vollständig abschließen. |
| Gemischte Ergebnisse | Post-/Like-Batches erfüllen die CompletionProfile-Prüfung und erhalten korrekte Kanalgesamtzahlen über mehrere Batches. |
| Storage-Fehler | Injizierte Storage-Ablehnung sperrt danach Abort und weitere Reservierungen als vergiftete Session; kein Async-Fallback. |
| Langsamer Provider | Auch ein Generator ohne eigene Deadline beendet die Worker-Wartezeit; ein rechtzeitiges Ergebnis bleibt erhalten. |
| SQLite-Neuöffnung | Eine offene Reservierung bleibt nach Close/Reopen reserviert und kann explizit abgebrochen werden; nach erneutem Abschluss und weiterer Neuöffnung genau ein Post/History-Knoten, keine erneute Taskverarbeitung. Das ist kein Kill-/Stromausfalltest. |

Die vorhandene F16-Fehlerinjektion wurde auf den tatsächlichen Durable-Abschluss verlegt: Post- und Follow-up-Fehler hinterlassen weder Phantomcache noch doppelte Posts und die Antwort wird nach Wiederholung erzeugt. Der F15-Migrationstest berücksichtigt den zwischenzeitlich eingeführten internen Retry transienter Fehler; er prüft Unvollständigkeit während der Unterbrechung sowie die idempotente Fertigstellung.

Aktuelle lokale Prüfungen des Nachtrags:

- Root- und Help-Typecheck erfolgreich.
- Help-Suite: 34 Tests, davon 33 bestanden und der separate Next-SSR-Fall bewusst übersprungen; darunter acht neue Batch-Tests.
- Root-Suite: 737 Tests, davon 736 bestanden, ein optionaler Bootstrap-Kopie-Test übersprungen, keine Fehler.
- Beispiele mit `--test-concurrency=1`: 158/158 bestanden. Zwei vorherige parallele Läufe scheiterten ausschließlich am unveränderten Golomb-BitSet-Zeitlimit (109 bzw. 119 ms statt unter 100 ms); die Grenze wurde nicht aufgeweicht.

Logs: `/tmp/phi-spaces-help-batch-final.log`, `/tmp/phi-spaces-root-batch-tests.log`, `/tmp/phi-spaces-examples-batch-serial.log`; temporäre lokale Evidenz, kein versioniertes CI-Artefakt. Der frühere Next-Produktionsnachweis aus Abschnitt 7.3 wurde für diesen rein serverseitigen Nachtrag nicht erneut ausgeführt.

**Verbleibende Performance-Grenzen:** Die Zähltests messen echte Storage-Aufrufe, nicht einen pauschalen CPU-/Durchsatzfaktor. Ein einzelner Commit serialisiert weiterhin das große Dokument, und Core-Operationen können die Entries linear durchsuchen. Producer-Intents, Remote-RPCs, Seeds und alte Outbox-Einträge verwenden weiterhin ihre bisherigen Aufrufpfade; deren Commits sind nicht in den zwei Worker-Commits enthalten. CPU, Event-Loop-Verzögerung sowie HTTP-p95/p99 auf dem großen Store und auf `big` wurden nicht gemessen. Die beobachteten 4:38 Minuten Offline-Migration stammen aus der Nutzermeldung, nicht aus diesem Testlauf. Kein Container/Host wurde neu gestartet oder veröffentlicht.

### 7.5 Abschluss der Help-Corpus-Konsistenzkorrekturen

**Status: Erledigt (lokale Umsetzung und Prüfung).** Die zusätzlichen Befunde C01–C14,
acht neue zweisprachige Praxisleitfäden und alle noch offenen Betriebs-/Veröffentlichungsgates
stehen im [detaillierten Abschlussbericht](analyse-hilfecorpus-konsistenz-2026-10-18.md).

- [x] API-Schemata, Codebeispiele, Mailbox-/Snapshot-Semantik und Stufentopologie korrigiert.
- [x] Corpus-/Link-/Anker-/Sprachprüfung, echte API-Signaturen und 60 kompilierte TS-Beispiele integriert.
- [x] Navigation, Suchfilter, Sprach-/Stufen-URLs, Renderer und Index-Fehlerbehandlung korrigiert.
- [x] Vollständiges Tutorial und Live-Synchronisationsbeispiel einschließlich Fehler-/Delete-Fällen getestet.
- [x] Shutdown-Rennen und Testisolation behoben; Help-Suite beendet sich sauber.
- [x] Standalone-React-Start korrigiert; frischer Produktionsbuild und SSR-Test bestanden.
- [x] Root-/Help-README-Sprachversionen aktualisiert, Experimental-Hinweis und MIT-Lizenz ergänzt.
- [x] Erledigt-Markierungen und Dokumentationsindex mit aktuellem Nachweis abgeglichen.

Aktueller Corpus: 45 Artikel/90 Sprachdatensätze, neun Bereiche, 14 API-Gruppen.
Help-Suite: 44 bestanden und ein separat erfolgreich geprüfter SSR-Fall übersprungen.
Root: 740 bestanden, ein optionaler Bootstrap-Kopie-Test übersprungen; Beispiele 158/158.
Die vorherigen Abschnitte dokumentieren ihre jeweiligen historischen Prüfläufe. Browser-Smoke-Tests
ergänzen jetzt die lokalen Nachweise; vollständige Browser-/Geräte-, Container-, Großstore- und
Zielbetriebsabnahmen bleiben ausdrücklich getrennt und sind im Abschlussbericht aufgelistet.
