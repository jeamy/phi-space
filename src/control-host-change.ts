// Promotion of a control replica (docs/abnahme/ap3-replica-control.md, "Promotion des Control-Replikats"): the authority keeps
// its ID, the control host, its supervisor key and its address change. Unlike the 5.2.1 successor decision this is
// no new authority. The recovery admin signs the change; the independent register records it in the authority
// record only after it holds the promoted host as active primary of the control Space and the old host without an
// active permit; every host follows only a recorded change carrying the signature it pins.
import type { Algorithm, Signer } from "./auth.ts";
import { canonicalJson } from "./canonical.ts";
import type { Json } from "./core.ts";
import { verifyDetached } from "./grants.ts";
import type { RecoveryRegister } from "./recovery-register.ts";

export type ControlHostChange = {
	recoveryId: string; authorityId: string; controlSpaceId: string; fromHostId: string; targetHostId: string;
	/** Control epoch of the promoted replica configuration */
	primaryEpoch: number;
	supervisorKey: string; algorithm: Algorithm; address: { host: string; port: number };
};
export type SignedControlHostChange = { change: ControlHostChange; algorithm: Algorithm; signature: string };
export class ControlHostChangeBlocked extends Error {}
const bytes = (c: ControlHostChange) => Buffer.from("phi-spaces/control-host-change/v1\n" + canonicalJson(c as unknown as Json));
const id = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v);

export async function signControlHostChange(change: ControlHostChange, signer: Signer): Promise<SignedControlHostChange> {
	return { change, algorithm: signer.algorithm, signature: Buffer.from(await signer.sign(bytes(change))).toString("base64") };
}
export function verifyControlHostChange(signed: SignedControlHostChange, pinned: { algorithm: Algorithm; publicKey: string }): ControlHostChange {
	const c = signed?.change;
	if (!c || ![c.recoveryId, c.authorityId, c.controlSpaceId, c.fromHostId, c.targetHostId].every(id) || c.fromHostId === c.targetHostId ||
		!Number.isSafeInteger(c.primaryEpoch) || c.primaryEpoch < 2 || typeof c.supervisorKey !== "string" || !["ed25519", "ecdsa-p256"].includes(c.algorithm) ||
		typeof c.address?.host !== "string" || !Number.isSafeInteger(c.address?.port) || c.address.port < 1 || c.address.port > 65535)
		throw new ControlHostChangeBlocked("invalid control host change");
	if (signed.algorithm !== pinned.algorithm || !verifyDetached(pinned.algorithm, pinned.publicKey, bytes(c), signed.signature)) throw new ControlHostChangeBlocked("invalid recovery admin signature");
	return c;
}
type Authority = { authorityId: string; hostId: string; supervisorKey: string; state: string; hostChange?: string; hostChanges?: Record<string, SignedControlHostChange> } & Record<string, Json>;

/**
 * Recovery admin side: records a signed change in `authority:<controlSpaceId>`. Idempotent per recovery ID. The
 * register must already show the promotion: the target active primary of the control Space at the change's epoch,
 * the old host without an active permit for it.
 */
export async function recordControlHostChange(register: RecoveryRegister, signed: SignedControlHostChange, pinned: { algorithm: Algorithm; publicKey: string }): Promise<ControlHostChange> {
	const c = verifyControlHostChange(signed, pinned), key = `authority:${c.controlSpaceId}`;
	const current = await register.get<Authority>(key);
	if (!current) throw new ControlHostChangeBlocked("authority register has not been provisioned");
	const a = current.value;
	if (a.hostChange === c.recoveryId && canonicalJson(a.hostChanges?.[c.recoveryId] as unknown as Json) === canonicalJson(signed as unknown as Json)) return c;
	if (a.state !== "active" || a.authorityId !== c.authorityId || a.hostId !== c.fromHostId) throw new ControlHostChangeBlocked("the authority is not active on the old control host");
	if (a.hostChanges?.[c.recoveryId]) throw new ControlHostChangeBlocked("recovery ID already used for another control host change");
	const [target, from] = await Promise.all([register.get<any>(`boot:${c.targetHostId}`), register.get<any>(`boot:${c.fromHostId}`)]);
	const t = target?.value.spaces?.[c.controlSpaceId], f = from?.value.spaces?.[c.controlSpaceId];
	if (target?.value.state !== "active" || t?.state !== "active" || t.role !== "primary" || t.authorityId !== c.authorityId || t.primaryEpoch !== c.primaryEpoch)
		throw new ControlHostChangeBlocked("the target is not the active primary of the control Space at this epoch");
	if (f?.state === "active") throw new ControlHostChangeBlocked("the old control host still holds an active permit");
	await register.compareAndSet(key, current.version, { ...a, hostId: c.targetHostId, supervisorKey: c.supervisorKey, hostChange: c.recoveryId, hostChanges: { ...(a.hostChanges ?? {}), [c.recoveryId]: signed } } as unknown as Json);
	return c;
}

/**
 * Host side, before anything else at start: when the register names another control host than this host uses, the
 * recorded change (signed with the pinned recovery admin key, same authority) is installed locally with address and
 * key. Returns the installed change, or null when nothing was to follow.
 */
export async function followControlHostChange(external: RecoveryRegister, installed: RecoveryRegister, o: { controlSpaceId: string; configured: { hostId: string; authorityId: string }; recoveryAdmin: { algorithm: Algorithm; publicKey: string } }): Promise<ControlHostChange | null> {
	const authority = await external.get<Authority>(`authority:${o.controlSpaceId}`);if (!authority) return null;
	const key = `installed-authority:${o.controlSpaceId}`, local = await installed.get<any>(key);
	const using = local?.value.address ? local.value.targetHostId : o.configured.hostId, authorityId = local?.value.authorityId ?? o.configured.authorityId;
	if (authority.value.hostId === using) return null;
	const signed = authority.value.hostChange ? authority.value.hostChanges?.[authority.value.hostChange] : undefined;if (!signed) return null;
	const c = verifyControlHostChange(signed, o.recoveryAdmin);
	if (c.controlSpaceId !== o.controlSpaceId || c.recoveryId !== authority.value.hostChange || c.targetHostId !== authority.value.hostId || c.supervisorKey !== authority.value.supervisorKey || c.authorityId !== authority.value.authorityId || c.authorityId !== authorityId)
		throw new ControlHostChangeBlocked("recorded control host change disagrees with the authority record");
	await installed.compareAndSet(key, local?.version ?? null, { kind: "hostChange", authorityId: c.authorityId, recoveryId: c.recoveryId, targetHostId: c.targetHostId, supervisorKey: c.supervisorKey, algorithm: c.algorithm, address: c.address });
	return c;
}
