// What the pieces of the local federation share: their addresses and ports.
export const IP = { register: "172.30.7.2", management: "172.30.7.3", control: "172.30.7.4", member: "172.30.7.5", client: "172.30.7.7", router: "172.30.7.8" };
export const PORT = { register: 7430, control: 7431, member: 7432 };
export const peer = (id: string, ip: string, groups: string[]) => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
export const POLICY = (version: number, rules: unknown[] = []) => ({ authorityId: "authority", policyVersion: version, rules, completionProfiles: [{ taskType: "Gated", resultTypes: ["GatedDone"], equalFields: ["runId", "n"], maxResultCount: 1, maxResultBytes: 1024, maxLeaseMs: 60_000, gateField: "runId" }], default: { mode: "local", member: "a" } }) as never;
// The replica hosts of `run.ts replica`, and the host's bridge address, where the fencing service runs outside every fenced container.
export const REPLICA = { "replica-a": "172.30.7.9", "replica-b": "172.30.7.10" }, RPORT = { gate: 7433, sync: 7434, fencing: 7435 }, GATEWAY = "172.30.7.1";
// The second control host of `run.ts change`, and which compose service each fenced host ID runs in.
export const CONTROL_B = "172.30.7.12", FENCED: Record<string, string> = { "replica-a": "replica-a", "replica-b": "replica-b", "control-host": "control-a", "control-host-b": "control-b" };
