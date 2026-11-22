// What the model processes keep in the space for the others: the models there are (ModelInfo) and every paid call
// (Spend). Read by the web process, which never loads the models itself.
import type { SpaceLike } from "phi-spaces";
import type { AdminModels, LlmInfo } from "./llm.ts";
import { today } from "./limits.ts";

/** What the model processes publish about the models. */
export type ModelInfoView = { info: LlmInfo; admin: AdminModels };
type AdminModel = AdminModels["models"][number];
/** The admin's model list as a ModelInfo entry carries it: [provider, id, name when it differs from the id]. Every
 *  model with credentials can be several hundred: packed, the entry stays under the space's 64 KiB. */
export const packModels = (l: AdminModel[]): Array<[string, string] | [string, string, string]> => l.map((m) => (m.name && m.name !== m.id ? [m.provider, m.id, m.name] : [m.provider, m.id]));
const unpackModels = (l: unknown): AdminModel[] => (Array.isArray(l) ? l : []).map((m) => (Array.isArray(m) ? { label: `${m[0]}/${m[1]}`, provider: String(m[0]), id: String(m[1]), name: String(m[2] ?? m[1]) } : (m as AdminModel)));
/** What the model processes say about the models: each keeps its own ModelInfo (renewed every 10 s), and they are
 *  merged here. Model processes take any call, so they are meant to have the same credentials. */
export async function modelInfoOf(space: SpaceLike): Promise<ModelInfoView> {
	const rows = (await space.readAll({ type: "ModelInfo" }, { limit: 50 })).map((e) => e.fields as unknown as ModelInfoView & { ts?: number }).filter((f) => f.info && f.admin).map((f) => ({ ...f, admin: { ...f.admin, models: unpackModels(f.admin.models) } })).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
	if (!rows.length) return { info: { enabled: false, on: false, models: [] }, admin: { enabled: false, on: false, models: [], allowed: [], custom: false } };
	const union = <T>(lists: T[][], key: (x: T) => string) => { const seen = new Set<string>(); return lists.flat().filter((x) => !seen.has(key(x)) && !!seen.add(key(x))); };
	const newest = rows[0]!;
	return {
		info: { enabled: rows.some((r) => r.info.enabled), on: rows.some((r) => r.info.on), models: union(rows.map((r) => r.info.models), (m) => m.label) },
		admin: { ...newest.admin, enabled: rows.some((r) => r.admin.enabled), on: rows.some((r) => r.admin.on), models: union(rows.map((r) => r.admin.models), (m) => m.label), allowed: union(rows.map((r) => r.admin.allowed), (l) => l) },
	};
}

/** A paid model call as the space keeps it for a day. */
export type Spend = { ip: string; admin: boolean; day: string; tokens: number; costUsd: number; model: string; kind: string; session: string; ts: number };
/** Tokens the visitor calls of an address used today (its Spend entries; an admin's calls do not count). */
export async function spentToday(space: SpaceLike, ip: string): Promise<number> {
	return (await space.readAll({ type: "Spend", fields: { ip, admin: false, day: today() } }, { limit: 5000 })).reduce((n, e) => n + Number((e.fields as { tokens?: unknown }).tokens ?? 0), 0);
}
