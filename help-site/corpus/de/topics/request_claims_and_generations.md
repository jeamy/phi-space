---
standard: help_topic
id: help.topic.request_claims_and_generations
title: "Request-Claims, Generationen und Idempotenz"
short: "Wie pi-spaces über {principal, generation, requestId} und kanonische RFC-8785-Hashes doppelte Mutationen nach Verbindungsabbruch oder Neustart verhindert."
tags: [claims, requestref, generation, idempotency, rfc8785, polloperation, resolveoperation]
owner: client
related: [help.topic.guarantees_and_boundaries, help.api.pispaces_claims, help.workflow.stage_v2_local_durable]
since: 0.0.1
---

# Request-Claims, Generationen und Idempotenz

## Überblick {#overview}

Im Cloudflare-Blogpost zu `pi-durable` musste für `conversation.create` ein eigenes `ConversationCommandReceipts`-Dokument programmiert werden, damit ein WebSocket-Reconnect keine doppelten Konversationen erzeugt. In `pi-spaces` ist dieser Mechanismus bereits als universelle Kernfunktion **Request-Claims (`src/claims.ts`)** für **alle** Mutationen (`write`, `take`, `createTransaction`, `commit`, `abort`, `renew`, `cancel`, `notify`, `wait`) eingebaut.

## Begriffs- und Systemmodell {#concept-model}

### Aufbau einer RequestRef {#requestref-shape}

```ts
type Principal = { peerId: string; agentId?: string };
type RequestRef = {
  principal: Principal;
  generation: string;
  requestId: string;
};
```

1. **Generation eröffnen (`issueGeneration`)**: Vor der ersten Mutation ruft der Client `const { generation } = await space.issueGeneration(principal)` auf. Die Generation ist kryptografisch (HMAC/Signatur) an Principal, `spaceId`, Dateninkarnation und `authorityId` gebunden (Standardlaufzeit: 1 Stunde).
2. **Kanonischer Argument-Hash (`argHash`)**: Für jeden Aufruf berechnet `pi-spaces` über `canonicalJson` (RFC 8785) den SHA-256-Hash ausschließlich über die **fachlichen Argumente** (ohne erneuerbare Rahmenfelder wie einen frischen 60-s-Grant).
3. **Atomare Speicherung**: Der Claim `(principal, spaceId, generation, requestId)` und das Operationsergebnis werden im selben Commit wie die Space-Mutation gespeichert.

### Verhalten bei Wiederholung (Retry) {#retry-behavior}

- **Gleiche `requestId` + gleiche Argumente**: Liefert sofort das gespeicherte Ergebnis zurück, ohne die Mutation ein zweites Mal auszuführen.
- **Gleiche `requestId` + andere Argumente**: Wirft `RequestConflict`.
- **Operation noch wartend (`pending`)**: Ein Retry oder `pollOperation(request)` hängt sich an denselben laufenden Waiter an, auch wenn der ursprüngliche Client-Prozess zwischendurch neu gestartet wurde!
- **Vor-Versand-Klärung (`resolveOperation`)**: Der Router in Phase 2 prüft mit `resolveOperation(request, method, argumentHash, primaryEpoch)`, ob ein Child-Request am Member bereits ankam oder in derselben Epoche sicher wiederholt werden darf.

## Beispiele {#examples}

```ts
const principal = { peerId: "web-user-alice" };
const { generation } = await space.issueGeneration(principal);
const request = { principal, generation, requestId: "create-thread-42" };

// Erster Aufruf (z.B. vor WebSocket-Abbruch):
const lease1 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architektur" } },
  null,
  FOREVER,
  { request }
);

// Zweiter Aufruf nach Reconnect mit derselben requestId:
const lease2 = await space.write(
  { type: "Thread", fields: { threadId: "t-42", title: "Architektur" } },
  null,
  FOREVER,
  { request }
);
// lease1.id === lease2.id -> Es wurde exakt EIN Thread-Entry erzeugt!
```

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): Persistenz, RequestRef-Claims, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)
- [Request-Claims & Generationen API](help.api.pispaces_claims)
