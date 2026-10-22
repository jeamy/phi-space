// Private endpoint on the same harness as the normal runtime; raw capabilities never enter the space-service chain.
import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "./context.ts";
import type { RecoveryRegister } from "./recovery-register.ts";
import type { Algorithm, Signer } from "./auth.ts";
import { privateFile } from "./keys.ts";
import { join, basename } from "node:path";
import { RecoveryController, dataRecoveryHandler } from "./recovery-controller.ts";
import { ControlAckService } from "./control-ack.ts";
import { RecoveryClient, serveRecovery } from "./recovery-service.ts";
import { SocketRecoveryRegister } from "./register-service.ts";
import { TlsRecoveryRegister, type RegisterTlsClient } from "./tls-register.ts";
import { SshRecoveryRegister } from "./ssh-register.ts";
import { sshRecoveryTransport } from "./ssh-recovery.ts";
import { verifySshFence } from "./fencing.ts";
import { RecoveryBlocked } from "./recovery.ts";
export type PrivateRecoveryConfig = { path: string; operator: { algorithm: Algorithm; publicKey: string }; writerTls?: RegisterTlsClient; writerSshTarget?: string; writerSocket?: string; snapshotDirectory?: string; fenceTargets?: Record<string, string>; controlEndpoint?: { path?: string; sshTarget?: string } };
export async function startConfiguredRecovery(host: Harness, raw: Pick<Harness,"commit" | "snapshot">, ctx: Context, o: { hostId: string; authorityId: string; controlHostId: string; controlSpaceId: string; mode: "control" | "member"; signer: Signer; controlKey: { algorithm: Algorithm; publicKey: string }; reconcileDataRestore?:(o:{hostId:string;spaceId:string;oldIncarnation:string;recoveryId:string})=>Promise<unknown>; config: PrivateRecoveryConfig; external: RecoveryRegister; installed: RecoveryRegister }) {
 const c = o.config;
 if ([c.writerSocket,c.writerSshTarget,c.writerTls].filter(Boolean).length > 1) throw new Error("configure one operator register endpoint");
 const writer = c.writerTls ? new TlsRecoveryRegister(c.writerTls) : c.writerSshTarget ? new SshRecoveryRegister(c.writerSshTarget, 10000, { operator: true }) : c.writerSocket ? new SocketRecoveryRegister(c.writerSocket, { writable: true }) : undefined;
 const acks = o.mode === "control" ? new ControlAckService({ host, ctx, register: o.external, hostId: o.hostId, authorityId: o.authorityId, controlSpaceId: o.controlSpaceId, reconcileDataRestore:o.reconcileDataRestore }) : undefined;
 let controller: RecoveryController | undefined;
 if (writer) {
  if (!c.snapshotDirectory || !c.fenceTargets || !c.controlEndpoint || !!c.controlEndpoint.path === !!c.controlEndpoint.sshTarget) { writer.close(); throw new Error("data recovery needs snapshot directory, pinned fencing endpoints and one control endpoint"); }
  controller = new RecoveryController({ host: raw, ctx, hostId: o.hostId, authorityId: o.authorityId, external: writer, installed: o.installed, loadSnapshot: async reference => { if (!reference || reference !== basename(reference) || reference.length > 256 || !/^[A-Za-z0-9_.-]+\.json$/.test(reference)) throw new RecoveryBlocked("snapshot reference must name a provisioned private JSON file"); return JSON.parse(privateFile(join(c.snapshotDirectory!, reference)).toString("utf8")); }, verifyFence: id => verifySshFence(writer, id, c.fenceTargets!), acknowledgeControl: async job => {
   const client = new RecoveryClient(c.controlEndpoint!.sshTarget ? sshRecoveryTransport(c.controlEndpoint!.sshTarget) : c.controlEndpoint!.path!, { hostId: o.controlHostId, signer: o.signer });
   try { return await client.call("controlAck", { recoveryId: job.request.recoveryId, space: job.request.space, incarnation: job.incarnation!, primaryEpoch: job.primaryEpoch!, authorityId: o.authorityId, targetHostId: o.hostId, argsHash: job.argsHash }, `ack:${job.request.recoveryId}`) as any; } finally { client.close(); }
  } });
 }
 try {
  const server = await serveRecovery({ path: c.path, hostId: o.hostId, operator: c.operator, supervisor: async () => o.controlKey, hostKey: acks ? call => acks.hostKey(call) : undefined, handle: async (call, role) => { if (call.method === "controlAck" && acks) return await acks.acknowledge(call.args as any, role === "host") as any; if (controller && role !== "host") return dataRecoveryHandler(controller)(call, role); throw new RecoveryBlocked("private recovery method is not provisioned on this host"); } });
  return { close: async () => { try { await server.close(); } finally { writer?.close(); } } };
 } catch(e) { writer?.close(); throw e; }
}
