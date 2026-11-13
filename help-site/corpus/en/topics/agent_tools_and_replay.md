---
standard: help_topic
id: help.topic.agent_tools_and_replay
title: "The 8 LLM Agent Tools and Replay Safety"
short: "How AI agents coordinate safely through space_write, space_read, space_take, space_list, space_txn, space_wait, space_notify, and space_lease."
tags: [tools, agent, replay, space_write, space_take, space_txn, space_wait, space_notify, pi-durable]
owner: tools
related: [help.topic.local_client_and_named_spaces, help.topic.examples, help.api.agent_tools]
since: 0.0.1
---

# The 8 LLM Agent Tools and Replay Safety

## Overview {#overview}

AI agents use a space through eight tools, for example to write, read and take over work. An agent can restart in the middle of a call. So each tool is built in a way that a repeat does nothing twice. The package for this is optional: the space itself also runs without any agents.

To try it out, there are [examples with agents](help.topic.examples#agents).

### Technical Details {#technical-details}

The `spaces` extension (`createSpaces(localSpaces(host))` in the `agent/` package, npm name `phi-spaces-agent`) equips `pi-durable` conversations with 8 tools, all marked `replay: "safe"`. The tools act on a separate space host. `remoteSpaces(...)` points them at a space server elsewhere ([below](help.topic.agent_tools_and_replay#remote-spaces)). The package uses pi-durable, pi-ai and Chord at version 1.5.2; tool results go in `output`, no longer in `content`.

## Technical Reference {#technical-reference}

| Tool | Parameters | Semantics & Protection |
|---|---|---|
| `space_write` | `{ type, fields, types?, ttlMs?, txn? }` | Writes an entry under the call's request identity; replaying the tool never creates a duplicate entry. |
| `space_list` | `{ id?, type?, fields?, limit?, txn? }` | Lists up to `limit` (default 100, max 1000) matching entries without locking, oldest first. A plain read without a request identity. |
| `space_read` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Blocking read up to `timeoutMs` (capped at 60 s); the space's claim keeps the first deadline across replays. |
| `space_take` | `{ id?, type?, fields?, timeoutMs?, ifExists?, txn? }` | Exclusive removal (or reservation under `txn`); the space's claim preserves the taken entry across replays. |
| `space_txn` | `{ action: "begin" \| "commit" \| "abort", txn?, leaseMs? }` | Begins, commits, or aborts a conversation-owned space transaction. |
| `space_wait` | `{ type?, fields?, mode?: "take" \| "read", timeoutMs?, txnLeaseMs?, handback? }` | Non-blocking wait (including `"forever"`); wakes the conversation with a message when a match arrives. |
| `space_notify` | `{ type?, fields?, ttlMs?, handback? }` | Subscribes to future matching entries as messages to the conversation, at most one per second; writes in between arrive bundled with a count. Needs a type or at least one field. |
| `space_lease` | `{ action: "renew" \| "cancel", id, ms? }` | Renews or cancels an owned lease (entry, txn, wait, or notify). |

### How A Call Stays Repeatable {#replay}

The space and the agent share no commit. The promise of "once" therefore comes from several steps:

1. Before its first business space call, the tool records its request identity as a task memo in the agent's store. Only the generation is fetched from the space before that.
2. The space stores effect and result atomically under this identity.
3. A replay finds the memo and calls the same operation again. It gets the first result.
4. The generation of each conversation lives in the agent's store and is renewed 10 minutes before it stops admitting. Once it admits no new requests, a call not admitted yet is refused with `RequestExpired`, never run under a new identity.

### Two Separate Stores {#two-stores}

The space lives in the own store, the agent in pi-durable's store. Both may run in one process, but their commit boundaries are separate. So the space survives an agent restart and the other way round.

- **Agent store**: The worker and the mobile runtime use SQLite with `synchronous=FULL`. Only the research runs of the examples use JSONL with `{ fsync: true }` plus an extra flush of commit marker and directory entries (`agent/src/storage.ts`). JSONL is not a store of the space.
- **Boundary**: The promise assumes the memo survives the failure. Stable identities do not replace a shared commit. Process crashes are tested; a real power loss is not (`docs/agenten-stromausfalltest.en.md`).
- **External services**: A model call repeated after a crash can run and be billed again.

### Agents On A Remote Space {#remote-spaces}

The tools can also act on a space server elsewhere. `remoteSpaces(open)` gives them a remote space through one connection of an agent host (role `agentHost`, `--agent-host` on the server). Every conversation acts as an agent of its own, `conversation-<id>`, with its own principal, mailbox, claims and pending budget. The host sends that name with each call as `frame.agent`; from any other connection the server refuses it. Waits and notifications land in the conversation's own mailbox.

`eventPump(open, harness)` reads each watched conversation's mailbox with a long poll and hands every event to the conversation once, under `phi-spaces:<mailbox epoch>:<seq>`. It acknowledges a page only after all of it was handed over, so a restart hands nothing over twice. A conversation that is gone gives back a take it was handed. If the space cannot be reached, the prompt section says so instead of failing the turn.

Two hosts use this. The chat of the Android app (pi-termux-mobile) has its own `phi-space-server` on the phone: the app's service supervises it beside node, its store is in the app's files and it listens only on a unix socket. pi-serverd gives its conversations' tools to a space server the same way, and the phone's remote sessions run as calls over a space, without pi-server and pi-client. Details: `docs/m1-mobile.en.md`.

### Separate Agent Process {#agent-process}

`DurableAgentClient` (`agent/src/durable-client.ts`) starts `durable-worker.ts` as a child process and talks to it over Node IPC (protocol in `durable-protocol.ts`). This keeps pi-durable imports out of the application, and the harness over there does not know the space. The worker guards its store against a second process with an `.owner` file of its own. Codemode-Chat and spaces-mmo use this path; `CODEMODE_DURABLE_AGENT=0` and `SPACES_MMO_DURABLE_NPCS=0` turn it off.

### Upgrades To pi 1.4.0 And 1.5.2 {#pi-140}

- Tool results go in `output` instead of `content`. Messages to the model keep their `content` structure.
- pi-durable 1.4.0 migrates its SQLite database to schema 2 automatically. After that, 1.3.0 or older can no longer open it. **Back up agent databases first**, including their WAL state.
- This concerns the agent store only. Format 2 of the own phi-spaces store has nothing to do with it.
- pi 1.5 counts a model request that a crash interrupted against the retry policy. The durable worker allows one retry so that crash recovery still works, bounded by the per-job model admission budget kept in its store.

Details are in `docs/upgrade-pi-1.4.0.en.md`.

## See Also {#see-also}

- [Examples to try](help.topic.examples#overview)
- [Agent Tools (spaces) & startService API](help.api.agent_tools)
