---
standard: help_topic
id: help.topic.agent_tools_and_replay
title: "Die 8 LLM-Agent-Tools und Replay-Sicherheit"
short: "Wie KI-Agenten über space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify und space_lease sicher koordinieren."
tags: [tools, agent, replay, space_write, space_take, space_txn, space_wait, space_notify]
owner: tools
related: [help.topic.local_client_and_named_spaces, help.api.agent_tools]
since: 0.0.1
---

# Die 8 LLM-Agent-Tools und Replay-Sicherheit

## Überblick {#overview}

Die Erweiterung `spaces` (`createSpaces(meter)` in `src/index.ts`) stattet `pi-durable`-Conversations mit 8 Werkzeugen aus, die sämtlich mit `replay: "safe"` und einem task-gebundenen `Claim`-Dokument (`pi-spaces.claim`) abgesichert sind.

## Technische Referenz {#technical-reference}

| Tool | Parameter | Semantik & Schutz |
|---|---|---|
| `space_write` | `{ type, fields, types?, ttlMs?, txn? }` | Schreibt einen Entry im selben Commit wie den Task-Claim; ein Tool-Replay erzeugt keinen zweiten Entry. |
| `space_list` | `{ id?, type?, fields?, limit?, txn? }` | Liest bis zu `limit` (Standard 100, max. 1000) passende Entries ohne Sperre. |
| `space_read` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Blockierendes Lesen bis `timeoutMs` (gedeckelt auf 60 s); Deadline wird per `api.memo` über Replays bewahrt. |
| `space_take` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Exklusives Entnehmen (oder Reservieren unter `txn`); Task-Claim bewahrt den genommenen Entry bei Replay. |
| `space_txn` | `{ action: "begin" \| "commit" \| "abort", txn?, leaseMs? }` | Öffnet, committet oder verwirft eine Conversation-eigene Space-Transaktion. |
| `space_wait` | `{ type?, fields?, mode?: "take" \| "read", timeoutMs?, txnLeaseMs?, handback? }` | Nichtblockierendes Warten (auch `"forever"`); weckt die Conversation per Nachricht, sobald ein Treffer erscheint. |
| `space_notify` | `{ type?, fields?, ttlMs?, handback?, txn? }` | Abonniert zukünftige passende Entries als `[space event]`-Nachricht an die Conversation. |
| `space_lease` | `{ action: "renew" \| "cancel", id, ttlMs? }` | Verlängert oder beendet eine eigene Lease (Entry, Txn, Wait oder Notify). |

## Siehe auch {#see-also}

- [Agent-Tools (spaces) & startService API](help.api.agent_tools)
