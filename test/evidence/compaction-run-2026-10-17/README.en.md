# Compaction for real: two merge members over NetBird — 2026-10-17

Real run of step 4 from [ap3-replikation.md](../../../docs/_attic/abnahme/ap3-replikation.en.md) with nano-test and standby-100.
The data is in `report.json`.

## Setup

- **Bundle:** `0b114dd5` (state `db827bb`) on both hosts.
- **Replication:** the same as in the [merge run](../merge-run-2026-10-17/README.en.md) (`merge-run-20261017`, `Sensor` as
  `lww`, `Fact` as `set`), additionally `compactEveryMs: 60000`.
- **History:** The members continued their history from the merge run. It had been written before step 4
  (positions without gaps, no vector, one deletion with redacted changes). So the takeover of old
  histories was part of the run.

## Result

1. **Start:** Both hosts were ready, and their views were equal.
2. **Writing:** At 18:30:02 UTC nano wrote `s8` four times and standby-100 wrote `s9` four times. Both then showed the
   respective latest version.
3. **Compaction:** Both hosts compacted periodically, without errors:
   - standby-100 removed 7 changes in three runs;
   - nano-test removed 4.
   Removed were superseded versions and old changes of the respective other host. Own changes are kept
   for 24 hours.
4. **Views:** After the compaction they were equal on both hosts and unchanged.
5. **Afterwards:** A new put on standby-100 and a new `Fact` on nano arrived at the respective other host
   through the streams with gaps.

## Reset

- Both configurations are again without merge replication, the services run.
- The baseline check afterwards was green; the backups are removed.
- The new bundle stays. The `EntryReplicas` documents stay in the `default` Spaces, now partly compacted.

## Limits

- Only two members, no partition during the compaction.
- The number of removed changes comes from the logs. The storage is released only by the offline compaction;
  it did not run here.
- No retry of a compacted request, no expiry and no deletion during the run; these cases are covered by the
  local tests.
