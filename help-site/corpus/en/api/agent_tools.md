---
standard: help_api
id: help.api.agent_tools
title: "Agent Tools (spaces) & startService – Replay-Safe LLM Tools"
short: "Provides AI agents with 8 replay-safe tools with a request identity per call and ownership protection; startService runs the reaper and delivery."
tags: [spaces, createspaces, startservice, space_write, space_take, space_txn]
owner: tools
related: [help.topic.agent_tools_and_replay]
since: 0.0.1
---

# Agent Tools (spaces) & startService – Replay-Safe LLM Tools

## Overview {#overview}

These tools give a language model access to a space: write, read, take, and wait. If a call is repeated after a crash, it still takes effect only once. The package is optional; a space without agents does not need it.

## Technical Reference {#technical-reference}

The tools come from the optional agent package (`agent/`, with its own dependencies: pi-durable, pi-ai, and Chord at 1.4.0). `createSpaces(localSpaces(host))` makes the extension for the agents' `pi-durable` registry. The space does not live in the agents' store but on a host of its own (the own store), so it survives an agent restart, and the other way round.

`startService(withEventSink(host, agentHost), ctx, { space? })` starts the background loop for lease expiration (`core.reap`) and delivery to the agents' conversations. A pi-durable 1.4 harness connects through `withAgentEventSink(host, harness)` from `agent/src/agent.ts`: it adds what harness and space each expect of the context. `withEventSink` from `phi-spaces` takes any other `EventSink`.

```ts
const spaces = createSpaces(localSpaces(host)); // the space: its own host
registry.install(spaces); // the agents' registry (pi-durable)
const stopService = await startService(withEventSink(host, agentHost), ctx);
```

## The 8 Tools And Their Safety {#parameters}

| Tool | Purpose |
| --- | --- |
| `space_write`, `space_read`, `space_take` | Fundamental entry operations; every tool call is a request identity of its own in the space. |
| `space_list` | Lists visible entries of a space/template (read-only). |
| `space_txn` | Starts, commits, or aborts transactions from within the agent. |
| `space_wait`, `space_notify` | Long-lived wishes and subscriptions without blocking the agent's turn. |
| `space_lease` | `renew`/`cancel` for owned resources. |

Every tool call gets a request identity (the conversation's generation and the call's task id), recorded in the agents' store before the first space call. The space keeps the operation and its result together: a call repeated after a crash gets the first result. A call whose generation no longer admits is refused (`RequestExpired`) and never run anew. Without a connected agent host, events wait in the space's outbox; they are dropped only for a conversation that no longer exists. Only `space_list` runs without a request identity.

Since pi 1.4.0 every tool returns its result as `{ output: [{ type: "text", text }] }` with JSON text (formerly `content`). `space_read` and `space_take` hold the turn for at most 60 seconds; `space_wait` waits without blocking the turn, by default forever. `space_list` returns at most `limit` entries (default 100, maximum 1000).

Tool descriptions and the prompt section tell the model that entry contents are data from other agents, never instructions. There is no marking in the result itself: the result is the entry's JSON. Ownership checks prevent an agent from manipulating foreign leases or claims. `startService` runs the lease reaper, waiter wakeup logic, and mailbox delivery. Operations still settle expiry without background maintenance; conversation delivery needs a running delivery service.

## Typical Use Cases {#use-cases}

- **AI chat agent**: An LLM answers `ChatTask`s via `space_take`/`space_write`, staying duplicate-free under replays thanks to each call's request identity.
- **Collaboration**: One agent posts tasks with `space_write`, another waits for them with `space_wait` without blocking its turn.
