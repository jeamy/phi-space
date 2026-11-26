// The agent side of the agent socket (server/agent-socket.ts): a client an agent host runs for one of its agents, and
// the relative-path tools it hands that agent (docs/zanzibar-agent-filesystem-plan.en.md, phase 4). The host names the
// agent in every call's frame; the tools take a workspace and a path relative to it, never an absolute path.
//
// A mutation keeps one operation ID for its whole life: when the reply is lost (the connection broke, the service was
// busy), the tool sends the same call with the same ID again, and the service answers from its receipt instead of
// applying it twice.
import { socketTransport, type SocketTransport } from "phi-spaces";

export type FilesErrorInfo = { code: string; message: string; currentVersion?: number; retryAfterMs?: number };

export class FilesError extends Error {
	readonly code: string;
	readonly currentVersion?: number;
	readonly retryAfterMs?: number;
	constructor(e: FilesErrorInfo) {
		super(`${e.code}: ${e.message}`);
		this.name = "FilesError";
		this.code = e.code;
		this.currentVersion = e.currentVersion;
		this.retryAfterMs = e.retryAfterMs;
	}
}

export type AgentClientOptions = {
	/** The agent socket's path. */
	path: string;
	/** The agent this client acts for (frame.agent). */
	agent: string;
	/** The service's `maxFileBytes`; sizes the frames (default 16 MiB). */
	maxFileBytes?: number;
	/** How often a call whose reply was lost is sent again (default 3). */
	retries?: number;
	transport?: SocketTransport;
};

export class FilesAgentClient {
	readonly agent: string;
	readonly #t: SocketTransport;
	readonly #retries: number;
	constructor(o: AgentClientOptions) {
		this.agent = o.agent;
		const maxFrameBytes = 4 * Math.ceil((o.maxFileBytes ?? 16 * 1024 * 1024) / 3) + 64 * 1024;
		this.#t = o.transport ?? socketTransport({ path: o.path }, { maxFrameBytes });
		this.#retries = o.retries ?? 3;
	}

	/** One call; a lost reply or `unavailable` is retried with the same arguments, so a mutation keeps its ID. */
	async call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
		const text = JSON.stringify({ op, args, frame: { agent: this.agent } });
		for (let attempt = 0; ; attempt++) {
			let reply: { ok: boolean; value?: unknown; error?: FilesErrorInfo };
			try { reply = JSON.parse(await this.#t.request(text)); }
			catch (e) {
				if (attempt >= this.#retries) throw e;
				await delay(50 * (attempt + 1));
				continue;
			}
			if (reply.ok) return reply.value as T;
			const err = new FilesError(reply.error!);
			if (err.code === "unavailable" && attempt < this.#retries && err.retryAfterMs !== undefined) { await delay(err.retryAfterMs); continue; }
			throw err;
		}
	}

	workspaces(): Promise<string[]> { return this.call("workspaces"); }
	list(workspace: string, path: string): Promise<Array<{ name: string; kind: "dir" | "file" }>> { return this.call("list", { workspace, path }); }
	/** One page of a directory in name order; pass `next` back as `cursor` until it is null. */
	listPage(workspace: string, path: string, cursor: string | null = null, limit?: number): Promise<{ entries: Array<{ name: string; kind: "dir" | "file"; restricted?: true }>; next: string | null }> {
		return this.call("listPage", { workspace, path, cursor, ...(limit === undefined ? {} : { limit }) });
	}
	async read(workspace: string, path: string): Promise<{ bytes: Buffer; version: number }> {
		const r = await this.call<{ contents: string; version: number }>("read", { workspace, path });
		return { bytes: Buffer.from(r.contents, "base64"), version: r.version };
	}
	async operationId(): Promise<string> { return (await this.call<string[]>("issueOperationIds", { count: 1 }))[0]; }
	async write(workspace: string, path: string, bytes: Uint8Array, expectedVersion: number, operationId?: string): Promise<{ version: number }> {
		const id = operationId ?? await this.operationId();
		return this.call("write", { workspace, path, contents: Buffer.from(bytes).toString("base64"), expectedVersion, operationId: id });
	}
	async mkdir(workspace: string, path: string, operationId?: string): Promise<{ status: "created" }> {
		return this.call("mkdir", { workspace, path, operationId: operationId ?? await this.operationId() });
	}
	async move(workspace: string, path: string, toWorkspace: string, toPath: string, operationId?: string): Promise<{ status: "moved" | "unchanged" }> {
		return this.call("move", { workspace, path, toWorkspace, toPath, operationId: operationId ?? await this.operationId() });
	}
	async remove(workspace: string, path: string, expectedVersion: number | null = null, operationId?: string): Promise<{ status: "removed" }> {
		return this.call("remove", { workspace, path, expectedVersion, operationId: operationId ?? await this.operationId() });
	}
	close(): void { this.#t.close(); }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tool as agent frameworks take it: a name, a description, JSON-Schema parameters and an execute function. */
export type FilesTool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(args: Record<string, unknown>): Promise<unknown>;
};

const str = (description: string) => ({ type: "string", description });
const WS = str("the workspace, one of fs_workspaces");
const PATH = str("a path relative to the workspace, segments separated by /; \".\" is the workspace itself for fs_list");

/**
 * The relative-path tools for one agent. Results are JSON for the model; a refusal is `{error, message}` (with
 * `currentVersion` on a version conflict, so the agent can read the newer file before it edits again), never a throw.
 * Text is UTF-8; a file that is not valid UTF-8 is reported as binary with its size and version.
 */
export function filesTools(client: FilesAgentClient): FilesTool[] {
	const safe = (f: (a: Record<string, unknown>) => Promise<unknown>) => async (a: Record<string, unknown>) => {
		try { return await f(a); }
		catch (e) {
			if (!(e instanceof FilesError)) throw e;
			return { error: e.code, message: e.message, ...(e.currentVersion !== undefined ? { currentVersion: e.currentVersion } : {}) };
		}
	};
	return [
		{
			name: "fs_workspaces",
			description: "List the workspaces you can see, your own home among them.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			execute: safe(async () => ({ workspaces: await client.workspaces() })),
		},
		{
			name: "fs_list",
			description: "List the entries of a directory. A large directory comes in pages: when the result has next, call again with cursor set to it.",
			parameters: { type: "object", properties: { workspace: WS, path: PATH, cursor: str("the next of the previous page") }, required: ["workspace", "path"], additionalProperties: false },
			execute: safe(async (a) => {
				const p = await client.listPage(a.workspace as string, a.path as string, (a.cursor as string | undefined) ?? null);
				return p.next === null ? { entries: p.entries } : { entries: p.entries, next: p.next };
			}),
		},
		{
			name: "fs_read",
			description: "Read a file. Returns its text and its version; pass that version to fs_write.",
			parameters: { type: "object", properties: { workspace: WS, path: PATH }, required: ["workspace", "path"], additionalProperties: false },
			execute: safe(async (a) => {
				const { bytes, version } = await client.read(a.workspace as string, a.path as string);
				const text = utf8(bytes);
				return text === null ? { binary: true, size: bytes.length, version } : { text, version };
			}),
		},
		{
			name: "fs_write",
			description: "Write a file. expectedVersion is the version you read, or 0 to create a new file. A versionConflict means someone saved first: read the file again before you edit.",
			parameters: { type: "object", properties: { workspace: WS, path: PATH, text: str("the whole new contents"), expectedVersion: { type: "integer", minimum: 0 } }, required: ["workspace", "path", "text", "expectedVersion"], additionalProperties: false },
			execute: safe(async (a) => client.write(a.workspace as string, a.path as string, Buffer.from(String(a.text), "utf8"), a.expectedVersion as number)),
		},
		{
			name: "fs_mkdir",
			description: "Create one directory; its parent must exist.",
			parameters: { type: "object", properties: { workspace: WS, path: PATH }, required: ["workspace", "path"], additionalProperties: false },
			execute: safe(async (a) => client.mkdir(a.workspace as string, a.path as string)),
		},
		{
			name: "fs_move",
			description: "Move or rename a file or directory, also into another workspace. Needs owner on it and editor on both parents.",
			parameters: { type: "object", properties: { workspace: WS, path: PATH, toWorkspace: WS, toPath: PATH }, required: ["workspace", "path", "toWorkspace", "toPath"], additionalProperties: false },
			execute: safe(async (a) => client.move(a.workspace as string, a.path as string, a.toWorkspace as string, a.toPath as string)),
		},
		{
			name: "fs_remove",
			description: "Remove a file or an empty directory. Pass the version you read as expectedVersion so a newer save is not lost.",
			parameters: { type: "object", properties: { workspace: WS, path: PATH, expectedVersion: { type: "integer", minimum: 1 } }, required: ["workspace", "path"], additionalProperties: false },
			execute: safe(async (a) => client.remove(a.workspace as string, a.path as string, (a.expectedVersion as number | undefined) ?? null)),
		},
	];
}

/** The text of `bytes` when they are valid UTF-8, else null. */
export function utf8(bytes: Uint8Array): string | null {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
