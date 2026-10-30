---
standard: help_topic
id: help.topic.safe_operations
title: "Safe Startup, Model Budgets and Backups"
short: "This guide says how to start the help site safely, limit model costs, and back up data. Web login, device pairing, and network permissions are three separate things here. phi-spaces is experimental, so check it yourself before important data depends on it."
tags: [password, PHI_SPACES_LLM, backup, restore, fsync, sqlite, grant, enrollment, security]
owner: security
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Safe Startup, Model Budgets and Backups

## Three Separate Security Paths {#overview}

This guide says how to start the help site safely, limit model costs, and back up data. Web login, device pairing, and network permissions are three separate things here. phi-spaces is experimental, so check it yourself before important data depends on it.

## Local Startup and Login {#startup}

Web login, peer enrollment and gate grants are different contracts. A local demo provisions neither a phone nor a trusted multi-host network.

After a fresh help build, start locally from the repository root; never overwrite an existing .env. HELP_BIND=127.0.0.1 prevents public exposure. Web login is disabled without a private PHI_SPACES_ADMIN_PASSWORD; there is no default password. Compose requires it during configuration resolution. In production host networking, HOST_BIND selects the bind; empty opens 0.0.0.0. Raw shard TCP sockets have no TLS: use a protected network/SSH tunnel. The same goes for the standalone service (npm run space-server): whoever reaches its socket uses the space. The optional dashboard port HELP_SPACE_LISTEN has a role of its own that reads only spaces and figures, no entries.

```bash
HELP_BIND=127.0.0.1 PHI_SPACES_LLM=0 npm --prefix help-site start
```


## Peer Pairing and Model Costs {#pairing-and-models}

Enrollment tokens register peer/app keys but do not open a web-admin session. Real gate connections require peer discovery, key proof and appropriate grants. AdminSpaces operates with its configured instance's authority, not blanket rights over other hosts. PHI_SPACES_LLM=0 keeps demos deterministic; credentials alone enable no models. Explicit PHI_SPACES_LLM=1 uses shared process limits of six calls/minute, two concurrent, 400 output tokens and 20 seconds/provider call; model changes require an admin session and CSRF token.

## Durability, Backup and Restore {#backup}

The in-memory store is volatile. The own SQLite store runs in WAL mode with synchronous=FULL (option NORMAL: a process crash loses nothing, a system failure can); pi-durable plays no part in it, and JSONL is not a space store. The reopen in the example only proves restart, not your own power- or host-loss safety. An owner lock (path + .owner) admits only one process. The file otherwise only grows: host.compact() gives free pages back, and the first call rewrites it once with VACUUM. For backups, stop the store exclusively or use a consistent SQLite backup path, not a blind copy of a live file and its WAL. Include store, upload files and confidential host configuration. Verify restore in an isolated target; respect incarnation/authority, quarantine and release. An async backup is not lossless promotion, and a readPage token is not a disaster-recovery backup.
