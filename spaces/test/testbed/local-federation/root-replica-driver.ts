// The Root's own agent in `run.ts root-replica`, in the `control` container: a write, a resumption or a count through the
// Root, which routes the type Ledger to the replicated Member `r`. Each step prints what it was answered.
import { RemoteSpace, loadFileSigner, socketTransport } from "../../../src/index.ts";
import { IP, PORT } from "./net.ts";

const [step, id, n] = process.argv.slice(2);
const options = { attempts: 1, sleep: () => Promise.resolve(), backoffMs: 1, callTimeoutMs: 30_000 };
const until = async <T>(f: () => Promise<T>, ms = 90_000): Promise<T> => { const end = Date.now() + ms; for (;;) { try { return await f(); } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 500)); } } };
async function agent() {
	const t = socketTransport({ host: IP.control, port: PORT.control }, { localAddress: IP.control });
	await new RemoteSpace(t, { ...options, signer: loadFileSigner("/fed/root-host.json"), expectedGateHostId: "control-host", ownPeerId: "control-peer" }).authenticate();
	return async (method: string, args: Record<string, unknown>) => {
		const r = JSON.parse(await t.request(JSON.stringify({ method, args: { agentId: "worker", ...args } }))) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
		return r.ok ? { result: r.result } : { error: r.error!.code, message: r.error!.message.slice(0, 120) };
	};
}
const root = await until(agent);
const seen: Record<string, unknown> = { step, id };
if (step === "write") seen.answer = await root("rootWrite", { id, entry: { type: "Ledger", fields: { label: id, n: Number(n ?? 0) } }, leaseMs: 600_000 });
else if (step === "resume") seen.answer = await root("rootResume", { id });
else if (step === "count") seen.answer = await root("rootCount", { template: { type: "Ledger" } });
else throw new Error(`unknown step ${step}`);
console.log(JSON.stringify(seen));
process.exit(0);
