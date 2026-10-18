---
standard: help_api
id: help.api.pispaces_claims
title: "Request-Claims & Generationen – Neustartfeste Idempotenz"
short: "Bindet Mutationen und blockierende Operationen atomar an {principal, generation, requestId} und einen kanonischen RFC-8785-Argument-Hash."
tags: [issuegeneration, polloperation, resolveoperation, canceloperation, requestref]
owner: client
related: [help.topic.request_claims_and_generations]
since: 0.0.1
---

# Request-Claims & Generationen – Neustartfeste Idempotenz

## Überblick {#overview}

`issueGeneration(principal)` erzeugt eine signierte Generation. `pollOperation(request)` fragt den Status eines bekannten Claims ab (`pending`, `done`, `cancelled`), `cancelOperation(request)` bricht eine noch wartende Operation gezielt ab und `resolveOperation` klärt vor dem Router-Retry die Admission-Bindung.

## Technische Referenz {#technical-reference}

```ts
const { generation } = await space.issueGeneration({ peerId: "alice" });
const status = await space.pollOperation({ principal: { peerId: "alice" }, generation, requestId: "req-1" });
```

## Wichtige Methoden {#parameters}

| Methode | Zweck |
| --- | --- |
| `issueGeneration(principal)` | Vergibt eine neue Generation (inkarnationsfest); alle Requests dieser Sitzung tragen `{ principal, generation, requestId }`. |
| `pollOperation(request)` | Fragt den Status eines Claims ab: `pending`, `done` (mit Ergebnis) oder `cancelled`. |
| `cancelOperation(request)` | Storniert eine noch wartende blockierende Operation gezielt. |
| `resolveOperation(req, method, argHash, epoch)` | Klärt vor einem Router-/Client-Retry, ob eine Admission bereits an denselben Argument-Hash gebunden ist. |

## Typische Anwendungsfälle {#use-cases}

- **Reconnect ohne Duplikate**: Bricht die WebSocket-/TCP-Verbindung mitten in `write(msg)` ab, sendet der Client denselben `RequestRef` erneut – der Space liefert das bereits verbuchte Ergebnis statt einer zweiten Nachricht.
- **Unklare Ausgänge auflösen**: Nach `OutcomeUnknown` (Timeout beim Commit) fragt der Client per `pollOperation` nach, ob die Mutation doch erfolgte.
- **Generation-Mixup-Schutz**: Startet ein Client neu, erhält er eine frische Generation; Claims alter Generationen können nicht mit Neuem kollidieren.
