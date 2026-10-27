// spaces-mmo, the web process: HTTP + WebSocket server around the Next.js app. Accounts and logins (accounts.ts), the
// gateway for playing browsers (gateway.ts), the world's graphics. It holds no game state: the world lives in the world
// space, logins in the accounts space; both are served by the space process (space-host.ts).
//
//   node --experimental-strip-types spaces-mmo/server/index.ts [--dev]
//   PORT (3900), SPACES_MMO_BIND (127.0.0.1), SPACES_MMO_SPACE, SPACES_MMO_ACCOUNTS (the sockets of the space process),
//   SPACES_MMO_REQ_PER_MIN (API requests and WebSocket connects per client IP and minute, default 120),
//   SPACES_MMO_GUESTS_PER_HOUR (new guests per client IP and hour, default 5), SPACES_MMO_SETUP_TOKEN (first admin),
//   SPACES_MMO_NO_NEXT=1 (API, assets and game socket only, no pages: the tests that start the web as a process),
//   SPACES_MMO_PUBLIC_URL (where a browser reaches it, when that is not where it listens: in a container, the port
//   Docker publishes; only for the log line)
//
// Every POST must carry the header `x-mmo: 1`: a cross-site form cannot set it, and the cookie is SameSite=Strict.
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { pathToFileURL } from "node:url";
import { Accounts, AuthError, type AccountOptions, type Me } from "./accounts.ts";
import { loadWorld, worldAsset } from "./engine/world.ts";
import { Gateway } from "./gateway.ts";
import { connectSpace, DEFAULT_ACCOUNTS, DEFAULT_SPACE } from "./space.ts";
import { upgradeWebSocket } from "./ws.ts";
import { chosen } from "./llm.ts";
import { saveModelChoice, saveSettings, SETTINGS, settingsOf, type ModelInfoFields } from "./settings.ts";

const COOKIE = "mmo_sid";

/** The client address: behind the local reverse proxy (loopback peer) the last x-forwarded-for hop, else the peer. */
function clientIp(req: http.IncomingMessage): string {
	const peer = req.socket.remoteAddress ?? "local";
	const xff = req.headers["x-forwarded-for"];
	if (!/^(127\.|::1$|::ffff:127\.)/.test(peer) || typeof xff !== "string" || !xff.trim()) return peer;
	return xff.split(",").at(-1)!.trim() || peer;
}

/** At most `limit` hits per key in a sliding window (at most 4096 tracked keys). */
function quota(limit: number, windowMs = 60_000): (key: string) => boolean {
	const seen = new Map<string, { at: number; count: number }>();
	return (key) => {
		const now = Date.now();
		if (seen.size >= 4096) for (const [k, v] of seen) if (now - v.at >= windowMs) seen.delete(k);
		let v = seen.get(key);
		if (!v || now - v.at >= windowMs) { if (!v && seen.size >= 4096) return false; v = { at: now, count: 0 }; seen.set(key, v); }
		return ++v.count <= limit;
	};
}

const cookieOf = (req: http.IncomingMessage, name: string): string | undefined => {
	for (const part of String(req.headers.cookie ?? "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
	return undefined;
};

export async function startServer(o: { port?: number; bind?: string; space?: string; accounts?: string; useNext?: boolean; dev?: boolean; accountOptions?: AccountOptions; build?: string | null } = {}) {
	const w = await loadWorld();
	const world = connectSpace(o.space ?? (process.env.SPACES_MMO_SPACE || DEFAULT_SPACE));
	const store = connectSpace(o.accounts ?? (process.env.SPACES_MMO_ACCOUNTS || DEFAULT_ACCOUNTS));
	const accounts = new Accounts(world.space, store.space, w, o.accountOptions);
	// the build of the pages (Next writes .next/BUILD_ID): a page from an older build reloads when it meets a newer one
	const build = o.build !== undefined ? o.build : (() => { try { return readFileSync(join(ROOT, ".next", "BUILD_ID"), "utf8").trim(); } catch { return null; } })();
	const gateway = new Gateway(world.space, w, (accountId) => void accounts.touchGuest(accountId).catch(() => {}), build);

	let nextHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null = null;
	let nextUpgrade: ((req: http.IncomingMessage, socket: any, head: Buffer) => void) | null = null;
	if (o.useNext) {
		const mod = await import("next");
		const app = ((mod as any).default ?? mod)({ dev: Boolean(o.dev), dir: ROOT });
		await app.prepare();
		nextHandler = app.getRequestHandler();
		if (typeof app.getUpgradeHandler === "function") nextUpgrade = app.getUpgradeHandler();
	}

	const allowed = quota(Number(process.env.SPACES_MMO_REQ_PER_MIN ?? 120));
	const loginByIp = quota(10), loginByName = quota(10);
	const guestsByIp = quota(Number(process.env.SPACES_MMO_GUESTS_PER_HOUR ?? 5), 3600_000);
	const registrationsByIp = quota(20, 24 * 3600_000);

	const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
		res.end(JSON.stringify(body));
	};
	const readBody = (req: http.IncomingMessage) => new Promise<Record<string, any>>((ok, fail) => {
		let n = 0; const parts: Buffer[] = [];
		req.on("data", (c: Buffer) => { n += c.length; if (n > 16_000) { fail(new AuthError(413, "Anfrage zu groß")); req.destroy(); } else parts.push(c); });
		req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { fail(new AuthError(400, "Ungültiges JSON")); } });
		req.on("error", fail);
	});
	const cookie = (req: http.IncomingMessage, sid: string | null) => {
		const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
		return sid
			? `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(accounts.webSessionMs / 1000)}${secure}`
			: `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
	};
	const meView = (me: Me | null) => ({ account: me ? { name: me.name, guest: me.guest, admin: me.admin } : null, world: { id: w.id, title: w.title }, build });
	/** Logs `me` in: a new web session, the old one (a guest's, say) ends. */
	const signIn = async (req: http.IncomingMessage, res: http.ServerResponse, me: Me) => {
		await accounts.closeSession(cookieOf(req, COOKIE));
		const sid = await accounts.openSession(me.accountId);
		json(res, 200, meView(me), { "set-cookie": cookie(req, sid) });
	};

	/** The operator's window (client/AdminPanel.tsx): the settings with where each value comes from, and the models the
	 *  model process published, with the admin's choice. `change` (a POST): `values` (key → number, null back to the .env)
	 *  and `models` ({on, allowed, model}, null back to the default choice). Only for an admin. */
	const adminSettings = async (me: Me | null, change: Record<string, any> | null) => {
		if (!me?.admin) throw new AuthError(403, "Nur für Admins");
		const info = (await world.space.readAll({ type: "ModelInfo" }, { limit: 1 }))[0]?.fields as unknown as ModelInfoFields | undefined;
		const available = info?.models ?? [];
		if (change) {
			try {
				if (change.values !== undefined) {
					if (!change.values || typeof change.values !== "object" || Array.isArray(change.values)) throw new RangeError("values: Schlüssel und Zahlen");
					await saveSettings(world.space, change.values);
				}
				if (change.models !== undefined) {
					const m = change.models;
					if (m === null) await saveModelChoice(world.space, null);
					else {
						if (typeof m !== "object" || typeof m.on !== "boolean" || !(m.allowed === null || (Array.isArray(m.allowed) && m.allowed.every((l: unknown) => typeof l === "string"))) || !(m.model === null || typeof m.model === "string")) throw new RangeError("models: {on, allowed, model}");
						const known = new Set(available.map((x) => x.label));
						const unknown = [...(m.allowed ?? []), ...(m.model ? [m.model] : [])].filter((l: string) => !known.has(l));
						if (unknown.length) throw new RangeError(`Unbekannte Modelle: ${unknown.slice(0, 5).join(", ")}`);
						if (m.allowed && !m.allowed.length) throw new RangeError("Mindestens ein Modell erlauben (oder Standard)");
						if (m.model && m.allowed && !m.allowed.includes(m.model)) throw new RangeError("Das verwendete Modell muss erlaubt sein");
						await saveModelChoice(world.space, { on: m.on, allowed: m.allowed, model: m.model });
					}
				}
			} catch (e) { if (e instanceof RangeError) throw new AuthError(400, e.message); throw e; }
		}
		const s = await settingsOf(world.space);
		const pick = chosen(available, s.models);
		return {
			fields: SETTINGS.map((d) => ({ key: d.key, label: d.label, unit: d.unit, help: d.help, env: d.env, def: d.def, min: d.min, max: d.max, ...s.values[d.key]! })),
			models: { enabled: info?.enabled ?? false, published: !!info, on: s.models.on, custom: s.models.allowed !== null, available, allowed: pick.allowed.map((m) => m.label), model: pick.model?.label ?? null },
		};
	};

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			const p = url.pathname;
			if (p === "/healthz") return json(res, 200, { ok: true });
			const asset = /^\/assets\/([a-z0-9-]+)\/(.+)$/.exec(p);
			if (asset && req.method === "GET") {
				const a = worldAsset(asset[1]!, asset[2]!);
				if (!a) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
				res.writeHead(200, { "content-type": a.type, "cache-control": "public, max-age=3600" });
				return res.end(a.body);
			}
			if (p.startsWith("/api/")) {
				const ip = clientIp(req);
				if (!allowed(ip)) return json(res, 429, { error: "Zu viele Anfragen; bitte in einer Minute noch einmal" });
				if (p === "/api/me" && req.method === "GET") return json(res, 200, meView(await accounts.resolve(cookieOf(req, COOKIE))));
				if (p === "/api/admin/settings" && req.method === "GET") return json(res, 200, await adminSettings(await accounts.resolve(cookieOf(req, COOKIE)), null));
				if (req.method !== "POST") return json(res, 405, { error: "POST erwartet" });
				if (req.headers["x-mmo"] !== "1") return json(res, 403, { error: "Header x-mmo fehlt" });
				const b = await readBody(req);
				if (p === "/api/guest") {
					if (!guestsByIp(ip)) return json(res, 429, { error: "Zu viele neue Gäste von dieser Adresse; bitte später noch einmal" });
					return await signIn(req, res, await accounts.createGuest());
				}
				if (p === "/api/register") {
					if (!registrationsByIp(ip)) return json(res, 429, { error: "Zu viele Registrierungen von dieser Adresse heute" });
					const current = await accounts.resolve(cookieOf(req, COOKIE));
					// a guest registers from its session: the same account, with its character and progress, becomes registered
					const me = await accounts.register(b.name, b.password, { ...(current?.guest ? { guestAccountId: current.accountId } : {}), ...(typeof b.setupToken === "string" ? { setupToken: b.setupToken } : {}) });
					return await signIn(req, res, me);
				}
				if (p === "/api/login") {
					const name = String(b.name ?? "").trim().toLowerCase();
					if (!loginByIp(ip) || !loginByName(name)) return json(res, 429, { error: "Zu viele Anmeldeversuche; bitte in einer Minute noch einmal" });
					return await signIn(req, res, await accounts.login(b.name, b.password, typeof b.setupToken === "string" && b.setupToken ? { setupToken: b.setupToken } : {}));
				}
				if (p === "/api/admin/settings") return json(res, 200, await adminSettings(await accounts.resolve(cookieOf(req, COOKIE)), b));
				if (p === "/api/logout") {
					await accounts.closeSession(cookieOf(req, COOKIE));
					return json(res, 200, meView(null), { "set-cookie": cookie(req, null) });
				}
				return json(res, 404, { error: "Unbekannter Aufruf" });
			}
			if (nextHandler) return await nextHandler(req, res);
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("Not found");
		} catch (e) {
			if (res.headersSent) return void res.end();
			if (e instanceof AuthError) return json(res, e.status, { error: e.message });
			console.error("[web]", (e as Error).message);
			json(res, 500, { error: "Das ging gerade nicht; bitte noch einmal" });
		}
	};

	const server = http.createServer((req, res) => void handle(req, res));
	// upgraded sockets (ours and Next's HMR) are not closed by server.close(): track every socket and destroy them
	const conns = new Set<import("node:net").Socket>();
	server.on("connection", (s) => { conns.add(s); s.on("close", () => conns.delete(s)); });
	let sockets = 0;
	server.on("upgrade", (req, socket, head) => {
		if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") { if (nextUpgrade) nextUpgrade(req, socket, head); else socket.destroy(); return; }
		// a browser sends its origin: only this site's own pages may open a game socket with the cookie
		const origin = req.headers.origin;
		if (origin !== undefined && URL.parse(origin)?.host !== req.headers.host) return void socket.destroy();
		if (sockets >= 1024 || !allowed(clientIp(req))) return void socket.destroy();
		void accounts.resolve(cookieOf(req, COOKIE)).then((me) => {
			if (!me) return void socket.destroy();
			const ws = upgradeWebSocket(req, socket, head);
			if (!ws) return;
			sockets++; ws.onClose(() => { sockets--; });
			void gateway.attach(ws, me).catch((e) => { console.error("[web] websocket attach failed:", (e as Error).message); ws.close(); });
		}, () => socket.destroy());
	});
	const port = o.port ?? Number(process.env.PORT ?? 3900), bind = o.bind ?? process.env.SPACES_MMO_BIND ?? "127.0.0.1";
	await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(port, bind, () => ok()); });
	const addr = server.address();
	const actual = typeof addr === "object" && addr ? addr.port : port;
	return {
		url: `http://127.0.0.1:${actual}`, port: actual, accounts, gateway,
		async close() { await gateway.close(); await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); for (const s of conns) s.destroy(); }); world.close(); store.close(); },
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const dev = process.argv.includes("--dev");
	const srv = await startServer({ useNext: process.env.SPACES_MMO_NO_NEXT !== "1", dev });
	const pub = process.env.SPACES_MMO_PUBLIC_URL;
	console.log(`[web] spaces-mmo listening on ${srv.url}${pub && pub !== srv.url ? ` (in the container; open ${pub})` : ""}`);
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
		// dev: exit at once, so `node --watch` can start the replacement before Next's dev lock is still held
		if (dev) process.exit(0);
		setTimeout(() => process.exit(0), 3000).unref();
		void srv.close().finally(() => process.exit(0));
	});
}
