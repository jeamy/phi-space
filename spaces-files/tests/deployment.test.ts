// The deployment state (docs/zanzibar-agent-filesystem-plan.en.md, section 6.6): sessions by hashed handle with idle,
// absolute and epoch expiry; signing-key generations with their own validUntil; the time floor that never goes back,
// also across a restart; the login index; the owner lock and the key file's permissions.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ClockJump, DeploymentState, KEYS_FILE, STATE_FILE, StateUnavailable } from "../server/deployment.ts";

const MIN = 60_000, HOUR = 60 * MIN;
const clock = (start = 1_000_000) => { const c = { t: start, now: () => c.t }; return c; };
const scratch = () => mkdtempSync(join(tmpdir(), "spaces-files-state-"));

test("sessions: lookup by handle, idle and absolute expiry, logout", async () => {
	const c = clock();
	const s = await DeploymentState.open({ dir: null, clock: c.now, sessionIdleMs: 30 * MIN, sessionAbsoluteMs: 2 * HOUR });
	try {
		const { handle, expiresAt } = s.createSession({ tenantId: "acme", actorKind: "user", actorId: "lea" });
		assert.equal(expiresAt, c.t + 2 * HOUR);
		assert.deepEqual(s.lookupSession(handle), { tenantId: "acme", actorKind: "user", actorId: "lea", epoch: 1, expiresAt });
		assert.equal(s.lookupSession("nope"), null);
		// activity keeps it alive past the first idle deadline, up to the absolute expiry
		for (let i = 0; i < 4; i++) { c.t += 20 * MIN; assert.ok(s.lookupSession(handle), `alive after ${(i + 1) * 20} min`); }
		c.t += 40 * MIN;
		assert.equal(s.lookupSession(handle), null, "absolute expiry");
		const idle = s.createSession({ tenantId: "acme", actorKind: "agent", actorId: "planner-17" });
		c.t += 31 * MIN;
		assert.equal(s.lookupSession(idle.handle), null, "idle expiry");
		const out = s.createSession({ tenantId: "acme", actorKind: "user", actorId: "lea" });
		s.endSession(out.handle);
		assert.equal(s.lookupSession(out.handle), null, "logout");
	} finally { s.close(); }
});

test("advancing the epoch ends every older session", async () => {
	const s = await DeploymentState.open({ dir: null });
	try {
		const a = s.createSession({ tenantId: "acme", actorKind: "user", actorId: "lea" });
		assert.equal(s.advanceEpoch(), 2);
		assert.equal(s.lookupSession(a.handle), null);
		const b = s.createSession({ tenantId: "acme", actorKind: "user", actorId: "lea" });
		assert.equal(s.lookupSession(b.handle)?.epoch, 2);
	} finally { s.close(); }
});

test("keys: rotations keep each retired generation for its own window; a restore rotation retires all", async () => {
	const c = clock();
	const s = await DeploymentState.open({ dir: null, clock: c.now });
	try {
		const g1 = s.currentKey()!;
		assert.equal(g1.generation, 1);
		assert.equal(g1.secret.length, 32);
		const window = 10 * MIN;
		const g2 = s.rotateKey(window);           // g1 valid until t0 + 10 min
		c.t += 5 * MIN;
		const g3 = s.rotateKey(window);           // g2 valid until t0 + 15 min; g1 keeps its own deadline
		assert.equal(s.currentKey()!.generation, g3.generation);
		assert.ok(s.keyFor(g1.generation, c.now()), "g1 still verifies inside its window");
		assert.ok(s.keyFor(g2.generation, c.now()));
		c.t += 6 * MIN;                            // t0 + 11 min
		assert.equal(s.keyFor(g1.generation, c.now()), undefined, "g1 retired after its window");
		assert.ok(s.keyFor(g2.generation, c.now()), "a second rotation did not cut g2 short");
		const g4 = s.rotateKeyRetiringAll();
		assert.equal(s.keyFor(g2.generation, c.now()), undefined);
		assert.equal(s.keyFor(g3.generation, c.now()), undefined);
		assert.equal(s.keyFor(g4.generation, c.now())?.generation, g4.generation);
		assert.equal(s.keyFor(99, c.now()), undefined);
	} finally { s.close(); }
});

test("the effective time never goes back and jumps wait for review", async () => {
	const c = clock();
	const s = await DeploymentState.open({ dir: null, clock: c.now, maxClockJumpMs: HOUR });
	try {
		const t1 = s.now();
		c.t -= 10 * MIN;
		assert.equal(s.now(), t1, "a clock moved back does not lower the time");
		c.t = t1 + 2 * HOUR;
		assert.throws(() => s.now(), ClockJump);
		assert.throws(() => s.createSession({ tenantId: "acme", actorKind: "user", actorId: "lea" }), ClockJump);
		assert.equal(s.acceptClock(), t1 + 2 * HOUR);
		assert.equal(s.now(), t1 + 2 * HOUR);
		assert.equal(s.timeFloor(), t1 + 2 * HOUR, "accepting persists the floor");
	} finally { s.close(); }
});

test("the login index is a replaceable lookup aid", async () => {
	const s = await DeploymentState.open({ dir: null });
	try {
		s.addLogin("https://id.example", "sub-1", "globex");
		s.addLogin("https://id.example", "sub-1", "acme");
		s.addLogin("https://id.example", "sub-1", "acme");
		assert.deepEqual(s.tenantsFor("https://id.example", "sub-1"), ["acme", "globex"]);
		assert.deepEqual(s.tenantsFor("https://other.example", "sub-1"), []);
		s.replaceLogins([{ issuer: "https://id.example", subject: "sub-2", tenantId: "acme" }]);
		assert.deepEqual(s.tenantsFor("https://id.example", "sub-1"), []);
		assert.deepEqual(s.tenantsFor("https://id.example", "sub-2"), ["acme"]);
	} finally { s.close(); }
});

test("on disk: state survives a restart, handles are stored hashed, the floor holds, one owner, protected keys", async () => {
	const dir = join(scratch(), "state");
	const c = clock(5_000_000);
	try {
		const a = await DeploymentState.open({ dir, clock: c.now });
		const { handle } = a.createSession({ tenantId: "acme", actorKind: "user", actorId: "lea" });
		const g2 = a.rotateKey(MIN);
		a.commitFloor(c.t + 1000);
		a.addLogin("iss", "sub", "acme");
		await assert.rejects(DeploymentState.open({ dir, clock: c.now }), StateUnavailable, "a second owner is refused");
		a.close();

		assert.equal((statSync(join(dir, KEYS_FILE)).mode & 0o777).toString(8), "600");
		const db = new DatabaseSync(join(dir, STATE_FILE), { readOnly: true });
		const rows = db.prepare("SELECT handle_hash FROM sessions").all() as Array<{ handle_hash: string }>;
		db.close();
		assert.equal(rows.length, 1);
		assert.notEqual(rows[0]!.handle_hash, handle, "only the hash of a handle is stored");
		assert.ok(!readFileSync(join(dir, STATE_FILE)).includes(handle), "the handle is nowhere in the file");

		c.t -= HOUR; // the machine's clock went back while the service was down
		const b = await DeploymentState.open({ dir, clock: c.now });
		try {
			assert.ok(b.now() >= 5_001_000, "the durable floor holds across the restart");
			assert.equal(b.lookupSession(handle)?.actorId, "lea");
			assert.equal(b.currentKey()!.generation, g2.generation);
			assert.ok(b.currentKey()!.secret.equals(g2.secret), "the key material survives");
			assert.deepEqual(b.tenantsFor("iss", "sub"), ["acme"]);
		} finally { b.close(); }

		chmodSync(join(dir, KEYS_FILE), 0o644);
		await assert.rejects(DeploymentState.open({ dir, clock: c.now }), /chmod 600/);
		chmodSync(join(dir, KEYS_FILE), 0o600);
		unlinkSync(join(dir, KEYS_FILE));
		await assert.rejects(DeploymentState.open({ dir, clock: c.now }), /lacks the key material/);
	} finally { rmSync(join(dir, ".."), { recursive: true, force: true }); }
});
