// Screenshots of the FORUM page (docs/screenshots/): rooms, a room at 360, 390, 768 and 1280 px, settings, help and the
// expert view, German and English, light and dark. The forum runs here with the fake models of its tests on the built
// page (`npm --prefix codemode-forum run build` first) on port 4100, signed in at the local Keycloak (phi-idp on
// loopback, its test user from idp/.env), driven in headless Chromium (`chromium-browser` on PATH) over the DevTools
// protocol. It reports any sideways scroll and any error of the page. From the repository root:
//   node --experimental-strip-types --no-warnings codemode-forum/tests/screenshots.ts [out-dir]
process.env.FORUM_REQ_PER_MIN = "5000";
import { fileURLToPath } from "node:url";
const R = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
await import(`${R}/codemode-forum/tests/test-env.ts`);
const { startServer } = await import(`${R}/codemode-forum/tests/stack.ts`);
const { loginConfig } = await import(`${R}/codemode-forum/server/auth.ts`);
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(readFileSync(`${R}/idp/.env`, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const OUT = process.argv[2] ?? `${R}/codemode-forum/docs/screenshots`;
mkdirSync(OUT, { recursive: true });
const login = loginConfig({ FORUM_LOGIN: "oidc", FORUM_PUBLIC_ORIGIN: "http://localhost:4100", FORUM_OIDC_ISSUER: "http://localhost:4300/realms/phi", FORUM_OIDC_CLIENT_ID: "codemode-forum", FORUM_OIDC_CLIENT_SECRET: env.IDP_FORUM_SECRET, FORUM_ADMINS: "" });
const srv = await startServer({ login, port: 4100, useNext: true, dev: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = `${process.env.TMPDIR ?? "/tmp"}/forum-shots-${process.pid}`;
const chrome = spawn("chromium-browser", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl: string = await new Promise((ok) => { let buf = ""; chrome.stderr!.on("data", (d) => { buf += d; const m = /DevTools listening on (ws:\S+)/.exec(buf); if (m) ok(m[1]!); }); });
const ws = new WebSocket(wsUrl);
await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
let n = 0;
const pending = new Map<number, (v: any) => void>();
const listeners: Array<(m: any) => void> = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } else for (const l of listeners) l(m); });
const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((ok, fail) => { const id = ++n; pending.set(id, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result))); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId: s } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, s); await send("Runtime.enable", {}, s);
const errors: string[] = [];
listeners.push((m) => {
	if (m.sessionId !== s) return;
	if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
	if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(" "));
});
const loaded = () => new Promise<void>((ok) => { const l = (m: any) => { if (m.sessionId === s && m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); ok(); } }; listeners.push(l); });
const go = async (url: string, settle = 1800) => { const w = loaded(); await send("Page.navigate", { url }, s); await w; await sleep(settle); };
const ev = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, s)).result.value;

try {
	// sign in: the forum sends the browser to Keycloak, the form there, back to the forum's callback page and on
	await go("http://localhost:4100/auth/login", 500);
	if (!String(await ev("location.href")).startsWith("http://localhost:4300/")) throw new Error(`not at Keycloak: ${await ev("location.href")}`);
	const back = loaded();
	await ev(`document.querySelector("#username").value = ${JSON.stringify("dev")}; document.querySelector("#password").value = ${JSON.stringify(env.IDP_DEV_USER_PASSWORD)}; document.querySelector("#kc-form-login").submit(); true`);
	await back; // the callback's page
	await sleep(2500); // its meta refresh to /
	const me = await ev(`fetch("/api/me").then((r) => r.json())`);
	console.log("signed in:", me.login, !!me.user, "at", await ev("location.pathname"), "cookie seen by the API after the provider's redirects:", !!me.user);
	if (!me.user) throw new Error("no session after the sign-in");
	// a room with a task and a run of the fake models
	const call = (path: string, body: object) => ev(`fetch(${JSON.stringify(path)}, { method: "POST", headers: { "content-type": "application/json", "x-forum-csrf": ${JSON.stringify(me.csrf)} }, body: ${JSON.stringify(JSON.stringify(body))} }).then(async (r) => [r.status, await r.json()])`);
	// the fake models take their scenario from the room's name up to the first dash: "both" writes two documents and
	// compares them, "talk" asks the person a question and waits for the answer
	const brief = "Eine App, die den Sternenhimmel zu einer bestimmten Zeit an einem bestimmten Ort zeigt, mit Kometen, Asteroiden, Sternbildern und Messier-Objekten.";
	for (const [room, run] of [["both-sternenhimmel", { way: "both", rounds: 1 }], ["talk-fragen", {}]] as const) {
		console.log("room", room, JSON.stringify((await call("/api/rooms", { room }))[0]));
		console.log("task", JSON.stringify((await call(`/api/rooms/${room}/task`, { brief, lang: "de", criteria: "Nennt die Datenquellen für jede Objektart" }))[0]));
		console.log("run", JSON.stringify(await call(`/api/rooms/${room}/run`, { models: ["fake/alpha", "fake/beta", "fake/gamma"], budgetTokens: 80000, ...run })));
	}
	for (let i = 0; i < 90; i++) { const snap = await ev(`fetch("/api/rooms/both-sternenhimmel").then((r) => r.json())`); if (snap.run && !snap.run.active) { console.log("run ended:", snap.run.phase, snap.run.ended ?? "", JSON.stringify(snap.lines.at(-1))); break; } await sleep(1000); }
	for (let i = 0; i < 30; i++) { const snap = await ev(`fetch("/api/rooms/talk-fragen").then((r) => r.json())`); if (snap.blocks[0]?.talk.forPerson) { console.log("a question waits in talk-fragen"); break; } await sleep(1000); }
	console.log("rooms:", JSON.stringify((await ev(`fetch("/api/rooms").then((r) => r.json())`)).rooms));

	let shots = 0;
	const shot = async (name: string, url: string, w: number, lang: string, mode: string, h = w < 760 ? 820 : 900) => {
		await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 760 }, s);
		await ev(`localStorage.setItem("forum.lang", ${JSON.stringify(lang)}); localStorage.setItem("forum.mode", ${JSON.stringify(mode)}); true`);
		// a new query each time: the same address with another hash is not loaded again
		await go(url.replace(/(#|$)/, `${url.includes("?") ? "&" : "?"}shot=${++shots}$1`), 2500);
		const overflow = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
		const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 72 }, s);
		const file = `${OUT}/${name}-${w}-${lang}-${mode}.jpg`;
		writeFileSync(file, Buffer.from(data, "base64"));
		console.log(file.replace(`${R}/`, ""), overflow > 0 ? `SIDEWAYS SCROLL ${overflow}px` : "no sideways scroll");
	};
	const room = "http://localhost:4100/r/both-sternenhimmel", talk = "http://localhost:4100/r/talk-fragen";
	for (const w of [360, 390, 768, 1280]) await shot("room-table", `${talk}#table`, w, "de", "dark");
	await shot("room-plan", `${room}#plan`, 390, "de", "dark");
	await shot("room-plan", `${room}#plan`, 1280, "de", "dark");
	await shot("room-files", `${room}#files`, 390, "en", "light");
	await shot("room-table", `${room}#table`, 1280, "en", "light");
	await shot("rooms", "http://localhost:4100/", 390, "de", "light");
	await shot("rooms", "http://localhost:4100/", 1280, "en", "dark");
	await shot("settings", "http://localhost:4100/settings", 390, "en", "dark");
	await shot("help", "http://localhost:4100/help?lang=de&article=help.topic.table", 1280, "de", "dark");
	await shot("expert", "http://localhost:4100/expert#both-sternenhimmel", 1280, "de", "dark");
	// signing out ends the session here and goes on to Keycloak
	const out = await call("/auth/logout", {});
	console.log("sign-out:", JSON.stringify(out[0]), String(out[1]?.next ?? "").startsWith("http://localhost:4300/") ? "goes on to Keycloak" : out[1]);
	console.log("errors in the page:", errors.length ? errors : "none");
} finally {
	ws.close(); chrome.kill(); await srv.close();
}
