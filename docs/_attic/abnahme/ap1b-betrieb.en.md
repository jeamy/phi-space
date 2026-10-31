# Phase 1b: Provisioned Start and Recovery Interfaces

As of 2026-10-11. This describes implemented tools and their
prerequisites. The complete operations acceptance is in
[ap1b-abnahme.en.md](ap1b-abnahme.en.md). Data and control restore have been checked live; fresh initial pairing through the phone UI has passed. The complete five-part NetBird outage matrix has passed, including resumption and cleanup.

## Normal Runtime

`PI_SERVERD_FEDERATION_CONFIG` activates the complete federation chain in `pi-serverd.mjs`.
It starts before `harness.resume()` and replaces the static
Space identity at the native Unix adapter. The adapter receives only the
provisioned own peer ID with freshly queried NetBird groups; client
presentation and service arguments set no identity. Every connection
still needs its app key proof and matching control grants.

The JSON configuration must be a regular file owned by the service user
with mode `0600`. Example structure, all values are explicitly
provisioned:

```json
{
  "hostId": "host-1",
  "peerId": "NETBIRD-PEER-ID",
  "authorityId": "INITIAL-AUTHORITY-ID",
  "controlHostId": "control-host",
  "controlSpaceId": "STABLE-CONTROL-SPACE-ID",
  "mode": "member",
  "listen": {"host": "OVERLAY-IP", "port": 7421},
  "keyFile": "/private/host-key.json",
  "registerSshTarget": "register-reader@independent-admin",
  "installedRegisterFile": "/private/installed.sqlite",
  "management": {"url": "https://NETBIRD-MANAGEMENT", "tokenFile": "/private/auditor-token"},
  "groupRoles": {
    "space-hosts": ["member", "host"],
    "space-admin": ["admin"],
    "space-members": ["member"],
    "space-observer": ["observer"],
    "space-enroll": ["unpaired"]
  },
  "control": {
    "address": {"host": "CONTROL-OVERLAY-IP", "port": 7421},
    "algorithm": "ed25519",
    "publicKey": "PINNED-PUBLIC-KEY-BASE64"
  }
}
```

As an alternative to `registerSshTarget`, exactly one `registerTls` or `registerReadSocket` is given,
for example an explicitly set up private SSH socket tunnel.
Normal members receive only reader access. An administrative, exclusive
member recovery process may have a separate TLS write access whose
`writeKeys` permit only its boot entry and the concrete authority ACK;
it does not receive unrestricted operator access.
`provisionFileSigner(path, algorithm)` creates a key once;
`loadFileSigner(path)` refuses missing, public, foreign or linked
files and creates no replacement. Key file and management token stay
outside Space snapshots.

Before the start, registry/Spaces, PeerKeys, an active external `authority:CONTROL_SPACE_ID` record, an external `boot:HOST` and
local `installed:HOST:SPACE` records must be provisioned consistently.
`mode: control` additionally requires the correct control Space ID and the public key/algorithm
matching the signer. The listen IP must, according to the
management API, belong to the provisioned peer. After an authority change
the new control endpoint must be explicitly configured accordingly. A missing
or inactive boot proof prevents the normal start.

The enrollment group is changed administratively into the
desired operating group after successful pairing. A PeerKey alone does not extend layer A.
Paired devices can resolve their own stored
enrollment request with the current key, even with a scope limited to data Spaces.
They cannot consume new tokens this way.

## Independent Register and SSH

On the independently managed recovery admin system:

```sh
npm run build
node scripts/recovery-register.mjs serve /private/register.sqlite /private/read.sock /private/operator.sock
node scripts/recovery-register.mjs get /private/read.sock boot:host-1
node scripts/recovery-register.mjs cas /private/operator.sock boot:host-1 null /private/initial-host-record.json
```

`cas` requires the current version number or `null` for a new record.
The file with the new value is likewise private. The service creates the socket
directory and database privately; at the reader socket CAS is rejected server-side,
even if the client claims to be a writer. The register must not be backed up/rolled back
together with Space snapshots: an already assigned
authority successor must be preserved.

A dedicated SSH key gets, for example, this fixed access in
`authorized_keys`; paths and users are installed by the operator:

```text
restrict,command="/usr/bin/node /opt/phi-spaces/scripts/recovery-ssh.mjs read /private/read.sock" ssh-ed25519 PUBLIC_READER_KEY
restrict,command="/usr/bin/node /opt/phi-spaces/scripts/recovery-ssh.mjs recovery /private/recovery.sock" ssh-ed25519 PUBLIC_RECOVERY_ACCESS_KEY
```

Readers accept only `SSH_ORIGINAL_COMMAND=phi-spaces-register-read`, a
bounded JSON `get` on stdin and deliver a JSON record on stdout. The
client uses BatchMode and StrictHostKeyChecking; without a provisioned
SSH host key or without a register response it is rejected. The recovery bridge
accepts only `phi-spaces-recovery` and forwards a bounded
signed RPC to the fixed private socket. SSH access
alone grants no recovery role: the service checks the separately provisioned
operator key or the current supervisor key and the host target.

## F15 and Durable Restart Lock

`scripts/fence-ssh.mjs HOST UNIT STATE_DIR` is another permanently installed
forced command. `phi-spaces-fence` writes and syncs `restart.lock`,
stops the fixed systemd user unit and returns its state.
`phi-spaces-fence-status` only checks. The service must be operated with `KillMode=control-group`.
Normal `pi-serverd` refuses to start when the lock is present,
even outside systemd. Unit, host ID and state directory never come from the SSH request.

`verifySshFence` uses only administratively provisioned
SSH targets, requires a stopped service and the durable lock and then sets
the external host boot state to `fenced` via CAS. F15 refuses
sync/replica configurations. This is an adapter for single operation;
its acceptance with the real service is pending. An unreachable old host without
independent fencing evidence does not entitle to a restore. Lock and external
permission are released again only in a separate checked administrative
procedure; a higher epoch does not remove the lock.

## Data Restore and Remaining Integration

`RecoveryController` journals argument hash, snapshot hash, source host and
import state. The source host comes from `placement:SPACE` in the independent
register, not from a claim of the requesting client. Before import the
Space boot permission is withdrawn. Registry incarnation and restore state change
atomically; import cursor and journal survive a process abort. Journal costs
are reserved against the commit budget in addition to the import.

`serveRecovery({ ..., handle: dataRecoveryHandler(controller) })` connects only
`restoreDataSpace`, `advanceRestore`, `restoreStatus` and `releaseRestored` to
the private signed socket. The controller receives privileged
host functions of the same harness, bound before the normal boot guard; these are not passed to the normal Space service. A second simultaneously opened harness is no substitute.
Snapshot loader, fencing targets and the actual control ACK channel must be
provided administratively. `acknowledgeControl` must deliver a durable
receipt with exactly recovery ID, Space, authority, incarnation and primary epoch;
a guessed `true` is not sufficient.

After at least 62 seconds and a valid ACK the controller installs the new
local and external permission and updates placement. Restored data
stays quarantined until the explicitly bounded release. This
release, too, now refuses fenced hosts or changed boot records.
`hello` and frame check use the stored epoch of the Space concerned.
Status/release retries use the same recovery/command ID.

`startConfiguredRecovery` is integrated into the normal runtime and provides
control ACK and optionally data recovery. Control restore runs only
via `startRecoveryOnly` under exclusive harness ownership and restart lock.
Member ACK, boot comparison and explicit new key release are implemented;
the distributed data/control live restores have since been accepted. The local
control import functions keep bootstrap closed, revoke PeerKeys,
discard tokens/commands/old policy rules and set members to
`recoveryBlocked`; they do not replace this distributed procedure.

## Android Operation

The page `spaces.html` offers create device key, pair,
enrollment status, key proof, rotation/rotation status and a selected
data Space with at most 100 objects and statistics. Peer ID and trusted
control/data host IDs are entered explicitly. A QR JSON can be pasted;
endpoint and, optionally, an already stored control Space ID are
compared. A camera QR capture is not yet implemented.

`SpaceKeyStore` creates P-256 in Android Keystore. The private key does not leave
the Keystore. Node receives only the public key and signatures through a local socket checked by app UID.
Signatures are limited to fresh,
identity-bound auth/rotation messages. An explicitly
added data host is stored in the local key binding.

The private profile file contains aliases, public metadata and request identifiers
synchronized before sending, never enrollment tokens.
Unclear rotation results are queried with the same command; they
trigger no second key change. A preparation step interrupted before sending
uses the same replacement key already created.
The successful APK build is no evidence of phone-to-server communication,
background operation. Native keystore execution and real phone-to-server pairing/
authentication over NetBird were checked on the device on 2026-10-11.
An authentication during a short app background has also passed;
object access with the matching overlay member role, rotation and resumption
after app restart have also passed. A ten-minute screen-off/background run and a three-minute
controlled deep Doze test have since passed, each with real
object accesses. The tests demonstrate these measured intervals; complete
initial pairing through the visible forms and camera QR remain separate.

## Installed Operation on big and vpsc

The register runs on `vpsc` under
`/home/mux/.local/share/phi-spaces-recovery`; the user services
`phi-spaces-recovery-register.service` and `phi-spaces-recovery-register-tls.service`
are enabled. `npm run build:operations` builds standalone `.mjs` artifacts
for register/SSH operation without application dependencies. Only built artifacts
were transferred. The TLS access serves only the independent
administrative register outside the overlay; F3 stays without TLS/mTLS on
Space port 7421. No further VPN is needed.

`registerTls` contains `host`, `port`, `caFile`, `certFile`, `keyFile` and optionally
`serverName`/`timeoutMs`. CA, certificate and key files are private,
regular files; server name/IP must match the certificate. The register server
admits only approved client certificate fingerprints. Readers have no CAS;
`writeKeys` restricts a service to explicitly named register keys.
Unrestricted operator certificates and the CA private key do not belong in
normal member/agent configurations. Since 2026-10-16 the TLS access listens dual-stack (`::`); IPv6 clients
such as nanoi use `serverName: "phi-spaces-register"` because the server certificate contains this name
([test environment §18](../../testumgebung-big.en.md#18-test-server-nanoi-phase-3-test-primary-and-fencing-target)). On big only reader
certificate/key are in the normal runtimes.

On big the two user services run:

```sh
systemctl --user status phi-spaces-phase1b-host-a.service
systemctl --user status phi-spaces-phase1b-member-1.service
```

Their respective containers hold `/data/phase1b/harness.sqlite`, local
installation, configuration and own signer. Since the rebuild of 2026-10-18
([test environment §20](../../testumgebung-big.en.md#20-rebuild-under-phi-spaces-2026-10-18)) the gate addresses
are `100.89.103.95:7421` (host-a) and `100.89.136.73:7421` (member-1). The registry IDs and key fingerprints
of the earlier federation (`100.89.128.128`, `100.89.5.70`) are in the public
[evidence](../../../test/evidence/ap1b-2026-10-11/README.md).
The daemon `tools/federation-host.mjs` supports `provision` (JSON on stdin),
`bootstrap`, `enroll` (token on stdin only), `run`, `stop`, `status`, `fence` and
`recovery`, `member-recovery` and `recovery-call`. `owner.lock` prevents two writers; `restart.lock` refuses
normal start. An orphaned owner lock is not deleted blindly.

`scripts/fence-docker-ssh.mjs` binds host, unit, container and storage directory
in `authorized_keys`. It checks both the actual node process in the
container and the stopped systemd service; a vanished Docker
exec client alone does not count as fencing. `scripts/recovery-docker-ssh.mjs`
forwards only the signed private RPC to the fixed container.
The local SSH aliases `phi-spaces-fence-host-a`, `phi-spaces-fence-member-1` and
`phi-spaces-recovery-host-a` use their own keys with forced commands.
`phi-spaces-register-reader` reaches the read-only register access on vpsc.

## Control Restore under Exclusive Recovery Ownership

`startRecoveryOnly(host, ctx, privateConfigFile, assertQuiesced)` requires:
`hostId`, `path`, `installedRegisterFile`, `operatorKeyFile`,
`supervisorKeyFile`, `snapshotDirectory`, `fenceTargets` and exactly one
`registerTls` or `registerSshTarget` operator access. The control program already holds
exclusive harness ownership; it starts neither agents nor a normal
gate. The normal service stays stopped and locked by `restart.lock`.
When using the SSH F15 check, the administrative runtime must have an
already present SSH client and the firmly provisioned targets;
the unchanged node-slim test bed image has no SSH client.

`restoreControlSpace` contains recovery ID, stable control Space ID, private
snapshot reference, expected authority/incarnation/epoch, target host and
`confirmedMembers` including the target. Every retry uses the same
arguments. `advanceControlRestore` imports in bounded steps, installs the same
signed transition locally and requires matching independent member ACKs.
`installAuthority` performs this transition on every stopped member.
`authorizeRecoveryKey` confirms the explicitly chosen **new** app identity;
an old revoked key is not revived by it. At least
one new admin with control scope is needed. Offline members remain visible
and `recoveryBlocked`. Only after 62 seconds and valid ACKs does the new
authority become active. Afterwards control address/host ID/signer are explicitly
re-provisioned and the normal runtimes released administratively.
An ACK with a lost network reply is written again from the local installation
into the independent register. Stale snapshot markers open no boot.

This procedure uses only single hosts; sync/replica configurations and
sealed candidates require the later replication/fencing path.
The actual distributed data/control restore execution has passed according to the
[acceptance state](ap1b-abnahme.en.md).


`startMemberRecoveryOnly(host, ctx, privateConfigFile, assertQuiesced)` requires
`hostId`, `path`, `installedRegisterFile`, the public
`operator: { algorithm, publicKey }` pin and a narrowly bounded `registerTls`
access. Private OP/control signing keys are not distributed to members.
The socket accepts only OP-signed `installAuthority`; control
restore, key authorization and arbitrary register commits are blocked.
The normal gate start takes place only after the installed transition, removal of the
administrative credentials and explicit new provisioning.

`tools/recovery-data-host.mjs backup HOME [jobs|control]` backs up SQLite via the
online backup API and exports the snapshot from the copy; it opens no
second writer on the live harness. `run` operates the administrative private
data recovery socket under exclusive ownership; `inspect` checks, under the same
restart lock, readable, not yet released restore objects. All additional
restore test directories are explicitly permitted in the forced-command tools
and every SSH key stays bound to a fixed host/container/path. The administrative SSH client was provided only in the separate recovery
runtime. Normal gate runtimes contain no OP TLS or
fencing keys.
