import { defineDocFamily } from "./store/documents.ts";
import {canonicalJson} from "./canonical.ts";
// The supervisor of the control space (federation-plan-v3.md 5 and 5.1, AP 1b.5): the only writer of everything in the
// control space except the `Command` entries of admins. This is its first part, the commands that need no router:
//   createEnroll  -> an `Enroll` entry (the plain token never reaches this code, only its hash)
//   revokePeer    -> every active `PeerKey` of the peer becomes `revoked` (the gate then closes the connections that proved it)
// Each command is one commit: the `Command` entry is taken, the effect applied and the `Result` written together, so a crash
// leaves either the command or its result and a repeated `commandId` never acts twice. The command's writer is the owner of the
// entry; it must hold an active admin key in the control space (a paired admin, not "whoever is on this host").
//
// `ControlAccess` is the network side of that rule: on the control space the wire may carry only `Command` writes of admins and
// reads of `Command`, `Result` and `PeerKey`; `Enroll` (token hashes) and `Bootstrap` never leave the host.
import { rotateKeyIn, type RotationChallenge } from "./rotation.ts";
import type { Context } from "./context.ts";
import type { StoreHost } from "./store/types.ts";
import * as core from "./core.ts";
import { NamedSpace, listSpaces, spaceDoc, createSpace } from "./spaces.ts";
import { CONTROL_SPACE, createEnrollIn, hasAdminKey, revokePeerKeysIn } from "./enroll.ts";
import type { Connection, IdentityAdapter, Reply } from "./service.ts";
import type { Json } from "./core.ts";

type Host = Pick<StoreHost, "commit" | "snapshot" | "watchDoc">;

export const COMMAND_KINDS = ["createEnroll", "revokePeer", "rotateKey"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
export const RESULT_RETENTION_MS = 7 * 24 * 3600 * 1000;
export type CommandResult = { commandId: string; kind: string; state: "completed" | "failed"; error?: string; result?: Json; requestedBy: string; at: number };

export type SupervisorOptions = {
	now?: () => number;
	/** Durable remote handlers execute outside Control commits and retain unknown outcomes. */
	asyncCommands?: Record<string,(commandId:string,args:Record<string,Json>,requestedBy:string)=>Promise<Json>>;
	/** Trusted synchronous control-only handlers; remote effects must use the router journal. */
	commands?: Record<string,(tx:import("./store/types.ts").StoreTx,args:Record<string,Json>,requestedBy:string)=>Promise<Json>>;
	/** Called after each processed command (audit): never carries tokens, only ids, kinds and states. */
	onEvent?: (e: { commandId: string; kind: string; state: string; requestedBy: string; error?: string }) => void;
	onError?: (e: unknown) => void;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
/** The owner of an entry is the principal id of its writer (mailbox.ts: canonical JSON [peerId, agentId]); a plain peer id works too. */
const peerOf = (owner: string): string => { try { const v = JSON.parse(owner); if (Array.isArray(v) && typeof v[0] === "string") return v[0]; } catch { /* not JSON */ } return owner.split("/")[0]!; };

const SupervisorJobs=defineDocFamily<{jobs:Record<string,{commandId:string;kind:string;args:Record<string,Json>;requestedBy:string;hash:string}>},null>({kind:"phi-spaces.supervisor-jobs",version:1,scope:"session",family:true,initial:()=>({jobs:{}})});
export class Supervisor {
	private host: Host; private ctx: Context; private o: SupervisorOptions;
	constructor(host: Host, ctx: Context, o: SupervisorOptions = {}) { this.host = host; this.ctx = ctx; this.o = o; }
	private now = () => (this.o.now ?? Date.now)();

	private async controlId(): Promise<string> {
		const known = (await listSpaces(this.host, this.ctx)).find((i) => i.alias === CONTROL_SPACE);
		return (known ?? (await this.host.commit((tx) => createSpace(tx, CONTROL_SPACE, this.now()), this.ctx))).spaceId;
	}

	/** Process every waiting command, oldest first; returns how many. */
	async tick(): Promise<number> {
		const id = await this.controlId();
		let n = await this.resumeJobs(id);
		for (;;) {
			const done = await this.host.commit(async (tx) => {
				const now = this.now();
				const s = await spaceDoc(tx, id, now);
				const next = core.list(s, now, { type: "Command" })[0];
				if (!next) return undefined;
				const taken = core.probe(s, now, { id: next.id }, null, true);
				if (taken.status !== "found") return undefined;
				const f = core.plain(taken.entry.fields) as Record<string, Json>;
				const requestedBy = peerOf(String(taken.entry.owner ?? ""));
				const commandId = str(f.commandId) ?? taken.entry.id;
				const kind = str(f.kind) ?? "?";
				// a command id seen before is a duplicate (the admin's retry): drop it, the first result stands
				if (core.list(s, now, { type: "Result", fields: { commandId } }).length > 0) return { commandId, kind, state: "duplicate", requestedBy };
				const finish = (state: "completed" | "failed", extra: { error?: string; result?: Json }) => {
					const res: CommandResult = { commandId, kind, state, ...extra, requestedBy, at: now };
					core.write(s, now, { type: "Result", fields: res as unknown as core.Fields }, null, RESULT_RETENTION_MS);
					return { commandId, kind, state, requestedBy, ...(extra.error ? { error: extra.error } : {}) };
				};
				if (!requestedBy || (kind !== "rotateKey" && !hasAdminKey(s, now, requestedBy))) return finish("failed", { error: "the writer of this command holds no active admin key" });
				const args = (f.args && typeof f.args === "object" && !Array.isArray(f.args) ? f.args : {}) as Record<string, Json>;
				try {
					if(this.o.asyncCommands?.[kind]) {const jobs=await tx.doc(SupervisorJobs,id,null),hash=canonicalJson([kind,args,requestedBy]);const old=jobs.jobs[commandId];if(old&&old.hash!==hash)throw new core.IllegalArgumentError("command ID changed remote arguments");if(!old&&Object.keys(jobs.jobs).length>=64)throw new core.ResourceExhausted("remote command admission full");jobs.jobs[commandId]={commandId,kind,args:core.plain(args),requestedBy,hash};return {commandId,kind,state:"applying",requestedBy,async:true};}
					if(this.o.commands?.[kind])return finish("completed",{result:await this.o.commands[kind]!(tx,args,requestedBy)});
					if (kind === "rotateKey") return finish("completed", { result: rotateKeyIn(s, now, { challenge: args.challenge as unknown as RotationChallenge, oldSignature: String(args.oldSignature ?? ""), newSignature: String(args.newSignature ?? "") }, requestedBy) });
					if (kind === "createEnroll") {
						const rec = createEnrollIn(s, now, { tokenHash: String(args.tokenHash ?? ""), role: String(args.role ?? ""), allowedPeerId: String(args.allowedPeerId ?? ""), scope: Array.isArray(args.scope) ? (args.scope as string[]) : [], ...(typeof args.ttlMs === "number" ? { ttlMs: args.ttlMs } : {}) });
						return finish("completed", { result: { tokenHash: rec.tokenHash, role: rec.role, allowedPeerId: rec.allowedPeerId, expiresAt: rec.expiresAt } });
					}
					if (kind === "revokePeer") {
						const peerId = str(args.peerId);
						if (!peerId) throw new core.IllegalArgumentError("revokePeer needs a peerId");
						return finish("completed", { result: { peerId, revoked: revokePeerKeysIn(s, now, peerId) } });
					}
					return finish("failed", { error: `unknown command ${kind}` });
				} catch (e) {
					if (e instanceof core.ResourceExhausted || e instanceof core.LimitError) throw e; // Roll back the command and every partial effect.
					return finish("failed", { error: e instanceof Error ? e.message : String(e) });
				}
			}, this.ctx);
			if (!done) return n;
			n++;
			if((done as any).async){await this.resumeJobs(id);return n;}
			try { this.o.onEvent?.(done as { commandId: string; kind: string; state: string; requestedBy: string }); } catch { /* an audit hook must not stop the supervisor */ }
		}
	}

 private async resumeJobs(id:string):Promise<number> {
  const jobs=(await this.host.snapshot(SupervisorJobs,id,this.ctx))?.jobs??{};let n=0;
  for(const job of Object.values(jobs)){const handler=this.o.asyncCommands?.[job.kind];if(!handler)continue;
   const active=await this.host.commit(async tx=>hasAdminKey(await spaceDoc(tx,id,this.now()),this.now(),job.requestedBy),this.ctx);if(!active)continue;
   let result:Json;try{result=await handler(job.commandId,core.plain(job.args),job.requestedBy);}catch{continue;} // no transport error proves a failed effect
   await this.host.commit(async tx=>{const j=await tx.doc(SupervisorJobs,id,null);if(j.jobs[job.commandId]?.hash!==job.hash)throw new core.IllegalArgumentError("remote command binding changed");const s=await spaceDoc(tx,id,this.now());if(!core.list(s,this.now(),{type:"Result",fields:{commandId:job.commandId}}).length)core.write(s,this.now(),{type:"Result",fields:{commandId:job.commandId,kind:job.kind,state:(result as any)?.phase==="failed"?"failed":"completed",requestedBy:job.requestedBy,at:this.now(),result}},null,RESULT_RETENTION_MS);delete j.jobs[job.commandId];},this.ctx);n++;
  }return n;
 }

	/** Process commands as they arrive (a watch on the control space plus a first pass); returns the function that stops it. */
	async start(): Promise<() => Promise<void>> {
		const id = await this.controlId();
		let running = false, again = false, stopped = false, current: Promise<void> = Promise.resolve();
		const run = async () => {
			if (stopped) return;
			if (running) { again = true; return; }
			running = true;
			current = (async () => {
				try { do { again = false; await this.tick(); } while (again && !stopped); }
				catch (e) { (this.o.onError ?? ((x) => console.error("phi-spaces supervisor:", x)))(e); }
				finally { running = false; }
			})();
			await current;
		};
		const watch = await this.host.watchDoc(NamedSpace, id, this.ctx);
		watch?.start(run);
		await run();
		const retry=this.o.asyncCommands?setInterval(()=>{void run();},1000):undefined;
		// Stopping waits for a pass in flight: it must not run on against a store that closes next.
		return async () => { stopped = true; if(retry)clearInterval(retry); await watch?.stop(); await current; };
	}
}

// ---- the wire side: what may touch the control space

export type ControlAccessOptions = {
	/** The same identity adapter the service uses: its roles decide who is an admin right now (layer B included). */
	identity: IdentityAdapter;
	host: Pick<StoreHost, "snapshot">;
	ctx: Context;
};
const READABLE = ["Command", "Result", "PeerKey"];

/** Wraps the service chain: on the control space only admins may write `Command`s, only admins read `Command`, `Result` and `PeerKey`. */
export class ControlAccess {
	private inner: { handle(call: unknown, conn: Connection, ...rest: never[]): Promise<Reply>; handleText(text: string, conn: Connection, maxFrameBytes?: number): Promise<string> };
	private o: ControlAccessOptions;
	private controlId?: string;
	constructor(inner: ControlAccess["inner"], o: ControlAccessOptions) { this.inner = inner; this.o = o; }

	async handleText(text: string, conn: Connection, maxFrameBytes?: number): Promise<string> {
		let call: unknown;
		try { call = JSON.parse(text); } catch { return this.inner.handleText(text, conn, maxFrameBytes); }
		const denied = await this.check(call, conn);
		return denied ? JSON.stringify(denied) : this.inner.handleText(text, conn, maxFrameBytes);
	}
	async handle(call: unknown, conn: Connection): Promise<Reply> { return (await this.check(call, conn)) ?? this.inner.handle(call, conn); }

	private async isControl(space: unknown): Promise<boolean> {
		if (space === CONTROL_SPACE) return true;
		if (typeof space !== "string") return false;
		if (!this.controlId) this.controlId = (await listSpaces(this.o.host, this.o.ctx)).find((i) => i.alias === CONTROL_SPACE)?.spaceId;
		return this.controlId !== undefined && space === this.controlId;
	}
	private async check(call: unknown, conn: Connection): Promise<Reply | undefined> {
		const c = call as { method?: unknown; space?: unknown; args?: Record<string, Json> } | null;
		if (!c || typeof c.method !== "string" || !(await this.isControl(c.space))) return undefined;
		const deny = (message: string): Reply => ({ ok: false, error: { code: "PermissionDenied", message } });
		if (["hello", "generation", "challenge", "prove", "enroll", "enrollStatus", "pollOperation"].includes(c.method)) return undefined; // the pairing and proof paths (their own checks apply)
		const id = await this.o.identity.authenticate(conn);
		const directoryRead = ["read","readAll","count"].includes(c.method) && ["Capability","MemberStatus"].includes(String((c.args?.template as any)?.type));
        if(id && directoryRead && id.roles.some(r=>["host","member","observer","admin","router"].includes(r)) && c.args?.txn == null) return undefined;
        if (!id || !id.roles.includes("admin")) return deny("the control space is for admins who proved their key");
		const a = c.args ?? {};
		switch (c.method) {
			case "write": {
				const type = (a.entry as { type?: unknown } | undefined)?.type;
				return type === "Command" ? undefined : deny("an admin writes only Command entries into the control space");
			}
			case "read": case "readAll": case "count": {
				const t = (a.template as { type?: unknown } | null | undefined)?.type;
				return typeof t === "string" && READABLE.includes(t) ? undefined : deny(`the control space can be read for ${READABLE.join(", ")}`);
			}
			case "cancelOperation": case "lease": return undefined;
			default: return deny(`${c.method} is not available on the control space`);
		}
	}
}
