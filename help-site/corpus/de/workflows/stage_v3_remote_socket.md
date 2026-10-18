---
standard: help_workflow
id: help.workflow.stage_v3_remote_socket
title: "Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace über Socket/TCP"
short: "Trennt Space-Host, Web-Gateway, Chat-Worker und Search-Subagent in separate RemoteSpace-Verbindungen über Unix-Socket oder TCP inklusive Consumer-Mailboxes."
tags: [v3, remotespace, spaceservice, servespace, socket, mailbox, events, ack]
owner: remote
related: [help.workflow.stage_v2_local_durable, help.workflow.stage_v4_gated_auth]
since: 0.0.1
---

# Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace über Socket/TCP

## Überblick {#overview}

In Stufe 3 (`help-site/examples/v3-remote-socket/run.ts`) greifen Chat-Gateway, Chat-Worker und Search-Subagent nicht mehr direkt auf das `Harness`-Objekt zu. Stattdessen veröffentlicht der Host den Space über `SpaceService` und `serveSpace` auf einem Unix-Domain-Socket (bzw. TCP-Port), und alle Teilnehmer arbeiten über `RemoteSpace`.

## Topologie: Space-Verteilung {#topology}

- **1 Host** (Harness + SQLite + `serveSpace`) exponiert den Space `chat-v3` über einen **Unix-Socket** (`space.sock`).
- **3 getrennte `RemoteSpace`-Clients** greifen auf denselben Space zu: Gateway (UI), Chat-Worker, Search-Subagent – jeder mit eigenem Transport und eigener Consumer-Mailbox.
- Verteilung: **1 Space, 1 Server, 3 Remote-Consumer** — echte Socket-Grenze statt geteiltem In-Memory-Objekt; dieselbe Engine läuft unverändert gegen `RemoteSpace`.

## Arbeitsablauf {#workflow}

### Schritt 1: SpaceService auf Unix-Socket starten {#step-1-serve}

```ts
const service = new SpaceService({
  host: harness,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "local-worker", credentials: { roles: ["admin", "member"] } })
});
```

### Schritt 2: RemoteSpace-Clients verbinden {#step-2-remote-clients}

```ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
```

Da `RemoteSpace` denselben `SpaceLike`-Vertrag wie `PhiSpaces` implementiert, läuft `SpaceChatEngine` aus `help-site/examples/shared/chat-core.ts` ohne jede Codeänderung über das Netzwerkprotokoll! Zusätzlich registriert der Worker ein `notify`/`wait`-Abo und liest seine Consumer-Mailbox über `events()` + `ack()`.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
```

## Siehe auch {#see-also}

- [Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B & 60s-Grants](help.workflow.stage_v4_gated_auth#overview)
