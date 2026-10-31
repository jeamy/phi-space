# Data storage: which data lies in which Space

As of 2026-10-28. Numbers and sizes, where "live" is stated, come from big and nano on this day (read, nothing
changed); the other statements are determined from the code. Every process that holds a store is its only
owner (owner lock, WAL); other processes reach it through the Space service (socket) or not at all.

## Distribution

```
                 big (AMD EPYC, 8 vCPU, 15.6 GiB)                     nano (QEMU, 4 vCPU, 7.8 GiB)
 ┌──────────────────────────────────────────────┐          ┌────────────────────────────────────────┐
 │ help-prod  ── spaces-eibrain.sqlite          │  :3600   │ swarm-nano ── swarm-b.sqlite           │
 │   (figures for the dashboard on :3520)     ──┼─────────▶│                                        │
 │ codemode: web, judge-big, agents, model ─────┼──:3800──▶│ codemode-space ── codemode-space.sqlite│
 │ mmo: per region (west, nord, ost, sued)      │          │                                        │
 │   space, world, npc, model ─ world-<r>.sqlite│          │                                        │
 │ mmo-web ─────────────────────────────────────┼──:3951──▶│ mmo-space ── accounts.sqlite           │
 │ dashboard (systemd) ── store.sqlite (empty)  │          │ codemode-judge-nano                    │
 │ nginx → spaces / codemode / spaces-mmo /     │          └────────────────────────────────────────┘
 │         spaces-stats .eibrain.org            │   SSH tunnels as user units on big:
 └──────────────────────────────────────────────┘   swarm-/codemode-nano-tunnel, mmo-accounts-tunnel
```

## Matrix

| App | Store (SQLite) | Machine · location | Held by · access | Space | Content (entry types) | Size (live) |
|---|---|---|---|---|---|---|
| Help site · hub | `spaces-eibrain.sqlite` | big · volume `phi-spaces-help_spaces-help-data` | `phi-spaces-help-prod` (in the web process); figures through `HELP_SPACE_LISTEN` `tcp:127.0.0.1:3520` | `default` | Settings: `LlmAdmin` (allowed models) | 1 entry · file 64 MB, Spaces together 19,234 entries, 15.4 MB |
| | | | | `social-swarm` (shard A) | Social feed: 16,813 `Like`, 848 `Post`, 848 `PostHistoryNode`, 500 `Agent`, 180 `AgentPulse`, 12 `Channel`, 12 `ChannelCount`, `HostInfo`, `PurgeNotice`, `PostHistoryHead` | 19,216 entries · 8.3 MB |
| | | | | `control` | Device pairing: `PeerKey`, `Capability`, `Result`; `Enroll` (hash of the token) only during a pairing | 3 entries · 4.2 MB (almost only claims) |
| | | | | `sieve-main` | Demo sieve of the admin portal: `SieveResult` | 8 entries · 2.9 MB |
| | | | | `chat-session-<id>` (one per chat; live only `lobby`) | Space chat: `Thread`, `Msg`, `ChatSessionPolicy`, `ThreadSequence`, `ChatReport` | 6 entries · 68 KB |
| Help site · swarm shard B | `swarm-b.sqlite` | nano · volume `phi-spaces-help_swarm-nano-data` | `phi-spaces-swarm-nano`, socket :3600 (tunnel on big) | `social-swarm` (`default` empty) | 4,608 `Post`, 4,608 `PostHistoryNode`, 546 `Like`, 12 `ChannelCount`, `SwarmTask`, `HostInfo`, `PurgeNotice`, `PostHistoryHead` | 9,779 entries · file 129 MB |
| Codemode chat | `codemode-space.sqlite` | nano · volume `phi-spaces-codemode_codemode-space-data` | `phi-spaces-codemode-space-1`, socket :3800 (tunnel) | `default` | Tasks and ratings: `CodeTask`, `CodeRoom`, `CodeProposal`, `CodeVote`, `CodeScore`, `CodeBest`, `CodeNote`, `CodeCritique`, `CodeEarlier`, `CodeRunDone`; chat: `ChatMessage`; quotas and costs: `QuotaUse`, `QuotaLock`, `Spend`; `CodeAdmin`, `ModelInfo`, `RoomLock`, `Process` | 61 entries · file 193 MB |
| spaces-mmo · world | `world-<region>.sqlite` (west, nord, ost, sued) | big · volume `phi-spaces-mmo_mmo-space-data` | `phi-spaces-mmo-space-<region>-1`, sockets :3950/:3952/:3953/:3954 (loopback) | `default` | World: `Room`, `Exit`, `Fog`, `RoomToken`, `Prototype`, `WorldClock`, `WorldSchedule`, `WorldLoaded`; things: `Coin`, `Shell`, `Driftwood`, `Weed`, `Gem`, `Tool`, `Fuel`, `Flame`, `Beacon`, `Gear`; players: `Account` (with admin flag), `Character`, `ActorToken`, `Session`; trade: `Listing`, `Order`, `Contribution`, `Bundle`; NPCs: `NpcOwner`, `NpcMemory`, `NpcVisit`; `Msg`, `Spot`, `HelpEntry`, `Lock`, `LlmCount`, `ModelInfo`, `Process` | 679 entries · file 50 MB |
| spaces-mmo · accounts | `accounts.sqlite` | nano · volume `phi-spaces-mmo_mmo-space-data` | `phi-spaces-mmo-space-1`, socket :3951 (tunnel, only the web process) | `default` | Credentials: `Credential` (salt and hash), `WebSession` (hash of the session ID), `Lock` (`names`); chat between players (end-to-end encrypted, spaces-mmo/docs/siedeln.en.md): `ChatMsg` (sealed copy per reader), `ChatKey`, `ChatGroup`, `ChatMember`, `ChatInvite`, `ChatBlock`, `ChatReport` | file 119 KB |
| Dashboard | `store.sqlite` | big · `~/.local/share/phi-spaces/dashboard-store/` (no Docker) | `phi-spaces-dashboard.service`, `space.sock` | `default` | empty; it reads the apps over their sockets | 45 KB |

The dashboard reads the figures of the hub as the app `help-hub` through `HELP_SPACE_LISTEN` (live since 2026-10-28, default in the
production compose); memory per Space is `stats.bytes.total` (entries and claims), not the file size.

## What the dashboard sees

| App in the dashboard | Spaces | Entries visible |
|---|---|---|
| `codemode-chat` | `default` | yes |
| `spaces-mmo` | `default` of the world | yes; the accounts store is deliberately missing |
| `help-swarm` | `social-swarm` of shard B | yes |
| `help-hub` (`@*`) | every Space of the hub, `chat-session-*` collapsed into one row | no: only figures (count per type, memory), because the hub holds `control` and the chat messages |

## Notes

- **Claims make up most of the file size.** Every changing call leaves a request claim
  (in the codemode chat 61 entries, but about 61 MB of Space data). The file does not shrink when claims run out.
- **Admin is no separate Space.** spaces-mmo: `admin: true` on the `Account` in the world Space; codemode chat: `CodeAdmin`;
  help site: admin sessions only in memory.
- **Credentials separated only in spaces-mmo** (separate store, separate socket).
- **Processes register:** codemode chat and spaces-mmo with `Process` (30 s lease), the help site with `HostInfo`;
  the system bar arises from this.
- **Empty volumes:** big `phi-spaces-codemode_codemode-space-data`, nano `phi-spaces-help_spaces-help-data`; plus the
  volumes `phi-spaces-test_*` of the test bed on big.

## Local

| Start | Location |
|---|---|
| `npm start` / `dev` | `codemode-chat/.local/codemode-space.sqlite`, `spaces-mmo/.local/{world,accounts}.sqlite`, `help-site/.local/spaces-eibrain.sqlite` (plus `uploads/`), `help-site/.local/swarm-b.phi.sqlite` |
| `docker:local:up` | separate volumes per compose project (`phi-spaces-mmo-local_mmo-space-data`, `phi-spaces-codemode-local_…`) |
| `docker:dev:up` | `*-dev-data` volumes (`dev-codemode-space.sqlite`, `dev-spaces.sqlite`, mmo `/data`) |
| Dashboard | `~/.local/share/phi-spaces/dashboard-store/` |
