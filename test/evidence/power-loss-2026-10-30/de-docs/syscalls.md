# Syscalls je Commit, 31.10.2026

Mitschnitt mit `strace -f -y` (strace 7.3) der Proben `power-loss-probe.ts` und `power-loss-own-probe.ts` im Modus `write` mit einem
Schreiber, auf dem Entwicklungsrechner (Node 22.23.1, SQLite 3.51.2, tmpfs), dazu die Läufe mit 8 Schreibern auf btrfs. Erfasst sind
Schreib-, Flush-, Öffnungs- und Umbenennungsaufrufe. Eine Bestätigung ist die Zeile der Probe auf stdout. Ohne den Start jedes Laufs.

| Profil | Commits im Muster | Aufrufe bis zur Bestätigung |
|---|---|---|
| pi-durable SQLite, schwach | 267 von 270 | `pwrite` WAL ×8 |
| pi-durable SQLite, stark | 267 von 270 | `pwrite` WAL ×8, `fdatasync` WAL |
| phi-spaces-Store, Dokument, schwach | 517 von 520 | `pwrite` WAL ×4 |
| phi-spaces-Store, Dokument, stark | 517 von 520 | `pwrite` WAL ×4, `fdatasync` WAL |
| phi-spaces-Store, Space-Writes, schwach | schwankt | `pwrite` WAL ×12 bis ×24 |
| phi-spaces-Store, Space-Writes, stark | schwankt | `pwrite` WAL ×12 bis ×24, `fdatasync` WAL |
| pi-durable JSONL, schwach | 29 von 30 | `write` doc-Sidecar, `write` main.jsonl, `write` .reclaim, `rename` |
| pi-durable JSONL, stark | 29 von 30 | `write` doc-Sidecar, `fsync` Sidecar, `fsync` Verzeichnis, `write` main.jsonl, `fsync` main.jsonl, `fsync` Verzeichnis, `fsync` main.jsonl, `write` .reclaim, `fsync` .reclaim, `rename`, `fsync` Verzeichnis |

Eine WAL-Seite sind zwei `pwrite`, Kopf und Inhalt.

Checkpoint, im Commit vor dessen Bestätigung: `pwrite` WAL, `fdatasync` WAL, `pwrite` Hauptdatei ×30 (phi-spaces-Store ×11), `ftruncate`,
`fdatasync` Hauptdatei. Der nächste Commit schreibt den WAL-Kopf neu und flusht ihn, auch im schwachen Profil. Der erste Checkpoint lag in
Commit 239 (pi-durable SQLite) und 488 (phi-spaces-Store, Dokument), in beiden Profilen. Das sind die Endstände 250·n − 11 und 500·n − 12 aus `hard-off*.jsonl`.

8 Schreiber, stark: phi-spaces-Store 81 Bestätigungen, 32 WAL-Flushes; pi-durable SQLite 47 Bestätigungen, 50 WAL-Flushes.

Unterschied zur VM: Dort ruft SQLite im offiziellen Node 22.23.1 `fsync` auf, nicht `fdatasync`.

## Hartes Aus mit Mitschnitt in der VM

`power-loss-hard-off.mjs --strace`, SQLite schwach, Seed 21, 9 Läufe, Rohdaten `hard-off-sqlite-weak-strace.jsonl`. Der Mitschnitt läuft über SSH aus der
VM; die Rohmitschnitte (55 MB) sind nicht aufgehoben. strace 5.16, Flushanteil = Summe der `fsync`-Dauern / Laufzeit.

| Lauf | Bestätigt | Dauerhaft | Ergebnis | Letzter Aufruf | Flushanteil |
|---|---|---|---|---|---|
| 1 | 6075 | 5989 | 86 verloren | `pwrite` WAL | 61 % |
| 2 | 4353 | 4239 | 114 verloren | `pwrite` WAL | 62 % |
| 3 | 7472 | 7239 | 233 verloren | `pwrite` WAL | 70 % |
| 4 | 4488 | ≥ 4488 | ohne Verlust | offener `fsync` WAL | 66 % |
| 5 | 7369 | 7239 | 130 verloren | `pwrite` WAL | 68 % |
| 6 | 6238 | ≥ 6238 | ohne Verlust | offener `fsync` WAL | 67 % |
| 7 | 2489 | ≥ 2489 | ohne Verlust | offener `fsync` WAL | 61 % |
| 8 | 2738 | ≥ 2738 | ohne Verlust | offener `fsync` WAL | 64 % |
| 9 | 7239 | ≥ 7239 | ohne Verlust | offener `fsync` WAL | 69 % |

Die letzten Zeilen eines Mitschnitts können unterwegs fehlen.
