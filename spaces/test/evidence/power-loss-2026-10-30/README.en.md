# Power-loss test of the agent store, 2026-10-30

Description and classification: [agenten-stromausfalltest.md](../../../docs/agenten-stromausfalltest.en.md).

- `replay.jsonl`: replay via dm-log-writes, three runs per cell, seeds 1 to 3, 15 s, 12 random cuts plus the last mark.
- `hard-off.jsonl`: `virsh destroy` during writing, seed 7, abort after 6 to 20 s.

- `hard-off-sqlite-weak.jsonl`, `hard-off-jsonl-weak.jsonl`: 6 repetitions each of the weak profiles, seeds 11 and 13. For this
  the script reads acknowledgements only after the connection has ended; the first series counted too few at a high rate.

- `replay-weak-rerun.jsonl`: repetition of the replay for the weak profiles, six runs per cell, seeds 4 to 9.

- `compare-replay.jsonl`, `compare-hard-off.jsonl`: comparison with the phi-spaces store, document (`backend` own) and 8 writers.
- `replay-space.jsonl`, `hard-off-space.jsonl`: Space writes of 2026-10-31 with the corrected probe, which checks every acknowledged entry. Seeds 1 to 3 and 31.
- `rate.jsonl`: 16 cells, 5 runs of 20 s each, seed 3, no run discarded; `guestLoad` is the load value of the VM. Load value of the host 4.3 to 10.6, median 6.7.

Environment: libvirt guest `linux2020` (Ubuntu 22.04.5, kernel 6.8.0-90, 8 vCPU, 8 GiB) on QEMU 10.2.2/KVM, test disk raw with
`cache=none` on a file of the host, ext4 with `data=ordered`, Node 22.23.1, SQLite 3.51.3, pi-durable 1.4.0.

- `syscalls.en.md`: `strace` capture per commit of 2026-10-31, outside the VM.
- `hard-off-sqlite-weak-strace.jsonl`: 9 hard-off runs, SQLite weak, with `strace`, seed 21; evaluation in `syscalls.en.md`.
