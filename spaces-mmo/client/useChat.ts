"use client";
// The page's keys of the end-to-end encrypted chat (client/chatcrypto.ts, server/chat.ts): the private key of this
// device (kept in IndexedDB, not extractable; unlocked from the server's backup with the chat password), the texts of
// the messages opened with it, and sending: the readers' public keys are asked for, a copy is sealed for each, and only
// the sealed copies go to the server.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatConv, ChatFrame, ChatKeyView, ChatView } from "../server/chat.ts";
import { aad, fingerprint, newKey, openBox, rewrap, sealFor, unlock, type KeyBackup } from "./chatcrypto.ts";
import type { Talks } from "./chat.ts";

const DB = "mmo-chat", STORE = "keys";
function db(): Promise<IDBDatabase> {
	return new Promise((ok, fail) => {
		const r = indexedDB.open(DB, 1);
		r.onupgradeneeded = () => r.result.createObjectStore(STORE);
		r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
	});
}
async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
	try {
		const d = await db();
		return await new Promise<T | undefined>((ok, fail) => { const r = run(d.transaction(STORE, mode).objectStore(STORE)); r.onsuccess = () => ok(r.result as T); r.onerror = () => fail(r.error); });
	} catch { return undefined; } // no IndexedDB (a private window): the key lives in this page only
}
type Stored = { priv: CryptoKey; pub: string };
/** Forgets every chat key of this browser (logout). */
export async function forgetDeviceKeys(): Promise<void> { await idb("readwrite", (s) => s.clear()); }

/** Opened texts by message id: the text, or null when this key cannot open it. */
export type Texts = Map<string, string | null>;

export function useChat(wsSend: (f: unknown) => boolean) {
	const [me, setMe] = useState<{ accountId: string; key: ChatKeyView | null } | null>(null);
	const [priv, setPriv] = useState<Stored | null>(null);
	const [texts, setTexts] = useState<Texts>(new Map());
	const [fingerprints, setFingerprints] = useState<Map<string, string>>(new Map()); // pub -> fingerprint
	const pending = useRef(new Map<number, (f: Extract<ChatFrame, { t: "chatkeys" }>) => void>());
	const reqNo = useRef(0);
	const seen = useRef<ChatView[]>([]); // the sealed messages so far, to open once the key is there
	const state = useRef({ me, priv });
	state.current = { me, priv };

	const fp = useCallback((pub: string) => { if (!fingerprints.has(pub)) void fingerprint(pub).then((f) => setFingerprints((m) => new Map(m).set(pub, f))); return fingerprints.get(pub) ?? ""; }, [fingerprints]);

	/** Opens what it can of `msgs` with the key at hand. */
	const open = useCallback(async (msgs: ChatView[], key = state.current.priv, accountId = state.current.me?.accountId) => {
		if (!key || !accountId) return;
		const out = new Map<string, string | null>();
		for (const m of msgs) {
			if (!m.box) continue;
			try { out.set(m.id, await openBox(key.priv, m.box, aad(m.id, m.fromId, accountId, m.conv.kind === "group" ? m.conv.id : ""))); }
			catch { out.set(m.id, null); }
		}
		if (out.size) setTexts((t) => { const n = new Map(t); for (const [k, v] of out) n.set(k, v); return n; });
	}, []);

	/** The frames of the server for chat keys and texts (the App hands them on). */
	const onFrame = useCallback((f: ChatFrame) => {
		if (f.t === "chatme") {
			setMe({ accountId: f.accountId, key: f.key });
			// this device's key, if it is the account's current one
			void idb<Stored>("readonly", (s) => s.get(f.accountId)).then((k) => {
				if (k && f.key && k.pub === f.key.pub) { setPriv(k); void open(seen.current, k, f.accountId); }
				else setPriv(null);
			});
		}
		else if (f.t === "chatlog") { seen.current = f.msgs.slice(-500); void open(f.msgs); }
		else if (f.t === "chat") { seen.current = [...seen.current, f.m].slice(-500); void open([f.m]); }
		else if (f.t === "chatkeys") { const done = pending.current.get(f.req); if (done) { pending.current.delete(f.req); done(f); } }
	}, [open]);

	const keep = async (k: CryptoKey, backup: KeyBackup, accountId: string) => {
		const s = { priv: k, pub: backup.pub };
		await idb("readwrite", (st) => st.put(s, accountId));
		setPriv(s);
		await open(seen.current, s, accountId);
	};
	/** The first key of the account (or a new one after a forgotten password: `replace`). */
	const setup = useCallback(async (password: string, replace = false) => {
		const m = state.current.me;
		if (!m) throw new Error("Noch nicht verbunden.");
		const { priv: k, backup } = await newKey(password);
		if (!wsSend({ t: "chatkey", key: backup, replace })) throw new Error("Nicht verbunden.");
		setTexts(new Map());
		await keep(k, backup, m.accountId);
	}, [wsSend]); // eslint-disable-line react-hooks/exhaustive-deps
	const unlockWith = useCallback(async (password: string) => {
		const m = state.current.me;
		if (!m?.key) throw new Error("Es gibt noch keinen Chat-Schlüssel.");
		await keep(await unlock(m.key, password), m.key, m.accountId);
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
	const changePassword = useCallback(async (oldPassword: string, newPassword: string) => {
		const m = state.current.me;
		if (!m?.key) throw new Error("Es gibt noch keinen Chat-Schlüssel.");
		if (!wsSend({ t: "chatkey", key: await rewrap(m.key, oldPassword, newPassword) })) throw new Error("Nicht verbunden.");
	}, [wsSend]);
	const lock = useCallback(async () => { const m = state.current.me; if (m) await idb("readwrite", (s) => s.delete(m.accountId)); setPriv(null); setTexts(new Map()); }, []);

	/** Seals `text` for every reader of the talk and sends the copies. Returns the readers without a key. */
	const sendText = useCallback(async (conv: Pick<ChatConv, "kind" | "id">, text: string): Promise<string[]> => {
		const { me: m, priv: k } = state.current;
		if (!m || !k) throw new Error("Der Chat ist auf diesem Gerät noch gesperrt (Reiter „Chats“).");
		const req = ++reqNo.current;
		const keys = await new Promise<Extract<ChatFrame, { t: "chatkeys" }>>((ok, fail) => {
			pending.current.set(req, ok);
			if (!wsSend({ t: "chatkeys", conv: { kind: conv.kind, id: conv.id }, req })) { pending.current.delete(req); fail(new Error("Nicht verbunden.")); }
			setTimeout(() => { if (pending.current.delete(req)) fail(new Error("Keine Antwort; bitte noch einmal.")); }, 10_000);
		});
		const msgId = [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
		const groupId = keys.conv.kind === "group" ? keys.conv.id : "";
		const copies = [];
		for (const r of keys.readers) copies.push({ to: r.accountId, box: await sealFor(k.priv, k.pub, r.pub, text, aad(msgId, m.accountId, r.accountId, groupId)) });
		if (!copies.some((c) => c.to === m.accountId)) throw new Error("Dein Chat-Schlüssel ist nicht mehr der aktuelle; entsperre den Chat neu.");
		if (!wsSend({ t: "chatsend", msgId, conv: { kind: keys.conv.kind, id: keys.conv.id }, copies })) throw new Error("Nicht verbunden.");
		return keys.missing;
	}, [wsSend]);

	/** Hands the text of another's message to the admins (only the reader can open it). */
	const report = useCallback((m: ChatView) => { const text = texts.get(m.id); if (text) wsSend({ t: "chatreport", msgId: m.id, text }); return !!text; }, [texts, wsSend]);

	/** The opened talks as a text file to keep (the server cannot give them back once the password is forgotten). */
	const backup = useCallback((talks: Talks) => {
		const lines = [`Leuchtfeuer – Chatverlauf, gesichert ${new Date().toLocaleString()}`, ""];
		for (const t of talks.values()) {
			lines.push(`== ${t.conv.kind === "group" ? `Gruppe ${t.conv.title}` : `Gespräch mit ${t.conv.title}`} ==`);
			for (const m of t.msgs) lines.push(`[${new Date(m.at).toLocaleString()}] ${m.note ? `(${m.note})` : `${m.from}: ${texts.get(m.id) ?? "(nicht lesbar)"}`}`);
			lines.push("");
		}
		const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
		const a = document.createElement("a");
		a.href = url; a.download = `chatverlauf-${new Date().toISOString().slice(0, 10)}.txt`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 5_000);
	}, [texts]);

	useEffect(() => () => pending.current.clear(), []);
	return { me, unlocked: !!priv, myPub: priv?.pub ?? me?.key?.pub ?? null, texts, fp, onFrame, setup, unlockWith, changePassword, lock, sendText, report, backup };
}
export type ChatKeys = ReturnType<typeof useChat>;
