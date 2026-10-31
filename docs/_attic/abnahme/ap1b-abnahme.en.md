# Phase 1b: Implementation and Acceptance

As of 2026-10-11. The [federation plan](../../federation-plan-v3.en.md) is the target contract.
The following evidence closes phase 1b in the examined F15 model; it is not a release of the
complete federation or of recovery in production operation.

## Merged Runtime

`startFederationHost` connects gate, overlay identity, key proof,
enrollment, control permissions, grants, key rotation, supervisor and
maintenance on one persistent harness. Only the configured control runtime
issues grants. A data member queries the key directory through the
proven control service and checks grants against a previously provisioned
public control key.

The runtime start requires an external boot register and a separate local
installation. Both must contain the same active authority,
data incarnation and role for every Space. `unsafeSkipBootGuardForTests` is an
explicit exception for fixtures and must not be set on a rolled-out host. Snapshot read
accesses also fail when the permission is missing;
before a commit the read register versions are compared again.

## Grants and Rotation

Grants are signed with Ed25519 or P-256, valid for at most 60 seconds and
bound to authority, issuer, principal, app key and Space scope.
The check allows for two seconds of time uncertainty. The control side
queries the current overlay identity before every issuance. During a
management outage no new grants are issued.

A pending take/read may decide only until the stored grant expiry.
A new effect grant can re-authorize its own pending work
if it also permits the original operation. A resolution grant permits
query, cancel and abort, but no new execution. Txn commit and
lease renew additionally check rights on the original entries or
operations. The deadline of a remote call also covers a hanging
grant provider.

Rotation requires a persisted one-time challenge and signatures of the
old and the new key. The supervisor revokes the old key
and writes the new key atomically; roles and scope are carried over.
Own rotation is possible even with a key limited to data Spaces,
without thereby being allowed to read control entries. After loss of the response
the own command result is queried with `rotationStatus`.

## Recovery Building Blocks

`SqliteRecoveryRegister` provides persistent compare-and-set.
`RecoveryCoordinator.reserve` requires an independent confirmation of
fencing including restart lock and reserves exactly one
successor of the old authority. Members check the signed transition against
a provisioned recovery key and install it outside the
Space snapshots.

`RecoveryController` connects the restore building blocks with a durable data recovery journal, independent placement/boot check and an exactly checked control receipt. `dataRecoveryHandler` binds these methods to the signed private socket. `ControlAckService` and `startConfiguredRecovery` provide the real signed ACK channel; its private socket and forced-command access are installed on host-a. A successful ACK within a real distributed data restore is now demonstrated (see live data restore below). The import has a
persisted cursor, observes the current Space/commit limits and waits
at least 62 seconds. Old txns, registrations, active waiters and
reservations are removed. Old claims remain historical evidence;
an open outcome becomes `unknownOutcome`, an old request must not re-execute
work. Data entries remain readable, but until the explicitly
bounded release are `restoredUnverified` and neither takeable nor usable under a txn.
Release also reserves stream and notification costs.

These functions do not replace fencing evidence: the calling recovery service
must lock admission, update the registry incarnation in the same commit,
check fencing, control ACK and external/local boot installation and only then
use `completeRestore`. On control import, old PeerKeys are revoked, bootstrap is closed durably, old policy, enroll, command and RouterLease entries are discarded and members set to `recoveryBlocked`. The control primary epoch begins at 1. The renewed release of the overlay groups and distributed member ACKs still belong to the administrative procedure.

## Automated Evidence

- `test/test-federation-runtime.test.ts`: two independent persistent harnesses
  over real TCP gates, on JSONL and SQLite. Bootstrap, host enrollment,
  key query over the wire, boot check, grants, expired take,
  resolution without effect, management outage, rotation and crash/reopen.
- `test/test-grants.test.ts`: manipulated signature, foreign principals/keys and
  scopes, resolution without effect, expiry immediately before mutation and
  role withdrawal before txn commit.
- `test/test-recovery.test.ts`: concurrent CAS successors, invalid
  fencing evidence, signed installation and reopen; permission per Space,
  locked reads and rollback on a simultaneous fence; restore in several
  batches with reopen, historical pending claims and bounded task release.

The overall run comprises 233 passed tests without omissions. Typecheck and all 158 example tests have also passed (example tests with `--test-concurrency=1`). The duplicate test now explicitly uses the same timestamp for both samples; separate `Date.now()` calls were unstable. The simulated
overlay directory source and the controlled clock in the new tests are
explicitly fixtures; these tests demonstrate no NetBird outage measurements.

The built scenario uses the same library as the test bed:

```sh
npm run testbed -- --dry-run scenario federation-runtime
npm run testbed -- scenario federation-runtime
```

It checks two persistent hosts inside the runner container. A real
distribution across several containers, the NetBird overlay and the phone are
separate acceptances.

## Result of the Complete Phase 1b Acceptance

Data and control restore have passed live on isolated additional test hosts
(see evidence below). The F15 fencing checks process, service and persistent
restart lock; promotion/cloud fencing is thereby not accepted.

The fresh initial pairing through the actual phone forms has since
passed, as have object access, rotation, key revocation, app restart,
ten minutes of screen-off/background and a controlled deep Doze.
The QR content was taken over via the intended input field; a camera
scanner function is, according to 4.5, not a mandatory phase 1b gate. Temporary
enrollment memberships and the consumed private input have been removed.
The normal APK contains no UI test instrumentation and afterwards read
the jobs object again.

The complete outage matrix is finished and cleaned up. Measured were
management 305.3 s and 3604.3 s, signal 608.6 s, relay 1807.3 s and
management + relay 3604.0 s. Every case ends with successful object access.
The desktop, too, could read an object again after the last case; its
temporary firewall exception was removed. The three main services remain active.

[Acceptance summary](../../../test/evidence/ap1b-2026-10-11/acceptance-summary.json)
and [complete measurements](../../../test/evidence/ap1b-2026-10-11/netbird-fault-matrix.json)
thus demonstrate the phase 1b acceptance in the examined F15 operating model. The outages
targeted the reachability of the components for two dedicated test peers,
not a global server/database outage. An existing direct tunnel
remained reachable during the management outage, while Space access was locked after expiry
of the gate cache. Measurement times include sampling and probe times.
RunGate, replication and promotion remain tasks of later phases.

## Operations Check of 2026-10-10

The first transfer to big failed with `No space left on device`. The repeat run
commissioned afterwards passed: complete artifact transfer,
image rebuild, restart of the runner container only and execution of the
built scenario `federation-runtime`. Result: `passed: true` on JSONL and
SQLite with two persistent hosts, TCP loopback and enabled boot check.
The overlay directory is a fixture; this is not a live NetBird outage matrix.
The remaining host/member and NetBird containers continued with their previous
images. The new federation service was not rolled out into these containers.

The subsequent phone acceptance passed: Xiaomi M2007J17G, Android 12,
Node v26.4.0, Wi-Fi ADB. The two freshly built test modules were run in the separate
app directory `files/runtime/phi-spaces-acceptance`. Result:
1 federation integration test and 3 recovery/boot/restore tests passed,
no failures and no omissions. The backend cases run on JSONL and SQLite;
test data use their own temporary directories.

The first federation run failed on TCP timeouts. An independent minimal test
reproduced this both for the default loopback connection and for
`127.0.0.3`. After starting the pi-mobile app in the foreground both
connections worked; afterwards the unchanged federation test module passed.
The evidence holds for the active app. It demonstrates no permanent background
or screen-off operation. VPN lockdown was not set and the app already had
the internet permission; these settings were not changed.

When starting the Termux node runtime directly, the app's own paths must be set:
in particular `LD_LIBRARY_PATH`, `OPENSSL_CONF`, `PREFIX`, `HOME` and
`TMPDIR`, corresponding to `PiService.startNode`. The OpenSSL default path otherwise points
to the private directory of the other app `com.termux` and is inaccessible.

On the phone, two local TCP gates with simulated overlay peers
and software keys run in the test. This is real Android runtime/persistence evidence,
but for this run still no phone-to-big connection over NetBird, no Android Keystore
evidence and no acceptance of the visible enrollment/QR operation. The native
keystore evidence was provided separately on 2026-10-11 (below).

## Implementation Added on 2026-10-10

The building blocks and concrete configuration/SSH calls are in
[ap1b-betrieb.en.md](ap1b-betrieb.en.md). `test/test-operations.test.ts` checks private
key files, reader/CAS separation, signed private recovery access,
data restore with journal/registry/ACK/boot comparison after reopen on both
backends, idempotent release over the real socket, locked release after
fencing, the configured federation start and closed control rights after
snapshot import. The external fencing/ACK evidence in restore tests are
explicit fixtures. No real systemd/SSH fencing evidence is derived from this.

`pi-termux-mobile/test/spaces-mobile.test.mjs` now contains three checks for request identifiers
stored before sending, token absence in profiles and
rotation resolution after reopen. The keystore there is an adapter fixture;
the native Java signer was compiled by the successful APK build,
but not yet executed on the device in this build run. The later native
device check of 2026-10-11 is documented below. The successful build replaces no
visible UI/NetBird device acceptance.

## Operations and Device Check of 2026-10-11

Evidence: [public result files](../../../test/evidence/ap1b-2026-10-11/README.md).
No tokens, private keys or still valid signed grants are contained in them.

- **Register:** `vpsc` is independent of the Space test bed on `big`. Two active
  systemd services enabled at user start provide private reader/operator
  sockets and an mTLS metadata access on TCP 17422. Database/keys/
  configurations are `0600`, directories `0700`. The firewall allows only
  big and the current operator connection. Reader CAS is rejected, operator
  CAS conflicts keep their error class; the test record is preserved after restart.
  The CA private key stayed on the operator machine.
- **Two real hosts:** `host-a` and `member-1` run their own SQLite harnesses and
  their own node processes. Gate IP/peer groups come from the real NetBird
  management API; no fixture directory and no skipped boot guard.
  Bootstrap/admin proof, supervisor host enrollment, object query, write/take,
  control grants and P-256 rotation passed. The old app identity is
  rejected; new identity/rotation remain usable after a service restart.
- **Permanent operation:** `phi-spaces-phase1b-host-a.service` and
  `phi-spaces-phase1b-member-1.service` start their existing containers and
  the built federation daemon. An exclusive owner lock prevents a second
  writer. Stop checks the actual container processes; recovery starts only
  with normal operation locked, without gate and without agents.
- **F15:** An SSH command bound firmly to member-1 stops the normal process and
  systemd service and writes a persistent restart lock. A renewed normal
  start was actually rejected. This test installed no
  restore/successor; only after an unchanged authority/boot comparison was the
  test lock removed. This is no promotion/cloud fencing evidence.
- **Private ACK access:** On host-a the signed private recovery socket runs
  behind a firmly bound Docker/SSH bridge command. A foreign signature,
  wrong authority in the ACK and an arbitrary commit were rejected live. A
  valid restore ACK was exercised automatically on both backends and then
  within the distributed live data restore.
- **Android:** Updated APK installed on Xiaomi M2007J17G/Android 12;
  real P-256 signatures from Android Keystore checked by phi-spaces and Node crypto.
  Foreign peer/host, expired challenge, arbitrary message and
  private-key export are rejected. Both rotation signatures work;
  aliases/public keys remain the same after force-stop and app restart.
  The test peer/host names are fixtures; this is no overlay/UI acceptance.

The operator TCP timeout was traced to an existing Tailscale rule:
`ts-input` drops foreign interfaces with source addresses from `100.64.0.0/10`.
SYN-ACKs were visible on `wt0` but did not arrive at the socket. Two narrow
runtime rules before this chain permit only established TCP replies from
100.89.128.128 and 100.89.5.70 with source port 7421. No VPN was installed
or disabled. These local rules are not yet a persistent general
VPN configuration.

`test/test-recovery-boundaries.test.ts` additionally checks the lost external ACK,
a second authority change, stale snapshot markers, bounded orphan audits,
TLS client rights/server identity, signed ACKs and their key revocation before
receipt commit as well as the complete control controller with two persistent
members. Fencing and clock are fixtures there. `test/test-grants.test.ts` denies
A-only observer rights after restore and permits only enrollment scope for unpaired.
The TUI now also reads running `harness.sqlite` via SQLite backup into a private
copy; history, invalid generations and restore/authority states are
displayed.

### Renewed Phone Connection and Final Server State

Wi-Fi ADB is connected again. The phone now has a real paired
keystore identity for `phase1b-host-a` and authenticates via NetBird.
The role limitation and the remaining acceptances are stated above; the test was done
via the local mobile API, not by visible UI operation. See
[phone evidence](../../../test/evidence/ap1b-2026-10-11/phone.json).

The final artifacts were rolled out to host-a and member-1; both services
are running. The checks of grants, write/take, existing rotation and private
recovery access were repeated afterwards. The built TUI inspector reads on
both running hosts `harness.sqlite` and shows control/jobs Space including
objects without read errors: [TUI evidence](../../../test/evidence/ap1b-2026-10-11/tui.json).

A renewed authentication call after a short switch of the app to the
background passed. Afterwards the app was displayed again. This demonstrates
no Doze, screen-off or long-term background operation. The final
built runner scenario passed again on JSONL and SQLite; its
overlay directory remains a fixture.

### Phone Tests after Admission to the Member Group

The first data access reported `grant belongs to another app key`: the mobile
client requested a grant over a separate, not yet authenticated
control connection. `MobileSpaces.connect` now first proves the same
keystore key there; on failure both connections are closed.
A regression test over two real TCP connections reproduces the old
error and passes with the fix. All three mobile tests pass.
The corrected APK was built and installed without deleting data.

Live on the Xiaomi, jobs object access over NetBird, own P-256 rotation,
rejection of the old key as well as resolution of a still pending rotation
after force-stop/restart and subsequent object access passed. The grant
test uses a fixture signer; the device check uses the native
Android Keystore. The visible UI operation is not yet fully accepted.
The screen-off attempt does not count as success: `dumpsys power` reported
`Awake`, so no screen-off duration is demonstrated. The screen was switched
on again at the end. Evidence: [phone.json](../../../test/evidence/ap1b-2026-10-11/phone.json).

The controlled 90-second attempt also could not demonstrate a full
rest phase: Android first switched to `Dozing`, but after about 11 seconds
was `Awake` again. The test therefore aborted and does not count as a
screen-off acceptance. No power or VPN settings were changed.

### Distributed Live Data Restore and Visible Object Display

The phone object display was triggered via the visible button; after the
response the test object was verified in the UI. The complete visible
enrollment/rotation operation remains separate from this single check.

A consistent online SQLite backup of `phase1b-restore-source` on host-b
was restored to `phase1b-restore-target` on member-2. The old normal
processes were actually stopped and restart-locked via firmly bound SSH commands;
the external register on vpsc continues to hold the source fenced.
The private control service on host-a confirmed the exactly matching tuple.
The recovery process was terminated with SIGKILL; only after proven process end
was the stale owner lock removed. The persisted wait state was reloaded after
restart with identical incarnation/epoch and completed after the real
wait period.

On the exclusively opened target storage the restored objects were readable,
but not removable before `releaseRestored`. The signed, type-bounded release
counted exactly one object; repetition was idempotent. Operator TLS and private
SSH credentials were removed before the normal start. From the real phone
the released object was read, taken and written back over NetBird.
The original phone jobs access continues to work. All 232 tests
passed again after the changes without omissions. Evidence:
[data-restore.json](../../../test/evidence/ap1b-2026-10-11/data-restore.json).


### Distributed Live Control Restore with a Separate Member

The isolated control authority was restored from a real SQLite backup to a
different test host. The old control process and its systemd service
were stopped via the firmly bound F15 access and locked permanently.
The independent register on vpsc reserved exactly the new authority
`a-de6377f2-2916-46ad-be65-8869dbc541c7` for
`live-control-restore-20261011`.

Target and separate member installed the signed transition durably.
The member received only the public OP pin; its temporary
TLS certificate was allowed to write only its boot entry and its authority ACK.
Without a member ACK the controller refused the release. After installation of the
member it still refused it without a fresh admin. Only after explicit
authorization of new admin/host keys was the restore completed.

The recovery processes were closed and their private administrative
credentials removed. After explicit re-provisioning both
normal gates started: the new admin authenticated and received grants, the
old admin key was rejected, existing member objects were readable,
and write/take worked over the real NetBird overlay.

Afterwards the additional control gates were stopped, the original
main services and the already restored data target started again and the
temporary register write permission and firewall rules removed. The old
control source remains locked. All 233 tests and the typecheck passed;
mobile bundle and test bed artifacts were rebuilt. Public evidence:
[control-restore.json](../../../test/evidence/ap1b-2026-10-11/control-restore.json).


### Repeated Short Screen-Off Test

The first attempt was not accepted because of premature waking. The
repetition demonstrates the uninterrupted short interval by means of consecutive
`dumpsys power` samples (`Dozing`/`Asleep`), then successful real
phone object access and finally still `Asleep`. The whole run took
115.2 seconds; the screen was switched on again afterwards.
This closes the short screen-off evidence, not the long-term/Doze acceptance.
Samples and both attempts are in
[phone.json](../../../test/evidence/ap1b-2026-10-11/phone.json).


### Visible Phone Operation after Rotation

The live UI check found a real error: the pairing status compared the
historical enrollment result with the already rotated current key.
The mobile runtime now checks the current app key on `paired`; a
revoked key is still rejected. Pending enrollment is still resolved
via its durably stored original request tuple.
Completed rotation command IDs are retained for renewed status queries.

The corrected APK was built offline and updated on the Xiaomi.
Operated visibly and passed: pairing status, key proof, own rotation,
evaluate rotation (including repetition after completion) and object display
with the new key. All four mobile regressions passed.
Public evidence: [phone-ui.json](../../../test/evidence/ap1b-2026-10-11/phone-ui.json).
Fresh initial pairing through the visible forms and camera QR capture were
not performed again in this run. The ten-minute screen-off attempt
was interrupted by waking after 192 seconds and does not count as passed.

### Bounded NetBird Outage Matrix in Progress

The separate administrative fault proxy and its measurement tools are described in
[test/testbed/netbird/FAULT-TESTS.en.md](../../../test/testbed/netbird/FAULT-TESTS.en.md).
Only the dedicated test peers host-b/member-2 and the additional
restored data gate run through it; original main services and phone
stay on their normal path. Management, signal and relay were each measured as connected
in a healthy baseline; the new test client restricted to `jobs`
successfully read the existing restored object.

Historical progress note before completion: The temporally complete matrix ran under `phi-spaces-netbird-matrix.service`
on big with an atomic progress report and independent time-controlled
return to the original network path. In the running management case, signal/relay and the direct TCP tunnel were retained, while the real data gate after
cache expiry refused object access. Running time spans are not yet
completed evidence. Desktop/relay access is additionally measured locally.


The first complete management case has ended: 305.3 seconds of fault phase,
signal/relay and direct TCP access retained, object access locked after gate cache
expiry and then restored. The separate one-hour run
has started. [Measurement evidence](../../../test/evidence/ap1b-2026-10-11/netbird-management-5m.json).


### Ten Minutes of Background Operation with the Screen Off

The repetition passed: 600 seconds requested duration, 608 seconds
total run, continuously `Asleep`/`Dozing`, six successful object checks
(including the end). Beforehand the app was put into the background with HOME;
Android confirmed `STOPPED` and not visible during the run. The service,
NetBird and native key proof continued to work. The samples for the
old Resumed-Activity field are not meaningful on all Android versions;
the independent activity check and the continuous screen state complement
them. The screen was switched on again afterwards.
[phone-background-10m.json](../../../test/evidence/ap1b-2026-10-11/phone-background-10m.json).
This demonstrates the measured ten-minute interval, no unlimited runtime and
no automatically entered deep Doze phase.


### Controlled Deep Doze Test

The forced deep Doze test passed: 180 seconds requested duration,
187.8 seconds total run, continuously `mState=IDLE` and `mForceIdle=true` as well as
four successful real object checks. Beforehand no force-idle was active.
Afterwards the own test lock was lifted; Android reported again
`mForceIdle=false` and `ACTIVE`. No battery exceptions or
power settings were changed. The screen was switched on again.
[phone-doze.json](../../../test/evidence/ap1b-2026-10-11/phone-doze.json).

The controlled Doze test with Wi-Fi ADB and the ten-minute screen-off run
have passed. They replace no uninstrumented overnight measurement.
Still open are the long NetBird time cases still running, measured
group/peer withdrawal and the complete initial pairing through the visible
forms or the camera QR function.

### Fresh Initial Pairing and Measured Group/Peer Withdrawal

On the real Xiaomi, prepare, takeover of a fresh QR payload,
data form, authentication and object display were executed by the actual
UI handlers. The new native keystore profile is paired; the previously
used key is revoked and rejected. After installing the normal APK without
instrumentation, object access continues to work.
[phone-first-pair-ui.json](../../../test/evidence/ap1b-2026-10-11/phone-first-pair-ui.json).

A dedicated NetBird peer lost access after group withdrawal in
2.895 seconds. After confirmed re-admission exactly this test peer was
deleted; access was denied after 2.823 seconds. The measurement concerns
end-to-end access including overlay ACL and gate, not an isolated
measurement of the layer A cache alone. Throwaway peer, container and setup key
were removed or revoked. Existing peers were not changed.
[peer-withdrawal.json](../../../test/evidence/ap1b-2026-10-11/peer-withdrawal.json).
