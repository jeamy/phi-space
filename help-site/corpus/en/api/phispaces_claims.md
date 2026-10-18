---
standard: help_api
id: help.api.phispaces_claims
title: "Request Claims & Generations – Restart-Safe Idempotency"
short: "Binds mutations and blocking operations atomically to {principal, generation, requestId} and a canonical RFC-8785 argument hash."
tags: [issuegeneration, polloperation, resolveoperation, canceloperation, requestref]
owner: client
related: [help.topic.request_claims_and_generations]
since: 0.0.1
---

# Request Claims & Generations – Restart-Safe Idempotency

## Overview {#overview}

`issueGeneration(principal)` issues a signed generation. `pollOperation(request)` inspects the status of a known claim (`pending`, `done`, `cancelled`), `cancelOperation(request)` cancels a pending operation, and `resolveOperation` resolves admission bindings before router retries.

## Technical Reference {#technical-reference}

```ts
const { generation } = await space.issueGeneration({ peerId: "alice" });
const status = await space.pollOperation({ principal: { peerId: "alice" }, generation, requestId: "req-1" });
```

## Key Methods {#parameters}

| Method | Purpose |
| --- | --- |
| `issueGeneration(principal)` | Issues a new incarnation-safe generation; all requests of this session carry `{ principal, generation, requestId }`. |
| `pollOperation(request)` | Queries the status of a claim: `pending`, `done` (with result), or `cancelled`. |
| `cancelOperation(request)` | Deliberately cancels a still-pending blocking operation. |
| `resolveOperation(req, method, argHash, epoch)` | Resolves before a router/client retry whether an admission is already bound to the same argument hash. |

## Typical Use Cases {#use-cases}

- **Reconnect without duplicates**: If the WebSocket/TCP connection drops during `write(msg)`, the client resends the same `RequestRef` – the space returns the already-recorded result instead of a second message.
- **Resolving unclear outcomes**: After `OutcomeUnknown` (timeout during commit), the client uses `pollOperation` to check whether the mutation actually succeeded.
- **Generation mixup protection**: On restart a client receives a fresh generation; claims from older generations cannot collide with new ones.
