---
standard: help_topic
id: help.topic.agent_tools_and_replay
title: "The 8 LLM Agent Tools and Replay Safety"
short: "How AI agents coordinate safely through space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify, and space_lease."
tags: [tools, agent, replay, space_write, space_take, space_txn, space_wait, space_notify]
owner: tools
related: [help.topic.local_client_and_named_spaces, help.api.agent_tools]
since: 0.0.1
---

# The 8 LLM Agent Tools and Replay Safety

## Overview {#overview}

The `spaces` extension (`createSpaces(meter)` in `src/index.ts`) equips `pi-durable` conversations with 8 tools, all marked `replay: "safe"` and backed by a task-scoped `Claim` document (`pi-spaces.claim`).

## Technical Reference {#technical-reference}

| Tool | Parameters | Semantics & Protection |
|---|---|---|
| `space_write` | `{ type, fields, types?, ttlMs?, txn? }` | Writes an entry in the same commit as the task claim; replaying the tool never creates a duplicate entry. |
| `space_list` | `{ id?, type?, fields?, limit?, txn? }` | Lists up to `limit` (default 100, max 1000) matching entries without locking. |
| `space_read` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Blocking read up to `timeoutMs` (capped at 60 s); deadline is memoized via `api.memo` across replays. |
| `space_take` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Exclusive removal (or reservation under `txn`); task claim preserves the taken entry across replays. |
| `space_txn` | `{ action: "begin" \| "commit" \| "abort", txn?, leaseMs? }` | Begins, commits, or aborts a conversation-owned space transaction. |
| `space_wait` | `{ type?, fields?, mode?: "take" \| "read", timeoutMs?, txnLeaseMs?, handback? }` | Non-blocking wait (including `"forever"`); wakes the conversation with a message when a match arrives. |
| `space_notify` | `{ type?, fields?, ttlMs?, handback?, txn? }` | Subscribes to future matching entries delivered as `[space event]` messages. |
| `space_lease` | `{ action: "renew" \| "cancel", id, ttlMs? }` | Renews or cancels an owned lease (entry, txn, wait, or notify). |

## See Also {#see-also}

- [Agent Tools (spaces) & startService API](help.api.agent_tools)
