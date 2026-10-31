# Mobile Spaces control on the device — 2026-10-16

Device acceptance of step B9 ([Betrieb und mobile Steuerung](../../../docs/betrieb-und-mobile-steuerung.en.md) §8):
the Spaces control page of `pi-termux-mobile`, served by the real app runtime on a Xiaomi M2007J17G (Android 12),
installed as a fresh debug APK over wireless ADB without clearing app data. The coordinator
(`test/testbed/device/b9-coordinator.ts`) ran on the operator host in the production composition
(`startFederationHost` with grants, enrollment, control access, supervisor, run and worker commands) on its LAN
address; the phone reached it over WLAN. Layer A was a fixture pin of the phone's LAN IP, not NetBird.

The app's own HTTP UI was operated through `adb forward` from a desktop browser; every call went through the
phone's runtime, its private profile and the Android Keystore.

| Step | Result |
|---|---|
| Prepare and pair through the Spaces page | new Keystore P-256 key, bootstrap enrollment as `admin` |
| Start sieve run 1 ([1, 20001), block 1024) from the form | `running`, revision 2 |
| Assign 2 workers from the form | applied state reported back with its age (Capability `metrics.workers`) |
| Pause run 1 by button | `paused`, revision 3 |
| Start run 2 ([1, 4000001), block 4096, 977 segments), move workers, pause by button | `paused`, revision 3; finished task count unchanged over 6 s |
| Coordinator killed (`SIGKILL`), resume by button | operation kept with its ID (state `sending`, raw connect error shown; fixed, see below) |
| Coordinator restarted on the same store, "Gleichen Auftrag erneut senden" | the same command ID completed; run 2 `running` again |
| Workers to 0 from the form, stop run 2 by button (confirmation) | workers 0; run 2 `stopped`, revision 5 |
| Store check after shutdown | run 1: 20 results, 2262 primes (π(20000)); run 2: 977 results, each task once, 283146 primes (π(4000000)); every result equals an independent recomputation; no open transactions |

Finding and fix: a connection failure before anything was sent showed the raw `ECONNREFUSED` error and left the
operation as `sending`. The bridge now marks it `notSent` and says that nothing was sent and the same ID can be
resent. A mobile regression test covers it; the rebuilt APK was installed and the message verified on the device
with the coordinator down.

Afterwards the original space profile (pairing with `phase1b-host-a`) was restored byte-identically; the test
profile is kept privately on the device as `space-profile.b9-test.json`, and the test key stays in the Keystore.
No tokens, keys or grants are part of this evidence. Not covered: NetBird overlay between phone and coordinator,
a production coordinator on big, screen-off/background behaviour of the page.

## Follow-up: alerts, audit and stop preview (B10)

After a further APK build the test profile was activated again against the same coordinator store. On the device:
the alerts view listed a worker assignment for a host without reports (with the note that silence proves nothing);
the audit listed the phone's admin commands; "Lauf stoppen" first requested a preview and its confirmation named
revision 4 — declining it left the run `paused`/3. Concurrent page actions collided with the bridge's single
operation lock ("another space operation is in progress"); the page now queues its calls, and the rebuilt APK showed
no collision. Afterwards the original profile was restored byte-identically again.

## Over NetBird (same day)

The phone's NetBird client (peer `xi`, 100.89.186.250) was connected for this test; the coordinator listened on the
operator host's NetBird address (100.89.218.189, TCP 17460) with `--netbird`: peer id, overlay IP and connection
state came from the real NetBird Management API (queried over ssh on big, so the token stayed there). Existing
policies (`net1`/`net8`) already connect both peers; only an owned local `ts-input` RETURN rule for exactly this
source, destination and port was added and removed afterwards. The phone's NetBird group assignment was not
changed: it is already in `space-admin`, and the Gate correctly refused a first pairing without a current app-key
proof. For the first pairing the coordinator mapped the phone to `space-enroll` until it held an active key; after
that its real NetBird groups applied. Traffic was relayed (about 300 ms round trip).

Through the app UI over NetBird: pairing as `admin` (peer id `db582l7lh8lg0086tdt0`), run `nb-sieve-1` started and
fully computed by two workers; run `nb-sieve-2` started and paused, workers moved onto it and took 0 tasks over 24 s,
resume, then all segments computed; alerts and audit (requested by the NetBird peer id) displayed. Store check:
both runs 977 results, each task once, 283146 primes, all results equal an independent recomputation, no open
transactions. Afterwards the original profile was restored byte-identically (test profile kept as
`space-profile.nb-test.json`), NetBird on the phone was disconnected again as before the test, and the firewall rule
was removed. Not covered: a coordinator on big, layer A group changes performed by an operator in NetBird.
