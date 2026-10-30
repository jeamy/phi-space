---
standard: help_topic
id: help.topic.agent_tools_and_replay
title: "Die 8 LLM-Agent-Tools und Replay-Sicherheit"
short: "Wie KI-Agenten über space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify und space_lease sicher koordinieren."
tags: [tools, agent, replay, space_write, space_take, space_txn, space_wait, space_notify, pi-durable]
owner: tools
related: [help.topic.local_client_and_named_spaces, help.topic.examples, help.api.agent_tools]
since: 0.0.1
---

# Die 8 LLM-Agent-Tools und Replay-Sicherheit

## Überblick {#overview}

KI-Agenten benutzen einen Space über acht Werkzeuge, etwa zum Schreiben, Lesen und Übernehmen von Arbeit. Ein Agent kann mitten in einem Aufruf neu starten. Darum ist jedes Werkzeug so gebaut, dass eine Wiederholung nichts doppelt tut. Das Paket dafür ist optional: Der Space selbst läuft auch ganz ohne Agenten.

Zum Ausprobieren gibt es [Beispiele mit Agenten](help.topic.examples#agents).

### Technische Details {#technical-details}

Die Erweiterung `spaces` (`createSpaces(localSpaces(host))` im Paket `agent/`, npm-Name `phi-spaces-agent`) stattet `pi-durable`-Conversations mit 8 Werkzeugen aus, die sämtlich mit `replay: "safe"` laufen. Die Werkzeuge wirken auf einen getrennten Space-Host. Das Paket nutzt pi-durable, pi-ai und Chord in Version 1.4.0; Werkzeugergebnisse stehen in `output`, nicht mehr in `content`.

## Technische Referenz {#technical-reference}

| Tool | Parameter | Semantik & Schutz |
|---|---|---|
| `space_write` | `{ type, fields, types?, ttlMs?, txn? }` | Schreibt einen Entry unter der Request-Identität des Aufrufs; ein Tool-Replay erzeugt keinen zweiten Entry. |
| `space_list` | `{ id?, type?, fields?, limit?, txn? }` | Liest bis zu `limit` (Standard 100, max. 1000) passende Entries ohne Sperre, älteste zuerst. Ein reiner Lesevorgang ohne Request-Identität. |
| `space_read` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Blockierendes Lesen bis `timeoutMs` (gedeckelt auf 60 s); die erste Frist hält der Claim im Space über Replays hinweg. |
| `space_take` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Exklusives Entnehmen (oder Reservieren unter `txn`); der Claim im Space bewahrt den genommenen Entry bei Replay. |
| `space_txn` | `{ action: "begin" \| "commit" \| "abort", txn?, leaseMs? }` | Öffnet, committet oder verwirft eine Conversation-eigene Space-Transaktion. |
| `space_wait` | `{ type?, fields?, mode?: "take" \| "read", timeoutMs?, txnLeaseMs?, handback? }` | Nichtblockierendes Warten (auch `"forever"`); weckt die Conversation per Nachricht, sobald ein Treffer erscheint. |
| `space_notify` | `{ type?, fields?, ttlMs?, handback? }` | Abonniert zukünftige passende Entries als Nachricht an die Conversation, höchstens eine pro Sekunde; dazwischen liegende Writes kommen gebündelt mit Anzahl. Braucht einen Typ oder mindestens ein Feld. |
| `space_lease` | `{ action: "renew" \| "cancel", id, ms? }` | Verlängert oder beendet eine eigene Lease (Entry, Txn, Wait oder Notify). |

### Wie ein Aufruf wiederholbar bleibt {#replay}

Space und Agent teilen sich keinen Commit. Die Zusage „einmal“ entsteht deshalb in Schritten:

1. Vor dem ersten fachlichen Space-Aufruf legt das Werkzeug seine Request-Identität als Task-Memo im Agentenspeicher ab. Nur die Generation wird davor beim Space geholt.
2. Der Space speichert Wirkung und Ergebnis atomar unter dieser Identität.
3. Ein Replay findet das Memo und ruft dieselbe Operation wieder auf. Es bekommt das erste Ergebnis.
4. Die Generation je Conversation liegt im Agentenspeicher und wird 10 Minuten vor Ablauf ihrer Zulassung erneuert. Nimmt sie keine neuen Anfragen mehr an, wird ein noch nicht aufgenommener Aufruf mit `RequestExpired` abgelehnt, nie unter neuer Identität ausgeführt.

### Zwei getrennte Speicher {#two-stores}

Der Space liegt im eigenen Speicher, der Agent im Speicher von pi-durable. Beide dürfen im selben Prozess laufen, haben aber getrennte Commit-Grenzen. So überlebt der Space einen Neustart des Agenten und umgekehrt.

- **Agentenspeicher**: Der Worker und die mobile Laufzeit nutzen SQLite mit `synchronous=FULL`. Nur die Rechercheläufe der Beispiele nutzen JSONL mit `{ fsync: true }` und zusätzlichem Flush von Commit-Marker und Verzeichniseinträgen (`agent/src/storage.ts`). JSONL ist kein Speicher des Space.
- **Grenze**: Die Zusage setzt voraus, dass das Memo den Ausfall überlebt. Stabile Identitäten ersetzen keinen gemeinsamen Commit. Prozessabstürze sind getestet, ein echter Stromausfall nicht (`docs/agenten-stromausfalltest.md`).
- **Externe Dienste**: Ein nach einem Absturz wiederholter Modellaufruf kann erneut ausgeführt und berechnet werden.

### Getrennter Agentenprozess {#agent-process}

`DurableAgentClient` (`agent/src/durable-client.ts`) startet `durable-worker.ts` als Kindprozess und spricht über Node-IPC mit ihm (Protokoll in `durable-protocol.ts`). So gelangen keine pi-durable-Importe in die Anwendung, und das Harness dort kennt den Space nicht. Der Worker sichert seinen Speicher mit einer eigenen `.owner`-Datei gegen einen zweiten Prozess. Codemode-Chat und spaces-mmo nutzen diesen Weg; `CODEMODE_DURABLE_AGENT=0` und `SPACES_MMO_DURABLE_NPCS=0` schalten ihn ab.

### Upgrade auf pi 1.4.0 {#pi-140}

- Werkzeugergebnisse stehen in `output` statt `content`. Nachrichten an das Modell behalten ihre `content`-Struktur.
- pi-durable 1.4.0 migriert seine SQLite-Datenbank automatisch auf Schema 2. Danach lässt sie sich mit 1.3.0 oder älter nicht mehr öffnen. **Agentendatenbanken vorher sichern**, einschließlich WAL-Zustand.
- Das betrifft nur den Agentenspeicher. Format 2 des eigenen phi-spaces-Speichers ist davon unabhängig.

Details stehen in `docs/upgrade-pi-1.4.0.md`.

## Siehe auch {#see-also}

- [Beispiele zum Ausprobieren](help.topic.examples#overview)
- [Agent-Tools (spaces) & startService API](help.api.agent_tools)
