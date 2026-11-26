// The signed-in person (docs/forum-seite-plan-2026-11-26.en.md, section 5): GET /api/me says whether this forum has a
// sign-in and who is signed in, with the session's CSRF token, which every request that changes something carries.
export type Me = { login: false } | { login: true; user: { id: string; name: string } | null; admin?: boolean; csrf?: string };

let csrf = "";
/** The headers a request that changes something carries (the CSRF token once a person is signed in). */
export const authHeaders = (): Record<string, string> => (csrf ? { "x-forum-csrf": csrf } : {});

export async function loadMe(): Promise<Me> {
	const r = await fetch("/api/me", { cache: "no-store" });
	const d = (await r.json().catch(() => ({ login: false }))) as Me;
	if (d.login && d.csrf) csrf = d.csrf;
	return d;
}

/** Signs out here, then at the identity provider, so that the next sign-in asks again. */
export async function signOut(): Promise<void> {
	const r = await fetch("/auth/logout", { method: "POST", headers: authHeaders() });
	const d = (await r.json().catch(() => ({}))) as { next?: unknown };
	csrf = "";
	if (typeof d.next === "string" && /^https?:\/\//.test(d.next)) location.href = d.next; else location.reload();
}

export async function rename(name: string): Promise<Me> {
	const r = await fetch("/api/me", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ name }) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((d as { error?: string }).error || r.statusText);
	return d as Me;
}
