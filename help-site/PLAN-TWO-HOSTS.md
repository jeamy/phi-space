# Plan: Demo-Last auf zwei Rechner verteilen (`big` + `nano`)

Stand: 2026-10-17 — **Phase B implementiert und lokal getestet** (Hub +
`nano-host` über Unix-Socket; b-Posts im Merge-Feed, Reply-Routing,
Shard-übergreifende `agent.posts`/`thread.fetch`/`ai.posts`-Queries,
aggregierte Stats `shards/shardsUp`).
Ziel: Die Social-Swarm-Demo (und perspektivisch die ganze Hilfe-Site) auf zwei
Rechner verteilen — `big` trägt die Hauptlast, `nano` entlastet.

## 1. Ausgangslage

Lasttreiber auf `big` (gemessen, siehe Profiling-Sessions):

- Jeder Space-Commit ist **O(live entries)** — `settle`/`maintain` scannen das Doc.
- ~10–25 Commits/s durch Producer, Worker, Pulses, Likes.
- Broadcast-Deltas + Stats-Tick scannen den Änderungsstrom.
- LLM-Aufrufe sind extern, kosten lokal fast nichts.

Seit Pruning entfernt wurde (alle Daten bleiben durable erhalten) wächst `N`
kontinuierlich — die Verteilung wird damit langfristig *wichtiger*, nicht weniger.

Vorhandene pi-spaces-Primitive, die direkt nutzbar sind:

- `src/socket.ts` `serveSpace({ listen: { host, port } })` — Space über TCP exponieren.
- `src/remote.ts` `RemoteSpace` — transparenter Client auf einen remote Space.
- `src/entry-replication.ts` — durable Entry-Replikation (Backup/Failover).
- v5-Federationsdemo — HRW-Sharding + Router, aktuell in einem Prozess simuliert.

## 2. Zielarchitektur

```text
            Browser / Mobile
                  │  HTTPS + WSS
                  ▼
        ┌───────────────────┐         TCP socket (serveSpace)
        │        big        │◄───────────────┐
        │ Next.js + WS-Hub  │                │
        │ Space "social-a"  │      ┌─────────┴──────────┐
        │ SQLite, Producer, │      │        nano        │
        │ Worker, Reaper,   │      │ Space "social-b"   │
        │ LLM-Client        │      │ SQLite, Producer,  │
        └───────────────────┘      │ Worker, Reaper     │
                                   └────────────────────┘
```

- `big`: Frontend (Next.js, WS-Hub, AdminSpaces), Koordinator/Router,
  Space `social-a` mit eigener SQLite, Producer + Worker für Shard A, LLM.
- `nano`: Space `social-b` mit eigener SQLite, Producer + Worker für Shard B,
  Reaper/Maintenance lokal. Kein Next.js nötig — reiner Space-Host
  (`serveSpace` auf TCP, z. B. `nano:3600`).

## 3. Phase 0 — Baseline messen

Vor jeder Änderung auf `big`:

```bash
docker stats pi-spaces-help-prod --no-stream
curl -o /dev/null -w '%{time_total}\n' http://localhost:3500/?view=feed
```

Kennzahlen: CPU %, HTTP-Latenz, Commits/s, Doc-Entry-Anzahl.

## 4. Phase A — Remote-Worker (kleiner Schritt, begrenzter Gewinn)

`nano` verbindet sich per `RemoteSpace` auf den Swarm-Space von `big` und
konsumiert `SwarmTask`s remote (`take` + `write` über TCP).

- **Gewinn**: Task-Verarbeitung (LLM-Render, Text-Gen) läuft auf nano.
- **Grenze**: Die O(entries)-Commit- und Scan-Kosten bleiben auf `big` — das
  Doc liegt dort. Ehrlich: nur ein Übergangsschritt, ~10–20 % Entlastung.

Aufwand: klein. `RemoteSpace` + `socket.ts` existieren, Worker-Loop ist schon
gegen `SpaceLike` geschrieben.

## 5. Phase B — Space-Sharding (die eigentliche Verteilung)

Der Swarm-Space wird in zwei durable Spaces gesplittet — wie v5, aber real
(**so umgesetzt**):

- `social-swarm` existiert auf beiden Hosts als eigener Space — `big` mit
  `post-N`-Ids, `nano` mit `b-post-N`-Ids (das Präfix **ist** das
  Shard-Verzeichnis: Routing ohne Lookup-Tabelle).
- **Routing**: Replies/Likes/Acks gehen in die Shard des Ziel-Posts
  (`postId`-Präfix) → Threads bleiben zusammen. Neue Posts splittet der Hub
  ~50/50. (Implementierungshinweis: Producer laufen zentral auf dem Hub —
  ein Remote-Write kostet `big` nur den RPC, der Commit/Scan liegt auf nano.
  `SWARM_PRODUCE=1` lässt nano zusätzlich lokal produzieren.)
- **Worker je Shard lokal**: Hub-Dispatcher konsumiert `social-a`-Tasks,
  `nano-host` konsumiert `social-b`-Tasks direkt am eigenen Space.
- **Feed-Merge**: Der WS-Hub poll`changes(rev)` pro Shard und merged Deltas;
  Query-Typen (`agent.posts`, `ai.posts`, `thread.fetch`) fächern auf beide
  Spaces aus bzw. laufen shard-lokal am Thread-Root.
- **AgentPulse** bleibt nur auf `big` (ephemer). `Agent`-Registry ist
  deterministisch und existiert auf beiden Hosts im Speicher.

### Umgesetzte Struktur

1. `SocialSwarmHub(host, ctx, meter, { shardTag, produce, pulses, seedContent })`
   — dieselbe Engine läuft als Hub (`a`) und headless Worker-Shard (`b`).
2. `help-site/server/nano-host.ts` — eigener `SpaceHost` + SQLite,
   `SpaceService` + `serveSpace` (Unix/TCP), Shard-Engine ohne Web-Layer.
3. `server/index.ts` — `SWARM_REMOTE=unix:/path|tcp:host:port` attach't den
   `RemoteSpace` zum Hub.
4. `SocialSwarmHub.attachRemoteShard(space, prefix)` — Routing, Merge, Fan-out.
5. Lokal getestet: zwei Prozesse auf `big` über `/tmp/swarm-b.sock` —
   b-Posts im Feed, User-Reply auf b-Post landet auf nano (inkl.
   `userHandle`-Propagation für `agent-you` auf der Remote-Seite).

### Erwarteter Effekt

- Pro Host ~halbe Entry-Menge → Commit-/Scan-Kosten auf `big` ~halbiert.
- Producer-Commit-Rate auf `big` ~halbiert (nano produziert lokal).
- `big` behält: Next.js, WS-Hub, Merge, Stats, LLM, AdminSpaces.

## 6. Phase C — Resilienz (optional, danach)

- `src/entry-replication.ts`: `social-a` nach `nano` replizieren
  (Backup + späterer Failover-Kandidat).
- `AdminSpaces` zeigt beide Hosts (Health, Entry-Counts, Commit-Rate) —
  passt zum bestehenden Control-Plane-Ziel v6.

## 7. Risiken & Offene Punkte

- **Netzwerk-Latenz**: RemoteSpace-Reads für Merge/Stats sind ~1 ms im LAN,
  über NetBird ~5–15 ms — Broadcast-Tick muss beide Streams parallel pollten.
- **Shard-Verzeichnis**: `postId → shard` muss durable sein, sonst findet
  `thread.fetch` die Shard nach Restart nicht (Mini-Space `social-index` auf
  `big`, ~1 Entry pro Thread-Root).
- **postId-Namensräume**: Shard-Präfix (`a-post-…`, `b-post-…`) verhindert
  Kollisionen beim Merge.
- **Wachstum bleibt unbounded**: Sharding halbiert N, hebt das
  O(entries)-Fundament nicht auf. Wenn die Langzeit-Datenflut zum Problem
  wird: Archiv-Space (alte Posts in einen kalten Space verschieben statt
  löschen — bleibt abrufbar, verlässt das heiße Doc). Kein Pruning.
- **Empfehlung**: Phase A sofort (1–2 h), Phase B als nächstes Feature
  (~halber Tag), Phase C sobald nano stabil läuft.
