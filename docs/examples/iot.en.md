# Sensor Pipeline

As of 2026-10-07. Implementation: [sensor-pipeline.ts](../../examples/sensor-pipeline.ts).
Local, deterministic host code with different conversation IDs as owners; no LLM and no federation.

## Data Contract

| Type | Fields | Lease |
|---|---|---|
| Window | id, sources[] | FOREVER |
| Reading | source, window, ts, kind, value | 24 h |
| Done | source, window | 24 h |
| Summary | window, stats, missing[], duplicates, rejected | FOREVER |
| Report | window, text | FOREVER |

`openWindow` creates an order. `collect` writes values and then Done.
Several analysts compete for Window. An analyst reserves it under a txn, waits for Done per source
with a shared deadline and writes the Summary under the same txn. The commit ties consumption and result together.
A simulated crashed analyst lets the txn expire; the Window becomes available again.

`present` likewise reserves a Summary under a txn and writes the Report under the same txn.
A write error aborts and returns the Summary. External file/network effects are not part of this txn.

## Validation and Limits

Invalid values are discarded before deduplication. Only a finite numeric value establishes the identity
`[source, kind, ts]`; collision-free JSON encoding replaces the ambiguous concatenation with colons.
Among valid duplicates, the value read first wins. Different valid values with the same
identity are not merged; the later one is counted as a duplicate.

At most 1000 visible readings per window. Larger windows are rejected with an error before aggregation,
the reservation is aborted; no silently truncated result is written. The collector must split such
windows. Done means that a source delivers no further values for this window. Late
writes after Done are outside this protocol; the data list is a local snapshot and not a global
transaction over the collector inputs.

Statistics per kind: count, minimum, maximum, arithmetic mean rounded to two decimal places.
Sources without Done by the deadline land in missing; valid values already present from these sources are counted.
Errors outside an expected txn flow are propagated. No alerts, continuous
window scheduling or persistent collector recovery implemented.

## Invocation and Evidence

```bash
npm run example:pipeline
npm test
npm run test:examples
```

`integration.test.ts` checks concurrent analysts, lease return and a missing source.
The example suite imports real pipeline functions. `recovery.test.ts` checks an invalid first duplicate,
report rollback and the size limit. No measured throughput/speedup values.
[Back to the overview](README.en.md).
