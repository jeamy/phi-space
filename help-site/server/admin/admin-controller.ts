// Login-protected AdminSpaces controller for https://spaces.eibrain.org.
// Mirrors the full capabilities of `pi-termux-mobile` (`spaces.html` + `steuerung.html` / `spaces-mobile.mjs`):
//   - Authentication via password (scryptSync + timingSafeEqual) or one-time enrollment token
//   - Session management with HttpOnly cookie + CSRF token + rate limiting
//   - Pre-persisted `commandId` (`w-<kind>-<hex>`) so retries/reloads never trigger duplicate execution
//   - Key rotation, QR/Token enrollment (`enrollQr`) for pairing mobile phones, and peer revocation
//   - Space lifecycle (`createSpace`, `archiveSpace`, `reactivateSpace`, `deleteSpace`) & object inspection
//   - Run control (`RunController` + `RunGate`: start, pause, resume, stop, schedule, export, preview)
//   - Worker scaling (`WorkerAssignments` + `WorkerSupervisor`: `listWorkers`, `setWorkers`)
//   - Deployment planning/export (`DeploymentController`)
//   - Live alerts (`collectAlerts`) and audit log (`auditLog`)

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, generateKeyPairSync, randomBytes, scryptSync, sign, timingSafeEqual } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { availableParallelism, freemem, totalmem } from "node:os";
import type { Context } from "@earendil-works/chord";
import {
	auditLog,
	CapabilityDirectory,
	collectAlerts,
	CONTROL_SPACE,
	core,
	createSpace,
	DeploymentController,
	enrollQr,
	FOREVER,
	hashToken,
	listSpaces,
	localRunMember,
	Meter,
	newEnrollToken,
	PiSpaces,
	RunController,
	snapshotSpace,
	SpaceLifecycle,
	type SpaceHost,
	WorkerAssignments,
	WorkerSupervisor,
	startWorkerSupervisor,
	spaceDoc,
	canonicalJson,
	type WorkerKind,
} from "../../../src/index.ts";
import {
	configureGatedSieveSpace,
	normalizeSieveRunConfig,
	prepareSieveRun,
	SIEVE_EXPORTER,
	SIEVE_WORKER_KIND,
} from "../../../examples/sieve.ts";
import { SpaceChatEngine } from "../../examples/shared/chat-core.ts";

export interface AdminSessionInfo {
	sessionId: string;
	csrfToken: string;
	username: string;
	peerId: string;
	keyId: string;
	algorithm: string;
	publicKey: string;
	controlHostId: string;
	controlSpaceId: string;
	createdAt: number;
	expiresAt: number;
}

export interface StoredAdminOperation {
	commandId: string;
	kind: string;
	args: Record<string, unknown>;
	at: number;
	state: "sending" | "sent" | "completed" | "failed" | "duplicate" | "needsReview";
	done?: number;
	result?: unknown;
	error?: string;
	requestedBy?: string;
}

export const WebAdminState = defineDoc<{
	keys: Record<string, { pem: string; publicKey: string; keyId: string }>;
	operations: Record<string, string>;
}>({ kind: "pi-spaces.help-web-admin", version: 1, scope: "session", initial: () => ({ keys: {}, operations: {} }) });

function freshKey(keyId: string) {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return { keyId, pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64") };
}
function loadKey(k: ReturnType<typeof freshKey>) {
	const privateKey = createPrivateKey(k.pem);
	return { publicKey: k.publicKey, signer: { keyId: k.keyId, algorithm: "ed25519" as const, publicKey: k.publicKey, sign: (data: Uint8Array) => sign(null, Buffer.from(data), privateKey) } };
}

function revokeAdminKeys(s: core.SpaceState, keep?: string): void {
	for (const e of core.list(s, Date.now(), { type: "PeerKey", fields: { peerId: "web-admin-eibrain", state: "active" } })) {
		if (e.fields.keyId === keep) continue;
		if (core.probe(s, Date.now(), { id: e.id }, null, true).status !== "found") throw new Error("Admin key is reserved");
		core.write(s, Date.now(), { type: "PeerKey", fields: { ...e.fields, state: "revoked" } }, null, FOREVER);
	}
}

export class WebAdminController {
	readonly host: SpaceHost;
	readonly ctx: Context;
	readonly meter: Meter;
	readonly authorityId = "authority-eibrain-main";
	readonly controlHostId = "host-coordinator-eibrain";
	controlSpaceId!: string;
	defaultSieveSpaceId!: string;

	#passwordSalt = randomBytes(16);
	#passwordHash: Buffer;
	#sessions = new Map<string, AdminSessionInfo>();
	#loginAttempts = new Map<string, { count: number; resetAt: number }>();
	#adminKey!: ReturnType<typeof loadKey>;
	#controlKey!: ReturnType<typeof loadKey>;
	#operations = new Map<string, StoredAdminOperation>();
	#capTimer: ReturnType<typeof setInterval> | null = null;
	#stopWorkers?: () => Promise<void>;
	#maintenance: Promise<void> = Promise.resolve();
	#maintenanceTimer?: ReturnType<typeof setTimeout>;
	#closed = false;
	maintenanceError?: string;
	#inflight = new Map<string, Promise<{ operation: StoredAdminOperation; result: unknown }>>();
	#commandTail: Promise<unknown> = Promise.resolve();
	#journalKey!: Buffer;
	#encode(op: StoredAdminOperation): string {
		const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#journalKey, nonce);
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(op), "utf8"), cipher.final()]);
		return "v1:" + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
	}
	#decode(value: string): StoredAdminOperation {
		if (!value.startsWith("v1:")) return JSON.parse(value) as StoredAdminOperation;
		const data = Buffer.from(value.slice(3), "base64"), decipher = createDecipheriv("aes-256-gcm", this.#journalKey, data.subarray(0, 12));
		decipher.setAuthTag(data.subarray(12, 28));
		return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8")) as StoredAdminOperation;
	}

	lifecycle!: SpaceLifecycle;
	workerAssignments!: WorkerAssignments;
	workerSupervisor!: WorkerSupervisor;
	runController!: RunController;
	deploymentController!: DeploymentController;

	constructor(options: {
		host: SpaceHost;
		ctx: Context;
		meter: Meter;
		adminPassword?: string;
	}) {
		this.host = options.host;
		this.ctx = options.ctx;
		this.meter = options.meter;
		// With no configured password, admin login is disabled (random unadvertised secret).
		const pwd = options.adminPassword ?? process.env.PI_SPACES_ADMIN_PASSWORD ?? randomBytes(32).toString("hex");
		this.#passwordHash = scryptSync(pwd, this.#passwordSalt, 64);
	}

	async initialize(): Promise<void> {
		const persisted = await this.host.commit(async tx => {
			const d = await tx.doc(WebAdminState);
			d.keys.admin ??= freshKey(`web-admin-${randomBytes(12).toString("hex")}`);
			d.keys.control ??= freshKey(`control-${randomBytes(12).toString("hex")}`);
			return JSON.parse(JSON.stringify(d)) as { keys: Record<string, ReturnType<typeof freshKey>>; operations: Record<string, string> };
		}, this.ctx);
		this.#adminKey = loadKey(persisted.keys.admin!);
		this.#controlKey = loadKey(persisted.keys.control!);
		this.#journalKey = createHash("sha256").update(persisted.keys.control!.pem).digest();
		this.#operations = new Map(Object.entries(persisted.operations).map(([id, json]) => [id, this.#decode(json)]));
		for (const op of this.#operations.values()) if (op.state === "sending") { op.state = "needsReview"; op.error = "Interrupted command requires review; its effect may already exist"; }
		this.controlSpaceId = (
			await this.host.commit((tx) => createSpace(tx, CONTROL_SPACE, Date.now()), this.ctx)
		).spaceId;
		this.defaultSieveSpaceId = (
			await this.host.commit((tx) => createSpace(tx, "sieve-main", Date.now()), this.ctx)
		).spaceId;
		await configureGatedSieveSpace(this.host, this.defaultSieveSpaceId);

		// Register initial admin PeerKey in CONTROL_SPACE
		const controlSpace = new PiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, {
			space: this.controlSpaceId,
		});
		await this.host.commit(async tx => {
		const s = await spaceDoc(tx, this.controlSpaceId, Date.now());
		revokeAdminKeys(s, this.#adminKey.signer.keyId);
		if (!s.entries.some(e => e.type === "PeerKey" && e.fields.peerId === "web-admin-eibrain" && e.fields.keyId === this.#adminKey.signer.keyId && e.fields.state === "active")) core.write(s, Date.now(),
			{
				type: "PeerKey",
				fields: {
					peerId: "web-admin-eibrain",
					principal: "web-admin-eibrain",
					keyId: this.#adminKey.signer.keyId,
					state: "active",
					roles: ["admin", "member", "host"],
					scope: ["*"],
					algorithm: this.#adminKey.signer.algorithm,
					publicKey: this.#adminKey.publicKey,
				},
			},
			null,
			FOREVER,
		);
		}, this.ctx);

		// Rebuild the idempotency map from durable Result entries: a retried commandId after
		// a restart resolves to the recorded outcome instead of silently re-executing.
		for (const e of await controlSpace.readAll({ type: "Result" })) {
			const f = e.fields as { commandId?: string; kind?: string; state?: string; at?: number; error?: string };
			if (!f.commandId || this.#operations.has(f.commandId)) continue;
			this.#operations.set(f.commandId, {
				commandId: f.commandId,
				kind: String(f.kind ?? ""),
				args: {},
				at: Number(f.at ?? 0),
				state: "failed",
				error: "Legacy result has no recoverable payload; review before issuing a new command",
				done: Number(f.at ?? 0),
				...(f.error ? { error: f.error } : {}),
			});
		}

		this.lifecycle = new SpaceLifecycle({
			host: this.host,
			ctx: this.ctx,
			now: Date.now,
		});

		this.workerAssignments = new WorkerAssignments({
			host: this.host,
			ctx: this.ctx,
			authorityId: this.authorityId,
			peerId: this.controlHostId,
			signer: this.#controlKey.signer,
			identity: async () => ({ incarnation: "inc-eibrain-1" }),
		});

		const chatWorkerKind: WorkerKind = {
			step: async ({ space }) => {
				const eng = new SpaceChatEngine(space);
				const msg = await eng.processNextChatTask({ timeoutMs: 25 });
				return msg !== null;
			},
		};
		const searchSubagentKind: WorkerKind = {
			step: async ({ space }) => {
				const eng = new SpaceChatEngine(space);
				const res = await eng.processNextSearchTask(25);
				return res !== null;
			},
		};

		this.workerSupervisor = new WorkerSupervisor({
			host: this.host,
			ctx: this.ctx,
			hostId: this.controlHostId,
			authorityId: this.authorityId,
			controllerPin: {
				issuer: this.controlHostId,
				algorithm: this.#controlKey.signer.algorithm,
				publicKey: this.#controlKey.publicKey,
			},
			kinds: {
				"chat-worker": chatWorkerKind,
				"search-subagent": searchSubagentKind,
				sieve: SIEVE_WORKER_KIND,
			},
			fetch: () => this.workerAssignments.forHost(this.controlHostId),
		});

		this.runController = new RunController({
			host: this.host,
			ctx: this.ctx,
			member: (spaceId: string) =>
				localRunMember(this.host, this.ctx, spaceId, async (run, sp) => {
					if (run.kind === "sieve") {
						await configureGatedSieveSpace(this.host, sp);
						await prepareSieveRun(
							this.host,
							normalizeSieveRunConfig(run.runId, run.config as Record<string, unknown> | undefined),
							{ space: sp },
						);
					}
				}),
			space: (spaceId: string) =>
				new PiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, { space: spaceId }),
			exporters: {
				sieve: SIEVE_EXPORTER,
			},
		});

		this.deploymentController = new DeploymentController({
			host: this.host,
			ctx: this.ctx,
			ports: {
				hostStatus: async () => ({ fresh: true, at: Date.now() }),
				createSpace: async (commandId, args) => {
					const created = await this.lifecycle.apply({
						commandId,
						action: "create",
						alias: String(args.alias),
						...(args.limits ? { limits: args.limits as any } : {}),
						...(args.profiles ? { profiles: args.profiles as any } : {}),
					});
					const sp = new PiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, {
						space: created.spaceId,
					});
					await new SpaceChatEngine(sp).installProfilesIfSupported();
					return created as any;
				},
				workers: this.workerAssignments,
				controlSpaceId: this.controlSpaceId,
			},
			now: Date.now,
		});
		await this.deploymentController.bindHost("host-a", this.controlHostId);

		// Capability heartbeat into the control space – metrics.workers carries the local
		// supervisor summary, so appliedWorkers/alerts see this host as reporting (lease 120s).
		const directory = new CapabilityDirectory({
			host: this.host,
			ctx: this.ctx,
			spaceId: this.controlSpaceId,
			assertAuthority: async () => {},
		});
		const beat = async () => {
			await directory.heartbeat(
				{
					hostId: this.controlHostId,
					resources: { memoryBytes: totalmem(), cpus: availableParallelism() },
					tools: ["chat-worker", "search-subagent", "sieve"],
					models: [],
					metrics: { freeMemoryBytes: freemem(), workers: this.workerSupervisor.summary() as unknown as core.Json },
				},
				{ peerId: this.controlHostId, roles: ["host"] },
			);
		};
		void beat().catch(() => {});
		this.#capTimer = setInterval(() => void beat().catch(() => {}), 30_000);
		await this.workerSupervisor.reconcile();
		this.#stopWorkers = startWorkerSupervisor(this.workerSupervisor, { intervalMs: 1_000, onError: e => { this.maintenanceError = String(e); } });
		const advance = () => {
			this.#maintenance = (async () => {
				try {
					const errors: string[] = [];
					for (const id of await this.runController.pending()) { try { await this.runController.advance(id); } catch (e) { errors.push(`${id}: ${String(e)}`); } }
					this.maintenanceError = errors.length ? errors.join("; ") : undefined;
				}
				catch (e) { this.maintenanceError = String(e); }
				if (!this.#closed) this.#maintenanceTimer = setTimeout(advance, 250);
			})();
		};
		advance();
	}

	async close(): Promise<void> {
		this.#closed = true;
		if (this.#maintenanceTimer) clearTimeout(this.#maintenanceTimer);
		if (this.#capTimer) clearInterval(this.#capTimer);
		await this.#maintenance;
		await this.#commandTail.catch(() => {});
		await this.#stopWorkers?.();
		await this.workerSupervisor?.stop();
	}

	// ---- Authentication & Sessions ----

	checkRateLimit(ip: string): boolean {
		const now = Date.now();
		const entry = this.#loginAttempts.get(ip);
		for (const [key, value] of this.#loginAttempts) if (value.resetAt <= now) this.#loginAttempts.delete(key);
		if (!entry && this.#loginAttempts.size >= 1024) return false;
		if (!entry || entry.resetAt <= now) {
			this.#loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
			return true;
		}
		entry.count += 1;
		return entry.count <= 15;
	}

	login(input: { username?: string; password?: string; enrollToken?: string; ip?: string }): AdminSessionInfo {
		if (!this.checkRateLimit(input.ip ?? "local")) {
			throw new core.PermissionError("Too many login attempts; please wait 60 seconds.");
		}
		let authenticated = false;
		// Peer enrollment never grants a web admin session. Web login uses its configured password.
		if (!input.enrollToken && typeof input.password === "string" && input.password.length > 0) {
			const candidate = scryptSync(input.password, this.#passwordSalt, 64);
			if (timingSafeEqual(candidate, this.#passwordHash)) {
				authenticated = true;
			}
		}
		if (!authenticated) {
			throw new core.PermissionError("Ungültige Zugangsdaten oder abgelaufenes Enrollment-Token.");
		}

		const sessionId = randomBytes(24).toString("hex");
		const csrfToken = randomBytes(16).toString("hex");
		const now = Date.now();
		const session: AdminSessionInfo = {
			sessionId,
			csrfToken,
			username: input.username?.trim() || "admin@spaces.eibrain.org",
			peerId: "web-admin-eibrain",
			keyId: this.#adminKey.signer.keyId,
			algorithm: this.#adminKey.signer.algorithm,
			publicKey: this.#adminKey.publicKey,
			controlHostId: this.controlHostId,
			controlSpaceId: this.controlSpaceId,
			createdAt: now,
			expiresAt: now + 12 * 3600_000,
		};
		this.#sessions.set(sessionId, session);
		for (const [id, value] of this.#sessions) if (value.expiresAt <= now) this.#sessions.delete(id);
		if (this.#sessions.size > 256) this.#sessions.delete(this.#sessions.keys().next().value!);
		return session;
	}

	/** Password-only check for non-HTTP surfaces (e.g. the swarm feed websocket). */
	verifyPassword(password: string, ip = "ws-feed"): boolean {
		if (!password || !this.checkRateLimit(ip)) return false;
		try {
			return timingSafeEqual(scryptSync(password, this.#passwordSalt, 64), this.#passwordHash);
		} catch {
			return false;
		}
	}

	getSession(sessionId: string | undefined): AdminSessionInfo | null {
		if (!sessionId) return null;
		const s = this.#sessions.get(sessionId);
		if (!s) return null;
		if (s.expiresAt <= Date.now()) {
			this.#sessions.delete(sessionId);
			return null;
		}
		return s;
	}

	logout(sessionId: string | undefined): void {
		if (sessionId) this.#sessions.delete(sessionId);
	}

	// ---- Admin Operations (1:1 with MobileSpaces in pi-termux-mobile) ----

	async overview() {
		const spacesList = await listSpaces(this.host, this.ctx);
		const spacesWithStats = await Promise.all(
			spacesList.map(async (info) => {
				const snap = await snapshotSpace(this.host, info.spaceId, this.ctx);
				return {
					...info,
					archived: Boolean(snap?.archived),
					stats: snap ? core.stats(snap, Date.now()) : null,
				};
			}),
		);
		const runs = await this.runController.list(50);
		// Live progress per run: the registered exporter (sieve) counts durable results in
		// the member space; runs without an exporter simply have no progress field.
		await Promise.all(
			runs.map(async (r: Record<string, unknown>) => {
				try {
					r.progress = await this.runController.export(String(r.runId));
				} catch {
					// no exporter for this kind, or member space unreachable
				}
			}),
		);
		const workerList = await this.workerAssignments.list();
		const supervisorSummary = this.workerSupervisor.summary();
		const alerts = await collectAlerts({
			runs: this.runController,
			workers: this.workerAssignments,
			host: this.host,
			ctx: this.ctx,
			controlSpaceId: this.controlSpaceId,
			now: Date.now,
		});
		const audit = await auditLog(this.host, this.ctx, this.controlSpaceId, { limit: 50 });
		const operations = [...this.#operations.values()].sort((a, b) => b.at - a.at);

		return {
			maintenanceError: this.maintenanceError ?? null,
			profile: {
				peerId: "web-admin-eibrain",
				controlHostId: this.controlHostId,
				controlSpaceId: this.controlSpaceId,
				defaultSieveSpaceId: this.defaultSieveSpaceId,
				keyId: this.#adminKey.signer.keyId,
				algorithm: this.#adminKey.signer.algorithm,
				publicKey: this.#adminKey.publicKey,
				state: "paired",
			},
			spaces: spacesWithStats,
			runs,
			workers: {
				desired: workerList.assignments,
				generation: workerList.generation,
				supervisor: supervisorSummary,
			},
			alerts,
			audit,
			operations,
		};
	}

	async inspectSpaceObjects(spaceIdOrAlias: string, limit = 100) {
		const sp = new PiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, {
			space: spaceIdOrAlias,
		});
		const stats = await sp.stats();
		const objects = await sp.readAll(null, { limit: Math.min(200, Math.max(1, limit)) });
		const allSpaces = await listSpaces(this.host, this.ctx);
		const info = allSpaces.find((i) => i.spaceId === spaceIdOrAlias || i.alias === spaceIdOrAlias) ?? null;
		return { info, stats, objects };
	}

	executeCommand(input: {
		commandId?: string; kind: string; args?: Record<string, unknown>; requestedBy: string;
	}): Promise<{ operation: StoredAdminOperation; result: unknown }> {
		const commandId = input.commandId?.trim() || `w-${input.kind}-${randomBytes(12).toString("hex")}`;
		const args = JSON.parse(JSON.stringify(input.args ?? {}));
		const same = (op: StoredAdminOperation) => op.kind === input.kind && canonicalJson(op.args as core.Json) === canonicalJson(args) && op.requestedBy === input.requestedBy;
		const existing = this.#operations.get(commandId);
		if (existing && !same(existing)) return Promise.reject(new Error("Command ID reused with different arguments or principal"));
		const running = this.#inflight.get(commandId);
		if (running) return running;
		// Publish identity synchronously, before another caller can enqueue the same ID.
		if (!existing) this.#operations.set(commandId, { commandId, kind: input.kind, args, requestedBy: input.requestedBy, at: Date.now(), state: "sending" });
		const p = this.#commandTail.catch(() => {}).then(() => this.#executeCommand({ ...input, args, commandId }));
		this.#commandTail = p;
		this.#inflight.set(commandId, p);
		void p.finally(() => this.#inflight.delete(commandId)).catch(() => {});
		return p;
	}

	async #executeCommand(input: {
		commandId?: string;
		kind: string;
		args?: Record<string, unknown>;
		requestedBy: string;
	}): Promise<{ operation: StoredAdminOperation; result: unknown }> {
		const args = input.args ?? {};
		const commandId =
			input.commandId && input.commandId.trim()
				? input.commandId.trim()
				: `w-${input.kind}-${randomBytes(6).toString("hex")}`;

		// Pre-persist operation before executing (same idempotent guarantee as spaces-mobile.mjs)
		const existing = this.#operations.get(commandId);
		if (existing && (existing.state === "completed" || existing.state === "duplicate")) {
			return { operation: existing, result: existing.result };
		}
		if (existing?.state === "failed" || existing?.state === "needsReview") throw new Error(existing.error ?? "Command failed; use a new command ID after review");

		const op: StoredAdminOperation = existing ?? {
			commandId,
			kind: input.kind,
			args,
			at: Date.now(),
			state: "sending",
		};
		this.#operations.set(commandId, op);
		const admitted = await this.host.commit(async tx => {
			const d = await tx.doc(WebAdminState);
			const prior = d.operations[commandId] ? this.#decode(d.operations[commandId]!) : undefined;
			if (prior) {
				if (prior.kind !== input.kind || prior.requestedBy !== input.requestedBy || canonicalJson(prior.args as core.Json) !== canonicalJson(args as core.Json)) throw new Error("Command ID reused with different arguments or principal");
				return prior;
			}
			d.operations[commandId] = this.#encode(op);
			return null;
		}, this.ctx);
		if (admitted) {
			this.#operations.set(commandId, admitted);
			if (admitted.state === "completed" || admitted.state === "duplicate") return { operation: admitted, result: admitted.result };
			throw new Error(admitted.error ?? "Interrupted command requires review; its effect may already exist");
		}

		const controlSpace = new PiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, {
			space: this.controlSpaceId,
		});

		try {
			let result: unknown;
			switch (input.kind) {
				case "createEnroll": {
					const peerId = String(args.peerId ?? "mobile-admin-phone");
					const role = String(args.role ?? "admin");
					const endpoint = String(args.endpoint ?? "tcp://100.64.0.10:9440");
					const token = newEnrollToken();
					const qr = enrollQr({
						endpoint,
						controlSpaceId: this.controlSpaceId,
						token,
					});
					result = { peerId, role, endpoint, token, qrPayload: qr };
					await this.host.commit(async tx => {
					const s = await spaceDoc(tx, this.controlSpaceId, Date.now());
					core.write(s, Date.now(),
						{
							type: "Enroll",
							fields: {
								tokenHash: hashToken(token),
								role,
								allowedPeerId: peerId,
								scope: ["*"],
							},
						},
						null,
						600_000,
					);
					const d = await tx.doc(WebAdminState);
					d.operations[commandId] = this.#encode({ ...op, state: "completed", done: Date.now(), result });
					}, this.ctx);
					break;
				}
				case "rotateKey": {
					const oldKeyId = this.#adminKey.signer.keyId;
					const saved = freshKey(`web-admin-${randomBytes(12).toString("hex")}`);
					const nextKey = loadKey(saved);
					result = { oldKeyId, newKeyId: saved.keyId, publicKey: saved.publicKey, state: "completed" };
					await this.host.commit(async tx => {
					const s = await spaceDoc(tx, this.controlSpaceId, Date.now());
					revokeAdminKeys(s);
					core.write(s, Date.now(),
						{
							type: "PeerKey",
							fields: {
								peerId: "web-admin-eibrain",
								principal: "web-admin-eibrain",
								keyId: nextKey.signer.keyId,
								state: "active",
								roles: ["admin", "member", "host"],
								scope: ["*"],
								algorithm: nextKey.signer.algorithm,
								publicKey: nextKey.publicKey,
							},
						},
						null,
						FOREVER,
					);
					const d = await tx.doc(WebAdminState);
					d.keys.admin = saved;
						d.operations[commandId] = this.#encode({ ...op, state: "completed", done: Date.now(), result });
					}, this.ctx);
					this.#adminKey = nextKey;
					break;
				}
				case "createSpace": {
					const alias = String(args.alias ?? "").trim();
					result = await this.lifecycle.apply({
						commandId,
						action: "create",
						alias,
					});
					const sp = new PiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, {
						space: (result as any).spaceId,
					});
					await new SpaceChatEngine(sp).installProfilesIfSupported();
					break;
				}
				case "archiveSpace":
				case "reactivateSpace":
				case "deleteSpace": {
					const actionMap = {
						archiveSpace: "archive" as const,
						reactivateSpace: "reactivate" as const,
						deleteSpace: "delete" as const,
					};
					result = await this.lifecycle.apply({
						commandId,
						action: actionMap[input.kind],
						spaceId: String(args.spaceId ?? ""),
					});
					break;
				}
				case "setWorkers": {
					const assignmentId = String(args.assignmentId ?? "assign-chat-default");
					const hostId = String(args.hostId ?? this.controlHostId);
					const kind = String(args.kind ?? "chat-worker");
					const targetSpace = String(args.targetSpace ?? "default");
					const count = Number(args.count ?? 1);
					const runId = args.runId ? String(args.runId) : undefined;
					await this.workerAssignments.set(commandId, {
						assignmentId,
						hostId,
						kind,
						targetSpace,
						count,
						...(runId ? { runId } : {}),
					});
					const summary = await this.workerSupervisor.reconcile();
					result = { assignmentId, count, targetSpace, kind, supervisor: summary };
					break;
				}
				case "listWorkers": {
					result = {
						desired: (await this.workerAssignments.list()).assignments,
						supervisor: this.workerSupervisor.summary(),
					};
					break;
				}
				case "startRun": {
					const runId = String(args.runId ?? `sieve-${commandId}`);
					const start = Number(args.start ?? 1);
					const end = Number(args.end ?? 1001);
					const blockSize = Number(args.blockSize ?? 128);
					const membersRaw = args.members;
					const members = Array.isArray(membersRaw)
						? membersRaw.map(String)
						: String(membersRaw || this.defaultSieveSpaceId)
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean);
					result = await this.runController.start(commandId, {
						runId,
						kind: "sieve",
						members,
						config: { start, end, blockSize },
					});
					// Sieve workers are bound to a runId – provision a small crew automatically so
					// a started run actually progresses instead of idling at 0/expected forever.
					if (members[0]) {
						try {
							await this.workerAssignments.set(`${commandId}-workers`, {
								assignmentId: `run-${runId}`,
								hostId: this.controlHostId,
								kind: "sieve",
								targetSpace: members[0],
								count: Math.max(1, Math.min(64, Math.round(Number(args.workers ?? 2)))),
								runId,
							});
							await this.workerSupervisor.reconcile();
						} catch {
							// worker provisioning is best-effort – the run exists regardless
						}
					}
					break;
				}
				case "pauseRun": {
					result = await this.runController.pause(commandId, String(args.runId ?? ""));
					break;
				}
				case "resumeRun": {
					result = await this.runController.resume(commandId, String(args.runId ?? ""));
					break;
				}
				case "stopRun": {
					const stopRunId = String(args.runId ?? "");
					if (args.dryRun) {
						result = await this.runController.preview("stop", stopRunId);
					} else {
						result = await this.runController.stop(commandId, stopRunId);
						// Release the auto-provisioned sieve crew with the run.
						try {
							const a = (await this.workerAssignments.list()).assignments.find((x) => x.assignmentId === `run-${stopRunId}`);
							if (a) {
								await this.workerAssignments.set(`${commandId}-workers`, {
									assignmentId: a.assignmentId,
									hostId: a.hostId,
									kind: a.kind,
									targetSpace: a.targetSpace,
									count: 0,
									...(a.runId ? { runId: a.runId } : {}),
								});
								await this.workerSupervisor.reconcile();
							}
						} catch {
							// best-effort
						}
					}
					break;
				}
				case "scheduleRun": {
					const runId = String(args.runId ?? "");
					const scheduleKind = args.scheduleKind === "resume" ? "resume" : "pause";
					const delayMs = Number(args.delayMs ?? 60_000);
					result = await this.runController.schedule(commandId, runId, {
						kind: scheduleKind,
						at: op.at + delayMs,
					});
					break;
				}
				case "exportRun": {
					result = await this.runController.export(String(args.runId ?? ""));
					break;
				}
				case "listRuns": {
					result = await this.runController.list(50);
					break;
				}
				case "listAlerts": {
					result = await collectAlerts({
						runs: this.runController,
						workers: this.workerAssignments,
						host: this.host,
						ctx: this.ctx,
						controlSpaceId: this.controlSpaceId,
						now: Date.now,
					});
					break;
				}
				case "auditLog": {
					result = await auditLog(this.host, this.ctx, this.controlSpaceId, { limit: 100 });
					break;
				}
				case "planDeployment": {
					const cfg = typeof args.config === "string" ? JSON.parse(args.config) : args.config;
					result = await this.deploymentController.plan(cfg);
					break;
				}
				case "applyDeployment": {
					const cfg = typeof args.config === "string" ? JSON.parse(args.config) : args.config;
					result = await this.deploymentController.apply(cfg);
					break;
				}
				case "startWorkers": {
					const depName = String(args.deployment ?? "chat-cluster-demo");
					result = await this.deploymentController.startWorkers(commandId, depName);
					await this.workerSupervisor.reconcile();
					break;
				}
				case "exportDeployment": {
					result = await this.deploymentController.export(args.deployment ? String(args.deployment) : undefined as any);
					break;
				}
				default:
					throw new core.IllegalArgumentError(`Unsupported admin command kind: ${input.kind}`);
			}

			op.state = "completed";
			op.done = Date.now();
			op.result = result;

			await this.host.commit(async tx => { (await tx.doc(WebAdminState)).operations[commandId] = this.#encode(op); }, this.ctx);
			await controlSpace.write(
				{
					type: "Result",
					fields: {
						commandId,
						kind: input.kind,
						args: args as core.Json,
						state: "completed",
						requestedBy: input.requestedBy,
						at: op.done,
					},
				},
				null,
				FOREVER,
			).catch(e => { this.maintenanceError = `Command completed; audit publication pending: ${String(e)}`; });

			return { operation: op, result };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			op.state = "failed";
			op.done = Date.now();
			op.error = msg;
			const recorded = await this.host.commit(async tx => {
				const d = await tx.doc(WebAdminState);
				// Never overwrite an atomically completed enrollment/rotation with an audit-write failure.
				const saved = d.operations[commandId] ? this.#decode(d.operations[commandId]!) : undefined;
				if (saved?.state === "completed") return saved;
				d.operations[commandId] = this.#encode(op);
				return null;
			}, this.ctx);
			if (recorded) { this.#operations.set(commandId, recorded); return { operation: recorded, result: recorded.result }; }
			await controlSpace.write(
				{
					type: "Result",
					fields: {
						commandId,
						kind: input.kind,
						state: "failed",
						requestedBy: input.requestedBy,
						at: op.done,
						error: msg,
					},
				},
				null,
				FOREVER,
			);
			throw err;
		}
	}
}
