---
standard: help_topic
id: help.topic.request_claims_and_generations
title: "Request-Claims, Generationen und Idempotenz"
short: "Wie phi-spaces über {principal, generation, requestId} und kanonische RFC-8785-Hashes doppelte Mutationen nach Verbindungsabbruch oder Neustart verhindert."
tags: [claims, requestref, generation, idempotency, rfc8785, polloperation, resolveoperation]
owner: client
related: [help.topic.guarantees_and_boundaries, help.api.phispaces_claims, help.workflow.stage_v2_local_durable]
since: 0.0.1
---

# Request-Claims, Generationen und Idempotenz

## Überblick {#overview}

Stell dir vor, du schickst ein Formular ab, und die Verbindung reißt, bevor die Antwort kommt. Schickst du es noch einmal, soll es nicht doppelt ankommen. Genau das regelt diese Funktion: Jeder Aufruf trägt eine feste Kennung, und der Space merkt sich das Ergebnis. Eine Wiederholung liefert das alte Ergebnis, statt die Arbeit noch einmal zu tun.

### Technische Details {#technical-details}

Der Mechanismus heißt **Request-Claims (`src/claims.ts`)** und gilt für **alle** Mutationen (`write`, `take`, `createTransaction`, `commit`, `abort`, `renew`, `cancel`, `notify`, `wait`, `batch`). Eine Anwendung muss dafür kein eigenes Quittungsdokument schreiben. Die Cloudflare-Vorlage zu `pi-durable` brauchte für `conversation.create` genau das: ein eigenes `ConversationCommandReceipts`-Dokument.

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

1. **Generation eröffnen (`issueGeneration`)**: Vor der ersten Mutation ruft der Client `const { generation, admitUntil } = await space.issueGeneration(principal)` auf. Die Generation ist per HMAC an Principal, `spaceId`, Dateninkarnation und `authorityId` gebunden und lässt standardmäßig 1 Stunde lang neue Anfragen zu.
2. **Kanonischer Argument-Hash (`argHash`)**: Für jeden Aufruf berechnet `phi-spaces` über `canonicalJson` (RFC 8785) den SHA-256-Hash ausschließlich über die **fachlichen Argumente** (ohne erneuerbare Rahmenfelder wie einen frischen 60-s-Grant).
3. **Atomare Speicherung**: Der Claim `(principal, spaceId, generation, requestId)` und das Operationsergebnis werden im selben Commit wie die Space-Mutation gespeichert.

### Verhalten bei Wiederholung (Retry) {#retry-behavior}

- **Gleiche `requestId` + gleiche Argumente**: Liefert sofort das gespeicherte Ergebnis zurück, ohne die Mutation ein zweites Mal auszuführen.
- **Gleiche `requestId` + andere Argumente**: Wirft `RequestConflict`.
- **Operation noch wartend (`pending`)**: Ein Retry oder `pollOperation(request)` hängt sich an denselben laufenden Waiter an, auch wenn der ursprüngliche Client-Prozess zwischendurch neu gestartet wurde. `cancelOperation(request)` beendet die Operation gezielt.
- **Generation nimmt nichts Neues mehr an**: Eine noch nicht aufgenommene Anfrage scheitert mit `RequestExpired`. Eine bekannte Anfrage liefert weiter ihr Ergebnis.
- **Aufbewahrung abgelaufen**: Nach `claimResultMs` (Standard 24 Stunden) liefert ein Retry `ResultExpired`, ohne erneut auszuführen.
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
// lease1.id === lease2.id: Es wurde genau EIN Thread-Entry erzeugt.
```

## Siehe auch {#see-also}

- [Stufe 2 (v2-local-durable): Persistenz, RequestRef-Claims, Alarme & Subagent](help.workflow.stage_v2_local_durable#overview)
- [Request-Claims & Generationen API](help.api.phispaces_claims)
