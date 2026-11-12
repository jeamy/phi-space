# M1: the space server on the phone

M1 runs the Rust space server (`phi-space-server`) on an Android phone, next to the agent host of pi-termux-mobile,
and lets that host's conversations take part in a space as agents of their own.

## The binary

`phi-space-server` builds for `aarch64-linux-android` with the NDK of the neighbouring project
(`pi-termux-mobile/tools/android-sdk/ndk/<version>`, API 24 clang):

```sh
NDK=…/toolchains/llvm/prebuilt/linux-x86_64/bin
CC_aarch64_linux_android=$NDK/aarch64-linux-android24-clang \
AR_aarch64_linux_android=$NDK/llvm-ar \
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android24-clang \
cargo build --release --locked --target aarch64-linux-android -p phi-space-server
```

The app's target SDK (28) lets it run a binary from its own files directory. On 2026-11-11 the binary ran as the
app (`run-as org.pimobile.app`) with a store file in the app's files. A write over a forwarded TCP port, a SIGKILL
and a restart kept the data.

## The agent frame

One process on the phone, the agent host, holds the connection to the space for all of its conversations. The
space must still tell those conversations apart, because each needs its own mailbox, its own claims and its own
pending budget. The host's connection therefore has the role `agentHost`, and every call it makes for a
conversation carries `frame.agent`:

```json
{ "method": "events", "args": { … }, "frame": { "agent": "conversation-3" } }
```

The service does the following, the same in TypeScript (`src/service.ts`) and Rust (`phi-service`):

- When the connection's identity has the role `agentHost` and no `agentId` of its own, the call is handled as the
  principal `{peerId: <the host's peer>, agentId: <frame.agent>}`. The role `agentHost` is dropped for that call, so
  an agent can never act for a further agent.
- When any other connection names an agent, the call is refused with `PermissionDenied`.
- `frame.agent` must be 1 to 128 characters of `A-Z a-z 0-9 _ . : -`. Anything else is refused with `BadRequest`.
- A call without `frame.agent` behaves exactly as before.

The standalone server grants the role with `--agent-host`. In TypeScript that is
`npm run space-server -- … --agent-host`; in Rust it is `phi-space-server … --agent-host`. On the client side,
`RemoteSpace` takes the option `agent` and sends it as `frame.agent` on every call except the key proof and
pairing calls.

`test/test-agent-frame.test.ts` holds the contract. It checks the principal and roles in `hello`, that each agent
has its own mailbox, and that wrong or unauthorised agent names are refused. With `PHI_SPACES_SERVER_CMD` it runs
against the Rust server.

## Remote conversations over a Space (replacing pi-server/pi-client)

Decided 2026-11-11 (variant 3): the phone's remote conversations stop using pi-server, pi-client and
pi-protocol, which stay at 1.1.0 and need Chord 1.1.0 next to the agent's 1.5.2. Instead they run through a
Space. Only the session transport changes. `remote-provision.mjs` still installs the runtime over SSH.

### The contract being replaced

pi-serverd answers two services. The phone's `server.mjs` only uses them through its `remote` object.

| Service | Member | Arguments | Answer |
|---|---|---|---|
| sessions | list | | `{sessions}` |
| sessions | models | | `{models: [{provider, modelId}]}` |
| sessions | create | `{name?}` | `{id}` |
| sessions | delete | id | `{ok}` (aborts, then removes; transcript stays) |
| sessions | rename | id, name | `{ok}` |
| sessions | attach | id | `{ok}` (binds the chat calls to that session) |
| chat | prompt | `{message, requestId, whenBusy}` | `{submissionId}`; `requestId` makes it exactly-once |
| chat | abort | | `{ok}` |
| chat | compact | `{instructions?}` | `{ok, taskId}` |
| chat | state | | the conversation view and `busy` |
| chat | configure | `{model: {provider, modelId}}` | `{ok}` |
| chat | history | `{limit}` (≤ 500) | `{entries, epoch, cursor}` oldest first |
| chat | events | `{after, epoch}` | long poll of 25 s: `{epoch, cursor, reset, events}` (self-contained snapshots) |

This table is the specification. The parity test at the end runs the existing `remote-state` and
`remote-regressions` suites against the new transport.

### Calls as entries

The design uses only operations both servers already have (`write`, `take`, `read` with a wait, leases, the
request identity of `RemoteSpace`). It adds no service method, so the Rust server serves it as is.

- **Space.** One Space per agent host, for example `remote-<host>`. Only the agent host and the paired phones
  have access, through the coordinator's grants. The policy grants rights per method and role, not per entry
  type, so the Space itself is the boundary.
- **`RemoteCall`** `{callId, session?, member, args}`, written by the phone with a lease of a few minutes.
  `callId` is chosen by the phone. A retry after OutcomeUnknown keeps the same request identity, so the write
  happens once.
- **The host** takes `RemoteCall` entries (`take` with a wait), carries out the member, and writes
  **`RemoteAnswer`** `{callId, ok, result | error}` with a lease of a few minutes. A call the host took but did
  not answer, because it crashed, comes back when the take's transaction lease runs out: take and answer run in
  one transaction. A `prompt` passes on its `requestId` (from the entry, never from a delivery count), so the
  harness runs the turn once even when the call is carried out twice.
- **The phone** waits for `RemoteAnswer {callId}` with a blocking `take`. Its own answer is taken, so answers
  do not pile up. One that is never taken expires with its lease.
- **`events`** stays a long poll. The host answers when there are events or after 25 s. The answer carries the
  self-contained snapshots and pages of `common.mjs` (bounded by the frame limit), never token deltas as
  entries of their own.

### Identity

The old path was authenticated by SSH. A LAN listener without authentication would let anyone on the network
drive a conversation that has bash tools, so it is not an option. The phone connects as for "Space öffnen":
key proof with its Keystore key at the host's gate (layer B) and a grant from the coordinator for the remote
Space. The agent host is a federation Member (`PI_SERVERD_FEDERATION_CONFIG`).

### Steps

1. Host side in pi-termux-mobile `pi-serverd.mjs` (the conversations live there): a call loop next to the
   pi-server listener, with the same member functions. Tests with scripted models against the TypeScript and
   Rust servers: one turn after a retry following OutcomeUnknown, a crash between take and answer, isolation of
   sessions.
   **Done 2026-11-11.**
   - `runtime/remote-calls.mjs` holds the host loop (`serveRemoteCalls`), the phone's call (`callRemote`) and
     the phone's `remote` object (`remoteOverSpace`). Answers above an entry's size go in parts.
   - `pi-serverd.mjs` shares `sessionsMember`/`chatMember` between both paths and serves the calls with
     `PI_SERVERD_REMOTE_SPACE=local[:alias]|unix:…|tcp:…`.
   - `runtime/test-remote-space.mjs` passes against both servers (`PHI_SPACES_SERVER_CMD` for Rust). It covers a
     host that dies after taking a call (the call comes back and is answered once), a 300 000-character answer,
     unknown members, and pi-serverd end to end (one turn for a repeated requestId, separate sessions, rename,
     delete).
   - Known gap: `create` has no request identity. A host crash between creating the session and committing
     the answer leaves an extra empty session.
2. Phone side: a `remote` object over the Space with the same interface as `remote-client.mjs`, behind a
   switch. `remote-state` and `remote-regressions` stay green against both transports.
   **Done 2026-11-11.**
   - Under Spaces, "4 · Remote-Sitzungen über Space" stores the agent host (`MobileSpaces` `remoteHost`: host
     id, endpoint, Space; the key is allowed at that host).
   - The Remote page offers it in its host list as "(über Space)", which is the switch. `POST
     /api/remote/connect-space` opens it with `MobileSpaces.openRemote()`: key proof at the agent host's gate
     and a coordinator grant on every call. It hands `remoteOverSpace` to `remoteState.connectVia`, which has
     the same generation rules as an SSH connection.
   - Tests:
     - pi-termux-mobile `test/spaces-mobile.test.mjs`: a gate in front of a real space service refuses
       anything without proof and grant, and the loop answers the phone's `list`.
     - `runtime/test-remote-state.mjs`: a late open does not resurrect a cancelled connection.
     - The runtime suite (27) is green.
3. Device test over WLAN with key proof.
   **Done 2026-11-11.**
   - pi-termux-mobile `scripts/remote-demo/run.sh` runs it; the flow is in its `docs/remote-demo.md`.
   - The demo starts `test/testbed/device/b9-coordinator.ts` with `B9_REMOTE_SOCKET`. The coordinator then also
     serves its Space `remote` to pi-serverd (scripted model) on a private socket as the peer `agent-host`, under
     the gate's authority, because generations are bound to the authority.
   - The phone is driven over adb through its app bridge:
     - it pairs over WLAN with a new Keystore key;
     - it gives the key proof;
     - it stores the agent host;
     - it connects the Remote page over the Space (`connect-space`);
     - it creates a session and sends one prompt, and `echo: …` comes back.
   - The demo found that `remote-calls.mjs` was missing from the APK (the app's node exited on start). The Android
     build now refuses a packaged module that imports a sibling it does not package.
4. Then remove pi-server, pi-client, pi-protocol and the Chord 1.1.0 overrides. In phi-spaces this touches
   `src/pi-server.ts` and `npm run test:pi-server`, so it is planned on its own.
   **Done 2026-11-11.**
   - pi-serverd has two sockets, both `serveSpace`:
     - The conversation socket (`PI_SERVERD_SOCK`, the one the phone forwards over SSH) serves a store of its own
       in memory. That store holds nothing but the calls, with a reaper, and its peer `ssh` reaches none of the
       daemon's Spaces.
     - Space RPC on the daemon's store is on `PI_SERVERD_SPACE_SOCK`. It exists only with
       `PI_SERVERD_SPACE_PRINCIPAL`/`PI_SERVERD_SPACE_ROLES` or a federation.
   - `PI_SERVERD_REMOTE_SPACE` still adds a federation Space.
   - pi-termux-mobile `attachRemote` keeps its interface: SSH tunnel, then `connectSpace` and `callRemote`.
     - A tunnel that exits or a transport error is reported as lost; an error the host answers is not.
     - `requestTimeoutMs` bounds every call, the 25 s long poll of `events` included.
     - A daemon whose update was declined and that does not answer gets the message to allow the update.
   - The SSH provisioning ships `remote-calls.mjs` too (it was missing since step 1); a test holds the shipped
     modules' imports against the list.
   - In phi-spaces, `src/pi-server.ts` (`withSpaceService`, `piServerTransport`, the `Routed*` types) and
     `test/test-pi-server.test.ts` are gone.
   - `agent/test/pi-serverd.test.ts` holds the built bundle in the real pi-serverd over both sockets.
   - The mobile runtime has one Chord, 1.5.2, and no overrides.
   - Known limits:
     - The SSH path ran on 2026-11-12 from the phone against one real host, this machine
       (pi-termux-mobile `scripts/remote-demo/phone-ssh.mjs`):
       - first run: provisioning;
       - second run: health check over the calls, sessions, an idle 25 s long poll, no `space.sock`.
       - The other saved clients were not reached: rb5 has Node 22.18.0, and the 192.168.1.x hosts are on another
         network.
     - Every host provisioned before asks for an update on its next connect (a full `npm install`).
     - A long poll of `events` holds one of the daemon's 16 call workers for 25 s: more clients polling at once
       make later calls wait.

## Still open

- The agent side: `remoteSpaces(…)` in `agent/src/agent.ts` with one agent id per conversation, and an event pump
  that reads each conversation's mailbox, hands an event to the conversation under a request id derived from the
  event, and acknowledges it only after the hand-over.
- In pi-termux-mobile: starting and supervising the binary in the app service (pi-serverd), and Doze.
- A device test over WLAN against a coordinator on the LAN.
