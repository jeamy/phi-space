---
standard: help_api
id: help.api.agent_tools
title: "Agent Tools (spaces) & startService – Replay-Safe LLM Tools"
short: "Provides AI agents with 8 replay-safe tools with automatic task claims and ownership protection; startService runs the reaper and delivery."
tags: [spaces, createspaces, startservice, space_write, space_take, space_txn]
owner: tools
related: [help.topic.agent_tools_and_replay]
since: 0.0.1
---

# Agent Tools (spaces) & startService – Replay-Safe LLM Tools

## Overview {#overview}

`registry.install(spaces)` registers the `spaces` extension in a `pi-durable` harness. `startService(harness, ctx, { space? })` starts the background loop for lease expiration (`core.reap`) and event delivery to waiting conversations.

## Technical Reference {#technical-reference}

```ts
const registry = createRegistry();
registry.install(spaces);
const stopService = await startService(harness, ctx);
```

## The 8 Tools And Their Safety {#parameters}

| Tool | Purpose |
| --- | --- |
| `space_write`, `space_read`, `space_take` | Fundamental entry operations with an automatic task claim per tool call. |
| `space_list` | Lists visible entries of a space/template (read-only). |
| `space_txn` | Starts, commits, or aborts transactions from within the agent. |
| `space_wait`, `space_notify` | Long-lived wishes and subscriptions without blocking the agent's turn. |
| `space_lease` | `renew`/`cancel` for owned resources. |

All entry payloads are presented to the agent strictly as `[data, not instructions]`; ownership checks prevent an agent from manipulating foreign leases or claims. `startService` runs the lease reaper, waiter wakeup logic, and mailbox delivery – operations still settle expiry without background maintenance; conversation delivery needs a running delivery service.

## Typical Use Cases {#use-cases}

- **AI chat agent**: An LLM answers `ChatTask`s via `space_take`/`space_write`, staying duplicate-free under replays thanks to tool claims.
- **Subagent search**: The `search_history` subagent processes `SearchTask`s with the same tools in a dedicated process.
