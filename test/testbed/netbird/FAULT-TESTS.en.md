# Bounded NetBird Fault Tests on big

The administrative test proxy uses only built-in Node modules and
existing TLS certificates on big. It changes neither the production nginx nor
its port 443. It listens on port 14443; the fault control is reachable only on
`127.0.0.1:19991`. Two dedicated test peers (`host-b`, `member-2`)
redirect outgoing TCP exclusively to `152.53.239.133:443` there by a marked
NAT rule. Host-a, member-1, phone and other VPN users stay on their
normal path. No second VPN is used.

The routes distinguish management (HTTP API/gRPC), signal and relay. A
fault closes existing streams of the affected component and refuses
new requests; the other components stay forwarded. HTTP/2 trailers
and relay WebSocket upgrades must be passed through. The route separation
corresponds to the [NetBird documentation](https://docs.netbird.io/selfhosted/external-reverse-proxy)
and was checked against the actual agents 0.80.0.

`fault-proxy.mjs CERT_FILE KEY_FILE` starts the administrative proxy. On big
it runs as its own time-limited service `phi-spaces-fault-proxy.service`.
Certificate keys are neither copied nor logged. Components are selected through
`POST /fault` with `{"blocked":["management"]}`;
an empty list removes the faults. `GET /status` shows only
components, active stream counts and request counters.

`run-fault-matrix.py --all` is the administrative test driver provisioned on big.
It requires a healthy baseline object access and runs
management 5 min, management 1 h, signal 10 min, relay 30 min and management plus
relay 1 h. After 60 seconds, signal includes a restart of only the dedicated
host-b agent, to check a fresh tunnel setup. Each run records
real management/signal/relay states, P2P/relay connection types, the actual
TCP connection and object access against the additional restored data gate.
After each fault phase, object access must work again.

The data gate on member-2 uses the same bounded network path
also for its management API queries. This checks the real gate cache flow.
The test client on host-b has a separately enrolled app key
with only the `jobs` scope; service keys are not repurposed for it.
Enrollment tokens are passed only on stdin; the temporary enrollment group
is removed again afterwards.

The Python files are provisioned on big as private administrative tools under
`/home/mux/.local/share/phi-spaces-operations/`. The driver uses
only the explicitly designated test containers and directories.
Progress is recorded atomically in `netbird-matrix-progress.json`; running
phases are not yet passed acceptance. The real desktop/relay access is
additionally logged locally, without copying private app keys to big.

`fault-cleanup.py` removes only the two marked NAT rules
and reconnects these test peers to the original endpoint. It runs in the
`finally` of the driver and independently as a timed service. The proxy has
a maximum runtime. An additional local desktop monitor removes its
own marked reply rule after the test ends.

The targeted unreachability of the components for two peers is a real
client/gate failure check; it does not test a global server crash or its
database recovery. A real peer deletion and the time-measured
group removal are separate cases. Results are derived from the measured
P2P/relay paths; the hypotheses of the target matrix do not count as confirmed without
corresponding measured values.
