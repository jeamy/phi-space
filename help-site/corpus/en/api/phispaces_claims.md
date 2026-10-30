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

When a reply gets lost on the network, the caller does not know whether its command arrived. These calls solve that: each command gets a fixed identity, and a repeat returns the first result. `issueGeneration` opens a range for such identities, `pollOperation` asks for a command's state.

## Technical Reference {#technical-reference}

`issueGeneration(principal)` issues a signed generation and returns `{ generation, admitUntil }`. `pollOperation(request)` inspects the status of a known claim (`pending`, `done`, `cancelled`), `cancelOperation(request)` cancels a pending operation, and `resolveOperation` resolves admission bindings before router retries. `RemoteSpace` does this by itself: it opens a generation and gives each mutation a request ID.

```ts
const { generation } = await space.issueGeneration({ peerId: "alice" });
const status = await space.pollOperation({ principal: { peerId: "alice" }, generation, requestId: "req-1" });
```

## Key Methods {#parameters}

| Method | Purpose |
| --- | --- |
| `issueGeneration(principal)` | Issues a new incarnation-safe generation; all requests of this session carry `{ principal, generation, requestId }`. |
| `pollOperation(request)` | Queries the status of a claim: `pending`, `done` (with result; `locked` when an `IfExists` call saw only held matches), or `cancelled`. |
| `cancelOperation(request)` | Deliberately cancels a still-pending blocking operation. |
| `resolveOperation(req, method, argHash, epoch)` | Resolves before a router/client retry whether an admission is already bound to the same argument hash. |

## Typical Use Cases {#use-cases}

- **Reconnect without duplicates**: If the WebSocket/TCP connection drops during `write(msg)`, the client resends the same `RequestRef` – the space returns the already-recorded result instead of a second message.
- **Resolving unclear outcomes**: After `OutcomeUnknown` (timeout during commit), the client uses `pollOperation` to check whether the mutation actually succeeded.
- **Generation mixup protection**: On restart a client receives a fresh generation; claims from older generations cannot collide with new ones.
