# A real phone on a Rust Member — 2026-11-01

Device acceptance of R5b ([Rust port](../../../docs/rust-portierung.en.md)): the app of `pi-termux-mobile` on a Xiaomi M2007J17G
(Android 12) against the local federation (`npm run testbed:federation -- phone`) in containers on the operator host: a TypeScript
control host, the TLS register and a Rust Member (`phi-space-server --member`). The phone reached them over WLAN; layer A was the
directory of the test bed with the phone's LAN address. The app's bridge was driven through `adb forward` from the desktop, and
every call went through the phone's runtime, its private profile and the Android Keystore.

| Step | Result |
|---|---|
| Prepare and enroll at the control host | new Keystore key, `paired`, role `member`; the gate saw the phone's own address through the published port |
| Data host set to the Rust Member, `objects` | info, stats and entries from the Member, on a grant of the control host |
| Member killed with SIGKILL | connection refused while down; served again 1 s after the restart |
| Register cut off | refused after 6 s (the read blocks the host); served again at once after reconnecting |
| Control host cut off | refused; the phone fails at the control host first, so this does not show the Member's own refusal, which `npm run testbed:federation` does |
| Host fenced in the register | refused with "external host boot authorization is absent or inactive"; served again after it went back to active |

Afterwards the original profile was restored byte-identically (sha256 `fd66a024…1043`, before and after), the test profile stays
on the device as `space-profile.fed-test.json`, and the test key stays in the Keystore. No tokens, keys or grants are part of this
evidence.

Not covered: writes from the phone (the bridge reads a data host; `objects` is its data call), NetBird as layer A, a Space on the
phone (M1).

Finding: this machine has two addresses in one subnet (`enp39s0` 192.168.8.28, `wlp47s0f3u4` 192.168.8.173). TLS to the phone hung
with source .28 and through the WLAN interface; it worked with source .173 over `enp39s0`. The cause is unknown. For the run a
temporary host route (`ip route add 192.168.8.22/32 dev enp39s0 src 192.168.8.173`) was set and removed again, and the stack was
bound to .173.
