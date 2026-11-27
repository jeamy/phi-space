// The join with spaces-files (docs/forum-seite-plan-2026-11-26.en.md, section 6, phase 5: reading). A room is linked to
// folders of a spaces-files workspace through an agent of its own there (`room-<room>`): what an owner in spaces-files
// grants that agent is what the room may read, and a revocation there ends it. Only the sources process talks to
// spaces-files (its agent socket, FORUM_FILES_SOCKET); the web process asks it through entries:
//
//   RoomLink      the room's link: tenant, agent, the folder that is only read, the project folder, who linked it
//   FilesRequest  one request to the sources process: `check` (what the agent sees; the chosen folders) or `snapshot`
//                 (a task's copy of the linked folders)
//   FilesResult   its answer, or the refusal with spaces-files' own code
//
// A snapshot walks both folders when a task is created. Every file enters the task's index with its path, size, kind
// and version, whatever it contains, but the names no reader gets (keys, local settings: sources.ts `denied`). Text
// files (valid UTF-8, up to 200 kB each) are copied into the space as SourceFile parts; the three reading calls work on
// that copy, and name the other files with their kind and size. A copy is written in parts outside any transaction
// (a transaction holds at most 192 kB), each part under the copy's own ID, and the task's PlanSource names the copy
// only once it is whole: a walk cut off leaves parts nobody reads, which the next attempt removes.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { denied, safePath, type IndexEntry } from "./sources.ts";

/** The limits of a copy, each a variable (FORUM_FILES_*): files in the index, text copied, levels below a folder,
 *  bytes fetched from spaces-files for one copy (a file's size and kind are known only by reading it). */
export const filesLimits = (env: Readonly<Record<string, string | undefined>> = process.env) => ({
	files: Math.max(1, Number(env.FORUM_FILES_MAX_FILES || 400)),
	textBytes: Math.max(1, Number(env.FORUM_FILES_MAX_TEXT_KB || 4000)) * 1000,
	depth: Math.max(1, Number(env.FORUM_FILES_MAX_DEPTH || 8)),
	readBytes: Math.max(1, Number(env.FORUM_FILES_MAX_READ_MB || 64)) * 1_000_000,
	fileText: 200_000,
});
/** How long a task's creation waits for a copy beyond the usual wait (FORUM_FILES_WAIT_S, default 120 s). */
export const filesWaitMs = () => Math.max(1000, Number(process.env.FORUM_FILES_WAIT_S || 120) * 1000);

/** A folder of a workspace: its workspace and the path in it ("" is the workspace itself). */
export type Folder = { workspace: string; path: string };
export type RoomLink = { session: string; tenant: string; agent: string; read: Folder | null; project: Folder; by: string; ts: number };
/** What the sources process says of spaces-files (its SourceInfo): the tenant and host peer to register the agents
 *  with; null while it has no agent socket. */
export type FilesInfo = { tenant: string; host: string } | null;

export type FilesRequest = { requestId: string; session: string; ts: number } & (
	| { op: "check"; read?: Folder | null; project?: Folder | null }
	| { op: "snapshot"; blockId: string; ttl: number });
export type CheckAnswer = { agent: string; workspaces: string[]; folders: Array<Folder & { role: "read" | "project"; entries: number }> };
export type SnapshotAnswer = { copy: string; files: number; texts: number; bytes: number; textBytes: number; indexHash: string; tenant: string };
export type FilesResult = { requestId: string; session: string; ok: boolean; code?: string; error?: string; check?: CheckAnswer; snapshot?: SnapshotAnswer; ts: number };

/** The agent of a room in spaces-files. */
export const agentOf = (room: string) => `room-${room}`;

/** A folder as a person names it: a workspace name and a path in it; throws what is wrong. */
export function checkFolder(raw: unknown, what: string): Folder {
	const f = (raw && typeof raw === "object" ? raw : {}) as { workspace?: unknown; path?: unknown };
	const workspace = String(f.workspace ?? "").trim(), path = safePath(String(f.path ?? "").trim());
	if (!workspace || workspace.length > 120 || /[/\\\0]/.test(workspace)) throw new Error(`${what}: name a workspace`);
	if (path === null) throw new Error(`${what}: not a path in the workspace: ${String(f.path ?? "").slice(0, 120)}`);
	return { workspace, path };
}
export const folderName = (f: Folder) => (f.path ? `${f.workspace}/${f.path}` : f.workspace);

/** The kind of a file by its first bytes, never by its name: `text` (valid UTF-8 without NUL), a picture, a PDF, an
 *  archive (also office files), or `binary`. */
export function kindOf(b: Buffer): string {
	const at = (s: string, o = 0) => b.subarray(o, o + s.length).toString("latin1") === s;
	if (at("%PDF-")) return "pdf";
	if (at("\x89PNG\r\n\x1a\n")) return "png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
	if (at("GIF87a") || at("GIF89a")) return "gif";
	if (at("RIFF") && at("WEBP", 8)) return "webp";
	if (at("PK\x03\x04") || at("PK\x05\x06")) return "zip";
	if (b[0] === 0x1f && b[1] === 0x8b) return "gzip";
	if (b.includes(0)) return "binary";
	try { new TextDecoder("utf-8", { fatal: true }).decode(b); return "text"; } catch { return "binary"; }
}

/** One file of a copy: its path in the pack, its size, kind and version in spaces-files, and its text when copied. */
export type Walked = { path: string; size: number; kind: string; version: number; text?: string };
/** What the walk needs of spaces-files (FilesAgentClient). */
export type FilesReader = {
	listPage(workspace: string, path: string, cursor?: string | null): Promise<{ entries: Array<{ name: string; kind: "dir" | "file" }>; next: string | null }>;
	read(workspace: string, path: string): Promise<{ bytes: Buffer; version: number }>;
};

/** The copy of the linked folders: the folder that is only read under `reference/`, the project folder under
 *  `project/`. Refused with the number when a limit is passed; never cut silently. */
export async function walkFolders(client: FilesReader, link: Pick<RoomLink, "read" | "project">, lim = filesLimits()): Promise<Walked[]> {
	const out: Walked[] = [];
	let text = 0, fetched = 0;
	const walk = async (f: Folder, dir: string, prefix: string, depth: number): Promise<void> => {
		if (depth > lim.depth) throw new Error(`${folderName(f)} goes deeper than ${lim.depth} levels below the linked folder`);
		const at = [f.path, dir].filter(Boolean).join("/");
		for (let cursor: string | null = null, first = true; first || cursor; first = false) {
			const page = await client.listPage(f.workspace, at || ".", cursor);
			cursor = page.next;
			for (const e of page.entries) {
				const rel = dir ? `${dir}/${e.name}` : e.name, path = `${prefix}/${rel}`;
				if (e.kind === "dir") {
					// a restricted folder the agent was not granted is not there for it: left out, like in spaces-files
					try { await walk(f, rel, prefix, depth + 1); } catch (err) { if ((err as { code?: string }).code !== "notFound") throw err; }
					continue;
				}
				if (denied(rel) || safePath(path) !== path) continue;
				if (out.length >= lim.files) throw new Error(`The linked folders hold more than ${lim.files} files`);
				const { bytes, version } = await client.read(f.workspace, at ? `${at}/${e.name}` : e.name);
				fetched += bytes.length;
				if (fetched > lim.readBytes) throw new Error(`The linked folders hold more than ${lim.readBytes / 1_000_000} MB`);
				const kind = kindOf(bytes);
				if (kind === "text" && bytes.length <= lim.fileText) {
					text += bytes.length;
					if (text > lim.textBytes) throw new Error(`The text files of the linked folders have more than ${lim.textBytes / 1000} kB together`);
					out.push({ path, size: bytes.length, kind, version, text: bytes.toString("utf8").replace(/\r\n/g, "\n") });
				} else out.push({ path, size: bytes.length, kind: kind === "text" ? "text (too large to copy)" : kind, version });
			}
		}
	};
	if (link.read) await walk(link.read, "", "reference", 1);
	await walk(link.project, "", "project", 1);
	return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The index of a copy: every file with its size; a file that was not copied also with its kind and version. */
export const walkedIndex = (files: Walked[]): IndexEntry[] => files.map((f) => (f.text === undefined ? [f.path, f.size, f.kind, f.version] : [f.path, f.size]));

// ---- the web side ----

const RESULT_WAIT = 20_000;

/** Asks the sources process about spaces-files and waits for the answer; a refusal throws its message. */
export async function askFiles(space: SpaceLike, req: FilesRequest, waitMs: number): Promise<FilesResult> {
	await space.write({ type: "FilesRequest", fields: req as never }, null, waitMs + 60_000);
	let r = null as Awaited<ReturnType<SpaceLike["take"]>>;
	for (const end = Date.now() + waitMs; !r && Date.now() < end; ) r = await space.take({ type: "FilesResult", fields: { requestId: req.requestId } }, Math.min(RESULT_WAIT, Math.max(1, end - Date.now())));
	if (!r) {
		const withdrawn = await space.take({ type: "FilesRequest", fields: { requestId: req.requestId } }, NO_WAIT).catch(() => null);
		throw new Error(withdrawn ? "No sources process with a spaces-files connection answered" : "The sources process did not answer in time");
	}
	const res = r.fields as unknown as FilesResult;
	if (!res.ok) throw new Error(res.error ?? "spaces-files refused the request");
	return res;
}

export async function readLink(space: SpaceLike, room: string): Promise<RoomLink | null> {
	return ((await space.readIfExists({ type: "RoomLink", fields: { session: room } }, NO_WAIT))?.fields as unknown as RoomLink | undefined) ?? null;
}
/** Writes or removes (`link` null) a room's link, replacing the one before in one transaction. */
export async function saveLink(space: SpaceLike, room: string, link: RoomLink | null, ttl?: number): Promise<void> {
	const t = await space.createTransaction(10_000);
	try {
		while (await space.take({ type: "RoomLink", fields: { session: room } }, NO_WAIT, { txn: t.id })) { /* the one before */ }
		if (link) await space.write({ type: "RoomLink", fields: link as never }, t.id, ttl);
		await space.commit(t.id);
	} catch (e) { await space.abort(t.id).catch(() => {}); throw e; }
}

/** The spaces-files connection the sources processes offer (their SourceInfo), the first that has one. */
export async function filesInfo(space: SpaceLike): Promise<FilesInfo> {
	for (const e of await space.readAll({ type: "SourceInfo" }, { limit: 20 })) {
		const f = (e.fields as { files?: FilesInfo }).files;
		if (f) return f;
	}
	return null;
}
