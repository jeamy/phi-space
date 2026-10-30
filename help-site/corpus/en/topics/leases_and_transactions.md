---
standard: help_topic
id: help.topic.leases_and_transactions
title: "Leases, Transactions, and Visibility"
short: "How leases enable self-healing state and how transactions (createTransaction, commit, abort) isolate writes and takes atomically."
tags: [leases, transactions, txn, visibility, locks, ifexists, renew, cancel]
owner: core
related: [help.topic.entries_and_templates, help.topic.completion_profiles_and_limits, help.api.phispaces_txn]
since: 0.0.1
---

# Leases, Transactions, and Visibility

## Overview {#overview}

Programs crash and connections drop. So everything in a space is only held for a limited time: whoever stops checking in loses it automatically. Several steps can also be grouped, so that either all of them count or none does. This way nothing stays half finished.

### Technical Details {#technical-details}

Two mechanisms provide this: **leases** (bounded lifetimes for entries, transactions, waiters, and subscriptions) and **space transactions** (atomic grouping of `take` reservations and `write` drafts).

## Concept And System Model {#concept-model}

### Leases And Self-Healing {#leases-self-healing}

Every resource in a space carries an expiration timestamp `expires` (milliseconds since epoch, or `FOREVER`):

- `ANY` (`-1`): Uses the space's default duration (default: 1 hour).
- `FOREVER`: Non-expiring entry (e.g. committed chat messages `Msg` or `Thread`).
- Finite duration (e.g. `30_000` ms): Ideal for participant presence (`Presence`) or delayed locks (`TimerLock`).
- `space.renew(leaseId, ms)` extends the lease; `space.cancel(leaseId)` terminates it immediately.

### Transaction Isolation And Visibility {#transaction-visibility}

A space transaction is opened with `const txn = await space.createTransaction(leaseMs)`:

1. **`write(entry, txn.id)`**: The new entry is **visible only inside `txn.id`** until `commit(txn.id)`. To all other participants it does not exist yet. On `abort(txn.id)` it is discarded.
2. **`take(template, timeout, { txn: txn.id })`**: The matching entry is **reserved** (locked and invisible to others). Only `commit(txn.id)` deletes it permanently. On `abort(txn.id)` or transaction lease expiry, the reservation is released and the entry becomes available to other workers again. Without `txn`, `take` removes the entry at once.
3. **`read` vs. `readIfExists` / `take` vs. `takeIfExists`**:
   - `read` and `take` wait up to `timeout` if no matching entry exists yet.
   - `readIfExists` and `takeIfExists` return `null` immediately if no matching entry is present. They wait up to `timeout` **only** while matching entries are locked by another transaction.

### Is The Entry Gone Or Only Locked? {#typed-misses}

A `null` does not say why nothing came. `probe(template, timeout, { take? })` therefore returns `{ entry, locked }`: `locked` is set when matches exist but every one is held by another transaction. `probe` is an optional capability of `SpaceLike`; `PhiSpaces` and `RemoteSpace` offer it.

`readExisting` and `takeExisting` from the client helpers are easier to use: `null` means gone, and a miss caused only by held matches throws `StillHeld`. Without `probe`, `null` counts as gone.

### Long Work And Several Steps {#long-work-and-batches}

- **`keepAlive(space, lease, leaseMs)`** renews a lease every `leaseMs / 3` while long work runs inside it, and returns the stop function.
- **`batch(ops, { request? })`** runs up to 64 steps (`begin`, `write`, `take`, `read`, `commit`, `abort`) in one commit, all or none. `txn: "$"` names the transaction a `begin` earlier in the same batch opened. This costs one round instead of one per step. `take` and `read` never wait inside a batch.

## Examples {#examples}

```ts
// Transactional processing of a ChatTask in the Multiplayer Space-Chat:
const txn = await space.createTransaction(30_000);
try {
  const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
  if (!task) {
    await space.abort(txn.id);
    return;
  }
  await space.write({
    type: "Msg",
    fields: {
      msgId: "msg-2",
      threadId: "main",
      seq: 2,
      author: "pi-agent",
      role: "assistant",
      text: "Reply to: " + task.fields.prompt,
      taskId: task.fields.taskId,
      createdAt: Date.now()
    }
  }, txn.id, FOREVER);
  await space.commit(txn.id); // Atomic: ChatTask is removed, Msg becomes visible
} catch (err) {
  await space.abort(txn.id); // ChatTask returns to the space
  throw err;
}
```

```ts
import { readExisting, StillHeld } from "phi-spaces";

// Tells "gone" from "held by someone else right now":
try {
  const job = await readExisting(space, { type: "Job" }, 1_000);
  if (job === null) console.log("No job left");
} catch (err) {
  if (!(err instanceof StillHeld)) throw err;
  console.log("The job is being worked on");
}
```

## See Also {#see-also}

- [CompletionProfiles and Resource Limits](help.topic.completion_profiles_and_limits#overview)
- [Transactions – createTransaction, commit & abort](help.api.phispaces_txn)
