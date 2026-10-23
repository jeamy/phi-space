---
standard: help_topic
id: help.topic.topology_and_readiness
title: "Topologies, API Boundaries and Readiness"
short: "A runnable example demonstrates a workflow, not automatically real distribution or complete fault tolerance. Stages v1–v6 are local demonstrations of different components, not automatic production-cluster provisioning."
tags: [topology, v1, v2, v3, v4, v5, v6, primary, sync, fencing, SpaceLike]
owner: federation
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Topologies, API Boundaries and Readiness

## Separate Demo, Implementation and Acceptance {#overview}

A runnable example demonstrates a workflow, not automatically real distribution or complete fault tolerance. Stages v1–v6 are local demonstrations of different components, not automatic production-cluster provisioning.

## Topology Matrix {#matrix}

| Stage | Processes/Hosts and Storage | Demonstrated Boundary | Not Established |
|---|---|---|---|
| v1 | One process, one in-memory host, named Chat Space | Local tasks, threads, results | Persistence or network |
| v2 | One process, SQLite harness, close/reopen | Durable alarms/search and restart | SIGKILL, power or host loss |
| v3 | One process, separate remote clients, real Unix socket | RPC, identity, mailbox | Independent physical hosts |
| v4 | Two persistent hosts and local TCP gates | Key proof, enrollment, grants, rotation | Real NetBird provisioning |
| v5 | Four in-memory hosts in one process | Router, HRW, federated search, LWW component | Production cluster/fencing |
| v6 | One in-memory host with multiple Spaces | Local operations and sample enrollment | Automatic phone pairing or full remote operations acceptance |

## Which API Is Interchangeable? {#api}

PhiSpaces and RemoteSpace implement the SpaceLike base contract; mailbox access is explicitly client-specific. FederatedSpace has a separate FederationRequest with principal, stable operation ID and optional Member transaction binding. write(entry, request, leaseMs), read(template, request) and finishTransaction are not drop-in local methods. Business concepts transfer, but routing, complete/partial results and request bindings need adaptation. Do not promise general atomic transactions across arbitrary hosts.

## Replication Modes and Acceptance {#replication}

Merge replication uses HLC, versioned tombstones and policy-specific LWW/Add-Wins sets for suitable data; it is not an exclusive queue. primary/sync confirms only through its configured synchronous storage/standby path. Promotion/degrade require authorized transitions and effective fencing/revocation evidence; a higher epoch alone does not stop an isolated old primary. The authoritative docs/abnahme/ap3-abnahme.md separates local components, real network/fencing runs and remaining gates. A metadata/LWW demo does not accept every Phase-3 path.

## Test System: Hardware and Data Cap {#testsystem}

The distributed test system runs on two hosts. **big** (KVM server, 8 vCPU on AMD EPYC 9634, 15 GiB RAM) carries the frontend, WebSocket hub, router and shard a. **nano** (netcup KVM, 4 vCPU, 7.8 GiB RAM) keeps shard b in its own database; they share no disk. Locally everything runs on one machine with one database. Every commit costs O(number of entries) per Space, so each database holds at most 20,000 entries (`SWARM_MAX_ENTRIES`, 0 disables the cap). Above it the oldest posts go in bursts, together with their likes and history nodes, until about 19,000 remain; channel counters stay lifetime totals. A yellow notice appears in the feed while this happens. This is a property of the test system, not a product limit. The slim bar below the chat window shows the actual values of the hosts (CPU, cores, memory, entries per database); the figures here are indicative.
