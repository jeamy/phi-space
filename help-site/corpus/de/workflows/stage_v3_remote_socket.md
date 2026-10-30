---
standard: help_workflow
id: help.workflow.stage_v3_remote_socket
title: "Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace über Socket/TCP"
short: "Trennt Speicher, Gateway, Chat-Worker und Search-Subagent: Ein Dienst stellt den Space über Socket oder TCP bereit, alle anderen sind Clients."
tags: [v3, remotespace, spaceservice, servespace, socket, mailbox, events, ack]
owner: remote
related: [help.workflow.stage_v2_local_durable, help.workflow.stage_v4_gated_auth]
since: 0.0.1
---

# Stufe 3 (v3-remote-socket): SpaceService & RemoteSpace über Socket/TCP

## Überblick {#overview}

In Stufe 3 arbeiten Chat-Oberfläche, Worker und Suche nicht mehr direkt auf dem Speicher. Ein Dienst stellt den Space über einen Socket bereit, und alle Beteiligten verbinden sich als Clients. So lassen sich die Teile auf getrennte Prozesse oder Rechner verteilen.

## Topologie: Space-Verteilung {#topology}

In `help-site/examples/v3-remote-socket/run.ts` veröffentlicht der Host den Space über `SpaceService` und `serveSpace` auf einem Unix-Domain-Socket (`serveSpace` kann ebenso TCP); Gateway, Worker und Subagent arbeiten über `RemoteSpace`.

- **1 Prozess, 1 Host** (eigener SQLite-Speicher + `serveSpace`) stellt den Space `chat-v3` über einen **Unix-Socket** (`space.sock`) bereit.
- **3 getrennte `RemoteSpace`-Clients** mit je eigenem Transport greifen auf denselben Space zu: Gateway (UI), Chat-Worker, Search-Subagent. Alle drei verbinden sich als Peer `remote-chat-peer` und teilen sich daher eine Consumer-Mailbox; das Programm liest sie über den Worker.
- Verteilung: **1 Space, 1 Server, 3 Remote-Clients**. Die Socket-Grenze ist echt, die Prozessgrenze nicht; dieselbe Engine läuft unverändert gegen `RemoteSpace`.

## Arbeitsablauf {#workflow}

### Schritt 1: SpaceService auf Unix-Socket starten {#step-1-serve}

```ts
const service = new SpaceService({
  host,
  ctx,
  identity: new GateIdentity(),
  policy: DEFAULT_POLICY
});
const server = await serveSpace(service, {
  listen: { path: socketPath },
  connection: () => ({ peerId: "remote-chat-peer", credentials: { roles: ["admin", "member"] } })
});
```

### Schritt 2: RemoteSpace-Clients verbinden {#step-2-remote-clients}

```ts
const gatewaySpace = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const workerSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
const searchSpace  = new RemoteSpace(socketTransport({ path: socketPath }), { space: "chat-v3" });
```

Da `RemoteSpace` denselben `SpaceLike`-Vertrag wie `PhiSpaces` implementiert, läuft `SpaceChatEngine` aus `help-site/examples/shared/chat-core.ts` ohne Codeänderung über das Netzwerkprotokoll. Das Programm registriert zusätzlich ein `notify`-Abo mit `target: "self"`, liest die Mailbox mit `events({ waitMs: 50 })` und bestätigt sie mit `ack(mailboxEpoch, next)`.

Ein eigenständiges Projekt braucht weniger Code: `connectSpace("unix:/pfad.sock")` aus `phi-spaces` liefert `{ space, close }`. Den Server dazu startet `npm run space-server -- --store FILE|memory --listen unix:/pfad.sock`; dort ist jede Verbindung derselbe Peer `local` mit Rolle `member`, wer den Socket erreicht, nutzt also den Space.

### Ausführung im Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v3-remote-socket/run.ts
```

## Siehe auch {#see-also}

- [Stufe 4 (v4-gated-auth): Overlay-Gate, Schicht A/B & 60s-Grants](help.workflow.stage_v4_gated_auth#overview)
