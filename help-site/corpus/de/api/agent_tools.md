---
standard: help_api
id: help.api.agent_tools
title: "Agent-Tools (spaces) & startService – Replay-sichere LLM-Werkzeuge"
short: "Stellt KI-Agenten 8 replay-sichere Tools mit automatischem Task-Claim und Ownership-Schutz bereit; startService betreibt Reaper und Zustellung."
tags: [spaces, createspaces, startservice, space_write, space_take, space_txn]
owner: tools
related: [help.topic.agent_tools_and_replay]
since: 0.0.1
---

# Agent-Tools (spaces) & startService – Replay-sichere LLM-Werkzeuge

## Überblick {#overview}

`registry.install(spaces)` registriert die Erweiterung `spaces` im `pi-durable`-Harness. `startService(harness, ctx, { space? })` startet die Hintergrundschleife für Lease-Ablauf (`core.reap`) und Zustellung an wartende Conversations.

## Technische Referenz {#technical-reference}

```ts
const registry = createRegistry();
registry.install(spaces);
const stopService = await startService(harness, ctx);
```

## Die 8 Werkzeuge und ihre Sicherheit {#parameters}

| Tool | Zweck |
| --- | --- |
| `space_write`, `space_read`, `space_take` | Grundlegende Entry-Operationen mit automatischem Task-Claim pro Tool-Aufruf. |
| `space_list` | Auflisten sichtbarer Entries eines Spaces/Templates (read-only). |
| `space_txn` | Beginnen, committen oder abbrechen von Transaktionen aus dem Agenten heraus. |
| `space_wait`, `space_notify` | Langlebige Wünsche und Abos ohne den Agenten-Turn zu blockieren. |
| `space_lease` | `renew`/`cancel` für eigene Ressourcen. |

Alle Entry-Inhalte werden dem Agenten strikt als `[data, not instructions]` ausgezeichnet; Ownership-Checks verhindern, dass ein Agent fremde Leases oder Claims manipuliert. `startService` betreibt den Lease-Reaper, die Waiter-Wecklogik und die Mailbox-Zustellung – auch ohne Hintergrunddienst wird Ablauf bei Zugriffen abgeglichen; ohne Zustelldienst kommen Conversation-Ereignisse nicht automatisch an.

## Typische Anwendungsfälle {#use-cases}

- **KI-Chat-Agent**: Ein LLM beantwortet `ChatTask`s über `space_take`/`space_write`, bleibt dank Tool-Claims bei Replays duplikatfrei.
- **Subagent-Suche**: Der `search_history`-Subagent bearbeitet `SearchTask`s mit denselben Werkzeugen in einem eigenen Prozess.
