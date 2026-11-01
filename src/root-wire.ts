// The Root on the wire (docs/rust-portierung.en.md, decision R-D11): the operations of a FederatedSpace for the hosted agents of this
// host. The caller proves an active host key of this very peer; the principal is this peer and the agent it names, never more.
import type { Json } from "./core.ts";
import type { Principal } from "./claims.ts";
import type { FederatedSpace } from "./federated-space.ts";
import type { Reply } from "./service.ts";

export const ROOT_METHODS = ["rootWrite", "rootRead", "rootTake", "rootBegin", "rootFinish", "rootTakeWaiting", "rootReadWaiting", "rootResume", "rootReadAll", "rootCount"] as const;
const CODES = new Set(["FederationPending", "FederationUnavailable", "RoutingConflict", "MemberDrained", "CapacityUnavailable", "NoCapableMember", "MergeTypeNotExclusive", "ResultExpired", "TypeError"]);

export function isRootMethod(m: unknown): boolean { return (ROOT_METHODS as readonly unknown[]).includes(m); }

/** One call of a proven local peer. A refusal of the journal keeps its class as the code, so that a client knows to `rootResume`. */
export async function rootCall(space: Pick<FederatedSpace, "write" | "read" | "take" | "createTransaction" | "finishTransaction" | "takeWaiting" | "readWaiting" | "resume" | "readAll" | "count">, peerId: string, call: { method: string; args?: Record<string, any> }): Promise<Reply> {
	const a = call.args ?? {};
	const principal: Principal = { peerId, ...(typeof a.agentId === "string" ? { agentId: a.agentId } : {}) };
	const q = { id: a.id, principal, ...(a.txn ? { txn: a.txn } : {}) };
	try {
		const result = await (async (): Promise<unknown> => {
			switch (call.method) {
				case "rootWrite": return space.write(a.entry, q, a.leaseMs ?? undefined);
				case "rootRead": return space.read(a.template ?? null, q);
				case "rootTake": return space.take(a.template ?? null, q);
				case "rootBegin": return space.createTransaction(a.member, a.leaseMs, q);
				case "rootFinish": return space.finishTransaction(a.origin, a.action, q);
				case "rootTakeWaiting": return space.takeWaiting(a.template ?? null, a.timeoutMs, a.txnLeaseMs, q);
				case "rootReadWaiting": return space.readWaiting(a.template ?? null, a.timeoutMs, q);
				case "rootResume": return space.resume(a.id);
				case "rootReadAll": return space.readAll(a.template ?? null, principal, { allowPartial: a.allowPartial === true });
				default: return space.count(a.template ?? null, principal, { allowPartial: a.allowPartial === true });
			}
		})();
		return { ok: true, result: (result ?? null) as Json };
	} catch (e) {
		const name = (e as Error).constructor?.name ?? "Error";
		return { ok: false, error: { code: (CODES.has(name) ? (name === "TypeError" ? "BadRequest" : name) : "Unavailable") as never, message: e instanceof Error ? e.message : String(e) } };
	}
}
