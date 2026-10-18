# Beispiele: Implementierung und Nachweise

Stand: 2026-10-07. Verbindlicher Einstieg für die Beispiele. Alle Implementierungen verwenden heute **einen
lokalen Harness pro Prozess und Storage**. Mehrere Conversations sind keine Federation.
Der [Föderationsplan v3](federation-plan-v3.md) beschreibt zukünftige Infrastruktur.

| Beispiel | Implementierung | Nachweis und Grenze |
|---|---|---|
| Master/Worker | [workers.ts](../examples/workers.ts) | geskriptete Write/Take-Demonstration; kein Bild-Resize, keine Crash-Wiedervergabe |
| Blockierendes Take | [blocking-tool.ts](../examples/blocking-tool.ts) | geskripteter Tool-Aufruf; Host schreibt später einen Job im selben Prozess |
| Sensor-Pipeline | [sensor-pipeline.ts](../examples/sensor-pipeline.ts) | echte Funktionen, Konkurrenz, Lease-Ablauf und Rollback lokal getestet |
| Chat | [chat.ts](../examples/chat.ts) | tatsächlicher geskripteter Ring getestet; Live-Modell nicht abgenommen |
| arXiv-Recherche | [arxiv-research.ts](../examples/arxiv-research.ts) | tatsächlicher Runner mit geskriptetem Modell und JSONL getestet; echte Quellen-/Modellqualität offen |
| Dark-Energy-Recherche | [dark-energy-research.ts](../examples/dark-energy-research.ts) | tatsächlicher Runner einschließlich Klassifikation und Abstract-Zusammenfassung geskriptet getestet |
| Golomb | [golomb.ts](../examples/golomb.ts) | tatsächliche Ordnung-4-Suche, Ergebnisvalidierung und persistente Wiederaufnahme getestet |
| Primzahlsieb | [sieve.ts](../examples/sieve.ts) | unabhängiger Referenzvergleich, Txn-Rollback, Lease-Recovery und JSONL-Reopen |
| Cache | [cache.ts](../examples/cache.ts) | lokaler atomarer Ersatz, CAS, TTL und JSONL-Reopen; keine Replikation |
| Space-Chat (v1–v6) | [help-site/examples/](../help-site/examples) | reine Tuple-Space-Architektur (`SpaceChatEngine`): Presence-Leases, `ChatTask`+CompletionProfile, `ScheduledJob`/`TimerLock`-Alarme; Stufen lokal bis föderiert |

## Zwei verschiedene Chat-Architekturen

`examples/chat.ts` und `help-site/examples/shared/chat-core.ts` (`SpaceChatEngine`) sind **absichtlich verschiedene
Paradigmen** und kein Duplikat:

- `examples/chat.ts` nutzt `pi-spaces` als Ereignis-Bus **zwischen langlebigen `pi-durable`-Conversations**
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
npm run example:blocking
npm run example:space-chat
npm run help
```

Live-Beispiele benötigen Zugangsdaten und verursachen Modellkosten. Gemäß AGENTS.md werden sie erst nach
Freigabe ausgeführt. Der arXiv-Netzzugang und wissenschaftliche Ergebnisqualität sind durch Faux-Tests nicht
validiert. API-Parser und Datenvertrag werden mit lokalen Fixtures geprüft.

## Space-Regeln für Beispiele

Entries sind `{type, fields}`. Feldfilter gehören unter `fields`. Es gibt kein Update, keine Unique-Keys und
kein Agenten-Tool `space_count`; Host-Code besitzt `count()`. Null in Templates ist ein Wildcard und bedeutet
nicht „Feld fehlt“. `readAll` liefert maximal 1000 Entries; `space_list` standardmäßig 100, maximal 1000.
Eine Entry-Lease lässt einen Entry verschwinden; nur eine Take-Transaktion erlaubt dessen Rückgabe nach Abort.

Ein Take unter einer Transaktion ist eine Reservierung. Erst der erfolgreiche Commit entfernt den Entry
dauerhaft. Nach Abort/Ablauf darf er erneut genommen werden. Task-Claims deduplizieren Tool-Replays; sie machen
externe Wirkungen nicht allgemein exactly-once. Dauerhaftigkeit hängt vom Storage ab: MemoryStorage ist flüchtig.

## Atomare Forschungsausgaben

[research-support.ts](../examples/research-support.ts) definiert `researchSpaces`. Ergebnis-Entries und
Abschlussmarker benötigen die aktive, dem Agenten gehörende Transaktion mit der passenden reservierten Aufgabe.
Fehlende/falsche Transaktionen werden serverseitig abgewiesen. Alle Writes einer Phase bleiben bis Commit
unsichtbar. Die einfache arXiv-Pipeline schreibt auch PresentTask unter der AnalyzeTask-Transaktion.

Die Ausführung verlangt ein frisches, leeres State-Verzeichnis. Ein exklusiver Marker verhindert zwei Starts
im selben Verzeichnis. Vorhandener JSONL-Zustand kann untersucht werden, wird aber nicht automatisch als neuer
Lauf verwendet. Ein allgemeiner Resume-Modus für die Forschungsbeispiele ist nicht implementiert.

## Testumfang

Die ältere Suite prüft viele Space-Muster mit eigenen Skripten. Sie ist kein vollständiger Nachweis für die
jeweiligen CLI-Programme. [recovery.test.ts](../test/examples/recovery.test.ts) ergänzt Aufrufe der tatsächlichen
Implementierungen, JSONL-Reopen sowie gezielte Fehler. [Testübersicht](../test/examples/README.md).

Keine gemessenen Skalierungs-, Federation-, Netzwerkpartition- oder Produktionsbenchmarks vorhanden.
[v3-Ressourcenwerte](federation-plan-v3.md#411-ressourcenplanung-bei-mehreren-vps) sind Planungsgrößen,
keine nachgewiesenen Mindestanforderungen.

Details: [IoT](examples/iot.md), [Chat](examples/chat.md), [Recherche](examples/arxiv.md),
[Golomb](examples/golomb.md), [Historische Einordnung](examples/HISTORISCHE-REFERENZEN.md).
