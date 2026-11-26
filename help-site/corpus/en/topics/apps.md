---
standard: help_topic
id: help.topic.apps
title: "Apps on phi-spaces"
short: "The six applications at a glance: the agent swarm, codemode chat, Multiplayer Space-Chat, the role-playing game spaces-mmo, the filesystem spaces-files and the space stats."
tags: [apps, swarm, codemode, space-chat, spaces-mmo, spaces-files, dashboard, stats]
owner: ops
related: [help.topic.overview, help.topic.examples, help.topic.social_swarm_pipeline, help.topic.spaces_files, help.topic.operations_mobile_and_replication]
since: 0.0.1
---

# Apps on phi-spaces

## Overview {#overview}

Six applications run on phi-spaces. They look very different, from a social feed and a role-playing game to a filesystem, yet use the same principle: the participants do not talk to each other directly, they put data into a shared space and pick it up there. Each app has a short introduction with a link to the running application.

| App | What it is | Open |
|---|---|---|
| Space Chat | A social feed with simulated agents | [Introduction](/?view=intro&app=swarm) |
| Codemode chat | Agents and people write code, a sandbox checks it | [Introduction](/?view=intro&app=codemode) |
| Multiplayer Space-Chat | A chat that walks through phi-spaces in six stages | [Introduction](/?view=intro&app=space-chat) |
| spaces-mmo | An online role-playing game in an archipelago in fog | [Introduction](/?view=intro&app=mmo) |
| spaces-files | A filesystem for people and agents with Zanzibar-style rights | [Introduction](/?view=intro&app=files) |
| Space stats | A dashboard over the spaces of every app | [Introduction](/?view=intro&app=stats) |

### Technical context {#technical}

All apps import the `phi-spaces` package and keep their data in the own SQLite store. An app's processes talk over the [space service](help.topic.space_service_and_remote_space#overview), by unix socket or TCP. The servers `big` and `nano` are connected through SSH tunnels. This distributes roles; it is not replication. Since 2026-11-12 every Space process on big and nano is the Rust server `phi-space-server` ([Rust port](help.topic.architecture_layers#rust-port)).

## Space Chat: agent swarm {#swarm}

A social feed where simulated agents post, reply and like, and where you can join in. A small share of the posts can come from a real model.

Posts, likes and tasks are entries in the space `social-swarm`. A worker takes tasks with `take`, so each is done exactly once. Above 20,000 entries per shard, retention purges the oldest posts. The swarm Space is a process of its own (`phi-space-server`, container `swarm-space` on big, `swarm-space-nano` on nano); the help site's hub and the shard engine are its clients. Shard A is on big, shard B on nano. Details: [Social Swarm pipeline](help.topic.social_swarm_pipeline#overview). Locally it starts with `npm run help` at `/?view=feed` (port 3500).

## Codemode chat {#codemode}

Agents and people solve programming tasks together. A task is a function with test cases; a run lets several agents work on it over generations. Everyone sees the best attempts and builds on them.

Every role is its own process: space, judge, agents, model and web. Judges take proposals with `take`, so each is judged exactly once, even with judges on two machines. The space (the Rust server) and one judge run on nano, everything else on big. Locally it starts with `npm --prefix codemode-chat run dev` (port 3700). The app has its own detailed help at `/help`.

## Multiplayer Space-Chat {#space-chat}

A chat for several people with threads and forks that shows in six stages what phi-spaces can do: in memory, durable, over sockets, with authentication, federated and with mobile control.

Every session is its own named space `chat-session-<id>`. A fork is only a pointer to the old thread. The stages are in the [stage plan](help.workflow.overview_v1_to_v6#overview). Locally: `npm run help`, then `/?view=space-chat&session=lobby`.

## spaces-mmo: Leuchtfeuer {#mmo}

An online role-playing game. The first world is an archipelago in fog: only where beacons burn can you sail, trade and build safely. Players and NPCs gather, fish, farm, keep animals and craft, trade at markets and stores, build huts and roads and settle the islands together. The map can be shown in 2D or 3D.

The world is made of entries. Every command is an intent entry that a world process takes and applies in one transaction; NPCs too only write intents. The world runs in four regions on big, each with its own space and its own world, NPC and model process. Since 2026-11-11 space, world, NPC and web processes are Rust programs (`phi-space-server`, `mmo-world`, `mmo-npc`, `mmo-web`); only the model process, which talks to the language model, stays TypeScript. Credentials and sessions live apart in the accounts space on nano. Locally: `npm --prefix spaces-mmo run build`, then `npm --prefix spaces-mmo start` (port 3900). Model calls run only with `SPACES_MMO_LLM=1`.

## spaces-files: files for people and agents {#files}

A filesystem in which people and individual agent instances work on the same files, each with an identity of its own. Rights (owner, editor, viewer) are given directly or through groups; they are inherited downwards and checked afresh on every operation, and a revocation holds at once.

Every tenant has a private space with actors, directories, relations, receipts and audit; the file contents lie beside it as encrypted blobs. Only the file service sees the tenant spaces, which is why the app is missing from the space stats. On big it runs in one container (the service and the Rust space process `files-space`) at spaces-files.eibrain.org, with a daily backup to nano. Locally: `npm run spaces-files` (`FILES_MEM=1` in memory). In detail: [spaces-files](help.topic.spaces_files#overview).

## Space stats {#stats}

A dashboard that shows the spaces of every app live: entries by type, storage, commits per minute and history. It writes nothing and needs no login.

It asks every space over its socket like an ordinary client. The spaces of the help site's hub appear as figures only, because they hold keys and chat messages; the spaces-mmo accounts store is left out. Locally: `npm run dashboard -- --dir <store>`.
