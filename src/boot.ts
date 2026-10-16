import {readRegisterRecords} from './recovery-register.ts';
import {checkErasureBarrier,validateErasureBarrier} from './erasure-barrier.ts';
// Boot fencing for every touched space. The external record and local installation are never restored with a space snapshot.
import { canonicalJson } from "./canonical.ts";
import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { RecoveryRegister } from "./recovery-register.ts";
import { Space } from "./doc.ts";
import { NamedSpace } from "./spaces.ts";
import type { Json, SpaceState } from "./core.ts";
import type { PrimarySyncConfig } from "./primary-sync.ts";

export type SpaceBootPermit = { erasureEpoch?:number; state: "active" | "revoked"; authorityId: string; dataIncarnation: string; role: "local" | "primary" | "standby" | "entryReplica"; primaryEpoch?: number; replicaConfigVersion?: number; durability?: "single" | "sync"; transitionId: string; authorityMarker?: boolean };
export type HostBootState = { hostId: string; state: "active" | "fenced" | "quarantine"; spaces: Record<string, SpaceBootPermit> };
export class BootBlocked extends Error {}
/**
 * A primary/sync Space admits work only as the primary of its current replica configuration: role, epoch, version
 * and durability of the permit equal the journal configuration. A standby never answers business calls.
 */
function replicaMismatch(hostId: string, permit: SpaceBootPermit, config: PrimarySyncConfig | null | undefined): string | null {
	if (permit.role === "standby") return "a standby permit admits no business work";
	if (!config) return null;
	if (permit.role !== "primary" || config.primaryReplica !== hostId) return "this host is not the primary of the replica configuration";
	if (permit.authorityId !== config.authorityId || permit.primaryEpoch !== config.primaryEpoch || permit.replicaConfigVersion !== config.replicaConfigVersion || permit.durability !== (config.durability ?? "sync")) return "boot permit disagrees with the local replica configuration";
	return null;
}
/** Guard a host once, after explicitly initializing/registering its spaces and installing their permits. */
export function installBootGuard(host: Harness, ctx: Context, o: { hostId: string; authorityId: string; external: RecoveryRegister; installed: RecoveryRegister;now?:()=>number; /** current replica configuration of a primary/sync Space (its journal), null for other Spaces */ replicaConfig?: (spaceId: string) => PrimarySyncConfig | null }) {
	const original = host.commit.bind(host), originalSnapshot = host.snapshot.bind(host); let installed = true;
	const guarded: typeof host.commit = async (fn, context) => {
		const checkedLocal = new Map<string, number>(),checkedErasure=new Map<string,number|null>();
		const external = await o.external.get<HostBootState & Record<string, Json>>(`boot:${o.hostId}`);
		if (!external || external.value.state !== "active" || external.value.hostId !== o.hostId) throw new BootBlocked("external host boot authorization is absent or inactive");
		return original(async tx => {
			const proxy = new Proxy(tx, { get(target, property) {
				if (property !== "doc") { const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value; }
				return async (...args: any[]) => {
					const state = await (target.doc as any)(...args);
					if (args[0] === Space || args[0] === NamedSpace) {
						const s = state as SpaceState, id = s.spaceId ?? args[1];
						const permit = external.value.spaces[id], local = await o.installed.get<SpaceBootPermit & Record<string, Json>>(`installed:${o.hostId}:${id}`);
						if (!permit || !local || permit.state !== "active" || local.value.state !== "active" || permit.authorityId !== o.authorityId || (permit.authorityMarker && s.acceptedAuthorityId !== o.authorityId) || permit.dataIncarnation !== s.incarnation || canonicalJson(permit as unknown as Json) !== canonicalJson(local.value as unknown as Json) || !["local", "primary", "standby"].includes(permit.role)) throw new BootBlocked(`space ${id} lacks matching external/local boot permission`);
						const replica = replicaMismatch(o.hostId, permit, o.replicaConfig?.(id));if (replica) throw new BootBlocked(`space ${id}: ${replica}`);
						if((permit.erasureEpoch??0)!==(s.erasureEpoch??0))throw new BootBlocked('space deletion epoch disagrees with boot permission');
						try{checkedErasure.set(id,await checkErasureBarrier(o.external,id,s,(o.now??Date.now)()));}catch(e){throw new BootBlocked((e as Error).message);}
						checkedLocal.set(id, local.version);
						if ((s as any).primaryEpoch !== undefined && permit.primaryEpoch !== (s as any).primaryEpoch) throw new BootBlocked("space epoch disagrees with boot permission");
					}
					return state;
				};
			} });
			const result = await fn(proxy);
			await Promise.all([...checkedLocal].map(async ([id, version]) => { if ((await o.installed.get(`installed:${o.hostId}:${id}`))?.version !== version) throw new BootBlocked("local boot installation changed before commit"); }));
            const records = await readRegisterRecords(o.external, [...[...checkedErasure.keys()].map(id => 'erasure:' + id), `boot:${o.hostId}`]);
            const current = records[`boot:${o.hostId}`];
            for(const [id,version]of checkedErasure)if((records['erasure:'+id]?.version??null)!==version)throw new BootBlocked('independent erasure barrier changed before commit');
			if (!current || current.version !== external.version) throw new BootBlocked("external boot permission changed before commit");
			return result;
		}, context);
	};
	host.commit = guarded;
	// Snapshots are also service answers: a restored/fenced host must not answer reads with stale data.
	const guardedSnapshot = (async (...args: any[]) => {
        const namedId=args[0]===NamedSpace&&typeof args[1]==='string'?args[1]:undefined;
        const start=namedId?await readRegisterRecords(o.external,['erasure:'+namedId,`boot:${o.hostId}`]):undefined;
        const external=(start?start[`boot:${o.hostId}`]:await o.external.get<HostBootState & Record<string, Json>>(`boot:${o.hostId}`)) as import("./recovery-register.ts").RegisterRecord<HostBootState & Record<string,Json>>|null;
		if (!external || external.value.state !== "active" || external.value.hostId !== o.hostId) throw new BootBlocked("external host boot authorization is absent or inactive");
		const state = await (originalSnapshot as any)(...args);
		if (state && (args[0] === Space || args[0] === NamedSpace)) {
			const s = state as SpaceState, id = s.spaceId ?? args[1];
			const permit = external.value.spaces[id], local = await o.installed.get<SpaceBootPermit & Record<string, Json>>(`installed:${o.hostId}:${id}`);
			if (!permit || !local || permit.state !== "active" || local.value.state !== "active" || permit.authorityId !== o.authorityId || (permit.authorityMarker && s.acceptedAuthorityId !== o.authorityId) || permit.dataIncarnation !== s.incarnation || canonicalJson(permit as unknown as Json) !== canonicalJson(local.value as unknown as Json) || !["local", "primary", "standby"].includes(permit.role) || (s.primaryEpoch !== undefined && permit.primaryEpoch !== s.primaryEpoch)) throw new BootBlocked(`space ${id} lacks matching external/local boot permission`);
			const replica = replicaMismatch(o.hostId, permit, o.replicaConfig?.(id));if (replica) throw new BootBlocked(`space ${id}: ${replica}`);
			if((permit.erasureEpoch??0)!==(s.erasureEpoch??0))throw new BootBlocked('space deletion epoch disagrees with boot permission');
			let erasureVersion:number|null;try{erasureVersion=start&&namedId===id?validateErasureBarrier(start['erasure:'+id]!,id,s,(o.now??Date.now)()):await checkErasureBarrier(o.external,id,s,(o.now??Date.now)());}catch(e){throw new BootBlocked((e as Error).message);}
			if ((await o.installed.get(`installed:${o.hostId}:${id}`))?.version !== local.version) throw new BootBlocked("local boot installation changed during read");
            const records=await readRegisterRecords(o.external,['erasure:'+id,`boot:${o.hostId}`]);
            if((records['erasure:'+id]?.version??null)!==erasureVersion)throw new BootBlocked('independent erasure barrier changed during read');
            if(records[`boot:${o.hostId}`]?.version!==external.version)throw new BootBlocked("external boot permission changed during read");
            return state;
		}
		if ((await o.external.get(`boot:${o.hostId}`))?.version !== external.version) throw new BootBlocked("external boot permission changed during read");
		return state;
	}) as typeof host.snapshot;
	host.snapshot = guardedSnapshot;
	return () => { if (installed && host.commit === guarded) host.commit = original; if (installed && host.snapshot === guardedSnapshot) host.snapshot = originalSnapshot; installed = false; };
}
