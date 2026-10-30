# Beispiele: Implementierung und Nachweise

Stand: 2026-10-18. Verbindlicher Einstieg für die Beispiele. Die Beispiele in `examples/` verwenden **einen
lokalen Harness pro Prozess und Storage**. Mehrere Conversations sind keine Federation; föderierte Stufen
liegen nur im Hilfesystem (v5/v6). Der [Föderationsplan v3](federation-plan-v3.md) ist umgesetzt; Stand und
Nachweise stehen im [Implementierungsstand](implementierungsstand.md) und den [Abnahmedokumenten](abnahme/ap3-abnahme.md).

| Beispiel | Implementierung | Nachweis und Grenze |
|---|---|---|
| Master/Worker | [workers.ts](../agent/examples/workers.ts) | geskriptete Write/Take-Demonstration; kein Bild-Resize, keine Crash-Wiedervergabe |
| Blockierendes Take | [blocking-tool.ts](../agent/examples/blocking-tool.ts) | geskripteter Tool-Aufruf; Host schreibt später einen Job im selben Prozess |
| Sensor-Pipeline | [sensor-pipeline.ts](../examples/sensor-pipeline.ts) | echte Funktionen, Konkurrenz, Lease-Ablauf und Rollback lokal getestet |
| Chat | [chat.ts](../agent/examples/chat.ts) | tatsächlicher geskripteter Ring getestet; Live-Modus (`--live`) vorhanden, nicht abgenommen |
| arXiv-Recherche | [arxiv-research.ts](../agent/examples/arxiv-research.ts) | tatsächlicher Runner mit geskriptetem Modell und JSONL getestet; echte Quellen-/Modellqualität offen |
| Dark-Energy-Recherche | [dark-energy-research.ts](../agent/examples/dark-energy-research.ts) | tatsächlicher Runner einschließlich Klassifikation und Abstract-Zusammenfassung geskriptet getestet |
| Golomb | [golomb.ts](../examples/golomb.ts) | tatsächliche Ordnung-4-Suche, Ergebnisvalidierung und persistente Wiederaufnahme getestet |
| Primzahlsieb | [sieve.ts](../examples/sieve.ts) | unabhängiger Referenzvergleich, Txn-Rollback, Lease-Recovery und JSONL-Reopen |
| Cache | [cache.ts](../examples/cache.ts) | lokaler atomarer Ersatz, CAS, TTL und JSONL-Reopen; keine Replikation |
| Space-Chat (v1–v6) | [help-site/examples/](../help-site/examples) | reine Tuple-Space-Architektur (`SpaceChatEngine`): Presence-Leases, `ChatTask`+CompletionProfile, `ScheduledJob`/`TimerLock`-Alarme; Stufen lokal bis föderiert |

## Zwei verschiedene Chat-Architekturen

`examples/chat.ts` und `help-site/examples/shared/chat-core.ts` (`SpaceChatEngine`) sind **absichtlich verschiedene
Paradigmen** und kein Duplikat:

- `examples/chat.ts` nutzt `phi-spaces` als Ereignis-Bus **zwischen langlebigen `pi-durable`-Conversations**
  (Aktor-Modell): jede Figur ist eine eigene Konversation mit Historie; der Space transportiert nur flache `Msg`-Benachrichtigungen.
- `chat-core.ts` (Stufen v1 bis v6 im Hilfesystem) realisiert den Chat **vollständig in Space-Primitiven**:
  zustandslose Worker ziehen `ChatTask`-Tupel transaktional, Präsenz sind Lease-Einträge, Alarme sind
  `ScheduledJob`+`TimerLock`. Kein Aktor-Framework, keine langlebigen Conversations.

CLI-Einstieg für die reine Tuple-Space-Variante ohne Web-Server: `npm run example:space-chat` (Stufe v1).

## Ausführung

```bash
npm run typecheck
npm test
npm run test:examples
npm run example
npm run example:pipeline
npm run example:chat
npm run example:golomb -- 4 --workers 2
npm run example:sieve -- 1001 4
npm run example:cache
npm run example:codemode-evolve -- --gens 6 --agents 8
npm run example:blocking
npm run example:dark-energy
npm run example:space-chat
npm run help
```

Sieb und Cache laufen ohne pi-durable auf dem eigenen Speicher. Mit `--remote` arbeiten sie über einen eigenständigen
Space-Dienst (`src/standalone.ts`), per Unix-Socket oder TCP:

```bash
npm run space-server -- --store /tmp/space.sqlite --listen unix:/tmp/space.sock
npm run example:sieve -- 1001 4 --remote unix:/tmp/space.sock
npm run example:cache -- --remote unix:/tmp/space.sock
```

Über den Dienst legt das Sieb alle Aufgaben eines Laufs in einer Transaktion an. Der Cache vergibt Versionen aus einem
Zähler je Namensraum. Neue Schlüssel schreibt er `unique`, damit zwei gleichzeitige erste `set` nicht beide gelingen.

`examples/codemode-evolve.ts` ist ein Experiment nach Art der Monte-Carlo-Methode: Viele zufällige Agentenbeiträge
(`CodeCandidate`, JavaScript-Quelltext) lösen eine Aufgabe (`CodeTask`: die ersten n Primzahlen). Evaluatoren nehmen
Kandidaten unter einer Transaktion, führen sie in einer QuickJS-Sandbox von `@earendil-works/pi-codemode` ohne Tools
aus und schreiben ein `CodeScore` (richtig? wie schnell?); der Host hält das beste Ergebnis als `CodeBest`, auf dem
die Agenten der nächsten Generation aufbauen. Ohne Modell lauf­fähig (Agenten sind Zufallsgeneratoren mit Seed); ein
LLM-Agent würde den Quelltext selbst schreiben. `@earendil-works/pi-codemode` ist eine Abhängigkeit des Projekts
(`PI_CODEMODE_DIR` wählt einen anderen Pfad); lässt es sich nicht laden, wird übersprungen. Gemessene Zeit ist Wandzeit und schwankt.

Live-Beispiele (`examples/chat.ts --live`, `npm run example:arxiv`) benötigen Zugangsdaten und verursachen
Modellkosten; [live-models.ts](../agent/src/live-models.ts) wählt Provider und Modell. Gemäß AGENTS.md werden
sie erst nach Freigabe ausgeführt. Der arXiv-Netzzugang und wissenschaftliche Ergebnisqualität sind durch
Faux-Tests nicht validiert. API-Parser und Datenvertrag werden mit lokalen Fixtures geprüft.

## Space-Regeln für Beispiele

Entries sind `{type, fields}`. Feldfilter gehören unter `fields`. Es gibt kein Update, keine Unique-Keys und
kein Agenten-Tool `space_count`; Host-Code besitzt `count()`. Null in Templates ist ein Wildcard und bedeutet
nicht „Feld fehlt“. `readAll` liefert maximal 1000 Entries; `space_list` standardmäßig 100, maximal 1000.
Eine Entry-Lease lässt einen Entry verschwinden; nur eine Take-Transaktion erlaubt dessen Rückgabe nach Abort.

Ein Take unter einer Transaktion ist eine Reservierung. Erst der erfolgreiche Commit entfernt den Entry
dauerhaft. Nach Abort/Ablauf darf er erneut genommen werden. Task-Claims deduplizieren Tool-Replays; sie machen
externe Wirkungen nicht allgemein exactly-once. Dauerhaftigkeit hängt vom Storage ab: MemoryStorage ist flüchtig.

## Atomare Forschungsausgaben

[research-support.ts](../agent/examples/research-support.ts) definiert `researchSpaces`. Ergebnis-Entries und
Abschlussmarker benötigen die aktive, dem Agenten gehörende Transaktion mit der passenden reservierten Aufgabe.
Fehlende/falsche Transaktionen werden serverseitig abgewiesen. Alle Writes einer Phase bleiben bis Commit
unsichtbar. Die einfache arXiv-Pipeline schreibt auch PresentTask unter der AnalyzeTask-Transaktion.

Ein neuer Lauf verlangt ein frisches, leeres State-Verzeichnis. Mit `--resume --dir <Verzeichnis>` öffnen
beide Rechercheprogramme einen kompatiblen vorhandenen Lauf ausdrücklich wieder. Die Topic-/Query-Konfiguration
wird übernommen; ausdrücklich abweichende Werte oder eine andere Laufart werden abgewiesen.
[research-run.ts](../agent/examples/research-run.ts) speichert die Laufidentität im Manifest und Team-IDs,
Modellauswahl und Phase in einem pi-durable-Dokument. Conversation-Erzeugung und ID-Eintrag sind ein Commit;
Startnachrichten besitzen stabile Request-IDs.

Phasenmarker und neue Aufgaben werden in derselben Space-Transaktion geschrieben. So entsteht bei Wiederaufnahme
auch dann keine zweite Aufgabe, wenn die erste schon konsumiert wurde. Der exklusive SQLite-Owner-Lock schützt
auch den Agentenspeicher vor einem zweiten Launcher und wird bei einem Prozessabsturz vom Betriebssystem freigegeben.
Ein fertiger Lauf kann seine Berichtdateien erneut ausgeben, ohne das Team neu zu starten.

```sh
node --experimental-strip-types agent/examples/arxiv-research.ts --resume --dir /pfad/zum/lauf
node --experimental-strip-types agent/examples/dark-energy-research.ts --resume --dir /pfad/zum/lauf
```

Resume macht abgelaufene Space-Transaktionen oder Request-Generationen nicht rückwirkend gültig.
Nicht abgeschlossene Phasen bleiben bei Zeitüberschreitung ein Fehler; sie werden nicht durch erfundene
Ergebnisse oder blind erneut erzeugte Aufgaben übergangen. Externe Modell-/Rechercheanfragen können nach einem
Absturz erneut ausgeführt werden. Live-Ausführung kostet Tokens und braucht eine eigene Freigabe.

## Testumfang

Die ältere Suite prüft viele Space-Muster mit eigenen Skripten. Sie ist kein vollständiger Nachweis für die
jeweiligen CLI-Programme. [recovery.test.ts](../test/examples/recovery.test.ts) ergänzt Aufrufe der tatsächlichen
Implementierungen, JSONL-Reopen, Resume nach SIGKILL während der Analyse sowie gezielte Fehler. Geskriptete Modelltests filtern Systemnachrichten vor der
Prüfung der letzten Nachricht (`m.role !== "system"`, siehe `test/examples/`). [Testübersicht](../test/examples/README.md).

Für die Beispiele selbst liegen keine Skalierungs- oder Produktionsbenchmarks vor. Systemweite NetBird-,
Partitions- und Lastnachweise stehen in [test/evidence](../test/evidence/) und den
[Abnahmedokumenten](abnahme/ap3-abnahme.md).
[v3-Ressourcenwerte](federation-plan-v3.md#411-ressourcenplanung-bei-mehreren-vps) sind Planungsgrößen,
keine nachgewiesenen Mindestanforderungen.

Details: [Sieb](examples/sieve.md), [IoT](examples/iot.md), [Chat](examples/chat.md), [Recherche](examples/arxiv.md),
[Golomb](examples/golomb.md), [Cache](examples/cache.md), [Analyse](examples/IMPLEMENTIERUNGS-ANALYSE-V2.md),
[Historische Einordnung](examples/HISTORISCHE-REFERENZEN.md).
