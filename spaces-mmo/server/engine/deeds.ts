// Services to the community: what a figure does that benefits others, counted for its reputation beside the wood laid
// into a beacon (Contribution) and the parks it tended (ParkCare). One Deed per account and kind in the region's space,
// written in the command's transaction, so a refused command counts nothing.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type DeedFields } from "../model.ts";
import type { CommandCtx } from "./context.ts";

export type DeedKind = DeedFields["kind"];

/** One more of `kind` for the actor's account. */
export async function creditDeed(c: CommandCtx, kind: DeedKind): Promise<void> {
	if (!c.account) return;
	const key = { accountId: c.account.accountId, kind };
	const held = await c.space.takeIfExists({ type: "Deed", fields: key }, NO_WAIT, { txn: c.txn });
	const had = held ? fieldsOf<DeedFields>(held) : null;
	const f: DeedFields = { ...key, charName: c.actor.name, points: (had?.points ?? 0) + 1, lastAt: Date.now() };
	await c.space.write({ type: "Deed", fields: f as never }, c.txn, FOREVER);
}

/** An account's deeds by kind, summed over the given spaces (one per region). */
export async function deedsOf(spaces: Iterable<SpaceLike>, accountId: string): Promise<Record<DeedKind, number>> {
	const out: Record<DeedKind, number> = { beet: 0, bau: 0, tiere: 0 };
	for (const space of spaces) {
		const rows = await space.readAll({ type: "Deed", fields: { accountId } }).catch(() => []);
		for (const e of rows) { const d = fieldsOf<DeedFields>(e); if (d.kind in out) out[d.kind] += Number(d.points) || 0; }
	}
	return out;
}

/** "3× am Gemeinschaftsbeet, 1× ausgebessert" (empty without any). */
export function deedText(d: Record<DeedKind, number>): string {
	return [d.beet ? `${d.beet}× am Gemeinschaftsbeet` : "", d.bau ? `${d.bau}× fremde Bauten ausgebessert` : "", d.tiere ? `${d.tiere}× fremde Tiere gefüttert` : ""].filter(Boolean).join(", ");
}
