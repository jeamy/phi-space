# lww/set for real: two merge members over NetBird — 2026-10-17

Real run of steps 1 to 3 from [ap3-replikation.md](../../../docs/_attic/abnahme/ap3-replikation.en.md):

- **Members:** nano-test (netcup, IPv6 only) and standby-100 (home network) as merge members of a shared
  replication `merge-run-20261017`.
- **Rules:** `Sensor` as `lww` with key `sensorId`, `Fact` as `set`. Served in the `default` Space of both hosts.
- **Bundle:** `4405c749` (state `031ab7d`).

Writing and reading went directly through the gates of the members, as admin `lux27` with grants from host-a. The path through
the root is covered by the local test. The data is in `report.json`.

## Result

1. **Replication:** A `Sensor` written on nano appears on 100. The replies carry `replicated: true`.
2. **Partition:** On 100 an nft rule discarded everything from nano's overlay address, from 16:56:53 to 16:59:03 UTC
   (40 packets).
   - Both sides wrote the same key (100 last) and one `set` entry each.
   - Each side saw only its own changes.
3. **Healing:** A good minute after lifting it (17:00:01) both had converged.
   - `s1` has the later-written value `100-2` on both.
   - Both see both `set` entries.
4. **Deletion of a principal:**
   - A marked secret entry stood on both hosts in the SQLite WAL file.
   - On nano the offline procedure ran: stop service, restart lock, boot record `fenced`, `erase-evidence`,
     `erase-local`, `erase-compact`.
   - `erase-evidence` named all six merge changes of the principal, including those from 100.
   - `erase-local` reported the deletion as locally complete.
   - The compaction removed 31 old revisions. Afterwards the secret stood in no file of nano any more.
5. **Distribution:** After the start of nano, the deletion arrived at 100 immediately over the stream; both views were empty.
   The offline compaction on 100 removed 19 revisions; there too the secret stands in no file any more.
6. **Afterwards:** A new write on 100 arrived at nano, the deleted value stayed gone.

## Reset

- The configurations of both hosts are back without merge replication.
- The boot records stand at their original values again; they were locked only during the
  offline steps.
- Backups and the compaction tool are removed. The new bundle stays.
- The baseline check afterwards is green.
- The `EntryReplicas` documents of the run stay in the `default` Spaces of both hosts: redacted history, the
  deletion event and a later test entry.

## Limits

- No root routing in the real run.
- Only two members.
- The partition was created by a firewall rule, not by a real network outage.
- No compaction of tombstones (step 4).
