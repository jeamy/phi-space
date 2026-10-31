# Project start from the phone: provisioning Spaces and monitoring automatically

Status: 2026-10-08 (bootstrap, boot authorizations per Space and complete run recovery aligned with v3). **Supplementary target contract**; parts have been implemented since 2026-10-16 (deployment plan/apply, Space lifecycle, workers, runs, alerting; see [Operations §8](../betrieb-und-mobile-steuerung.en.md#8-implementation-status-and-order-of-the-operations-extension)), the automatic project start as a whole has not. The binding federation basis
is [v3](../federation-plan-v3.en.md); the [v2 summary](federation-plan-v2-summary.en.md) remains an archive.
Architecture and manual bootstrap: [Operations and mobile control](../betrieb-und-mobile-steuerung.en.md).

## 1. Desired operation

**Select project → start → automatic preparation → check readiness → start workers.**

The selection loads the project configuration and shows hosts, Spaces, mode and resource needs.
Only Start triggers the provisioning. Prerequisites are previously set up host access and
authorized installation/enrollment rights. After that the user does not have to install every Space individually.

phi-spaces is the TypeScript library of this project. The respective pi-serverd keeps Spaces in a
phi-spaces store (`space.sqlite`); the pi-durable harness carries only its conversations. Logical Spaces are
persistent documents with stable IDs.

## 2. What the existing mobile runtime already does

Code findings in the neighboring project pi-termux-mobile:

- `runtime/server.mjs` and `runtime/remote-state.mjs`: `remoteState.connect` calls `ensureRemoteServer` before the remote attach.
- `runtime/remote-provision.mjs`: checks Node/npm, transfers pi-serverd, common.mjs, phi-spaces.mjs and
  package files; prepares dependencies, starts the daemon and checks the sessions protocol.
- The runtime release is prepared before the old daemon is ended; if the start fails,
  a switch back to the previous release is attempted. This is not an atomic data migration.
- tmux is installed if necessary, otherwise nohup is used. Node must already be present in a supported
  version; this code does not install it automatically.
- `runtime/pi-serverd.mjs`: opens the SQLite harness (sessions, with Spaces extension) and the phi-spaces store of the Space and starts reaper/delivery.

This happens today at **remote connect**, not at the start of a declarative federation project.
There is one active remote connection; no multi-host provisioning, named project Spaces,
monitoring installation or readiness check of a federation. A successful `sessions.list`
does not prove that the planned Space RPC and its guarantees exist.
The code finding is no executed remote installation or mobile E2E acceptance.

### 2.1 Prerequisites by role

NetBird and Node.js alone are not enough. Before the start, the planned bootstrap checks the following
prerequisites; existing matching components are reused.

| Location | Prerequisite | Why / current state |
|---|---|---|
| Every remote host | supported Linux environment, Node.js and npm | the mobile runtime requires Node ≥ 22.19.0 according to package.json; check the actually released release |
| Every remote host | working `node:sqlite` | the SQLite adapter uses Node's DatabaseSync; check import and write test, not only the version number |
| Every remote host | OpenSSH server, authorized SSH access | first bootstrap and today's remote connection; the later Space RPC does not replace the initial provisioning |
| Every remote host | bash, tar with gzip support, base64 and usual Unix tools | the existing SSH provisioner uses these tools; the Linux process check needs /proc |
| Every federation host | NetBird client, enrollment and reachable overlay | installation alone is not enough; check peer assignment, groups and ACLs |
| Every remote host | released runtime release with matching npm dependencies and Spaces bundle | pi-durable, pi-server, pi-ai, chord and further packages according to the runtime lockfile; check the bundle version separately |
| Every remote host | private, writable persistent state directory | one storage owner; room for DB/journal and backups, correct file/socket rights |
| Every remote host | host/app identity and authorized grants | in addition to the NetBird network identity, v3 requires app keys and roles |
| Every remote host | working time synchronization | leases/deadlines and later replication need the intended time contract |
| Every remote host | independent service execution | start through tmux or nohup today; additionally provide boot autostart and restart supervision |
| Every federation host | Space RPC, supervisor, recovery, reaper/delivery and host monitor | parts exist; federation/monitoring services still to be implemented |
| Coordinator | control Space, router, journal and provisioning accesses | durable continuation after the phone disconnects; own protected control state |
| First installation | reachable package source or prepared offline release | npm/OS packages must be obtainable; no renewed download needed for later runs |
| Native mobile control | mobile runtime, SSH client/keys and for v3 NetBird/app pairing | Android/Termux environment according to the released mobile build; multiple host connections still open |
| NetBird infrastructure | management, signal and relay services, DNS/domain and matching network releases | self-hosted v3 plan: own VM and Docker Compose; exact version/ports follow gate 5 |
| Browser access | HTTPS gateway, TLS certificate and user/app login | only for the browser path; the browser device itself needs neither Node.js nor SSH, the gateway needs overlay access |

NetBird is required for the planned overlay federation. The local sieve and today's pure
SSH remote control do not need NetBird. With an existing NetBird installation, the
infrastructure is reused; not every worker host runs management/signal/relay.

**No general mandatory installations:** standalone SQLite server, PostgreSQL/Redis,
Docker on every worker, Git, global TypeScript or Prometheus/Grafana. The SQLite adapter uses
Node's built-in SQLite binding. TypeScript is needed for development, Git for deployment from source;
not in principle for a finished JS release. tmux is optional in the existing provisioner.
Docker Compose concerns the planned self-hosted NetBird infrastructure host, not automatically every member.
Provider credentials are only needed for real LLM agents; pure sieve workers need none.

Installation rights for missing OS components are set during host onboarding; the normal
worker runtime can run under a separate unprivileged user. NetBird service/network setup and
package installation need matching system rights. Missing rights block the preparation step.
A simple project start does not install Node/NetBird automatically today.

The bootstrap then checks not only installed packages, but also SSH access, SQLite writability,
storage owner, runtime/protocol features, overlay reachability, app rights and monitoring heartbeat.
Only then does the host count as ready. Exact OS/NetBird compatibility remains an integration acceptance.

## 3. Three separate states

| State | Meaning | Lifetime |
|---|---|---|
| Host runtime ready | matching pi-serverd, pi-durable, Spaces bundle, supervisor and monitor present | reused by projects |
| Project ready | Spaces, membership, policy, rights and monitoring assigned to this project | persists after the end of a run |
| Compute run active | runId and concrete workers process tasks | independent of the open phone dashboard |

Start checks and completes the desired state; it does not reinstall at every click.
A second start of the same request must create neither duplicate Spaces nor a second compute run.
A deliberately new run receives a new runId. Accesses of different projects are separated according to the
configured rights contract; an explicitly shared Space remains possible.

### Reusing existing runtime and Spaces

A Space is a general stock for typed entries, not the installation of a specific
algorithm. Sieve, research, pipeline and other kinds of work can use the same runtime and, with matching
rules, also the same data Space. What is new then are tasks and worker bindings, not the Space.
A Space is normally not a server process of its own that would have to be started per kind of work.

The start assignment resolves the selected stable Space IDs and checks the actual state:

| Existing state | Behavior at project start |
|---|---|
| runtime and selected Space reachable and compatible | connect and reuse; no second daemon, no further Space |
| Space persistently present, its host service stopped | start the same service with the same storage; open the existing Space |
| selected Space provably not present | if creation is allowed, create once under the intended ID |
| host not reachable or state unknown | block the start and resolve the state; create no substitute Space under a new ID |
| existing Space has unsuitable rights, mode, schema or policy | report the concrete conflict; no silent change or reinstallation |

Reuse follows **selected IDs and checked rights**, not the first
Space found by chance. On the phone, a project can select existing Spaces/federation and save this
assignment. The same setting applies to the script bootstrap. Enrollment, member admission,
router and host monitor are also reused when the state matches.

In a shared Space, entry contracts and type rules must match. Workers filter
tasks by kind of work and runId; for shared project-related types additionally by
projectId. Such filters prevent accidental mixing, but replace no server-side
access rights. Hard isolation or contradictory replication/routing contracts may require separate Spaces.
Task processing with exclusive take needs expand/primary; an LWW Space is not suitable for it.

## 4. Project configuration

The following JSON shows a **proposed project schema** for which no parser exists. What is implemented is the
leaner deployment schema from [Operations §4](../betrieb-und-mobile-steuerung.en.md#4-bootstrap-script-plus-config)
(`validateDeployment`, `npm run bootstrap`); federation members, routing policy and workload of this project schema
are not yet applied by it. Release, project
and config revision are frozen as soon as a start assignment is accepted. Credentials lie
outside the file; a new revision does not change a running assignment.

```json
{
  "schemaVersion": 1,
  "projectId": "prime-demo",
  "configRevision": 1,
  "runtimeRelease": "approved-space-runtime-1",
  "provisioning": { "reuseExisting": true, "createMissing": true },
  "coordinatorHost": "host-a",
  "hosts": [
    { "alias": "host-a", "ssh": "pi@vps-a" },
    { "alias": "host-b", "ssh": "pi@vps-b" }
  ],
  "federation": {
    "federationAlias": "prime-demo-fed",
    "controlSpace": "prime-demo-control",
    "mode": "expand",
    "members": [
      { "space": "prime-demo-a", "host": "host-a" },
      { "space": "prime-demo-b", "host": "host-b" }
    ],
    "routingProfile": "sieve-hrw-by-taskid"
  },
  "monitoring": { "enabled": true, "sampleIntervalMs": 2000 },
  "workload": {
    "kind": "sieve",
    "start": 1,
    "end": 1001,
    "blockSize": 128,
    "workersPerMember": 1,
    "partition": "hrw-by-taskId"
  }
}
```

Release names and aliases are examples. Hosts, Spaces and federation appear in the config only as aliases;
`hostId` and `spaceId` are generated at creation according to v3 and assigned to the alias on the server side.
The project controller translates the routing profile into a validated policy and a run manifest; the string
itself is no additional v3 routing mode. `sieve-hrw-by-taskid` means one expand rule each by `taskId`
with the same member set for SieveTask and SieveResult. Thus each `taskId` binds task, result and txn to
the same member; the manifest records the computed assignment. Targeted pinned sub-ranges
(`disjoint-ranges` per member) are an extension outside v3
([Operations, section 6](../betrieb-und-mobile-steuerung.en.md#later-several-task-spaces)).
Capability/capacity selection must not independently distribute task and result to different hosts.

## 5. Automatic start assignment

| Step | Action | Prerequisite for the next step |
|---|---|---|
| 1. Check | check config, user rights, host access, features, release and storage needs | no unresolved conflict with the existing state |
| 2. Secure coordinator | prepare runtime on A, make control/supervisor reachable; complete the first admin pairing or check the existing one | durable deployment assignment on A and authorized admin context; bootstrap authority closed after consumption |
| 3. Prepare hosts | install/reuse runtime; createEnroll as paired admin, sanitized enrollment RPC per host | authenticated Space/supervisor health check successful; SSH/host rights replace no admin authorization |
| 4. Start monitoring | start/reuse host sampler; activate project-related Space/worker views | fresh status from every required host |
| 5. Provision Spaces | resolve selected IDs and check/reuse existing Spaces; create only missing permitted Spaces | rights, limits, project access and schema compatible |
| 6. Provision federation | check and reuse existing membership/policy/router; apply only required permitted additions | all required members reachable; policy consistent |
| 7. Prepare run | store runId/manifest and local RunGates in preparing; prepare tasks in bounded idempotent partial commits | all parts confirmed; existing workers locked by RunGates until preparation is complete |
| 8. Activate workers | release RunGates in a controlled way, start sieve workers with fixed member bindings | control revision, start generation and desired count stored; member ACKs complete, no atomic global start promised |

The infrastructure is controlled with **one durable deployment assignment** and separate sub-request IDs.
A business run start is likewise deduplicated. After its
readiness, the coordinator continues the steps; the phone observes and provides no durable worker execution.

Before step 2, a connection loss can interrupt the first bootstrap. The phone stores the
assignment ID and config hash and reconciles them with the host on reconnect. It must not start a
second bootstrap under a new identity if the outcome of the first is unknown.
After step 2, the work assignment, progress and host responses must be durable on the coordinator.
How the coordinator obtains SSH provisioning rights is still to be implemented: either explicitly
authorized host accesses or preinstalled bootstrap supervisors. Phone keys are not
copied to the coordinator automatically. Without this execution path there is no autonomous continuation.

The overall sequence is **no distributed atomic commit**. Each host confirms its own effect.
On partial failures, Spaces already created are kept; the controller shows the state and
continues the same assignment after the error is fixed. Unknown RPC outcomes are resolved with the same
sub-request ID. A timeout alone does not justify a renewed task/Space start.

## 6. Readiness, updates and errors

Project states: `checking → provisioning → configuring → preparing → ready → starting → running`.
`ready` means that infrastructure and tasks are ready; it does not mean that workers are already running.
Missing prerequisites lead to `blocked`, a confirmed final error to `failed`.
These project states do not replace the v3 states of individual commands. Effects that can no longer be
resolved automatically receive `needsReview` and block their dependent steps, not independent projects.
No automatic substitute assignment after ResultExpired or restore. After a restart, the controller continues
reconstructed long-running operations without making their completion a global start condition.
Pending states preserved after control/data restore are historical evidence, not long-running
operations to be continued. Affected runs stay `reconciling` or `needsReview` until the complete
`RunRecoveryView` evidence per [Operations, section 6](../betrieb-und-mobile-steuerung.en.md#6-example-controlling-the-prime-sieve)
has been reconciled. Entry locks and begun control phases count just like gates; a highest
running revision triggers no automatic resume. Resumption needs `resolveRunRecovery`
with an admin decision; `releaseRestored` only releases restored tasks and does not replace this reconciliation.

Before worker start, all members, rights, Space features, policy versions, storage budgets and fresh monitor heartbeats
required in the manifest must be checked. With primary/sync, the fixed
standby must additionally be able to actually confirm. A failure produces no silent switch to expand or async.
LWW/set are impermissible for the exclusive assignment of sieve tasks.
Additionally, every Space must have an external boot authorization for its current authority/data incarnation,
role and existing replica version (v3 5.5). The provisioning reconciles local configuration and
evidence, without overwriting authorizations of other Spaces or automatically reactivating fenced hosts.

A host that is already in use is not silently restarted. Release and schema changes need
a compatible upgrade path; conflicting updates wait for a planned maintenance window.
Provisioning assignments of different projects are serialized per host. A bundle rollback is
permissible only if the stored state remains compatible with the older release.

After the run start, a monitor failure must be distinguished from a worker/member failure. The display reports
stale data; it does not automatically declare the run finished and deletes no tasks.
An unknown member response remains unresolved; complete success requires all expected results.

## 7. What is monitored automatically

- **Host:** reachability, runtime version, CPU, RAM, disk and commit latency; additional sampler required.
- **Space:** entries, reservations, txns, waiters, limits; existing local stats/count as a basis.
- **Worker:** desired/active count, bound member, current task, last error and heartbeat.
- **Run:** expected taskIds per sub-range, committed results, completeness and result export.
- **Federation:** members, policyVersion, open commands/RPCs, replication lag where applicable.

To get started, a monitor in the host runtime process suffices; Prometheus/Grafana are no prerequisite.
Persistent run/deployment status stays separate from process-local meter counters. Host sampler and
monitoring endpoints are only partly implemented: hosts report resources and worker state through the
Capability heartbeat, `listAlerts`/`auditLog` deliver hints and audit; a host sampler for CPU load, disk and
commit latency is missing. They use observer views with timestamps;
internal journal, keys and enrollment tokens are not delivered to the UI.
The mobile status queries pause when the page is closed, the server-side samplers keep running.

## 8. Stopping, removing and example acceptance

**Pause/resume/stop a run:** protected RunGates, finite worker txns and a confirmed lock barrier
on all manifest members per [Operations, section 6](../betrieb-und-mobile-steuerung.en.md#6-example-controlling-the-prime-sieve).
Pause shows pausing/pauseIncomplete until all ACKs; stop ends in stopped after the same barrier and ends
only workers of this run. Resume uses a higher control revision of the same runId; stopped is final.
Runtime, monitor and stored results are kept. **Removing a project** is a separate action
with drain, bound completion writes, result retention and removeMember including a durable local
lock and EmptyProof. HRW members of this example cannot be removed in v3; project removal does not dissolve their
membership. Run/worker bindings can be ended, the infrastructure stays. A shared host daemon
is not ended across the board. **Disconnecting the phone** ends neither run nor monitoring.

Acceptance for prime-demo with two members:

1. On prepared test hosts the project is missing: one Start creates the infrastructure and delivers
   exactly the 168 reference primes for [1,1001); one committed result per task.
2. The same start is repeated after a lost response: no duplicate Spaces, workers or tasks.
3. Error on B during installation/preparation: A is kept; no worker start before readiness;
   resuming uses the same IDs and the same manifest.
4. Phone and later the coordinator process are interrupted: the assignment is continued after resumption on the basis of
   persisted effects; no claim of progress without execution evidence.
5. A worker dies after a reservation: the task returns on its member after lease expiry.
6. Monitor on B fails: the UI shows stale status; existing work is not deleted as failed.
7. Another project runs on A: stopping/removing prime-demo does not end its workers or runtime;
   HRW membership stays unchanged.
8. Pause with an offline member and controller restart: no false success display; after all ACKs no run commit,
   late old control revisions are rejected. Large preparation respects commit budget and RunGates.
9. First admin pairing, enrollment and recovery correspond to v3: no plaintext token in storage, no
   automatic re-release of restored keys, no setStandby circularity after control promotion.

These multi-host/installation cases are **not yet tested**. Today's sieve tests prove local
computation, txn rollback, lease expiry and reopening the store. For the automatic mobile provisioning, the
project controller, named Spaces/RPC, enrollment/router, supervisor assignments, host monitor and mobile project page are missing.
