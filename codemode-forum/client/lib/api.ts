// A call of the forum's API from a page: JSON in and out, the sign-in's CSRF token on a change.
import { authHeaders } from "./me.ts";

export async function api<R>(path: string, body?: unknown): Promise<R> {
	const r = await fetch("/api" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", "x-forum-admin": "1", ...authHeaders() }, body: JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
	return data as R;
}
export const firstLine = (s: string, max = 90) => { const l = s.split("\n")[0]!; return l.length > max ? l.slice(0, max) + "…" : l; };
