---
standard: help_api
id: help.api.phispaces_read
title: "read & readIfExists – Non-Destructive Entry Read"
short: "Finds a matching visible entry using a template (missing/null fields are wildcards) and waits up to the timeout."
tags: [read, readifexists, template, wildcard, timeout]
owner: client
related: [help.topic.entries_and_templates, help.api.phispaces_take]
since: 0.0.1
---

# read & readIfExists – Non-Destructive Entry Read

## Overview {#overview}

`read` looks for an entry that matches a pattern and leaves it in the space. If there is none yet, it waits up to the given time. Use it to check a state or wait for a result. `readIfExists` does not wait for new entries, only for ongoing changes to existing ones.

## Technical Reference {#technical-reference}

`read(template, timeout, options?)` returns a matching `EntryView` without removing it from the space. If no match is visible yet, it waits up to `timeout` milliseconds (`NO_WAIT = 0` returns immediately).

```ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
```

- `readIfExists` waits **only** while matching entries are locked by another transaction; if no candidate exists at all, it returns `null` immediately.
- `probe(template, timeout, { take? })` says why nothing came: `{ entry, locked }`, where `locked: true` reports a miss caused only by held matches. It is optional in `SpaceLike`; remotely it belongs to the feature `read.locked`.
- `readExisting(space, template, waitMs, { txn })` from `phi-spaces` builds on it: `null` means gone, a match still held throws `StillHeld`. Without `probe`, `null` counts as gone.
- `peek(space, template, { txn })` reads the first match as a snapshot (`readAll` with `limit: 1`) and leaves no claim behind.
- **Waiting is cheap**: Locally a change wakes the call, which looks again after 20 to 40 ms. Remotely the service polls every 50 ms; with `wakeOnCommit` it looks at the first commit and then at most every 25 ms.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| `template` | `Template` | Query pattern `{ type?, fields?, id? }`; missing or `null` fields act as wildcards, `types` subtypes match as well. |
| `timeout` | `number` | Maximum wait in ms; `NO_WAIT = 0` returns immediately, `FOREVER` waits indefinitely. |
| `options.txn` | `string` | Optional: also reads your own uncommitted drafts inside the same transaction. More options: `deadline`, `request`, locally `once`. |
| **Return** | `Promise<EntryView | null>` | The matching entry including `gid`, `type`, `fields`, and metadata – or `null` on timeout. |

## Typical Use Cases {#use-cases}

- **Thread check**: `readIfExists({ type: "Thread", fields: { threadId } })` verifies that a conversation context exists before a client creates it.
- **Result waiting**: The subagent consumer blocks via `read({ type: "SearchResult", fields: { searchId } }, 60_000)` instead of polling.
- **State checks**: Check a configuration or result entry without consuming it. If a snapshot without a claim is enough, `peek` is cheaper.
