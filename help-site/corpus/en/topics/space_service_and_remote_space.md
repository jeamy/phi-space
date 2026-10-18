---
standard: help_topic
id: help.topic.space_service_and_remote_space
title: "SpaceService, RemoteSpace, and Network Transports"
short: "How SpaceService enforces role policies and how RemoteSpace communicates over in-process, Unix socket, TCP, or pi-serverd transports with stable retries."
tags: [spaceservice, remotespace, socket, tcp, policy, identityadapter, outcomeunknown]
owner: remote
related: [help.workflow.stage_v3_remote_socket, help.api.space_service_and_remote]
since: 0.0.1
---

# SpaceService, RemoteSpace, and Network Transports

## Overview {#overview}

When web servers, workers, and subagents run in separate processes or on different machines, `SpaceService` (`src/service.ts`) handles server-side dispatch while `RemoteSpace` (`src/remote.ts`) provides the client implementation.

## Concept And System Model {#concept-model}

### Authentication Via IdentityAdapter And Policy {#identity-and-policy}

`SpaceService` never trusts a principal sent inside a client JSON payload. Instead, its `IdentityAdapter` (`StaticIdentity` locally or `GateIdentity` over NetBird/Layer B) derives the `Principal` and roles (`admin`, `host`, `member`, `observer`) from the trusted `Connection` context. `Policy` checks allowed methods and entry types before executing any call. A type grant covers subtypes: a write is allowed as soon as its type or one of its declared supertypes is granted. Because the writer declares the supertypes, a role granted `Job` can also write `{ type: "X", types: ["Job"] }`; type grants are therefore no integrity boundary for subtypes. Federation members, in contrast, enforce the supertypes declared in their type policy.

### Stable Retries And OutcomeUnknown In RemoteSpace {#remote-retries}

Before its first mutation, `RemoteSpace` automatically calls `hello` and `generation` and assigns a stable `requestId` to every mutating call. If a reply is lost on the socket/TCP transport, `RemoteSpace` retries with the **exact same `requestId`**. If `maxClientWaitMs` expires, it throws `OutcomeUnknown` while the host operation continues and can be resolved via `pollOperation`. Unclassified host errors arrive as code `Internal` with the fixed message `internal error`; only the host logs the actual error.

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): SpaceService & RemoteSpace in Practice](help.workflow.stage_v3_remote_socket#overview)
- [SpaceService, serveSpace & RemoteSpace API](help.api.space_service_and_remote)
