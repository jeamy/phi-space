# Native Root performance investigation, 2026-10-14

The first failed Take remains a negative acceptance result. Its preceding transaction
had a 60-second lease; the next request generation was issued 36,586 ms after Begin.
No retained Take claim exists. No failed request was replaced or relabelled successful.

The read-only baseline took 19,371 ms and made 141 independent register calls on Root.
Subsequent profiles distinguish restart overhead from steady-state work. Timings are
inclusive and can overlap; adding host and register milliseconds double-counts work.
These small probes are not Gate-4 latency percentiles.

The implementation groups fresh register reads, obtains Root keys and state from one
normal BootGuard-protected Control snapshot, preserves all authority/boot/key checks,
and resolves the original persisted claim before attaching a bound inline receipt.
Transaction follow-ups may reuse the original still-open admission generation; each
actual effect still freshly authenticates and obtains its grant/delegation. The Member
validates the generation again and each effect keeps its own durable request ID.

Typecheck, 151 targeted checks and 473 full-suite tests pass. The built manifest is
included in validation.json. Live completion, original-claim audit, fencing and replay
must be established separately before Block 4 can be accepted.
