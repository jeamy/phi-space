// The recovery page (docs/zanzibar-agent-filesystem-plan.en.md, section 6.5, step 2): a rostered recoverer inspects
// the tenant's actors and administrators, provisions today's administrator and removes an obsolete one. Every step
// carries a recovery operation ID; a reply lost on the way is sent once more with the same ID, and the receipt answers.
type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
type View = { actors: Array<{ kind: string; id: string; state: string; issuer?: string; subject?: string }>; admins: string[] };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let csrf = "";

async function call<T>(op: string, args: Record<string, unknown> = {}): Promise<Reply<T>> {
	const body = JSON.stringify({ op, args });
	const send = () => fetch("/api/recovery", { method: "POST", headers: { "content-type": "application/json", "x-files-csrf": csrf }, body });
	let r: Response;
	try { r = await send(); } catch { r = await send(); }
	if (r.status === 401) { show(false); throw new Error("signed out"); }
	return await r.json() as Reply<T>;
}

function show(signedIn: boolean): void {
	$("signin").hidden = signedIn;
	$("app").hidden = !signedIn;
	$("account").hidden = !signedIn;
}

function say(text: string): void { $("status").textContent = text; }

async function refresh(): Promise<void> {
	const r = await call<View>("inspect");
	if (!r.ok) return say(`${r.error.code}: ${r.error.message}`);
	const list = (id: string, items: string[]) => {
		const ul = $(id);
		ul.replaceChildren(...items.map((t) => { const li = document.createElement("li"); li.textContent = t; return li; }));
	};
	list("admins", r.value.admins);
	list("actors", r.value.actors.map((a) => `${a.kind}:${a.id} (${a.state})${a.issuer ? ` ${a.issuer} ${a.subject}` : ""}`));
}

async function step(op: string, args: Record<string, unknown>): Promise<void> {
	const ids = await call<string[]>("issueOperationIds", { count: 1 });
	if (!ids.ok) return say(`${ids.error.code}: ${ids.error.message}`);
	const r = await call<{ status: string }>(op, { ...args, operationId: ids.value[0] });
	say(r.ok ? `${op}: ${r.value.status}` : `${r.error.code}: ${r.error.message}`);
	await refresh();
}

async function start(): Promise<void> {
	const r = await fetch("/api/recovery/session");
	const s = await r.json() as Reply<{ tenantId: string; issuer: string; subject: string; epoch: number; csrf: string }>;
	if (!s.ok) return show(false);
	csrf = s.value.csrf;
	$("who").textContent = `${s.value.subject} · ${s.value.tenantId} · restore epoch ${s.value.epoch}`;
	show(true);
	await refresh();
}

$("provision").addEventListener("submit", (e) => {
	e.preventDefault();
	const v = (id: string) => ($(id) as HTMLInputElement).value.trim();
	void step("provisionAdmin", { actorId: v("p-actor"), homeName: v("p-home"), identity: { issuer: v("p-issuer"), subject: v("p-subject") } });
});
$("revoke").addEventListener("submit", (e) => {
	e.preventDefault();
	void step("revokeAdmin", { user: ($("r-user") as HTMLInputElement).value.trim() });
});
$("logout").addEventListener("click", async () => {
	await fetch("/recovery/logout", { method: "POST", headers: { "x-files-csrf": csrf } });
	show(false);
});
void start();
