// Durable principal mailboxes. ACK is a delivered prefix, never a take transaction's commit.
import { randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import { bytePage, encodedBytes } from "./paging.ts";
import * as core from "./core.ts";
import type { Principal } from "./claims.ts";

export type MailItem = { seq: number; at: number; event: core.SpaceEvent };
export type Mailbox = { principal: Principal; epoch: string; next: number; acked: number; delivered: number; bytes: number; events: MailItem[]; gap?: { epoch: string; from: number; to: number } };
export type MailboxState = { boxes: Record<string, Mailbox> };
export type MailboxPage = { mailboxEpoch: string; events: MailItem[]; next: number; more: boolean; gap?: Mailbox["gap"] };
export class MailboxEpochMismatch extends Error {}
export class InvalidAck extends Error {}
export const principalId = (p: Principal): string => canonicalJson([p.peerId, p.agentId ?? null]);
const epoch = () => `mb${randomBytes(16).toString("hex")}`;

function box(s: core.SpaceState, p: Principal): Mailbox {
	if (!p || typeof p.peerId !== "string" || !p.peerId || (p.agentId !== undefined && typeof p.agentId !== "string")) throw new core.IllegalArgumentError("invalid mailbox principal");
	s.mailboxes ??= { boxes: {} };
	const id = principalId(p);
	if (!s.mailboxes.boxes[id]) { s.mailboxes.boxes[id] = { principal: { ...p }, epoch: epoch(), next: 1, acked: 0, delivered: 0, bytes: 2, events: [] }; core.touch(s, Date.now()); }
	return s.mailboxes.boxes[id]!;
}
function expireBox(b: Mailbox, s: core.SpaceState, now: number): void {
	while (b.events[0] && b.events[0].seq <= b.acked) {
		if (!core.maintenanceStep(s, 128, now, `ack:${b.epoch}`)) return;
		const item = b.events.shift()!; b.bytes -= encodedBytes(item) + (b.events.length ? 1 : 0); core.touch(s, now);
	}
	let through = b.acked, changed = false;
	while (b.events[0] && b.events[0].at + core.limitsOf(s).mailboxTtlMs <= now) {
		if (!core.maintenanceStep(s, 128, now, `mailbox:${b.epoch}`)) break;
		const item = b.events.shift()!;
		through = item.seq; b.bytes -= encodedBytes(item) + (b.events.length ? 1 : 0);
		if (item.event.txn && s.txns[item.event.txn]) {
			s.releaseQueue ??= [];
			if (!s.releaseQueue.includes(item.event.txn)) s.releaseQueue.push(item.event.txn);
		}
		changed = true;
	}
	if (!changed) return;
	// Keep sequence numbers on the retained suffix: expiry must not rewrite a potentially multi-MiB mailbox.
	b.gap = { epoch: b.epoch, from: b.acked + 1, to: through };
	b.epoch = epoch(); b.acked = through; b.delivered = through;
	core.touch(s, now);
}
export function sweepMailboxes(s: core.SpaceState, now: number): void { for (const b of Object.values(s.mailboxes?.boxes ?? {})) expireBox(b, s, now); }

export function assertMailboxCapacity(s: core.SpaceState, p: Principal, event: core.SpaceEvent, now: number): void {
	const b = box(s, p); expireBox(b, s, now);
	const item = { seq: b.next, at: now, event };
	const lim = core.limitsOf(s);
	if (encodedBytes(event) > lim.maxEventBytes) throw new core.ResourceExhausted("the event exceeds maxEventBytes");
	if (b.bytes + encodedBytes(item) + 1 > lim.maxMailboxBytes) throw new core.ResourceExhausted("the principal's mailbox is full");
}
export function assertMailboxBatch(s: core.SpaceState, p: Principal, events: core.SpaceEvent[], now: number): void {
	const b = box(s, p); expireBox(b, s, now);
	let size = b.bytes;
	for (let i = 0; i < events.length; i++) {
		if (encodedBytes(events[i]) > core.limitsOf(s).maxEventBytes) throw new core.ResourceExhausted("the event exceeds maxEventBytes");
		size += encodedBytes({ seq: b.next + i, at: now, event: events[i] }) + 1;
	}
	if (size > core.limitsOf(s).maxMailboxBytes) throw new core.ResourceExhausted("the principal's mailbox cannot hold this fanout");
}
export function appendMail(s: core.SpaceState, p: Principal, event: core.SpaceEvent, now: number): void {
	assertMailboxCapacity(s, p, event, now);
	const b = box(s, p); b.events.push({ seq: b.next++, at: now, event: core.plain(event) }); b.bytes = encodedBytes(b.events); core.touch(s, now);
}

export function mailboxPage(s: core.SpaceState, p: Principal, now: number, o: { mailboxEpoch?: string; after?: number; maxBytes?: number } = {}): MailboxPage {
	const b = box(s, p); expireBox(b, s, now);
	const after = o.after ?? b.acked;
	if (!Number.isSafeInteger(after) || after < 0) throw new core.IllegalArgumentError("invalid mailbox cursor");
	const maxBytes = o.maxBytes ?? core.limitsOf(s).maxFrameBytes;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new core.IllegalArgumentError("maxBytes must be positive");
	const cap = Math.min(maxBytes, core.limitsOf(s).maxFrameBytes);
	if (o.mailboxEpoch !== undefined && o.mailboxEpoch !== b.epoch) {
		const gap = b.gap ?? { epoch: o.mailboxEpoch, from: after + 1, to: Math.max(after, b.next - 1) };
		const result: MailboxPage = { mailboxEpoch: b.epoch, events: [], next: b.acked, more: b.events.length > 0, gap };
		if (encodedBytes(result) > cap) throw new core.ResponseBudgetTooSmall(encodedBytes(result));
		return result;
	}
	if (after >= b.next || after < b.acked || after > b.delivered) throw new core.IllegalArgumentError("mailbox cursor is ahead, undelivered or already acknowledged");
	const pending = b.events.filter(e => e.seq > after);
	const result = bytePage(pending, 0, cap, (events, next) => ({ mailboxEpoch: b.epoch, events, next: events.length ? events[events.length - 1]!.seq : after, more: next !== null, ...(o.mailboxEpoch === undefined && b.gap ? { gap: b.gap } : {}) }));
	// Do not mark anything delivered when the caller's byte budget failed.
	if (result.next > b.delivered) { b.delivered = result.next; core.touch(s, now); }
	return core.plain(result);
}

export function ackMailbox(s: core.SpaceState, p: Principal, mailboxEpoch: string, upTo: number): { mailboxEpoch: string; acked: number } {
	const b = box(s, p);
	if (mailboxEpoch !== b.epoch) throw new MailboxEpochMismatch("ACK refers to another mailbox epoch");
	if (!Number.isSafeInteger(upTo) || upTo < 0 || upTo > b.delivered) throw new InvalidAck("ACK exceeds the delivered prefix");
	if (upTo > b.acked) {
		const covered = b.events.filter(e => e.seq > b.acked && e.seq <= upTo);
		if (covered.length !== upTo - b.acked) throw new InvalidAck("ACK is not a contiguous prefix");
		b.acked = upTo; // Physical deletion follows in bounded maintenance commits.
		core.touch(s, Date.now());
		for (const job of s.jobs ?? []) if (job.events.slice(job.cursor).some(e => e.consumer && principalId(e.consumer) === principalId(p))) job.retryAt = 0;
	}
	return { mailboxEpoch: b.epoch, acked: b.acked };
}
