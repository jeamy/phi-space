# Mobile Spaces control on the device with the own store — 2026-10-24

Re-run of the B9 acceptance ([2026-10-16](../b9-device-2026-10-16/README.md)) after the cutover from pi-durable
to the own store (U6/U8): a freshly built debug APK (`pi-termux-mobile`, bundle of phi-spaces at commit e817ab9
plus the mobile edits of U6) installed over wireless ADB on the Xiaomi M2007J17G, Node 26.4.0 from the app's rootfs.
The coordinator (`test/testbed/device/b9-coordinator.ts`) ran on the operator host on its LAN address
(layer A: fixture pin of the phone's IP). The app's HTTP bridge was driven through `adb forward`; every call went
through the phone's runtime, its private profile and the Android Keystore.

| Step | Result |
|---|---|
| `node:sqlite` (SQLite 3.53.4, WAL) and an eval `Worker` with `process.getBuiltinModule` on the device | work |
| Own store from the shipped bundle on the device: write, close, reopen | the entry is there |
| Prepare and pair as `admin` (new Keystore key, bootstrap enrollment), authenticate | paired |
| Start sieve run, pause, resume from the phone | `running` → `paused` → `running` |
| Run with two members on the one coordinator host | refused by the example (`Sieve run belongs to another space`, a limit of the test composition: one seed per run); stopped |
| Assign 2 workers; 20 blocks of [1, 20001) | 20 tasks, 0 errors |
| Coordinator killed (`SIGKILL`), pause from the phone | operation kept, state `notSent`, message says nothing was sent and the same ID can be resent |
| Coordinator restarted on the same store (`fresh: false`), same command ID resent | completed once: `paused`, revision 5 |
| Resume, workers to 0, stop | `stopped`, revision 7 |
| Store check after shutdown (read-only, independent recomputation) | 20 results, each task once, every prime list equals trial division, 2262 primes = π(20000); the 20 tasks left belong to the stopped first run |

Afterwards the phone's original space profile was restored; the test profile stays on the device as
`space-profile.u6-test.json` and the test key in the Keystore. No tokens, keys or grants are part of this evidence.
Not covered: NetBird between phone and coordinator, screen-off behaviour, a coordinator on big.
