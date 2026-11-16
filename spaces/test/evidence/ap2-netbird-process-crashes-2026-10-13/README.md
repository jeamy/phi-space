# NetBird Root process crash evidence — 2026-10-13

The full signed-wire fixture passed with 10,000 initial Entries, 1,000 jobs,
six fixed Workers and three persistent Members. Docker observed 30 Root
process deaths (exit 137, no OOM), and 31 Root starts retained the same lease
ID and router epoch. Five effect kinds × three Members × two RPC boundaries
were exercised. Task-write interruptions occur during workload production;
processing interruptions follow the verified full inventory. Crash spacing
allows bounded transaction processing between selected outages.

The closed-store audit opened only private copies and checked all 5,000
Parents, Children and original Member claims. It also checked every one of
the 30 interrupted request identities and zero unused future reservations.
The final result comparison confirms 1,000 unique results, no remaining tasks,
9,000 retained background Entries, 9,592 primes and sum 454,396,537.

The 12-job smoke passed six actual commit-boundary deaths. A final small
run passed one real death using the current CID-capture and cleanup path. An initial PID-1
configuration was explicitly rejected by the driver because no process died;
its negative driver log is retained. This is not a successful crash test.
Docker init fixes that configuration. The expanded audit also passed on the
previous Admission full run. The routine suite passed 428 tests, and typecheck
passed. `cleanup.json` verifies removal of owned fixture containers/policy/group
and three existing services remaining active. Only built artifacts were shipped.

Members stayed running on one physical server. Mailbox ACK interruption,
individual Member process death, all explicit journal boundaries, independent
physical failure domains, production provisioning and boot/fencing remain
separate gates. This is controlled same-authority Root restart, not promotion
or full Phase-2 acceptance. The library and mobile runtime are unchanged.

`sameParentRetries` is an explicit Pending-retry counter for the final Root
process, not a total of all restarts or request replays.
