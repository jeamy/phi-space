// Cases for the Rust port of validateErasureRegisterUpdate: seeded updates of barriers and archive catalogs, each line
// {key, next, prior, related, reject}. rust/phi-host/tests/erasure_policy.rs asks the same of phi_host::register.
import { validateErasureRegisterUpdate } from "../../src/erasure-register-policy.ts";

let seed = Number(process.argv[2] ?? 1), n = Number(process.argv[3] ?? 4000);
const rand = (m: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % m; };
const pick = <T,>(a: readonly T[]): T => a[rand(a.length)]!;
const hash = (c: string) => c.repeat(64);
const barrier = (): any => ({ spaceId: pick(["jobs", "jobs", "jobs", "other"]), epoch: pick([1, 1, 2, 2, 3, 0, 1.5]), state: pick(["pending", "sealed", "sealed", "open"]), commandHash: hash(pick(["a", "a", "b", "z"])), archiveDeadline: pick([2000, 2000, 3000, -1]), archivesPending: pick([true, false, false]) });
const artifact = (id: string): any => { const a: any = { id, sha256: hash(pick(["c", "c", "d"])), epoch: pick([0, 0, 1, 2, -1]), kind: pick(["backup", "backend-history", "other"]), state: pick(["retained", "retained", "quarantined", "destroyed", "gone"]) }; if (rand(3) === 0) a.deleteBefore = pick([2000, 3000, -1]); return a; };
const catalog = (): any => ({ spaceId: pick(["jobs", "jobs", "jobs", "other"]), artifacts: Array.from({ length: rand(4) }, (_, i) => artifact(pick(["x", "y", "z"]) + (rand(4) ? i : ""))) });
for (let i = 0; i < n; i++) {
	const archives = rand(2) === 0, key = (archives ? "erasure-archives:" : "erasure:") + pick(["jobs", "jobs", "jobs", "jobs", ""]);
	const make = archives ? catalog : barrier;
	const prior = rand(3) ? make() : null;
	// half the updates start from the prior, so that the rules beyond the shape are reached
	const next = prior && rand(2) ? { ...structuredClone(prior), ...(archives ? {} : pick([{}, { state: "sealed" }, { epoch: prior.epoch + 1, state: "pending", archivesPending: true, commandHash: hash("b") }, { archivesPending: false }])) } : make();
	// an archive that moves on or back, or changes what it binds
	if (archives && prior && next !== prior && next.artifacts?.length && Array.isArray(prior.artifacts)) { const a = next.artifacts[rand(next.artifacts.length)]; if (a) { if (rand(2)) a.state = pick(["retained", "quarantined", "destroyed"]); else a.sha256 = hash("e"); } }
	const related = rand(2) ? (archives ? barrier() : catalog()) : null;
	let reject: string | null = null;
	try { validateErasureRegisterUpdate(key, next, prior, () => related, (m) => { throw new Error(m); }); }
	catch (e) { reject = (e as Error).message; }
	console.log(JSON.stringify({ key, next, prior, related, reject }));
}
