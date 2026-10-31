# Syscalls per commit, 2026-10-31

Capture with `strace -f -y` (strace 7.3) of the probes `power-loss-probe.ts` and `power-loss-own-probe.ts` in mode `write` with one
writer, on the development machine (Node 22.23.1, SQLite 3.51.2, tmpfs), plus the runs with 8 writers on btrfs. Captured are
write, flush, open and rename calls. An acknowledgement is the probe's line on stdout. Without the start of each run.

| Profile | Commits in the sample | Calls up to the acknowledgement |
|---|---|---|
| pi-durable SQLite, weak | 267 of 270 | `pwrite` WAL ×8 |
| pi-durable SQLite, strong | 267 of 270 | `pwrite` WAL ×8, `fdatasync` WAL |
| phi-spaces store, document, weak | 517 of 520 | `pwrite` WAL ×4 |
| phi-spaces store, document, strong | 517 of 520 | `pwrite` WAL ×4, `fdatasync` WAL |
| phi-spaces store, Space writes, weak | varies | `pwrite` WAL ×12 to ×24 |
| phi-spaces store, Space writes, strong | varies | `pwrite` WAL ×12 to ×24, `fdatasync` WAL |
| pi-durable JSONL, weak | 29 of 30 | `write` doc sidecar, `write` main.jsonl, `write` .reclaim, `rename` |
| pi-durable JSONL, strong | 29 of 30 | `write` doc sidecar, `fsync` sidecar, `fsync` directory, `write` main.jsonl, `fsync` main.jsonl, `fsync` directory, `fsync` main.jsonl, `write` .reclaim, `fsync` .reclaim, `rename`, `fsync` directory |

One WAL page is two `pwrite`, header and content.

Checkpoint, in the commit before its acknowledgement: `pwrite` WAL, `fdatasync` WAL, `pwrite` main file ×30 (phi-spaces store ×11), `ftruncate`,
`fdatasync` main file. The next commit rewrites the WAL header and flushes it, also in the weak profile. The first checkpoint was in
commit 239 (pi-durable SQLite) and 488 (phi-spaces store, document), in both profiles. These are the final states 250·n − 11 and 500·n − 12 from `hard-off*.jsonl`.

8 writers, strong: phi-spaces store 81 acknowledgements, 32 WAL flushes; pi-durable SQLite 47 acknowledgements, 50 WAL flushes.

Difference from the VM: There, SQLite in the official Node 22.23.1 calls `fsync`, not `fdatasync`.

## Hard off with capture in the VM

`power-loss-hard-off.mjs --strace`, SQLite weak, seed 21, 9 runs, raw data `hard-off-sqlite-weak-strace.jsonl`. The capture runs over SSH from the
VM; the raw captures (55 MB) are not kept. strace 5.16, flush share = sum of the `fsync` durations / runtime.

| Run | Acknowledged | Durable | Result | Last call | Flush share |
|---|---|---|---|---|---|
| 1 | 6075 | 5989 | 86 lost | `pwrite` WAL | 61 % |
| 2 | 4353 | 4239 | 114 lost | `pwrite` WAL | 62 % |
| 3 | 7472 | 7239 | 233 lost | `pwrite` WAL | 70 % |
| 4 | 4488 | ≥ 4488 | no loss | open `fsync` WAL | 66 % |
| 5 | 7369 | 7239 | 130 lost | `pwrite` WAL | 68 % |
| 6 | 6238 | ≥ 6238 | no loss | open `fsync` WAL | 67 % |
| 7 | 2489 | ≥ 2489 | no loss | open `fsync` WAL | 61 % |
| 8 | 2738 | ≥ 2738 | no loss | open `fsync` WAL | 64 % |
| 9 | 7239 | ≥ 7239 | no loss | open `fsync` WAL | 69 % |

The last lines of a capture can be missing along the way.
