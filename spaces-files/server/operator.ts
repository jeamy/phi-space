// The host operator's local interface (docs/zanzibar-agent-filesystem-plan.en.md, section 5, *Host operator
// operations*): a unix socket inside the deployment-state directory, which only the service account can reach (mode
// 700, checked on open), so the OS account is the separate authentication. Its operations are serialized and offer no
// file access: create or resume a tenant with its first administrator and home, list tenants, switch the admission
// mode. Backup, restore and key rotation join it in phase 5.
//
//   node --experimental-strip-types server/operator.ts create-tenant <tenant> <adminId> <homeName> <issuer> <subject>
//   node --experimental-strip-types server/operator.ts tenants | mode normal|maintenance
//   … backup <file> (FILES_BACKUP_KEY) | backup-state <file> | rotate-content-key           (against the running service; FILES_STATE_BACKUP_KEY)
//   … roster-add|roster-remove <tenant> <issuer> <subject> | roster | approve-reconciler <tenant> <issuer> <subject>
//   … mark-reconciled <tenant> | restore-status
//   … new-backup-key <file> | restore <file> | restore-state <file>   (offline: the service stopped)
//   (root: npm --prefix spaces-files run operator -- …; FILES_STATE_DIR names the state directory)
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serveSpace, socketTransport, type SpaceServer } from "phi-spaces";
import type { FilesService } from "./service.ts";
import { checkSocketPath } from "./agent-socket.ts";
import { newBackupKey, readBackupKey } from "./archive.ts";
import { backupData, backupState, restoreData, restoreState } from "./backup.ts";
import { isObj, wireError } from "./wire.ts";

export const OPERATOR_SOCKET = "operator.sock";

export async function serveOperator(svc: FilesService, stateDir: string): Promise<SpaceServer> {
	checkSocketPath(join(stateDir, OPERATOR_SOCKET));
	let chain: Promise<unknown> = Promise.resolve();
	const run = async (msg: unknown) => {
		if (!isObj(msg) || typeof msg.op !== "string") throw Object.assign(new Error("a call is {op, args}"), { code: "invalidInput" });
		const a = isObj(msg.args) ? msg.args : {};
		switch (msg.op) {
			case "createTenant": return svc.createTenant(String(a.tenantId), { actorId: String(a.actorId), homeName: String(a.homeName), issuer: String(a.issuer), subject: String(a.subject) });
			case "tenants": return Promise.all((await svc.tenants()).map(async (t) => ({ tenantId: t, state: await svc.tenantState(t) })));
			case "backupData": return backupData(svc, String(a.file), readBackupKey(String(a.keyFile)));
			case "backupState": return backupState(svc, String(a.file), readBackupKey(String(a.keyFile)));
			case "rosterAdd": svc.state.rosterAdd(String(a.tenantId), String(a.issuer), String(a.subject)); return svc.state.roster(String(a.tenantId));
			case "rosterRemove": svc.state.rosterRemove(String(a.tenantId), String(a.issuer), String(a.subject)); return svc.state.roster(String(a.tenantId));
			case "roster": return svc.state.roster();
			case "approveReconciler": svc.state.approveReconciler(String(a.tenantId), String(a.issuer), String(a.subject)); return { tenantId: a.tenantId, epoch: svc.state.restoreEpoch() };
			case "markReconciled": svc.state.markReconciled(String(a.tenantId)); return { tenantId: a.tenantId, epoch: svc.state.restoreEpoch() };
			case "restoreStatus": return { journal: svc.state.restoreJournal(), mode: svc.state.mode() };
			case "rotateContentKey": return { generation: svc.state.rotateContentKey(), note: "seals nothing until the next state backup" };
			case "setMode": await svc.setMode(a.mode === "maintenance" ? "maintenance" : a.mode === "normal" ? "normal" : (() => { throw Object.assign(new Error("mode is normal or maintenance"), { code: "invalidInput" }); })()); return { mode: svc.state.mode() };
			default: throw Object.assign(new Error("unknown operation"), { code: "invalidInput" });
		}
	};
	return serveSpace({
		handleText: (text) => {
			// one operation at a time, in arrival order
			const p = chain.then(async () => {
				try { return JSON.stringify({ ok: true, value: await run(JSON.parse(text)) ?? null }); }
				catch (e) { return JSON.stringify({ ok: false, error: wireError(e) }); }
			});
			chain = p;
			return p;
		},
	}, { listen: { path: join(stateDir, OPERATOR_SOCKET) }, maxConnections: 4 });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const { ROOT, loadDotEnv } = await import("./env.ts");
	loadDotEnv();
	const stateDir = process.env.FILES_STATE_DIR || join(ROOT, ".local", "state");
	const [cmd, ...rest] = process.argv.slice(2);
	const dataKey = (): string => { const k = process.env.FILES_BACKUP_KEY; if (!k) throw new Error("FILES_BACKUP_KEY names the data backup's key file"); return resolve(k); };
	const stateKey = () => { const k = process.env.FILES_STATE_BACKUP_KEY; if (!k) throw new Error("FILES_STATE_BACKUP_KEY names the state backup's key file"); return resolve(k); };
	if (cmd === "new-backup-key" && rest.length === 1) { newBackupKey(resolve(rest[0])); console.log(`[operator] new backup key ${resolve(rest[0])}`); process.exit(0); }
	if (cmd === "restore" && rest.length === 1) {
		const dataDir = process.env.FILES_DATA_DIR || join(ROOT, ".local", "data");
		const blobDir = process.env.FILES_BLOB_DIR || join(ROOT, ".local", "blobs");
		try { console.log(JSON.stringify(await restoreData(resolve(rest[0]), readBackupKey(dataKey()), { dataDir, stateDir, blobDir }), null, 2)); process.exit(0); }
		catch (e) { console.error(`[operator] restore failed: ${(e as Error).message}`); process.exit(1); }
	}
	if (cmd === "restore-state" && rest.length === 1) {
		const dataDir = process.env.FILES_DATA_DIR || join(ROOT, ".local", "data");
		const blobDir = process.env.FILES_BLOB_DIR || join(ROOT, ".local", "blobs");
		try { console.log(JSON.stringify(await restoreState(resolve(rest[0]), readBackupKey(stateKey()), { dataDir, stateDir, blobDir }), null, 2)); process.exit(0); }
		catch (e) { console.error(`[operator] restore-state failed: ${(e as Error).message}`); process.exit(1); }
	}
	const call = cmd === "create-tenant" && rest.length === 5 ? { op: "createTenant", args: { tenantId: rest[0], actorId: rest[1], homeName: rest[2], issuer: rest[3], subject: rest[4] } }
		: cmd === "tenants" ? { op: "tenants" }
		: cmd === "mode" && rest.length === 1 ? { op: "setMode", args: { mode: rest[0] } }
		: cmd === "backup" && rest.length === 1 ? { op: "backupData", args: { file: resolve(rest[0]), keyFile: dataKey() } }
		: cmd === "backup-state" && rest.length === 1 ? { op: "backupState", args: { file: resolve(rest[0]), keyFile: stateKey() } }
		: cmd === "rotate-content-key" ? { op: "rotateContentKey" }
		: cmd === "roster-add" && rest.length === 3 ? { op: "rosterAdd", args: { tenantId: rest[0], issuer: rest[1], subject: rest[2] } }
		: cmd === "roster-remove" && rest.length === 3 ? { op: "rosterRemove", args: { tenantId: rest[0], issuer: rest[1], subject: rest[2] } }
		: cmd === "roster" ? { op: "roster" }
		: cmd === "approve-reconciler" && rest.length === 3 ? { op: "approveReconciler", args: { tenantId: rest[0], issuer: rest[1], subject: rest[2] } }
		: cmd === "mark-reconciled" && rest.length === 1 ? { op: "markReconciled", args: { tenantId: rest[0] } }
		: cmd === "restore-status" ? { op: "restoreStatus" }
		: null;
	if (!call) {
		console.error("usage: operator.ts create-tenant <tenant> <adminId> <homeName> <issuer> <subject> | tenants | mode normal|maintenance | backup <file> | backup-state <file> | rotate-content-key | roster-add|roster-remove <tenant> <issuer> <subject> | roster | approve-reconciler <tenant> <issuer> <subject> | mark-reconciled <tenant> | restore-status | new-backup-key <file> | restore <file> | restore-state <file>");
		process.exit(2);
	}
	const t = socketTransport({ path: join(stateDir, OPERATOR_SOCKET) });
	try {
		const r = JSON.parse(await t.request(JSON.stringify(call)));
		console.log(JSON.stringify(r.ok ? r.value : r.error, null, 2));
		process.exitCode = r.ok ? 0 : 1;
	} catch (e) {
		console.error(`[operator] the service does not answer at ${join(stateDir, OPERATOR_SOCKET)}: ${(e as Error).message}`);
		process.exitCode = 1;
	} finally { t.close(); }
}
