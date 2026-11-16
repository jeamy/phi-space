# Stromausfallversuch Agentenspeicher, 30.10.2026

Beschreibung und Einordnung: [agenten-stromausfalltest.md](../../../../docs/agenten-stromausfalltest.en.md).

- `replay.jsonl`: Replay über dm-log-writes, drei Läufe je Zelle, Seeds 1 bis 3, 15 s, 12 zufällige Schnitte plus letzte Marke.
- `hard-off.jsonl`: `virsh destroy` während des Schreibens, Seed 7, Abbruch nach 6 bis 20 s.

- `hard-off-sqlite-weak.jsonl`, `hard-off-jsonl-weak.jsonl`: je 6 Wiederholungen der schwachen Profile, Seeds 11 und 13. Dafür liest
  das Skript Bestätigungen erst nach dem Ende der Verbindung, die erste Serie zählte bei hoher Rate zu wenige.

- `replay-weak-rerun.jsonl`: Wiederholung des Replays für die schwachen Profile, sechs Läufe je Zelle, Seeds 4 bis 9.

- `compare-replay.jsonl`, `compare-hard-off.jsonl`: Vergleich mit dem phi-spaces-Store, Dokument (`backend` own) und 8 Schreibern.
- `replay-space.jsonl`, `hard-off-space.jsonl`: Space-Writes vom 31.10.2026 mit der korrigierten Probe, die jeden bestätigten Entry prüft. Seeds 1 bis 3 und 31.
- `rate.jsonl`: 16 Zellen, je 5 Läufe von 20 s, Seed 3, kein Lauf verworfen; `guestLoad` ist der Lastwert der VM. Lastwert des Hosts 4,3 bis 10,6, Median 6,7.

Umgebung: libvirt-Gast `linux2020` (Ubuntu 22.04.5, Kernel 6.8.0-90, 8 vCPU, 8 GiB) auf QEMU 10.2.2/KVM, Testplatte raw mit
`cache=none` auf einer Datei des Hosts, ext4 mit `data=ordered`, Node 22.23.1, SQLite 3.51.3, pi-durable 1.4.0.

- `syscalls.md`: `strace`-Mitschnitt je Commit vom 31.10.2026, außerhalb der VM.
- `hard-off-sqlite-weak-strace.jsonl`: 9 Läufe hartes Aus, SQLite schwach, mit `strace`, Seed 21; Auswertung in `syscalls.md`.
