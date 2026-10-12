import {FederationRouting} from "./federation-policy.ts";
// Durable control-primary receipt for an independently registered data transition, behind signed private RPC.
import { defineDoc, type Session } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { RecoveryRegister } from "./recovery-register.ts";
import { RegisterConflict } from "./recovery-register.ts";
import { RecoveryBlocked } from "./recovery.ts";
import { canonicalJson } from "./canonical.ts";
import { spaceDoc } from "./spaces.ts";
import * as core from "./core.ts";
import { SpaceKeyDirectory } from "./enroll.ts";
import type { Algorithm } from "./auth.ts";
export type ControlAck = { recoveryId: string; space: string; incarnation: string; primaryEpoch: number; authorityId: string; targetHostId: string; argsHash: string };
export const RecoveryReceipts = defineDoc<{ receipts: Record<string, ControlAck> }>({ kind: "pi-spaces.control-recovery-receipts", version: 1, scope: "session", initial: () => ({ receipts: {} }) });
export class ControlAckService {
 private o: { host: Pick<Session, "commit" | "snapshot">; ctx: Context; register: RecoveryRegister; hostId: string; authorityId: string; controlSpaceId: string; reconcileDataRestore?:(o:{hostId:string;spaceId:string;oldIncarnation:string;recoveryId:string})=>Promise<unknown>; now?: () => number };
 constructor(o: ControlAckService["o"]) { this.o = o; }
 async hostKey(call: import("./recovery-service.ts").RecoveryCall): Promise<{ algorithm: Algorithm; publicKey: string } | null> {
  const args = call.args as unknown as ControlAck;
  if (!args || typeof args.targetHostId !== "string") return null;
  const key = await this.o.register.get<any>(`host-key:${args.targetHostId}`);
  if (!key || typeof key.value.peerId !== "string" || typeof key.value.keyId !== "string") return null;
  const appKey = await new SpaceKeyDirectory(this.o.host, this.o.ctx).find(key.value.peerId, key.value.keyId);
  return appKey?.state === "active" && appKey.roles.includes("host") && appKey.algorithm === key.value.algorithm && appKey.publicKey === key.value.publicKey && key?.value.state === "active" && key.value.authorityId === this.o.authorityId && ["ed25519", "ecdsa-p256"].includes(key.value.algorithm) && typeof key.value.publicKey === "string" ? key.value : null;
 }
 async acknowledge(args: ControlAck, requireHostKey = false): Promise<ControlAck> {
  if (![args.recoveryId,args.space,args.incarnation,args.authorityId,args.targetHostId,args.argsHash].every(s => typeof s === "string" && s.length > 0 && s.length <= 512) || !Number.isSafeInteger(args.primaryEpoch) || args.primaryEpoch < 1 || args.authorityId !== this.o.authorityId) throw new RecoveryBlocked("invalid control acknowledgement tuple");
  const authority = await this.o.register.get<any>(`authority:${this.o.controlSpaceId}`), transition = await this.o.register.get<any>(`data-transition:${args.space}`), target = await this.o.register.get<any>(`boot:${args.targetHostId}`);
  if (!authority || authority.value.state !== "active" || authority.value.hostId !== this.o.hostId || authority.value.authorityId !== this.o.authorityId) throw new RecoveryBlocked("control is not the independently active authority");
  if (!transition || !["restoring","completed"].includes(transition.value.state) || ["recoveryId","incarnation","primaryEpoch","targetHostId","argsHash","authorityId"].some(k => transition.value[k] !== (args as any)[k])) throw new RecoveryBlocked("control receipt disagrees with the independent data transition");
  const permit = target?.value.spaces[args.space];
  if (!target || target.value.state !== "active" || !permit || permit.authorityId !== args.authorityId || !((permit.state === "revoked" && permit.dataIncarnation === transition.value.expectedDataIncarnation) || (permit.state === "active" && permit.dataIncarnation === args.incarnation && permit.primaryEpoch === args.primaryEpoch && permit.transitionId === args.recoveryId))) throw new RecoveryBlocked("target boot permission disagrees with recovery");
  const source = await this.o.register.get<any>(`boot:${transition.value.sourceHostId}`);
  if (!source || source.value.state !== "fenced") throw new RecoveryBlocked("source host is not independently fenced");
  const hostKey = requireHostKey ? await this.o.register.get<any>(`host-key:${args.targetHostId}`) : null;
  if (requireHostKey && (!hostKey || hostKey.value.state !== "active" || hostKey.value.authorityId !== this.o.authorityId)) throw new RecoveryBlocked("target host key is no longer independently authorized");
  const routing=await this.o.host.snapshot(FederationRouting,this.o.controlSpaceId,this.o.ctx);
  if(Object.values(routing?.members??{}).some(m=>m.target.spaceId===args.space)) {
   if(!this.o.reconcileDataRestore) throw new RecoveryBlocked("managed Data restore requires Router/parent reconciliation before acknowledgement");
   await this.o.reconcileDataRestore({hostId:transition.value.sourceHostId,spaceId:args.space,oldIncarnation:transition.value.expectedDataIncarnation,recoveryId:args.recoveryId});
  }
  return this.o.host.commit(async tx => {
   const state = await spaceDoc(tx, this.o.controlSpaceId, (this.o.now ?? Date.now)());
   if (!core.maintenanceStep(state, Buffer.byteLength(JSON.stringify(args)) + 512, (this.o.now ?? Date.now)(), "control-recovery-ack")) throw new core.ResourceExhausted("control receipt exceeds commit budget");
   if (hostKey) { const key = core.list(state, (this.o.now ?? Date.now)(), { type: "PeerKey", fields: { peerId: hostKey.value.peerId, keyId: hostKey.value.keyId } })[0]; if (!key || key.fields.state !== "active" || !Array.isArray(key.fields.roles) || !key.fields.roles.includes("host") || key.fields.algorithm !== hostKey.value.algorithm || key.fields.publicKey !== hostKey.value.publicKey || (await this.o.register.get(`host-key:${args.targetHostId}`))?.version !== hostKey.version) throw new RecoveryBlocked("target host key changed before control receipt commit"); }
   const doc = await tx.doc(RecoveryReceipts), existing = doc.receipts[args.recoveryId];
   if (existing && canonicalJson(existing as any) !== canonicalJson(args as any)) throw new RegisterConflict("recovery receipt identity has different arguments");
   if ((await this.o.register.get(`authority:${this.o.controlSpaceId}`))?.version !== authority.version || (await this.o.register.get(`data-transition:${args.space}`))?.version !== transition.version || (await this.o.register.get(`boot:${args.targetHostId}`))?.version !== target.version || (await this.o.register.get(`boot:${transition.value.sourceHostId}`))?.version !== source.version) throw new RecoveryBlocked("recovery authorization changed before control receipt commit");
   doc.receipts[args.recoveryId] ??= core.plain(args); return core.plain(doc.receipts[args.recoveryId]!);
  }, this.o.ctx);
 }
}
