---
standard: help_topic
id: help.topic.request_claims_and_generations
title: "Request Claims, Generations, and Idempotency"
short: "How phi-spaces prevents duplicate mutations across connection drops or restarts using {principal, generation, requestId} and canonical RFC-8785 hashes."
tags: [claims, requestref, generation, idempotency, rfc8785, polloperation, resolveoperation]
owner: client
related: [help.topic.guarantees_and_boundaries, help.api.phispaces_claims, help.workflow.stage_v2_local_durable]
since: 0.0.1
---

# Request Claims, Generations, and Idempotency

## Overview {#overview}

Imagine you submit a form and the connection drops before the answer arrives. If you submit it again, it should not arrive twice. This feature takes care of that: every call carries a fixed identifier, and the space remembers the result. A repeat returns the earlier result instead of doing the work again.

### Technical Details {#technical-details}

The mechanism is called **Request Claims (`src/claims.ts`)** and covers **every** mutation (`write`, `take`, `createTransaction`, `commit`, `abort`, `renew`, `cancel`, `notify`, `wait`, `batch`). An application does not need a receipt document of its own. The Cloudflare `pi-durable` reference needed exactly that for `conversation.create`: a custom `ConversationCommandReceipts` document.

## Concept And System Model {#concept-model}

### RequestRef Structure {#requestref-shape}

```ts
type Principal = { peerId: string; agentId?: string };
type RequestRef = {
  principal: Principal;
  generation: string;
  requestId: string;
};
```

1. **Open a Generation (`issueGeneration`)**: Before mutating, the client calls `const { generation, admitUntil } = await space.issueGeneration(principal)`. The generation is bound by HMAC to the principal, `spaceId`, data incarnation, and `authorityId`, and admits new requests for 1 hour by default.
2. **Canonical Argument Hash (`argHash`)**: For every call, `phi-spaces` computes an RFC-8785 canonical JSON hash over the **semantic arguments only** (excluding renewable envelope fields like a refreshed 60s grant).
3. **Atomic Persistence**: The claim `(principal, spaceId, generation, requestId)` and its result are committed atomically alongside the space mutation.

### Retry Semantics {#retry-behavior}

- **Same `requestId` + identical arguments**: Immediately returns the stored result without repeating the mutation.
- **Same `requestId` + different arguments**: Throws `RequestConflict`.
- **Operation still `pending`**: A retry or `pollOperation(request)` reattaches to the persistent waiter, even if the original caller process restarted in the meantime. `cancelOperation(request)` ends the operation on purpose.
- **Generation no longer admitting**: A request not admitted yet fails with `RequestExpired`. A known request still returns its result.
- **Retention expired**: After `claimResultMs` (default 24 hours), a retry returns `ResultExpired` without executing again.
- **Admission Resolution (`resolveOperation`)**: In Phase 2 federation, the router uses `resolveOperation(request, method, argumentHash, primaryEpoch)` to verify whether a child request was admitted or can be safely retried in the same primary epoch.

## Examples {#examples}

```ts
const principal = { peerId: "web-user-alice" };
const { generation } = await space.issueGeneration(principal);
const request = { principal, generation, requestId: "create-thread-42" };

// First call (e.g. before WebSocket drop):
const lease1 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architecture" } },
  null,
  FOREVER,
  { request }
);

// Second call after reconnect with the same requestId:
const lease2 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architecture" } },
  null,
  FOREVER,
  { request }
);
// lease1.id === lease2.id: Exactly ONE Thread entry was created.
```

## See Also {#see-also}

- [Stage 2 (v2-local-durable): Persistence, RequestRef Claims, Alarms & Subagent](help.workflow.stage_v2_local_durable#overview)
- [Request Claims & Generations API](help.api.phispaces_claims)
