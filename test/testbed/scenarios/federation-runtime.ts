// Built-artifact acceptance using two persistent harnesses and real TCP gates.
// Overlay directory and clocks are fixtures; this does not certify the NetBird outage matrix.
import { exerciseFederationRuntime } from "../../support/federation-runtime.ts";
await exerciseFederationRuntime();
console.log(JSON.stringify({ scenario: "federation-runtime", passed: true, backends: ["jsonl", "sqlite"], hosts: 2, transport: "tcp-loopback", bootAuthorization: true, overlayDirectory: "fixture" }));
