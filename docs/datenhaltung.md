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
 │ mmo: web, world-big, npc, model ─────────────┼──:3950──▶│ mmo-space ── world.sqlite              │
 │                     (nur web) ───────────────┼──:3951──▶│              accounts.sqlite           │
 │ dashboard (systemd) ── store.sqlite (leer)   │          │ codemode-judge-nano, mmo-world-nano    │
 │ nginx → spaces / codemode / spaces-mmo /     │          └────────────────────────────────────────┘
 │         spaces-stats .eibrain.org            │   SSH-Tunnel als User-Units auf big:
 └──────────────────────────────────────────────┘   swarm-/codemode-/mmo-nano-tunnel (127.0.0.1:Port → nano)
```

## Matrix

| App | Store (SQLite) | Rechner · Ablage | Gehalten von · Zugang | Space | Inhalt (Entry-Typen) | Größe (live) |
|---|---|---|---|---|---|---|
| Hilfeseite · Hub | `spaces-eibrain.sqlite` | big · Volume `phi-spaces-help_spaces-help-data` | `phi-spaces-help-prod` (im Web-Prozess); Kennzahlen über `HELP_SPACE_LISTEN` `tcp:127.0.0.1:3520` | `default` | Einstellungen: `LlmAdmin` (erlaubte Modelle) | Datei 64 MB |
| | | | | `social-swarm` (Shard A) | Social-Feed: `Post`, `PostHistory*`, `Like`, `ChannelCount`, `SwarmTask`, `Agent`, `AgentPulse`, `HostInfo` | |
| | | | | `control` | Geräte-Kopplung: `Enroll` (Hash des Tokens), `PeerKey` | |
| | | | | `sieve-main` | Demo-Sieb des Admin-Portals | |
| | | | | `chat-session-<id>` (je Chat einer) | Space-Chat: `Thread`, `Msg`, `ChatSessionPolicy`, `ChatReport` | |
| Hilfeseite · Swarm-Shard B | `swarm-b.sqlite` | nano · Volume `phi-spaces-help_swarm-nano-data` | `phi-spaces-swarm-nano`, Socket :3600 (Tunnel auf big) | `social-swarm` (`default` leer) | 4.608 `Post`, 4.608 `PostHistoryNode`, 546 `Like`, 12 `ChannelCount`, `SwarmTask`, `HostInfo`, `PurgeNotice`, `PostHistoryHead` | 9.779 Entries · Datei 129 MB |
| Codemode-Chat | `codemode-space.sqlite` | nano · Volume `phi-spaces-codemode_codemode-space-data` | `phi-spaces-codemode-space-1`, Socket :3800 (Tunnel) | `default` | Aufgaben und Bewertungen: `CodeTask`, `CodeRoom`, `CodeProposal`, `CodeVote`, `CodeScore`, `CodeBest`, `CodeNote`, `CodeCritique`, `CodeEarlier`, `CodeRunDone`; Chat: `ChatMessage`; Kontingente und Kosten: `QuotaUse`, `QuotaLock`, `Spend`; `CodeAdmin`, `ModelInfo`, `RoomLock`, `Process` | 61 Entries · Datei 193 MB |
| spaces-mmo · Welt | `world.sqlite` | nano · Volume `phi-spaces-mmo_mmo-space-data` | `phi-spaces-mmo-space-1`, Socket :3950 (Tunnel) | `default` | Welt: `Room`, `Exit`, `Fog`, `RoomToken`, `Prototype`, `WorldClock`, `WorldSchedule`, `WorldLoaded`; Dinge: `Coin`, `Shell`, `Driftwood`, `Weed`, `Gem`, `Tool`, `Fuel`, `Flame`, `Beacon`, `Gear`; Spieler: `Account` (mit Admin-Flag), `Character`, `ActorToken`, `Session`; Handel: `Listing`, `Order`, `Contribution`, `Bundle`; NPCs: `NpcOwner`, `NpcMemory`, `NpcVisit`; `Msg`, `Spot`, `HelpEntry`, `Lock`, `LlmCount`, `ModelInfo`, `Process` | 679 Entries · Datei 50 MB |
| spaces-mmo · Konten | `accounts.sqlite` | nano · dasselbe Volume | derselbe Container, Socket :3951 (nur der Web-Prozess) | `default` | Zugangsdaten: `Credential` (Salt und Hash), `WebSession` (Hash der Session-ID), `Lock` (`names`) | Datei 119 KB |
| Dashboard | `store.sqlite` | big · `~/.local/share/phi-spaces/dashboard-store/` (kein Docker) | `phi-spaces-dashboard.service`, `space.sock` | `default` | leer; die Apps liest es über ihre Sockets | 45 KB |

Die Spaces des Hubs sind aus dem Code bestimmt (`help-site/server/`); ihre Zahlen zeigt das Dashboard als App
`help-hub`, sobald help-prod mit `HELP_SPACE_LISTEN` läuft (Standard im Produktions-Compose).

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
