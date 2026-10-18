---
standard: help_topic
id: help.topic.guarantees_and_boundaries
title: "Binding Guarantees and System Boundaries"
short: "What pi-spaces strictly guarantees for local commits, retries, transactions, restores, and federation—and what is intentionally out of scope."
tags: [guarantees, boundaries, idempotency, consistency, limits, restore, epochs]
owner: core
related: [help.topic.overview, help.topic.request_claims_and_generations, help.topic.gate_auth_grants_and_recovery]
since: 0.0.1
---

# Binding Guarantees and System Boundaries

## Overview {#overview}

A reliable distributed system defines both its guarantees and its boundaries explicitly and proves them on persistent storage (JSONL and SQLite). This article summarizes the current implementation state (`docs/implementierungsstand.md`) and contract (`docs/federation-plan-v3.md`).

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

### Guarantee Matrix {#guarantee-matrix}

| Layer | Binding Contract in `pi-spaces` | What Does Explicitly NOT Follow |
|---|---|---|
| **Local Commit** | Space mutation, RPC claim, revision `rev`, and mailbox event are persisted atomically together. | No external exactly-once guarantee for HTTP calls, emails, or LLM token costs outside the space. |
| **Idempotent Retry** | Identical `{ principal, generation, requestId }` with matching RFC-8785 argument hash returns the stored result across process restarts without repeating the mutation. | After retention expiry (default 24 h), a retry returns `ResultExpired` without re-executing. |
| **Take under Txn** | At most one active reservation per entry; `abort` or lease expiry returns the entry to the space. | No global FIFO ordering across competing consumers. |
| **CompletionProfile** | A take-transaction commit is rejected server-side with `CompletionViolation` unless result type, matching fields, and count match. | No semantic validation of payload quality by the space core. |
| **Data Restore (5.2.2)** | Increments data incarnation; old generations fail with `IncarnationChanged`; restored exclusive tasks are quarantined as `restoredUnverified` until `releaseRestored`. | Restoring from an asynchronous backup is **not** a lossless promotion. |
| **Operating Limits (Gate 4)** | Frame max 256 KiB, commit batch max 192 KiB, entry max 64 KiB, max 32 connections per peer / 64 per listener, peer identification 5 s, grant max 60 s. | No unbounded batch transactions; large preparations split into idempotent sub-commits. |

### The Three Distinct Epoch Counters {#three-epochs}

Using the word "epoch" without a qualifier is invalid in `pi-spaces`. Three independent monotonic counters exist:

1. **`primaryEpoch`**: Scoped to a logical space for replication or data restore (+1 on data restore, promotion, or single-mode switch; resets to 1 under a new `authorityId` after control restore).
2. **`routerEpoch`**: Scoped to `RouterLease` issuance in a federation (+1 on router restart or failover).
3. **`mailboxEpoch`**: An opaque consumer-mailbox string identity. Reset changes the token; compare equality, never increment or order it numerically.

## Failures And Diagnostics {#failures-and-diagnostics}

- **`OutcomeUnknown`**: Raised when `maxClientWaitMs` elapses or the transport drops before a reply arrives. **Critical:** `OutcomeUnknown` does not mean the operation failed! The client must poll with the same `requestId` via `pollOperation`.
- **`RequestConflict`**: The same `requestId` was reused with different arguments.
- **`ResourceExhausted`**: Extending a transaction would exceed the commit/abort byte budget (`192 KiB`) or document quota; prior transaction work remains committable or abortable.

## See Also {#see-also}

- [Request Claims, Generations, and Idempotency](help.topic.request_claims_and_generations#overview)
- [Overlay Gate, Authentication, Grants, and Recovery](help.topic.gate_auth_grants_and_recovery#overview)
