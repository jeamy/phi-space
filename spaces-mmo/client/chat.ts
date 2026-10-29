// The page's side of the chat between players (server/chat.ts): the talks by key, what is unread in each, and the line a
// message in a talk becomes. What was read is remembered in the browser (per talk, the time of the last message seen), so
// messages that came while one was away count as unread at the next visit.
import type { ChatConv, ChatView } from "../server/chat.ts";

export type Talk = { conv: ChatConv; msgs: ChatView[]; unread: number };
export type Talks = Map<string, Talk>;

const KEEP = 200;
const SEEN = "mmo.chatSeen";
export const keyOf = (c: ChatConv) => `${c.kind}:${c.id}`;

function seenAll(): Record<string, number> { try { return JSON.parse(localStorage.getItem(SEEN) ?? "{}") as Record<string, number>; } catch { return {}; } }
/** Marks a talk as read up to `at`. */
export function markSeen(key: string, at: number): void {
	try { const s = seenAll(); if ((s[key] ?? 0) < at) { s[key] = at; localStorage.setItem(SEEN, JSON.stringify(s)); } } catch { /* storage off: unread counts start anew */ }
}

/** The talks of a fresh page: from the messages kept for the player. */
export function fromLog(msgs: ChatView[], open: string): Talks {
	const seen = seenAll(), t: Talks = new Map();
	for (const m of msgs) {
		const k = keyOf(m.conv), old = t.get(k);
		const unread = (old?.unread ?? 0) + (k !== open && !m.mine && m.from && m.at > (seen[k] ?? 0) ? 1 : 0);
		t.set(k, { conv: m.conv, msgs: [...(old?.msgs ?? []), m].slice(-KEEP), unread });
	}
	return t;
}

/** A new message; unread unless its talk is open or it is one's own. */
export function addMsg(t: Talks, m: ChatView, open: string): Talks {
	const k = keyOf(m.conv), old = t.get(k);
	if (old?.msgs.some((x) => x.id === m.id)) return t;
	const unread = (old?.unread ?? 0) + (k !== open && !m.mine && m.from ? 1 : 0);
	return new Map(t).set(k, { conv: m.conv, msgs: [...(old?.msgs ?? []), m].slice(-KEEP), unread });
}

/** A talk to show (opened from the map or by `chat <name>`), empty if there was none. */
export function openTalk(t: Talks, conv: ChatConv): Talks {
	return t.has(keyOf(conv)) ? t : new Map(t).set(keyOf(conv), { conv, msgs: [], unread: 0 });
}

export function readTalk(t: Talks, key: string): Talks {
	const old = t.get(key);
	if (!old) return t;
	const last = old.msgs.at(-1);
	if (last) markSeen(key, last.at);
	return old.unread ? new Map(t).set(key, { ...old, unread: 0 }) : t;
}
