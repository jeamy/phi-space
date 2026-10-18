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

`read(template, timeout, options?)` returns a matching `EntryView` without removing it from the space. If no match is visible yet, it waits up to `timeout` milliseconds (`NO_WAIT = 0` returns immediately).

## Technical Reference {#technical-reference}

```ts
const view = await space.read({ type: "SearchResult", fields: { searchId: "s-1" } }, 5_000);
const immediate = await space.readIfExists({ type: "Thread", fields: { threadId: "main" } }, 1_000);
```

- `readIfExists` waits **only** while matching entries are locked by another transaction; if no candidate exists at all, it returns `null` immediately.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| `template` | `Template` | Query pattern `{ type?, fields?, id? }`; missing or `null` fields act as wildcards, `types` subtypes match as well. |
| `timeout` | `number` | Maximum wait in ms; `NO_WAIT = 0` returns immediately, `FOREVER` waits indefinitely. |
| `options.txn` | `string` | Optional: also reads your own uncommitted drafts inside the same transaction. |
| **Return** | `Promise<EntryView | null>` | The matching entry including `gid`, `type`, `fields`, and metadata – or `null` on timeout. |

## Typical Use Cases {#use-cases}

- **Thread check**: `readIfExists({ type: "Thread", fields: { threadId } })` verifies that a conversation context exists before a client creates it.
- **Result waiting**: The subagent consumer blocks via `read({ type: "SearchResult", fields: { searchId } }, 60_000)` instead of polling.
- **State queries**: `RunGate`, `Worker`, and `Alert` entries are queried by `AdminSpaces` in exactly the same way.
