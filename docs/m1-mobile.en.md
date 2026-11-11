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

## Still open

- The agent side: `remoteSpaces(…)` in `agent/src/agent.ts` with one agent id per conversation, and an event pump
  that reads each conversation's mailbox, hands an event to the conversation under a request id derived from the
  event, and acknowledges it only after the hand-over.
- In pi-termux-mobile: starting and supervising the binary in the app service (pi-serverd), and Doze.
- A device test over WLAN against a coordinator on the LAN.
