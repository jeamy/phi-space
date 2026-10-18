---
standard: help_topic
id: help.topic.async_interaction
title: "Async Operations, Waiters and Agent Turns"
short: "PhiSpaces and RemoteSpace return Promises; persistent waiters and notify registrations are also implemented. JavaSpaces is the semantic foundation, not the runtime or transport implementation."
tags: [async, promise, await, wait, notify, event-loop, turn]
owner: client
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Async Operations, Waiters and Agent Turns

## What Is Actually Implemented {#overview}

PhiSpaces and RemoteSpace return Promises; persistent waiters and notify registrations are also implemented. JavaSpaces is the semantic foundation, not the runtime or transport implementation.

## What Each Call Waits For {#completion}

write confirms its storage step, not processing by a worker. await read/take waits for a match or timeout and suspends its caller, not the whole event loop while merely waiting. NO_WAIT only skips waiting for future matches; storage/scan latency remains. CPU work and serialization can still occupy the event loop.

## Which Mechanism When? {#turns}

Use read/take with NO_WAIT for an immediate attempt. Use a bounded timeout for a short result window. Register space_wait for a later agent turn: the call returns a wait ID and the event arrives later. Tools space_read/space_take hold the turn for up to 60 seconds; space_wait supports long waits. notify subscribes to matching writes but does not reserve work and is not a complete audit log.

## Identity and Delivery {#delivery}

Locally, target is a conversation ID (string/number), not a Principal object. Consumer-mailbox routing requires PhiSpaces options.consumer. Remotely the consumer comes from the authenticated connection: remote.events(options), remote.ack(epoch, sequence). Locally use space.events(principal, options), space.ack(principal, epoch, sequence). startService runs local maintenance/delivery; operations still settle expiry without background maintenance, but conversation delivery is not automatic. [Mailbox contract](help.topic.durable_mailboxes_and_ack#overview).
