---
standard: help_api
id: help.api.pispaces_txn
title: "Transactions – createTransaction, commit & abort"
short: "Groups takes (reservations) and writes (invisible drafts) atomically; verifies all CompletionProfiles and byte budgets on commit."
tags: [createtransaction, commit, abort, txn, atomic]
owner: client
related: [help.topic.leases_and_transactions, help.topic.completion_profiles_and_limits]
since: 0.0.1
---

# Transactions – createTransaction, commit & abort

## Overview {#overview}

`createTransaction(lease?, options?)` starts a space transaction. `commit(txnId, options?)` publishes all entries written under `txnId` and permanently deletes all entries taken under `txnId`. `abort(txnId, options?)` discards all writes and releases all reserved takes.

## Technical Reference {#technical-reference}

```ts
const txn = await space.createTransaction(60_000, { request: reqBegin });
// ... space.take(..., { txn: txn.id }) & space.write(..., txn.id) ...
await space.commit(txn.id, { request: reqCommit });
```

## Behavior And Guarantees {#parameters}

- **Isolation**: Entries written under `txn` are visible only to operations carrying the same `txnId`; reserved takes are locked for other consumers.
- **Atomicity**: `commit` applies all writes and takes together, bumps `rev` exactly once, and emits the corresponding mailbox events. `abort` discards everything and releases reserved entries.
- **Lease**: The transaction owns a lease (the `lease` argument); expiry without commit implies an implicit `abort`.
- **Contract enforcement**: Before committing, the core checks all `CompletionProfiles` (`CompletionViolation` on missing results) and configured byte budgets (`LimitsExceeded`).

## Typical Use Cases {#use-cases}

- **Task processing**: `take(ChatTask, { txn })` + `write(Msg, txn)` + `commit(txn)` – the reply never exists without the consumed task and vice versa.
- **Multi-step state transitions**: `take(Thread) + write(Thread')` inside one `txn` replaces in-place updates safely.
- **Abort on failure**: If processing (e.g. a model call) throws, the worker calls `abort(txn)` and nothing half-finished becomes visible.
