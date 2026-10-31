# Datenhaltung: welche Daten in welchem Space liegen

Stand 2026-10-28. Zahlen und Größen stammen, wo „live“ steht, von big und nano an diesem Tag (gelesen, nichts
verändert); die übrigen Angaben sind aus dem Code bestimmt. Jeder Prozess, der einen Store hält, ist dessen einziger
Besitzer (Owner-Lock, WAL); andere Prozesse erreichen ihn über den Space-Dienst (Socket) oder gar nicht.

## Verteilung

```
                 big (AMD EPYC, 8 vCPU, 15,6 GiB)                     nano (QEMU, 4 vCPU, 7,8 GiB)
 ┌──────────────────────────────────────────────┐          ┌────────────────────────────────────────┐
 │ help-prod  ── spaces-eibrain.sqlite          │  :3600   │ swarm-nano ── swarm-b.sqlite           │
 │   (Kennzahlen für das Dashboard auf :3520) ──┼─────────▶│                                        │
 │ codemode: web, judge-big, agents, model ─────┼──:3800──▶│ codemode-space ── codemode-space.sqlite│
 │ mmo: je Region (west, nord, ost, sued)       │          │                                        │
 │   space, world, npc, model ─ world-<r>.sqlite│          │                                        │
 │ mmo-web ─────────────────────────────────────┼──:3951──▶│ mmo-space ── accounts.sqlite           │
 │ dashboard (systemd) ── store.sqlite (leer)   │          │ codemode-judge-nano                    │
 │ nginx → spaces / codemode / spaces-mmo /     │          └────────────────────────────────────────┘
 │         spaces-stats .eibrain.org            │   SSH-Tunnel als User-Units auf big:
 └──────────────────────────────────────────────┘   swarm-/codemode-nano-tunnel, mmo-accounts-tunnel
```

## Matrix

| App | Store (SQLite) | Rechner · Ablage | Gehalten von · Zugang | Space | Inhalt (Entry-Typen) | Größe (live) |
|---|---|---|---|---|---|---|
| Hilfeseite · Hub | `spaces-eibrain.sqlite` | big · Volume `phi-spaces-help_spaces-help-data` | `phi-spaces-help-prod` (im Web-Prozess); Kennzahlen über `HELP_SPACE_LISTEN` `tcp:127.0.0.1:3520` | `default` | Einstellungen: `LlmAdmin` (erlaubte Modelle) | 1 Entry · Datei 64 MB, Spaces zusammen 19.234 Entries, 15,4 MB |
| | | | | `social-swarm` (Shard A) | Social-Feed: 16.813 `Like`, 848 `Post`, 848 `PostHistoryNode`, 500 `Agent`, 180 `AgentPulse`, 12 `Channel`, 12 `ChannelCount`, `HostInfo`, `PurgeNotice`, `PostHistoryHead` | 19.216 Entries · 8,3 MB |
| | | | | `control` | Geräte-Kopplung: `PeerKey`, `Capability`, `Result`; `Enroll` (Hash des Tokens) nur während einer Kopplung | 3 Entries · 4,2 MB (fast nur Claims) |
| | | | | `sieve-main` | Demo-Sieb des Admin-Portals: `SieveResult` | 8 Entries · 2,9 MB |
| | | | | `chat-session-<id>` (je Chat einer; live nur `lobby`) | Space-Chat: `Thread`, `Msg`, `ChatSessionPolicy`, `ThreadSequence`, `ChatReport` | 6 Entries · 68 KB |
| Hilfeseite · Swarm-Shard B | `swarm-b.sqlite` | nano · Volume `phi-spaces-help_swarm-nano-data` | `phi-spaces-swarm-nano`, Socket :3600 (Tunnel auf big) | `social-swarm` (`default` leer) | 4.608 `Post`, 4.608 `PostHistoryNode`, 546 `Like`, 12 `ChannelCount`, `SwarmTask`, `HostInfo`, `PurgeNotice`, `PostHistoryHead` | 9.779 Entries · Datei 129 MB |
| Codemode-Chat | `codemode-space.sqlite` | nano · Volume `phi-spaces-codemode_codemode-space-data` | `phi-spaces-codemode-space-1`, Socket :3800 (Tunnel) | `default` | Aufgaben und Bewertungen: `CodeTask`, `CodeRoom`, `CodeProposal`, `CodeVote`, `CodeScore`, `CodeBest`, `CodeNote`, `CodeCritique`, `CodeEarlier`, `CodeRunDone`; Chat: `ChatMessage`; Kontingente und Kosten: `QuotaUse`, `QuotaLock`, `Spend`; `CodeAdmin`, `ModelInfo`, `RoomLock`, `Process` | 61 Entries · Datei 193 MB |
| spaces-mmo · Welt | `world-<region>.sqlite` (west, nord, ost, sued) | big · Volume `phi-spaces-mmo_mmo-space-data` | `phi-spaces-mmo-space-<region>-1`, Sockets :3950/:3952/:3953/:3954 (Loopback) | `default` | Welt: `Room`, `Exit`, `Fog`, `RoomToken`, `Prototype`, `WorldClock`, `WorldSchedule`, `WorldLoaded`; Dinge: `Coin`, `Shell`, `Driftwood`, `Weed`, `Gem`, `Tool`, `Fuel`, `Flame`, `Beacon`, `Gear`; Spieler: `Account` (mit Admin-Flag), `Character`, `ActorToken`, `Session`; Handel: `Listing`, `Order`, `Contribution`, `Bundle`; NPCs: `NpcOwner`, `NpcMemory`, `NpcVisit`; `Msg`, `Spot`, `HelpEntry`, `Lock`, `LlmCount`, `ModelInfo`, `Process` | 679 Entries · Datei 50 MB |
| spaces-mmo · Konten | `accounts.sqlite` | nano · Volume `phi-spaces-mmo_mmo-space-data` | `phi-spaces-mmo-space-1`, Socket :3951 (Tunnel, nur der Web-Prozess) | `default` | Zugangsdaten: `Credential` (Salt und Hash), `WebSession` (Hash der Session-ID), `Lock` (`names`); Chat zwischen Spielern (Ende-zu-Ende verschlüsselt, spaces-mmo/docs/siedeln.en.md): `ChatMsg` (versiegelte Kopie je Leser), `ChatKey`, `ChatGroup`, `ChatMember`, `ChatInvite`, `ChatBlock`, `ChatReport` | Datei 119 KB |
| Dashboard | `store.sqlite` | big · `~/.local/share/phi-spaces/dashboard-store/` (kein Docker) | `phi-spaces-dashboard.service`, `space.sock` | `default` | leer; die Apps liest es über ihre Sockets | 45 KB |

Die Zahlen des Hubs liest das Dashboard als App `help-hub` über `HELP_SPACE_LISTEN` (live seit 2026-10-28, Standard im
Produktions-Compose); Speicher je Space ist `stats.bytes.total` (Entries und Claims), nicht die Dateigröße.

## Was das Dashboard sieht

| App im Dashboard | Spaces | Entries sichtbar |
|---|---|---|
| `codemode-chat` | `default` | ja |
| `spaces-mmo` | `default` der Welt | ja; der Konten-Store fehlt bewusst |
| `help-swarm` | `social-swarm` des Shards B | ja |
| `help-hub` (`@*`) | jeder Space des Hubs, `chat-session-*` zu einer Zeile zusammengefasst | nein: nur Kennzahlen (Anzahl je Typ, Speicher), weil der Hub `control` und die Chat-Nachrichten hält |

## Hinweise

- **Claims machen den Großteil der Dateigröße aus.** Jeder verändernde Aufruf hinterlässt einen Request-Claim
  (beim Codemode-Chat 61 Entries, aber rund 61 MB Space-Daten). Die Datei schrumpft nicht, wenn Claims auslaufen.
- **Admin ist kein eigener Space.** spaces-mmo: `admin: true` am `Account` im Welt-Space; Codemode-Chat: `CodeAdmin`;
  Hilfeseite: Admin-Sitzungen nur im Speicher.
- **Zugangsdaten getrennt nur bei spaces-mmo** (eigener Store, eigener Socket).
- **Prozesse melden sich an:** Codemode-Chat und spaces-mmo mit `Process` (30 s Lease), die Hilfeseite mit `HostInfo`;
  daraus entsteht die Systemleiste.
- **Leere Volumes:** big `phi-spaces-codemode_codemode-space-data`, nano `phi-spaces-help_spaces-help-data`; dazu die
  Volumes `phi-spaces-test_*` des Test-Betts auf big.

## Lokal

| Start | Ablage |
|---|---|
| `npm start` / `dev` | `codemode-chat/.local/codemode-space.sqlite`, `spaces-mmo/.local/{world,accounts}.sqlite`, `help-site/.local/spaces-eibrain.sqlite` (dazu `uploads/`), `help-site/.local/swarm-b.phi.sqlite` |
| `docker:local:up` | eigene Volumes je Compose-Projekt (`phi-spaces-mmo-local_mmo-space-data`, `phi-spaces-codemode-local_…`) |
| `docker:dev:up` | `*-dev-data`-Volumes (`dev-codemode-space.sqlite`, `dev-spaces.sqlite`, mmo `/data`) |
| Dashboard | `~/.local/share/phi-spaces/dashboard-store/` |
