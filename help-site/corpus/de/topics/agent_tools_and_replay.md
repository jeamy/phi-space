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

Die Erweiterung `spaces` (`createSpaces(localSpaces(host))` im Paket `agent/`, npm-Name `phi-spaces-agent`) stattet `pi-durable`-Conversations mit 8 Werkzeugen aus, die sämtlich mit `replay: "safe"` laufen. Die Werkzeuge wirken auf einen getrennten Space-Host. `remoteSpaces(...)` richtet sie auf einen Space-Server anderswo ([unten](help.topic.agent_tools_and_replay#remote-spaces)). Das Paket nutzt pi-durable, pi-ai und Chord in Version 1.5.2; Werkzeugergebnisse stehen in `output`, nicht mehr in `content`.

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
- **Grenze**: Die Zusage setzt voraus, dass das Memo den Ausfall überlebt. Stabile Identitäten ersetzen keinen gemeinsamen Commit. Prozessabstürze sind getestet, ein echter Stromausfall nicht (`docs/agenten-stromausfalltest.en.md`).
- **Externe Dienste**: Ein nach einem Absturz wiederholter Modellaufruf kann erneut ausgeführt und berechnet werden.

### Agenten auf einem entfernten Space {#remote-spaces}

Die Werkzeuge können auch auf einem Space-Server anderswo wirken. `remoteSpaces(open)` gibt ihnen einen entfernten Space über eine Verbindung eines Agenten-Hosts (Rolle `agentHost`, `--agent-host` am Server). Jede Conversation handelt als eigener Agent `conversation-<id>`, mit eigenem Principal, eigener Mailbox, eigenen Claims und eigenem Budget für offene Anfragen. Der Host schickt diesen Namen mit jedem Aufruf als `frame.agent`; von jeder anderen Verbindung weist der Server ihn ab. Waits und Benachrichtigungen landen in der eigenen Mailbox der Conversation.

`eventPump(open, harness)` liest die Mailbox jeder beobachteten Conversation per Long Poll und übergibt jedes Ereignis einmal an die Conversation, unter `phi-spaces:<Mailbox-Epoche>:<seq>`. Eine Seite bestätigt er erst, wenn sie ganz übergeben ist, sodass ein Neustart nichts doppelt übergibt. Eine Conversation, die es nicht mehr gibt, gibt einen ihr übergebenen Take zurück. Ist der Space nicht erreichbar, sagt das der Prompt-Abschnitt, statt den Turn scheitern zu lassen.

Zwei Hosts nutzen das. Der Chat der Android-App (pi-termux-mobile) hat einen eigenen `phi-space-server` auf dem Handy: Der Dienst der App überwacht ihn neben node, sein Speicher liegt in den Dateien der App und er lauscht nur auf einem Unix-Socket. pi-serverd gibt die Werkzeuge seiner Conversations auf dieselbe Weise an einen Space-Server, und die Remote-Sitzungen des Handys laufen als Aufrufe über einen Space, ohne pi-server und pi-client. Details: `docs/m1-mobile.en.md`.

### Getrennter Agentenprozess {#agent-process}

`DurableAgentClient` (`agent/src/durable-client.ts`) startet `durable-worker.ts` als Kindprozess und spricht über Node-IPC mit ihm (Protokoll in `durable-protocol.ts`). So gelangen keine pi-durable-Importe in die Anwendung, und das Harness dort kennt den Space nicht. Der Worker sichert seinen Speicher mit einer eigenen `.owner`-Datei gegen einen zweiten Prozess. Codemode-Chat und spaces-mmo nutzen diesen Weg; `CODEMODE_DURABLE_AGENT=0` und `SPACES_MMO_DURABLE_NPCS=0` schalten ihn ab.

### Upgrades auf pi 1.4.0 und 1.5.2 {#pi-140}

- Werkzeugergebnisse stehen in `output` statt `content`. Nachrichten an das Modell behalten ihre `content`-Struktur.
- pi-durable 1.4.0 migriert seine SQLite-Datenbank automatisch auf Schema 2. Danach lässt sie sich mit 1.3.0 oder älter nicht mehr öffnen. **Agentendatenbanken vorher sichern**, einschließlich WAL-Zustand.
- Das betrifft nur den Agentenspeicher. Format 2 des eigenen phi-spaces-Speichers ist davon unabhängig.
- pi 1.5 rechnet eine Modellanfrage, die ein Absturz unterbrochen hat, gegen die Wiederholungsregel. Der Durable-Worker erlaubt eine Wiederholung, damit die Wiederherstellung nach einem Absturz weiter funktioniert, begrenzt durch das in seinem Speicher gehaltene Budget an Modellaufrufen je Job.

Details stehen in `docs/upgrade-pi-1.4.0.en.md`.

## Siehe auch {#see-also}

- [Beispiele zum Ausprobieren](help.topic.examples#overview)
- [Agent-Tools (spaces) & startService API](help.api.agent_tools)
