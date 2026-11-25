/// <reference lib="dom" />
// The page (docs/zanzibar-agent-filesystem-plan.en.md, phase 4): served by server/http.ts with its types stripped.
// Every call goes to POST /api/call with the session's CSRF token; the cookie carries the session, the page never sees
// it. The editor's draft follows client/draft.ts: a conflict or a refusal keeps it.
import { afterLostReply, afterSave, dirty, edit, openDraft, operationIdFor, rebase, type Draft, type SaveOutcome } from "../client/draft.ts";

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; currentVersion?: number } };
type Entry = { name: string; kind: "dir" | "file" };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let csrf = "";
let workspace: string | null = null;
let dir: string[] = [];
let draft: Draft | null = null;

class Lost extends Error {}

/** The session's CSRF token; the adapter derives it anew after a restart, so a refusal (HTTP 403) fetches it again. */
async function refreshCsrf(): Promise<boolean> {
	const r = await fetch("/api/session");
	if (!r.ok) return false;
	csrf = ((await r.json()).value as { csrf: string }).csrf;
	return true;
}

async function call<T>(op: string, args: Record<string, unknown> = {}): Promise<Reply<T>> {
	const body = JSON.stringify({ op, args });
	const send = () => fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-files-csrf": csrf }, body });
	let res: Response;
	try {
		res = await send();
		// service refusals come back as 200; a 403 is the adapter's origin or CSRF check: the same call once more with a
		// fresh token (a mutation keeps its operation ID, so it still applies once)
		if (res.status === 403 && await refreshCsrf()) res = await send();
	} catch { throw new Lost(); }
	if (res.status === 401) { showSignIn(); }
	try { return await res.json() as Reply<T>; } catch { throw new Lost(); }
}
async function must<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
	const r = await call<T>(op, args);
	if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
	return r.value;
}
const freshId = async () => (await must<string[]>("issueOperationIds", { count: 1 }))[0];
const pathOf = (segs: string[]) => segs.length ? segs.join("/") : ".";
const b64 = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function li(label: string, onClick: () => void): HTMLLIElement {
	const item = document.createElement("li");
	const b = document.createElement("button");
	b.className = "link";
	b.type = "button";
	b.textContent = label;
	b.onclick = onClick;
	item.append(b);
	return item;
}
function text(label: string): HTMLLIElement { const item = document.createElement("li"); item.textContent = label; return item; }

function showSignIn() { $("app").hidden = true; $("account").hidden = true; $("signin").hidden = false; }

async function start() {
	const r = await fetch("/api/session");
	if (!r.ok) return showSignIn();
	const reply = await r.json() as Reply<{ tenantId: string; actor: { kind: string; id: string }; admin: boolean; csrf: string }>;
	if (!reply.ok) { $("signin").hidden = false; $("signin").querySelector("p")!.textContent = reply.error.message; return; }
	const s = reply.value;
	$("admin-open").hidden = !s.admin;
	csrf = s.csrf;
	$("who").textContent = `${s.actor.id} in ${s.tenantId}`;
	$("account").hidden = false;
	$("app").hidden = false;
	await showWorkspaces();
}

async function showWorkspaces() {
	const list = $("workspaces");
	list.replaceChildren();
	const r = await call<string[]>("workspaces");
	if (!r.ok) { list.append(text(r.error.message)); return; }
	for (const w of r.value) list.append(li(w, () => { workspace = w; dir = []; void showDir(); }));
	if (workspace !== null && !r.value.includes(workspace)) { workspace = null; dir = []; }
	await showDir();
}

async function showDir() {
	const entries = $("entries");
	entries.replaceChildren();
	$("create").hidden = workspace === null;
	$("grants-box").hidden = workspace === null;
	if (workspace === null) { $("where").textContent = ""; return; }
	$("where").textContent = `${workspace}/${dir.join("/")}`;
	const r = await call<Entry[]>("list", { workspace, path: pathOf(dir) });
	if (!r.ok) { entries.append(text(r.error.code === "notFound" ? "Not found." : r.error.message)); return; }
	if (dir.length) entries.append(li("..", () => { dir = dir.slice(0, -1); void showDir(); }));
	for (const e of r.value) entries.append(li(e.kind === "dir" ? `${e.name}/` : e.name, () => {
		if (e.kind === "dir") { dir = [...dir, e.name]; void showDir(); } else void openFile([...dir, e.name]);
	}));
	await showGrants();
}

async function showGrants() {
	const list = $("grants");
	list.replaceChildren();
	const r = await call<Array<{ relation: string; subject: { kind: string; id: string; relation?: string } }>>("listGrants", { workspace, path: pathOf(dir) });
	if (!r.ok) { list.append(text(r.error.code === "permissionDenied" ? "Only an owner sees the grants." : r.error.message)); return; }
	for (const g of r.value) list.append(text(`${g.relation}: ${g.subject.kind}:${g.subject.id}${g.subject.relation ? "#" + g.subject.relation : ""}`));
}

function renderDraft() {
	$("editor").hidden = draft === null;
	if (draft === null) return;
	$("editing").textContent = `${draft.workspace}/${draft.path} (version ${draft.baseVersion}${dirty(draft) ? ", edited" : ""})`;
	$("status").textContent = draft.status;
	$("theirs").hidden = draft.conflictVersion === null;
}

async function openFile(segs: string[]) {
	if (draft && dirty(draft) && !confirm("Discard your unsaved draft?")) return;
	const path = segs.join("/");
	const r = await call<{ contents: string; version: number }>("read", { workspace, path });
	if (!r.ok) { alert(r.error.message); return; }
	const bytes = unb64(r.value.contents);
	let t: string;
	try { t = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch {
		// not UTF-8: offered as a download, never edited as text
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([bytes]));
		a.download = segs[segs.length - 1];
		a.click();
		return;
	}
	draft = openDraft(workspace!, path, t, r.value.version);
	$<HTMLTextAreaElement>("text").value = t;
	renderDraft();
}

async function save() {
	if (draft === null) return;
	const d = draft;
	const sent = d.text;
	let id: string;
	try { id = await operationIdFor(d, freshId); } catch (e) { draft = { ...d, status: (e as Error).message }; return renderDraft(); }
	try {
		const r = await call<{ version: number }>("write", { workspace: d.workspace, path: d.path, contents: b64(new TextEncoder().encode(sent)), expectedVersion: d.baseVersion, operationId: id });
		const outcome: SaveOutcome = r.ok ? r.value : { error: r.error.code, message: r.error.message, currentVersion: r.error.currentVersion };
		// the user may have typed on while the save was under way: the base is what was sent
		draft = { ...afterSave({ ...d, text: sent }, outcome), text: draft!.text };
	} catch (e) {
		if (!(e instanceof Lost)) throw e;
		draft = afterLostReply(d, id, sent);
	}
	renderDraft();
	if (draft.status.startsWith("Saved")) void showDir();
}

async function loadTheirs() {
	if (draft === null) return;
	const r = await call<{ contents: string; version: number }>("read", { workspace: draft.workspace, path: draft.path });
	if (!r.ok) { draft = { ...draft, status: r.error.message }; return renderDraft(); }
	const theirs = new TextDecoder().decode(unb64(r.value.contents));
	if (!confirm(`Version ${r.value.version}:\n\n${theirs.slice(0, 2000)}\n\nKeep your text and save over this version?`)) return;
	draft = rebase(draft, theirs, r.value.version);
	renderDraft();
}

async function create(kind: string) {
	const name = $<HTMLInputElement>("create-name").value.trim();
	if (!name || workspace === null) return;
	const path = [...dir, name].join("/");
	const r = kind === "dir"
		? await call("mkdir", { workspace, path, operationId: await freshId() })
		: await call("write", { workspace, path, contents: "", expectedVersion: 0, operationId: await freshId() });
	if (!r.ok) alert(r.error.message);
	$<HTMLInputElement>("create-name").value = "";
	await showDir();
}

// The administration is offered to administrators only (the session says so) and loads on request.
async function showAdmin() {
	const actors = await call<Array<{ kind: string; id: string; state: string }>>("listActors");
	$("admin").hidden = false;
	if (!actors.ok) { $("admin-status").textContent = actors.error.code === "permissionDenied" ? "Only a tenant administrator manages the tenant." : actors.error.message; $("actors").replaceChildren(); $("groups").replaceChildren(); return; }
	$("actors").replaceChildren(...actors.value.map((a) => text(`${a.kind}:${a.id} (${a.state})`)));
	const groups = await call<string[]>("listGroups");
	$("groups").replaceChildren(...(groups.ok ? groups.value : []).map((g) => text(g)));
}
async function admin(op: string, args: Record<string, unknown>) {
	const r = await call(op, { ...args, operationId: await freshId() });
	$("admin-status").textContent = r.ok ? `${op}: done` : `${op}: ${r.error.code} (${r.error.message})`;
	await showAdmin();
	await showWorkspaces();
}
const val = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id).value.trim();
const submitter = (e: SubmitEvent) => (e.submitter as HTMLButtonElement | null)?.value ?? "";

$<HTMLTextAreaElement>("text").addEventListener("input", (e) => { if (draft) { draft = edit(draft, (e.target as HTMLTextAreaElement).value); renderDraft(); } });
$("save").onclick = () => void save();
$("theirs").onclick = () => void loadTheirs();
$("close").onclick = () => { if (draft && dirty(draft) && !confirm("Discard your unsaved draft?")) return; draft = null; renderDraft(); };
$("logout").onclick = async () => {
	const out = () => fetch("/auth/logout", { method: "POST", headers: { "x-files-csrf": csrf } });
	if ((await out()).status === 403 && await refreshCsrf()) await out();
	location.reload();
};
$("admin-open").onclick = () => void showAdmin();
$("create").addEventListener("submit", (e) => { e.preventDefault(); void create(submitter(e as SubmitEvent)); });
$("grant-form").addEventListener("submit", (e) => {
	e.preventDefault();
	const kind = val("grant-kind");
	const subject = kind === "group" ? { kind: "group", id: val("grant-id"), relation: "member" } : { kind, id: val("grant-id") };
	void (async () => {
		const r = await call(submitter(e as SubmitEvent), { workspace, path: pathOf(dir), relation: val("grant-relation"), subject, operationId: await freshId() });
		if (!r.ok) alert(r.error.message);
		await showGrants();
	})();
});
$("register").addEventListener("submit", (e) => {
	e.preventDefault();
	const kind = val("reg-kind");
	const identity = kind === "user" ? { issuer: val("reg-a"), subject: val("reg-b") } : { enrolledHostPeerId: val("reg-a"), agentId: val("reg-b") };
	void admin("registerActor", { kind, actorId: val("reg-id"), homeName: val("reg-home"), identity });
});
$("member").addEventListener("submit", (e) => { e.preventDefault(); void admin(submitter(e as SubmitEvent), { group: val("mem-group"), subject: { kind: val("mem-kind"), id: val("mem-id") } }); });
$("workspace").addEventListener("submit", (e) => { e.preventDefault(); void admin("createWorkspace", { name: val("ws-name"), owner: { kind: val("ws-kind"), id: val("ws-owner") } }); });

void start();
