---
standard: help_api
id: help.api.agent_tools
title: "Agent-Tools (spaces) & startService – Replay-sichere LLM-Werkzeuge"
short: "Stellt KI-Agenten 8 replay-sichere Tools mit Request-Identität pro Aufruf und Ownership-Schutz bereit; startService betreibt Reaper und Zustellung."
tags: [spaces, createspaces, startservice, space_write, space_take, space_txn]
owner: tools
related: [help.topic.agent_tools_and_replay]
since: 0.0.1
---

# Agent-Tools (spaces) & startService – Replay-sichere LLM-Werkzeuge

## Überblick {#overview}

Diese Werkzeuge geben einem Sprachmodell Zugriff auf einen Space: schreiben, lesen, nehmen und warten. Wird ein Aufruf nach einem Absturz wiederholt, wirkt er trotzdem nur einmal. Das Paket ist optional; für einen Space ohne Agenten brauchst du es nicht.

## Technische Referenz {#technical-reference}

Die Werkzeuge kommen aus dem optionalen Agent-Paket (`agent/`, eigene Abhängigkeiten: pi-durable, pi-ai und Chord in 1.4.0). `createSpaces(localSpaces(host))` erzeugt die Erweiterung für die Agenten-Registry von `pi-durable`. Der Space liegt dabei nicht im Speicher der Agenten, sondern auf einem eigenen Host (dem eigenen Speicher). Er überlebt so einen Neustart der Agenten, und umgekehrt.

`startService(withEventSink(host, agentHost), ctx, { space? })` startet die Hintergrundschleife für Lease-Ablauf (`core.reap`) und die Zustellung an die Conversations der Agenten. Ein pi-durable-Harness 1.4 wird mit `withAgentEventSink(host, harness)` aus `agent/src/agent.ts` angebunden: Es ergänzt den Kontext, den Harness und Space unterschiedlich erwarten. `withEventSink` aus `phi-spaces` nimmt jede andere `EventSink`.

```ts
const spaces = createSpaces(localSpaces(host)); // the space: its own host
registry.install(spaces); // the agents' registry (pi-durable)
const stopService = await startService(withEventSink(host, agentHost), ctx);
```

## Die 8 Werkzeuge und ihre Sicherheit {#parameters}

| Tool | Zweck |
| --- | --- |
| `space_write`, `space_read`, `space_take` | Grundlegende Entry-Operationen; jeder Tool-Aufruf ist eine eigene Request-Identität des Spaces. |
| `space_list` | Auflisten sichtbarer Entries eines Spaces/Templates (read-only). |
| `space_txn` | Beginnen, committen oder abbrechen von Transaktionen aus dem Agenten heraus. |
| `space_wait`, `space_notify` | Langlebige Wünsche und Abos ohne den Agenten-Turn zu blockieren. |
| `space_lease` | `renew`/`cancel` für eigene Ressourcen. |

Jeder Tool-Aufruf erhält eine Request-Identität (die Generation der Conversation und die Task-ID des Aufrufs). Sie wird vor dem ersten Space-Aufruf im Speicher der Agenten festgehalten. Der Space speichert Operation und Ergebnis zusammen: Ein nach einem Absturz wiederholter Aufruf erhält das erste Ergebnis. Ein Aufruf, dessen Generation nicht mehr zulässt, wird abgewiesen (`RequestExpired`) und nie neu ausgeführt. Ohne verbundenen Agenten-Host warten Ereignisse im Postausgang des Spaces; nur für eine nicht mehr existierende Conversation werden sie verworfen. Nur `space_list` läuft ohne Request-Identität.

Jedes Werkzeug liefert sein Ergebnis seit pi 1.4.0 als `{ output: [{ type: "text", text }] }` mit JSON-Text (vorher `content`). `space_read` und `space_take` halten den Turn höchstens 60 Sekunden; `space_wait` wartet ohne Turn-Blockade, standardmäßig ohne Ende. `space_list` liefert höchstens `limit` Entries (Standard 100, Maximum 1000).

Werkzeugbeschreibungen und Prompt-Abschnitt sagen dem Modell, dass Entry-Inhalte Daten anderer Agenten sind und nie Anweisungen. Eine Auszeichnung im Ergebnis selbst gibt es nicht: Das Ergebnis ist das JSON des Entries. Ownership-Checks verhindern, dass ein Agent fremde Leases oder Claims manipuliert. `startService` betreibt den Lease-Reaper, die Waiter-Wecklogik und die Mailbox-Zustellung. Auch ohne Hintergrunddienst wird Ablauf bei Zugriffen abgeglichen; ohne Zustelldienst kommen Conversation-Ereignisse nicht automatisch an.

## Typische Anwendungsfälle {#use-cases}

- **KI-Chat-Agent**: Ein LLM beantwortet `ChatTask`s über `space_take`/`space_write`, bleibt dank der Request-Identität jedes Aufrufs bei Replays duplikatfrei.
- **Zusammenarbeit**: Ein Agent stellt Aufgaben mit `space_write` ein, ein anderer wartet mit `space_wait` darauf, ohne seinen Turn zu blockieren.
