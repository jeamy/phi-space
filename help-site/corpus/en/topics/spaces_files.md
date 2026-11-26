---
standard: help_topic
id: help.topic.spaces_files
title: "spaces-files: files for people and agents"
short: "A filesystem with Zanzibar-style rights: what it is, why agents need identities of their own, what it is for and how it is built on phi-spaces."
tags: [apps, spaces-files, files, zanzibar, permissions, agents, groups, receipts]
owner: ops
related: [help.topic.apps, help.topic.leases_and_transactions, help.topic.gate_auth_grants_and_recovery, help.topic.agent_tools_and_replay]
since: 0.0.1
---

# spaces-files: files for people and agents

## Overview {#overview}

spaces-files is a filesystem on phi-spaces for **people and individual agent instances**. Both work on the same files, each under an identity of its own and with rights of its own. The rights follow the model of Google's Zanzibar: they are relationships ("group North is editor of dispatch"), evaluated afresh on every operation, and a revocation holds for every later check.

| Question | In short |
|---|---|
| What | Files and directories in workspaces, with the roles owner, editor, viewer, groups and inheritance |
| Why | Agents need an identity of their own that can be revoked, not a person's account |
| What for | People and agents share work without overwriting each other or seeing too much |
| How | One private space per tenant for metadata and rights, encrypted blobs for the contents |
| Where | On big at spaces-files.eibrain.org; locally with `npm run spaces-files` |

## What it is {#what}

The terms:

- **Tenant:** a closed customer or team with a private space of its own. Tenants do not see each other.
- **Actor:** a person (user) or an agent instance (agent). Every actor has a stable ID and a **home**, a workspace of its own created with it in the same transaction.
- **Workspace:** a named top-level directory, e.g. `dispatch`. Below it are directories and files, text or binary.
- **Roles:** owner may grant rights and edit, editor may edit and read, viewer may read. A role comes from a direct grant, from a grant to a group (nested groups too), or is inherited from a directory above.
- **Tenant administrator:** manages the actors, groups and workspaces of the tenant; this gives no file rights.
- **Host operator:** runs the service: tenants, keys, backups, limits. Works through a local interface of its own without file operations.

A file has versions. A save is always "over version n": if someone else has saved version n+1 in the meantime, a version conflict comes back, and the other's text is not lost.

## Why {#why}

Once agents take part, the usual solutions fall short:

- **An agent with a person's account** can do everything that person can, and afterwards nobody knows who did what. In spaces-files every agent instance is an actor of its own: bound to the agent host that runs it and its agent ID. Its rights are visible and can be revoked on their own.
- **A revocation must hold at once.** When Lea is removed from the group North, her editor that is already open may no longer save, and if North was her only access, `dispatch` disappears from her list: every path in it then answers exactly like a path that does not exist. That is why every operation re-evaluates the relationships instead of trusting a session.
- **Concurrent work** by people and agents creates conflicts. Versions make them visible instead of silently overwriting one side.
- **Networks lose replies.** Every changing operation carries a signed operation ID; a retry after a lost reply returns the stored receipt instead of applying the change twice.

## What for {#purpose}

- A team and its planning agent work on the same brief; the agent sees the people's changes before it writes on.
- Every agent gets a home of its own for notes and drafts that nobody else sees until it shares them.
- A review agent gets viewer on a workspace and can read but change nothing.
- A group gives rights to many at once; whoever leaves the group loses exactly the access that came through it.
- Read-only mounts (`@name`) show files of another system with that system's rights, without copying them.

## How it works {#how}

### Rights as relationships {#rights}

Rights are tuples in the tenant's space, for example:

```text
group:north#member@user:lea
directory:dispatch#editor@group:north#member
directory:dispatch#owner@agent:planner-17
```

Lea is a member of North, North is editor of `dispatch`, the agent planner-17 is owner. The rights extend downwards to everything in `dispatch`. The effective rights are the union of all paths; a revocation removes only that one path. A workspace is visible exactly when one has viewer on its root.

### Store and contents {#store}

The tenant's space holds actors, nodes (directories, files), relations, receipts and the audit, all in phi-spaces' own SQLite store. An operation runs in its tenant's queue and in **one** transaction: check the rights, change, write receipt and audit. The file contents do not live in the space but beside it as blobs, one file per version, sealed with AES-256-GCM. The space only holds the reference to the current version. The tenant spaces are never exposed: a generic space tool would bypass the rights check.

### Access {#access}

- **Browser:** over HTTPS. Sign-in through an OpenID provider or, where none is set up (on big for now), with username and password. The host operator sets the password; only a scrypt hash is stored. The session is a `__Host-` cookie (Secure, HttpOnly, SameSite=Strict); every change checks the origin and a CSRF token.
- **Agents:** an agent host connects over a unix socket of its own per host and tenant, or from another machine over TLS with phi-spaces' key proof. The host names the agent ID for each conversation; together with the host that is the actor's identity. `client/agent-client.ts` provides the tools with relative paths.
- **Administration:** the tenant administrator works in the browser; the host operator over a socket in the state directory (`operator create-tenant`, `set-password`, `backup`, …).

### Operations and recovery {#operations}

The service and its space process are separate processes; the space process exists in TypeScript and in Rust (`files-space`). Backups are encrypted archives, one for the data and one for the deployment state (sessions, keys, passwords). A restore advances the session epoch, so no old session survives. For a second site there is a standby with fencing and promotion; it is tested but not switched on on big.

## Where it runs {#where}

- **big:** one container (the service and the Rust space process) behind nginx at https://spaces-files.eibrain.org. Every day the encrypted backups go to nano, into an account that may add but not delete.
- **Locally:** `npm run spaces-files` (`FILES_MEM=1` keeps everything in memory), tests with `npm run test:spaces-files`.

## Limits {#limits}

- A tenant has exactly one instance that admits its operations; that is the basis of the ordering guarantee. Several hosts for many tenants are noted as a possible extension.
- The space stats leave the app out on purpose, because it would expose the tenant spaces.
- On big there is password sign-in for now and no agent hosts on other machines; both are built and can be switched on.

## Further reading {#further}

- In the repository: `spaces-files/README.md` (state and evidence), `docs/zanzibar-agent-filesystem-plan.en.md` (plan and decisions), `spaces-files/docs/operator-guide.en.md` (operations).
- [Apps on phi-spaces](help.topic.apps#files) puts the app beside the others.
- [Leases and transactions](help.topic.leases_and_transactions#overview) explains the transactions every operation rests on.
