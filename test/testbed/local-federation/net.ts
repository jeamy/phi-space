// What the pieces of the local federation share: their addresses and ports.
export const IP = { register: "172.30.7.2", management: "172.30.7.3", control: "172.30.7.4", member: "172.30.7.5", client: "172.30.7.7", router: "172.30.7.8" };
export const PORT = { register: 7430, control: 7431, member: 7432 };
export const peer = (id: string, ip: string, groups: string[]) => ({ id, name: id, ip, connected: true, groups: groups.map((g) => ({ id: `g-${g}`, name: g })) });
export const POLICY = (version: number, rules: unknown[] = []) => ({ authorityId: "authority", policyVersion: version, rules, completionProfiles: [{ taskType: "Gated", resultTypes: ["GatedDone"], equalFields: ["runId", "n"], maxResultCount: 1, maxResultBytes: 1024, maxLeaseMs: 60_000, gateField: "runId" }], default: { mode: "local", member: "a" } }) as never;
