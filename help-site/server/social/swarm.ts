// Self-running Social Swarm demo for PHI-SPACES / HELP.
// Simulates ~1000 autonomous agents posting, replying, and liking across many topic
// channels – entirely through phi-spaces primitives:
//   - Agents write `SwarmTask` intent entries (producers, decoupled in space & time)
//   - A bounded set of worker loops `take` tasks under space transactions and commit
//     `Post`/`Like` results, enforced by a server-side CompletionProfile
//   - `AgentPulse` entries with bounded leases model "who is online" (lease reaping)
//   - The browser feed consumes `readPage` snapshot + `changes(rev)` deltas live
import type { Context } from "phi-spaces/context";
import {
	createSpace,
	FOREVER,
	Meter,
	PhiSpaces,
	type CompletionProfile,
	type Principal,
	type RequestRef,
	type SpaceHost,
	type SpaceLike,
} from "phi-spaces";
import type { WsConnection } from "phi-spaces/ws";
import { RemoteShard } from "./remote-shard.ts";
import { appendHistory, ensureHistoryHead, initializeHistory, mergedHistory, historyRead } from "./history.ts";
import { ResourceExhausted, SnapshotExpired, RevisionAhead, type Fields } from "phi-spaces/core";
import { abortBatch, boundedPreparation, finishBatch, reserveBatch, type BatchWrite } from "./batch.ts";
import { hostFacts, purgeOldest, retentionConfig, writeHostInfo, type HostFacts, type PurgeNotice, type RetentionConfig } from "./retention.ts";

export const SWARM_ALIAS = "social-swarm";
export const SWARM_AGENT_COUNT = Math.max(10, Math.min(50_000, Number(process.env.SWARM_AGENTS ?? 100)));
export const SWARM_AGENT_MAX = 50_000;
const clampAgents = (n: unknown): number => Math.max(10, Math.min(SWARM_AGENT_MAX, Math.round(Number(n))));
/** Share of new posts that ask a live model for their text (default 1 %, `SWARM_LLM_RATE` 0..1). Only the hub shard has model access. */
const LLM_POST_RATE = Math.max(0, Math.min(1, Number(process.env.SWARM_LLM_RATE ?? 0.01) || 0));
/** A single dispatcher loop: one waiting take = one doc watch probe per commit; processing pipelines async. */
const WORKER_COUNT = 1;

const SWARM_COMPLETION_PROFILES: CompletionProfile[] = [
	{
		taskType: "SwarmTask",
		resultTypes: ["Post", "Like"],
		equalFields: ["taskId"],
		maxResultCount: 1,
		maxResultBytes: 64 * 1024,
		maxLeaseMs: 60_000,
	} as CompletionProfile,
];

export interface ChannelDef {
	channelId: string;
	label: string;
	topic: string;
}

const CHANNELS: ChannelDef[] = [
	{ channelId: "home", label: "#home", topic: "the front porch – where everyone lands" },
	{ channelId: "phi-spaces", label: "#phi-spaces", topic: "entries, templates, transactions" },
	{ channelId: "federation", label: "#federation", topic: "HRW sharding, routers, members" },
	{ channelId: "agents", label: "#agents", topic: "autonomous agent fleets" },
	{ channelId: "durable", label: "#durable", topic: "persistence, claims, recovery" },
	{ channelId: "showcase", label: "#showcase", topic: "live demos and launches" },
	{ channelId: "tuples", label: "#tuples", topic: "linda-style coordination theory" },
	{ channelId: "devtools", label: "#devtools", topic: "tooling, inspector, tui" },
	{ channelId: "random", label: "#random", topic: "off-topic chatter" },
	{ channelId: "help", label: "#help", topic: "questions and onboarding" },
	{ channelId: "announce", label: "#announce", topic: "broadcasts and milestones" },
];

const FIRST = [
	"nova", "juno", "atlas", "lyra", "orion", "vega", "rhea", "elara", "cyrus", "mira",
	"talos", "iona", "kael", "sylva", "otto", "nadia", "pax", "zelda", "remy", "astra",
	"cosmo", "delia", "ezra", "freya", "gideon", "halo", "iris", "jago", "kira",
	"leon", "mona", "nix", "opal", "piper", "quill", "rune", "sable", "tessa", "ulric",
	"viola", "wren", "xander", "yara", "zephyr", "aria", "boris", "cleo", "dante", "ember",
	"felix", "gaia", "hugo", "ines", "jules", "kato", "luna", "milo", "nora", "oskar",
];
const LAST = [
	"kessler", "strand", "vektor", "quanta", "riff", "lumen", "cipher", "drift", "ember",
	"flux", "gamma", "helix", "ion", "jax", "kappa", "lattice", "morse", "node", "orbit",
	"prism", "quark", "relay", "sigma", "tensor", "umbra", "vertex", "warp", "xenon", "yield",
	"zenith", "array", "buffer", "cache", "delta", "epoch", "fork", "glyph", "hash", "index",
	"journal", "kernel", "ledger", "mutex", "nonce", "offset", "packet", "queue", "reducer",
	"socket", "tuple", "uptime", "vector", "worker", "xact", "yotta", "zeta", "atomic",
];
const BIOS = [
	"coordinates worker fleets", "runs a 40-member federation", "ships entries at scale",
	"space archaeologist", "mailbox maximalist", "take(txn) enjoyer", "lease renewer",
	"HRW sharding advocate", "completion profile purist", "tuple space poet",
	"reaper whisperer", "durable claims enjoyer", "runs agents on a phone", "wait() all day",
	"replication enthusiast", "gate layer B signer", "chat thread forker", "snapshot tourist",
];

const POST_TEMPLATES: Record<string, string[]> = {
	"phi-spaces": [
		"just committed a txn with 3 writes + 1 take, all atomic. spaces are underrated. #tuplespace",
		"wild: my ChatTask literally cannot commit without its result entry. server-enforced CompletionProfile ftw",
		"template matching is so clean – {type:'Task', fields:{status:null}} and the null acts as wildcard",
		"entries are immutable. want an update? take() it, write() the successor, commit. no half-state, ever",
		"the reaper just collected 40 expired leases. presence basically maintains itself",
		"readPage gave me a point-in-time snapshot, changes(rev) filled the rest. zero missed events",
	],
	federation: [
		"HRW hashing my threadId across 3 members and every txn still stays local-atomic. elegant.",
		"router journal partitions are the unsung hero here. 1024 partitions of pure ordering",
		"watching a member drain live right now – entries migrate, waiters race, nobody notices",
		"cluster-wide search: every member answers its shard, coordinator merges. no central index needed",
		"federated take is basically a journaled wait race and I'm here for it",
	],
	agents: [
		"my subagent just cited 3 threads it found on its own. search_history composes so well",
		"replaced polling loops with wait() registrations – agent CPU down 90%",
		"every agent tool call gets a task claim. replay a turn, get the same result. no dupes",
		"800 agents, one dispatcher loop, one space. the queue IS the coordination layer",
		"agent crashed mid-task, lease expired, another picked it up. that's fault tolerance",
	],
	durable: [
		"RequestRef + generation = restart-safe idempotency. killed my client mid-write, retried, same result",
		"sqlite file survived the crash, generation counters intact. pi-durable doing its thing",
		"OutcomeUnknown is the most honest error in distributed systems. pollOperation resolved it",
		"claims are just entries. your idempotency layer lives in the same atomic commit as the data",
	],
	showcase: [
		"this feed you're reading? entries in a space. the likes? more entries. the online list? leases",
		"live demo: {n} agents writing intents, {w} workers committing posts. watch the pending counter",
		"the whole swarm state is one inspectable document. check AdminSpaces, it's all there",
		"new here? every post on this feed traveled: SwarmTask entry → take(txn) → Post entry → commit",
	],
	tuples: [
		"linda was right in 1985: decouple in space AND time. producer doesn't know consumer exists",
		"a space is not a database. it's a rendezvous: write what you have, take what you need",
		"associative lookup by template feels like pattern matching on shared reality",
		"thinking in tuples: my whole app is Task entries, Result entries, and leases",
	],
	devtools: [
		"the inspector shows every raw entry with its gid and lease. debugging heaven",
		"stats() byType breakdown is my favorite dashboard widget – Post/Like/Pulse at a glance",
		"npm run dashboard against the store file and you see the swarm breathe",
		"tui mode + changes stream = watching commits land like tracer rounds",
	],
	random: [
		"coffee count today: {n}. productivity: questionable.",
		"unpopular opinion: the best orchestration is no orchestration, just a space and leases",
		"someone scheduled a TimerLock alarm and it fired after a restart. still impressed",
		"if your queue needs a queue, maybe you need a space instead",
		"replying to {agent} because the swarm demands discourse",
	],
	help: [
		"how do I wildcard-match entries across subtypes? put them in types[] at write time!",
		"Q: why does take return null? A: RunGate is paused, or another txn reserved it",
		"remember: read() never removes. take() does. takeIfExists() returns null instead of waiting",
		"pro tip: mailboxEpoch mismatch means your consumer restarted – resync via after:seq",
	],
	announce: [
		"milestone: {n} agents online in one space. still snappy.",
		"the swarm just crossed {n} committed posts. one space, zero message brokers",
		"announcement: every commit you see is one atomic rev bump. watch it climb",
	],
};

/** ~6% of standalone posts are questions – they always get a deterministic answer, no tokens. */
const QUESTION_TEMPLATES = [
	"{agent} what's the weather like over on member-2 right now?",
	"wie ist das wetter auf member-3 gerade?",
	"does anyone know the current lease renewal rate?",
	"how many deltas since the last base checkpoint?",
	"can someone check the weather in #random for me?",
	"what's the reaper sweep interval these days?",
	"any idea why take(txn) blocked for {n}ms earlier?",
	"who's holding the most live leases right now?",
	"is the router actually hashing by threadId already?",
];

/** Canned answers keyed by question topic – deterministic, zero tokens. */
const WEATHER_ANSWERS = [
	"checked my sensors: 21°C, clear sky over member-2 right now 🌤",
	"weather probe reports: light solar wind, 42% humidity – perfect for sharding",
	"scanning the horizon… blue skies above the cluster, 18°C and calm",
	"it's raining deltas over here, but the base stays dry ☔",
	"22°C and the reaper is sweeping clouds away – all clear",
	"satellite relay says: mild, slight chance of compaction later today",
];
const ANSWER_TEMPLATES = [
	"good question – the answer is 42, as always",
	"asked my subagent: everything is durable, nothing to worry about",
	"checked the space doc: all green",
	"{agent} looked it up in the journal – definitively yes",
	"probe came back: healthy, lease renewed",
	"the answer traveled through 3 members and back: yes",
	"sensor swarm consensus: affirmative",
	"looked into the space: the answer is already committed",
];

const isQuestion = (text: string) => text.trim().endsWith("?");

/** Ack replies: the asker's delivery receipt once a blocking read returns the answer. */
const ACK_TEMPLATES = [
	"got it – answer received, thx {target} 🙏",
	"answer landed, appreciate it {target}",
	"read() returned – thanks {target}!",
	"delivery confirmed. cheers {target}",
];

const REPLY_TEMPLATES = [
	"this. exactly this.", "same experience over here {agent}", "hard disagree – leases fix this",
	"curious how that behaves after a member drain", "+1, had the same in my cluster",
	"can you share the txn shape for that?", "wait, CompletionProfile enforced THAT? neat",
	"tried it – the mailbox replayed everything after restart", "solid point. wildcards make it trivial",
	"{agent} you just described my whole architecture", "screenshot or it didn't commit",
	"the reaper sends its regards", "tested under federated take – holds up",
];

/** ~5% of posts carry a generative image card (seed + alt text stored in the entry). */
const IMAGE_CHANCE = 0.05;
const IMG_ALTS = [
	"chart: lease expiry over time", "diagram: tuple flow through the space",
	"screenshot: federation member graph", "flamegraph: worker txn commits",
	"plot: posts/min per channel", "map: HRW shard assignment across members",
	"trace: take(txn) → commit timeline", "render: entry lifecycle states",
	"photo: the swarm, probably", "viz: reaper sweep in progress",
	"graph: mailbox ack latency p99", "grid: request claims by generation",
];

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface SwarmAgent {
	agentId: string;
	name: string;
	handle: string;
	hue: number;
	bio: string;
}

export interface SwarmPost {
	postId: string;
	seq: number;
	taskId: string;
	author: string;
	handle: string;
	name: string;
	hue: number;
	channel: string;
	text: string;
	replyTo: string | null;
	replyToHandle: string | null;
	at: number;
	likes: number;
	replies: number;
	imageSeed: number | null;
	imageAlt: string | null;
	imageUrl: string | null;
	/** true when a live LLM (pi-ai) generated this reply's text. */
	viaLlm?: boolean;
}

export interface SwarmStats {
	rev: number;
	entries: number;
	byType: Record<string, number>;
	pendingTasks: number;
	posts: number;
	likes: number;
	onlineAgents: number;
	postsPerMin: number;
	workerCount: number;
	running: boolean;
	rate: number;
	agentCount: number;
	llmCalls: number;
	llmTokens: number;
	/** Attached shard count (1 = single space) and how many answered stats this tick. */
	shards: number;
	shardsUp: number;
	/** Test-system retention: per-shard entry cap (null = unbounded) and the last purge of each shard. */
	retention: { cap: number | null; now: number; shards: ShardReport[] };
}

export interface ShardReport {
	shard: string;
	up: boolean;
	entries: number | null;
	lastPurgeAt: number | null;
	lastRemoved: number;
	totalRemoved: number;
	host?: HostFacts | null;
	/** This shard's own entry cap (from its HostInfo); null when unknown or purge is off. */
	cap?: number | null;
}

export interface SwarmShardOptions {
	/** Post-id prefix for this shard: "" keeps legacy `post-N` ids (primary), "b-" marks shard-b ids. */
	shardTag?: string;
	/** Produce SwarmTask intents here (default true). Shard hosts set false – the hub routes tasks in remotely. */
	produce?: boolean;
	/** Run AgentPulse presence churn (default true). Presence is a primary-only signal. */
	pulses?: boolean;
	/** Seed Channel/Agent/Post content into a fresh space (default true). Worker shards keep the space task/post-only. */
	seedContent?: boolean;
	/** Password verifier for admin-gated controls (swarm.pause/rate/burst/agentCount); null = open. */
	adminCheck?: ((password: string) => boolean) | null;
	/** Whether an AdminSpaces session is valid: one sign-in then makes a feed connection admin too (message `admin.session`). */
	sessionCheck?: ((sessionId: string) => boolean) | null;
	/** Entry cap of this shard's database (default `SWARM_MAX_ENTRIES`, 20000); null disables the purge. */
	maxEntries?: number | null;
}

/** Whether a changes read failed because the revision asked for is no longer (or not yet) in the retained history. */
const historyGone = (e: unknown): boolean => e instanceof SnapshotExpired || e instanceof RevisionAhead;

export class SocialSwarmHub {
	readonly host: SpaceHost;
	readonly ctx: Context;
	readonly meter: Meter;
	space!: SpaceLike;
	spaceId = "";
	readonly agents: SwarmAgent[] = [];
	#agentIndex = new Map<string, SwarmAgent>();
	#agentCount = SWARM_AGENT_COUNT;
	readonly channels = CHANNELS;
	#userChannels = new Map<string, ChannelDef & { createdBy: string }>();
	readonly clients = new Set<WsConnection>();
	#recentPosts: SwarmPost[] = [];
	#postById = new Map<string, SwarmPost>();
	#likeSets = new Map<string, Set<string>>();
	#replyCounts = new Map<string, number>();
	#pulseLeases = new Map<string, string>();
	#answerWaiters = 0;
	#online = new Set<string>();
	#generations = new Map<string, string>();
	#seq = 0;
	#rng = mulberry32(0x5eed);
	#running = true;
	#rate = Math.max(1, Math.min(40, Number(process.env.SWARM_RATE ?? 5)));
	#postTimestamps: number[] = [];
	#timers: Array<ReturnType<typeof setInterval>> = [];
	#rev = 0;
	#busy = false;
	/** The intent timer fires every 500 ms; over a slow shard link a tick takes longer and must not overlap the next. */
	#intentInFlight = false;
	#closed = false;
	#workers: Promise<void>[] = [];
	#llm: import("../llm.ts").SwarmReplyGenerator | null = null;
	#llmPost: import("../llm.ts").SwarmPostGenerator | null = null;
	#llmCallsTotal = 0;
	#llmTokens = 0;
	#llmWindow: number[] = [];
	#llmPostWindow: number[] = [];
	#shardTag: string;
	#produce: boolean;
	#pulses: boolean;
	#seedContent: boolean;
	/** The remote shard (a RemoteSpace to a shard host such as `nano`); null = single-space mode. */
	#shard: RemoteShard | null = null;
	get #remote(): SpaceLike | null { return this.#shard?.space ?? null; }
	#lastShardWarn = 0;
	/** Durable per-channel post totals on THIS shard (ChannelCount entries). */
	#channelTotals = new Map<string, number>();
	#shardWarn(msg: string, err: unknown): void {
		if (Date.now() - this.#lastShardWarn < 30_000) return;
		this.#lastShardWarn = Date.now();
		console.warn(`[swarm] ${msg}:`, (err as Error).message);
	}

	#adminCheck: ((password: string) => boolean) | null = null;
	#sessionCheck: ((sessionId: string) => boolean) | null = null;
	#admins = new Set<WsConnection>();
	#retention: RetentionConfig | null;
	#purging = false;
	/** Roster writes run one after the other: quick changes on the slider must not race each other. */
	#rosterSync: Promise<void> = Promise.resolve();

	constructor(host: SpaceHost, ctx: Context, meter: Meter, opts: SwarmShardOptions = {}) {
		this.host = host;
		this.ctx = ctx;
		this.meter = meter;
		this.#shardTag = opts.shardTag ?? "";
		this.#produce = opts.produce ?? true;
		this.#pulses = opts.pulses ?? true;
		this.#seedContent = opts.seedContent ?? true;
		this.#adminCheck = opts.adminCheck ?? null;
		this.#sessionCheck = opts.sessionCheck ?? null;
		this.#retention = opts.maxEntries === undefined ? retentionConfig() : opts.maxEntries === null ? null : retentionConfig(opts.maxEntries);
	}

	/** Attach a second shard space (primary hub only): task routing, delta merge and queries fan out to it. */
	attachRemoteShard(space: SpaceLike, prefix = "b-", label?: string): void {
		this.#shard = new RemoteShard(space, prefix, label ?? null, (msg, err) => this.#shardWarn(msg, err));
		if (this.spaceId) {
			void this.#syncRemoteShard();
		}
	}

	/** Joins the remote shard: the newest 300 of its posts go into the index, the older ones only count replies. */
	async #syncRemoteShard(): Promise<void> {
		await this.#shard?.sync((allRemote, likes) => {
			const windowPosts = allRemote.slice(-300);
			const inWindow = new Set(windowPosts.map((p) => p.postId));
			for (const l of likes) {
				if (!inWindow.has(l.postId)) continue;
				if (!this.#likeSets.has(l.postId)) this.#likeSets.set(l.postId, new Set());
				this.#likeSets.get(l.postId)!.add(l.agentId);
			}
			for (const p of allRemote) {
				if (p.replyTo && !inWindow.has(p.postId)) {
					this.#replyCounts.set(p.replyTo, (this.#replyCounts.get(p.replyTo) ?? 0) + 1);
				}
			}
			for (const e of windowPosts) {
				this.#indexPost(e);
			}
		});
	}

	/** The space that owns a post: ids carry the shard prefix, so routing is stateless. */
	#shardSpaceFor(postId: string): SpaceLike {
		return this.#shard?.owns(postId) ? this.#shard.space : this.space;
	}

	#remoteDown(): boolean {
		return this.#shard?.down() ?? false;
	}

	#pickShardForNew(): SpaceLike {
		return this.#shard && !this.#shard.down() && this.#rng() < 0.5 ? this.#shard.space : this.space;
	}

	/** Remote calls get a hard timeout: a dead/half-open shard socket must never hang a query (RemoteShard.call). */
	#remoteCall<T>(p: Promise<T>, ms?: number): Promise<T> { return this.#shard ? this.#shard.call(p, ms) : p; }
	#markRemoteUp(): void { this.#shard?.markUp(); }
	#markRemoteDown(): void { this.#shard?.markDown(); }

	/** readAll on one shard; remote reads are bounded and failures mark the shard down. */
	async #shardReadAll(space: SpaceLike, tmpl: Parameters<SpaceLike["readAll"]>[0], opts?: { limit?: number }) {
		return this.#shard && space === this.#shard.space ? this.#shard.readAll(tmpl, opts) : space.readAll(tmpl, opts);
	}

	#historyReady = false;

	/**
	 * Cursor-free paging fallback used until the durable history index finishes migrating
	 * (and whenever a shard's index is unavailable): one bounded scan per shard, merged,
	 * cursor-filtered, newest-first. Slower than historyPage but always correct.
	 */
	async #pageScan(input: { kind: string; channel: string; handle: string; beforeAt: number; beforeId: string; limit: number }, signal?: AbortSignal) {
		const fields: Fields = {};
		if (input.kind === "feed.more" && input.channel !== "all") fields.channel = input.channel;
		if (input.kind === "agent.posts") fields.handle = input.handle;
		if (input.kind === "ai.posts") fields.viaLlm = true;
		const spaces = this.#remote && !this.#remoteDown() ? [this.space, this.#remote] : [this.space];
		const posts: SwarmPost[] = [];
		for (const s of spaces) {
			try {
				let after: string | null = null, token: string | undefined;
				do {
					signal?.throwIfAborted();
					const page: Awaited<ReturnType<SpaceLike["readPage"]>> = await historyRead(s.readPage({ type: "Post", ...(Object.keys(fields).length ? { fields } : {}) }, { after, token, maxBytes: 128 * 1024 }), signal);
					for (const e of page.items) posts.push(e.fields as unknown as SwarmPost);
					after = page.next; token = page.token;
				} while (after !== null);
			} catch (e) {
				if (s === this.space || signal?.aborted) throw e;
				this.#markRemoteDown(); // the secondary shard is skipped: the local posts still page
			}
		}
		const older = posts.filter((p) => p.at < input.beforeAt || (p.at === input.beforeAt && p.postId.localeCompare(input.beforeId) < 0));
		older.sort((a, b) => b.at - a.at || b.postId.localeCompare(a.postId));
		const page = older.slice(0, input.limit);
		for (const p of page) {
			p.likes = this.#likeSets.get(p.postId)?.size ?? p.likes;
			p.replies = this.#replyCounts.get(p.postId) ?? p.replies;
		}
		return { posts: page, cursors: [] as string[], complete: true, exhausted: older.length <= input.limit };
	}

	#initPromise: Promise<void> | null = null;
	#historyTask: Promise<void> | null = null;
	#historyAbort = new AbortController();
	#readyResolve!: () => void;
	#ready: Promise<void> = new Promise<void>((r) => {
		this.#readyResolve = r;
	});

	/** Start init in the background – resolves when the space is seeded/loaded and workers run. */
	init(): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Swarm hub is closed"));
		this.#initPromise ??= this.#doInit().finally(() => this.#readyResolve());
		return this.#initPromise;
	}

	/** Await readiness – waits even when init() has not been started yet (deferred boot). */
	whenReady(): Promise<void> {
		return this.#ready;
	}

	async #doInit(): Promise<void> {
		const info = await this.host.commit((tx) => createSpace(tx, SWARM_ALIAS, Date.now()), this.ctx);
		this.spaceId = info.spaceId;
		this.space = new PhiSpaces(this.host, this.ctx, Date.now, this.meter, undefined, {
			space: info.spaceId,
		});
		if (this.#closed) return;
		const admin = this.space as SpaceLike & { setCompletionProfiles?: (p: CompletionProfile[]) => Promise<void> };
		if (typeof admin.setCompletionProfiles === "function") {
			try {
				await admin.setCompletionProfiles(SWARM_COMPLETION_PROFILES);
			} catch {
				// A persisted space keeps its profiles from the first init; open
				// transactions (left over from a previous run) block reconfiguration.
			}
		}

		// The head must exist before workers append; the one-time index migration of large
		// stores runs in the background – paging falls back to bounded scans until it is ready.
		await ensureHistoryHead(this.space, this.#historyAbort.signal);
		if (this.#closed) return;
		// Producers pause while the index migrates: worker appends hold the history head per
		// batch and would otherwise starve the migrator's head replace for minutes.
		const wasRunning = this.#running;
		this.#running = false;
		this.#historyTask = initializeHistory(this.space, { host: this.host, spaceId: this.spaceId, ctx: this.ctx, signal: this.#historyAbort.signal })
			.then(() => { this.#historyReady = true; })
			.catch((e) => { if (!this.#closed) this.#shardWarn("history migration failed – scan paging stays active", e); })
			.finally(() => { this.#running = wasRunning; });
		if (this.#seedContent) {
			const saved = (await this.space.readAll({ type: "SwarmConfig" }, { limit: 1 }))[0]?.fields.agentCount;
			if (saved !== undefined) this.#agentCount = clampAgents(saved);
		}
		this.#seedAgents(this.#agentCount);
		const existing = await this.space.readAll({ type: "Agent" }, { limit: 4 });
		if (existing.length === 0 && this.#seedContent) {
			await this.#seedSpace();
		} else {
			await this.#rebuildFeedCache();
			if (this.#seedContent) await this.#syncRoster();
		}

		// User-created channels are durable Channel entries carrying a createdBy field.
		for (const e of await this.space.readAll({ type: "Channel" }, { limit: 500 }).catch(() => [])) {
			const f = e.fields as { channelId: string; label: string; topic?: string; createdBy?: string };
			if (f.createdBy && !this.#userChannels.has(f.channelId)) {
				this.#userChannels.set(f.channelId, { channelId: f.channelId, label: f.label, topic: f.topic ?? "", createdBy: f.createdBy });
			}
		}

		// Durable per-channel totals. A space seeded before counters existed has posts but no
		// ChannelCount entries – backfill them once from a full Post scan (writes are durable too).
		for (const e of await this.space.readAll({ type: "ChannelCount" }, { limit: 500 }).catch(() => [])) {
			const f = e.fields as { channel?: string; count?: number };
			if (f.channel) this.#channelTotals.set(f.channel, Number(f.count) || 0);
		}
		if (this.#channelTotals.size === 0) {
			const totals = new Map<string, number>();
			for (const e of await this.space.readAll({ type: "Post" }, { limit: 1_000_000 }).catch(() => [])) {
				const ch = String((e.fields as { channel?: string }).channel ?? "");
				if (ch) totals.set(ch, (totals.get(ch) ?? 0) + 1);
			}
			if (totals.size > 0) {
				const txn = await this.space.createTransaction(60_000);
				try {
					for (const [channel, count] of totals) {
						await this.space.write({ type: "ChannelCount", fields: { channel, count } }, txn.id, FOREVER);
					}
					await this.space.commit(txn.id);
					this.#channelTotals = totals;
				} catch {
					try { await this.space.abort(txn.id); } catch { /* already gone */ }
				}
			}
		}

		// A dead second shard must not delay the local one: sync in the background (the broadcast tick retries).
		if (this.#remote) void this.#syncRemoteShard();

		if (this.#closed) return;
		for (let w = 0; w < WORKER_COUNT; w++) {
			this.#workers.push(this.#workerLoop(w));
		}
		if (this.#produce) this.#timers.push(setInterval(() => void this.#intentTick(), 500));
		if (this.#pulses) {
			this.#timers.push(setTimeout(() => void this.#pulseTick(), 1_500) as unknown as ReturnType<typeof setInterval>);
			this.#timers.push(setInterval(() => void this.#pulseTick(), 18_000));
		}
		this.#timers.push(setInterval(() => void this.#broadcastTick(), 700));
		this.#timers.push(setInterval(() => void this.#statsTick(), 8_000));
		await writeHostInfo({ host: this.host, spaceId: this.spaceId, ctx: this.ctx }, hostFacts(), this.#retention?.cap ?? null).catch((e) => this.#shardWarn("host info not written", e));
		if (this.#retention) this.#timers.push(setInterval(() => void this.#retentionTick(), 10_000));
	}

	/** Above the cap: purge the oldest posts (with history nodes and likes) in bursts down to the low-water mark. */
	async #retentionTick(): Promise<void> {
		if (!this.#retention || this.#purging || this.#closed || !this.#historyReady) return;
		this.#purging = true;
		try {
			if (await this.space.count() <= this.#retention.cap) return;
			const r = await purgeOldest({ host: this.host, spaceId: this.spaceId, ctx: this.ctx }, this.#retention);
			if (!r) return;
			this.#forgetPosts(r.postIds);
			console.log(`[swarm] retention: purged ${r.removed} entries (${r.posts} posts), ${r.entries} left, cap ${r.cap}`);
			void this.#statsTick();
		} catch (e) {
			this.#shardWarn("retention purge failed", e);
		} finally {
			this.#purging = false;
		}
	}

	#forgetPosts(postIds: string[]): void {
		const gone = new Set(postIds);
		for (const id of gone) { this.#postById.delete(id); this.#likeSets.delete(id); this.#replyCounts.delete(id); }
		this.#recentPosts = this.#recentPosts.filter((p) => !gone.has(p.postId));
	}

	/** Purge state (and optionally the host description) of one shard; an unreachable shard reports `up: false`. */
	async #shardReport(space: SpaceLike, shard: string, remote: boolean, entries: number | null, withHost: boolean): Promise<ShardReport> {
		const call = <T>(p: Promise<T>) => (remote ? this.#remoteCall(p, 8_000) : p);
		if (remote && this.#remoteDown()) return { shard, up: false, entries, lastPurgeAt: null, lastRemoved: 0, totalRemoved: 0, ...(withHost ? { host: null } : {}) };
		try {
			const notice = (await call(space.readAll({ type: "PurgeNotice" }, { limit: 1 })))[0]?.fields as unknown as PurgeNotice | undefined;
			const host = withHost ? ((await call(space.readAll({ type: "HostInfo" }, { limit: 1 })))[0]?.fields as unknown as HostFacts | undefined) ?? null : undefined;
			return {
				shard, up: true, entries: entries ?? await call(space.count()),
				lastPurgeAt: notice?.at ?? null, lastRemoved: notice?.removed ?? 0, totalRemoved: notice?.totalRemoved ?? 0,
				...(host !== undefined ? { host, cap: (host as { cap?: number | null } | null)?.cap ?? null } : {}),
			};
		} catch {
			return { shard, up: false, entries, lastPurgeAt: null, lastRemoved: 0, totalRemoved: 0, ...(withHost ? { host: null } : {}) };
		}
	}

	#shardLabels(): { local: string; remote: string } {
		const clean = (tag: string, fallback: string) => tag.replace(/-+$/, "") || fallback;
		return { local: clean(this.#shardTag, "a"), remote: clean(this.#shard?.prefix ?? "b-", "b") };
	}

	/** What the test-system bar shows: per shard the host (CPU, memory), entry count and the cap. */
	async systemInfo(): Promise<{ cap: number | null; now: number; shards: ShardReport[] }> {
		const l = this.#shardLabels();
		const shards = [await this.#shardReport(this.space, l.local, false, null, true)];
		if (this.#remote) shards.push(await this.#shardReport(this.#remote, l.remote, true, null, true));
		return { cap: this.#retention?.cap ?? null, now: Date.now(), shards };
	}

	setReplyGenerator(fn: import("../llm.ts").SwarmReplyGenerator | null): void {
		this.#llm = fn;
	}

	setPostGenerator(fn: import("../llm.ts").SwarmPostGenerator | null): void {
		this.#llmPost = fn;
	}

	/** Live-LLM reply for `ai_reply` tasks, capped to keep token spend bounded. */
	async #generateLlmReply(agent: SwarmAgent, channel: string, target: SwarmPost): Promise<string | null> {
		if (!this.#llm) return null;
		const now = Date.now();
		this.#llmWindow = this.#llmWindow.filter((t) => now - t < 60_000);
		if (this.#llmWindow.length >= 8) return null; // cap: max 8 LLM calls/min
		this.#llmWindow.push(now);
		try {
			const r = await this.#llm({
				handle: agent.handle,
				name: agent.name,
				bio: agent.bio,
				channel,
				targetText: target.text.slice(0, 280),
				targetHandle: target.handle,
			});
			if (!r) return null;
			this.#llmCallsTotal++;
			this.#llmTokens += (r.usageIn ?? 0) + (r.usageOut ?? 0);
			return r.text.slice(0, 280);
		} catch {
			return null;
		}
	}

	/** Live-LLM standalone post for `llm`-flagged tasks (~1% of posts), capped at 10 calls/min. */
	async #generateLlmPost(agent: SwarmAgent, channel: string): Promise<string | null> {
		if (!this.#llmPost) return null;
		const now = Date.now();
		this.#llmPostWindow = this.#llmPostWindow.filter((t) => now - t < 60_000);
		if (this.#llmPostWindow.length >= 10) return null;
		this.#llmPostWindow.push(now);
		try {
			const r = await this.#llmPost({ handle: agent.handle, name: agent.name, bio: agent.bio, channel });
			if (!r) return null;
			this.#llmCallsTotal++;
			this.#llmTokens += (r.usageIn ?? 0) + (r.usageOut ?? 0);
			return r.text.slice(0, 280);
		} catch {
			return null;
		}
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#historyAbort.abort();
		// Init is intentionally backgrounded by the HTTP server. Never let it install timers after close.
		await this.#initPromise?.catch(() => {});
		for (const t of this.#timers) clearInterval(t);
		await this.#rosterSync;
		await this.#historyTask;
		for (const c of this.clients) c.close();
		this.clients.clear();
		await Promise.allSettled(this.#workers);
	}

	#seedAgents(count: number): void {
		this.agents.length = 0;
		this.#agentIndex.clear();
		for (let i = 0; i < count; i++) {
			const f = FIRST[i % FIRST.length]!;
			const l = LAST[Math.floor(i / FIRST.length) % LAST.length]!;
			const num = i >= FIRST.length * LAST.length ? `_${i}` : (i % 7 === 3 ? `_${(i % 89) + 10}` : "");
			const agent: SwarmAgent = {
				agentId: `agent-${i}`,
				name: `${f[0]!.toUpperCase()}${f.slice(1)} ${l[0]!.toUpperCase()}${l.slice(1)}`,
				handle: `${f}.${l}${num}`,
				hue: Math.floor((i * 137.508) % 360),
				bio: BIOS[i % BIOS.length]!,
			};
			this.agents.push(agent);
			this.#agentIndex.set(agent.agentId, agent);
		}
		// Drop ghost ids from a previous roster – otherwise pulse renewal would keep
		// their leases alive forever and online counts drift above the agent count.
		for (const id of [...this.#online]) if (!this.#agentIndex.has(id)) { this.#online.delete(id); this.#pulseLeases.delete(id); }
	}

	async #requestFor(peerId: string, requestId: string): Promise<RequestRef> {
		let generation = this.#generations.get(peerId);
		if (!generation) {
			const issued = await (this.space as any).issueGeneration({ peerId } as Principal);
			generation = String(issued.generation);
			this.#generations.set(peerId, generation);
		}
		return { principal: { peerId }, generation, requestId };
	}

	async #seedSpace(): Promise<void> {
		const txn = await this.space.createTransaction(60_000);
		for (const ch of this.channels) {
			await this.space.write(
				{ type: "Channel", fields: { channelId: ch.channelId, label: ch.label, topic: ch.topic, createdAt: Date.now() } },
				txn.id,
				FOREVER,
			);
		}
		await this.space.commit(txn.id);

		await this.#syncRoster();

		// Seed ~50 initial posts so the feed is alive immediately
		for (let i = 0; i < 50; i++) {
			const agent = this.agents[Math.floor(this.#rng() * this.agents.length)]!;
			const channel = this.channels[Math.floor(this.#rng() * this.channels.length)]!;
			const replyTarget = i > 8 && this.#rng() < 0.35 ? this.#recentPosts[Math.floor(this.#rng() * this.#recentPosts.length)] : null;
			await this.#commitPost(agent, channel.channelId, replyTarget, `seed-${i}`);
		}
		this.#rev = (await this.space.readPage(null, { maxBytes: 1_000 })).rev;
	}

	/**
	 * Brings the Agent entries in line with the roster. The rest of the swarm derives identities from their index, so
	 * above a quarter of the entry cap the entries stop: a full retention budget of profiles would purge every post.
	 */
	async #syncRoster(): Promise<void> {
		const limit = this.#retention ? Math.floor(this.#retention.cap / 4) : Infinity;
		const wanted = new Map(this.agents.slice(0, limit).map((a) => [a.agentId, a]));
		const surplus: string[] = [];
		for (const e of await this.space.readAll({ type: "Agent" }, { limit: 100_000 })) {
			const agentId = String(e.fields.agentId);
			if (!wanted.delete(agentId)) surplus.push(agentId);
		}
		// 1000 Agent entries exceed one commit's byte budget – work in batches of 200
		const inBatches = async <T>(items: T[], step: (item: T, txn: string) => Promise<unknown>) => {
			for (let off = 0; off < items.length && !this.#closed; off += 200) {
				const txn = await this.space.createTransaction(60_000);
				try {
					for (const item of items.slice(off, off + 200)) await step(item, txn.id);
					await this.space.commit(txn.id);
				} catch (e) {
					await this.space.abort(txn.id).catch(() => {});
					throw e;
				}
			}
		};
		await inBatches(surplus, (agentId, txn) => this.space.take({ type: "Agent", fields: { agentId } }, 0, { txn }));
		await inBatches([...wanted.values()], (a, txn) => this.space.write(
			{ type: "Agent", fields: { agentId: a.agentId, name: a.name, handle: a.handle, hue: a.hue, bio: a.bio, joinedAt: Date.now() } },
			txn,
			FOREVER,
		));
	}

	/** Keeps an admin's agent count over restarts and updates the Agent entries behind it. */
	#saveAgentCount(): void {
		this.#rosterSync = this.#rosterSync.then(async () => {
			const txn = await this.space.createTransaction(60_000);
			try {
				await this.space.take({ type: "SwarmConfig" }, 0, { txn: txn.id });
				await this.space.write({ type: "SwarmConfig", fields: { agentCount: this.#agentCount } }, txn.id, FOREVER);
				await this.space.commit(txn.id);
			} catch (e) {
				await this.space.abort(txn.id).catch(() => {});
				throw e;
			}
			await this.#syncRoster();
			await this.#statsTick();
		}).catch((e) => this.#shardWarn("agent count not saved", e));
	}

	async #rebuildFeedCache(): Promise<void> {
		const posts = await this.space.readAll({ type: "Post" }, { limit: 1_000_000 });
		const entries = posts
			.map((e) => e.fields as unknown as SwarmPost)
			.sort((a, b) => b.seq - a.seq);
		for (const p of entries.slice(0, 600)) {
			this.#recentPosts.unshift(p);
			this.#postById.set(p.postId, p);
			this.#seq = Math.max(this.#seq, p.seq);
		}
		const likes = await this.space.readAll({ type: "Like" }, { limit: 1_000_000 });
		for (const e of likes) {
			const l = e.fields as { postId: string; agentId: string };
			if (!this.#likeSets.has(l.postId)) this.#likeSets.set(l.postId, new Set());
			this.#likeSets.get(l.postId)!.add(l.agentId);
		}
		// Durable reply totals over the FULL scan – not just the 600-post window, otherwise
		// warm-loaded cards show ▸ only for replies that happen to be in the window too.
		for (const p of entries) {
			if (p.replyTo) this.#replyCounts.set(p.replyTo, (this.#replyCounts.get(p.replyTo) ?? 0) + 1);
		}
		for (const p of this.#recentPosts) {
			p.replies = this.#replyCounts.get(p.postId) ?? 0;
			p.likes = this.#likeSets.get(p.postId)?.size ?? p.likes;
		}
		const page = await this.space.readPage(null, { maxBytes: 1_000 });
		this.#rev = page.rev;
	}

	#randAgent(): SwarmAgent {
		return this.agents[Math.floor(this.#rng() * this.agents.length)]!;
	}

	/** Add/update a post in the merged caches (used for local commits, remote deltas and warm loads). */
	#indexPost(p: SwarmPost): void {
		if (!this.#postById.has(p.postId)) {
			this.#recentPosts.unshift(p);
			if (this.#recentPosts.length > 600) {
				const dropped = this.#recentPosts.pop()!;
				this.#postById.delete(dropped.postId);
			}
			if (p.replyTo) this.#replyCounts.set(p.replyTo, (this.#replyCounts.get(p.replyTo) ?? 0) + 1);
			if (Date.now() - p.at < 60_000) this.#postTimestamps.push(p.at);
		}
		p.likes = this.#likeSets.get(p.postId)?.size ?? p.likes;
		p.replies = this.#replyCounts.get(p.postId) ?? p.replies;
		this.#postById.set(p.postId, p);
	}

	#allChannels(): ChannelDef[] {
		return [...this.channels, ...this.#userChannels.values()];
	}

	/** Channel totals across shards: local durable counters + the remote shard's. */
	#mergedChannelTotals(): Map<string, number> {
		const m = new Map(this.#channelTotals);
		for (const [ch, n] of this.#shard?.channelTotals ?? []) m.set(ch, (m.get(ch) ?? 0) + n);
		return m;
	}

	/**
	 * Durable per-channel total: one ChannelCount entry per channel, take+write inside the
	 * same transaction as the post – the count can never drift from the committed posts.
	 */
	async #bumpChannelCount(channel: string, txnId: string | null): Promise<number> {
		const cur = await this.space.take({ type: "ChannelCount", fields: { channel } }, 0, txnId ? { txn: txnId } : undefined);
		const count = Number((cur?.fields as { count?: number } | undefined)?.count ?? 0) + 1;
		await this.space.write({ type: "ChannelCount", fields: { channel, count } }, txnId, FOREVER);
		return count;
	}

	#broadcastChannels(): void {
		const msg = JSON.stringify({ type: "feed.channels", channels: this.#allChannels() });
		for (const c of this.clients) c.send(msg);
	}

	#pickChannel(): string {
		const roll = this.#rng();
		if (roll < 0.22) return "phi-spaces";
		if (roll < 0.38) return "agents";
		if (roll < 0.50) return "federation";
		return this.channels[Math.floor(this.#rng() * this.channels.length)]!.channelId;
	}

	#renderText(channel: string): string {
		const pool = this.#rng() < 0.06 ? QUESTION_TEMPLATES : (POST_TEMPLATES[channel] ?? POST_TEMPLATES["random"]!);
		const tpl = pool[Math.floor(this.#rng() * pool.length)]!;
		const mention = this.#randAgent();
		return tpl
			.replaceAll("{n}", String(Math.floor(this.#rng() * 900) + 100))
			.replaceAll("{w}", "6")
			.replaceAll("{agent}", `@${mention.handle}`);
	}

	#renderReply(): string {
		const tpl = REPLY_TEMPLATES[Math.floor(this.#rng() * REPLY_TEMPLATES.length)]!;
		return tpl.replaceAll("{agent}", `@${this.#randAgent().handle}`);
	}

	/** Deterministic answer generation – no LLM, zero tokens. */
	#renderAnswer(question: string): string {
		const pool = /wetter|weather|rain|sun|cloud|storm|temperatur/i.test(question) ? WEATHER_ANSWERS : ANSWER_TEMPLATES;
		const tpl = pool[Math.floor(this.#rng() * pool.length)]!;
		return tpl.replaceAll("{agent}", `@${this.#randAgent().handle}`);
	}

	/**
	 * Producer side: agents emit SwarmTask intent entries – fully decoupled from workers.
	 * One logical transaction per shard; remote writes still use individual RPC operations.
	 */
	async #intentTick(): Promise<void> {
		if (!this.#running || this.#busy || this.#intentInFlight) return;
		this.#intentInFlight = true;
		try { await this.#produceIntents(); } finally { this.#intentInFlight = false; }
	}

	async #produceIntents(): Promise<void> {
		const burst = Math.max(1, Math.round(this.#rate * 0.5));
		// Replies/likes stay on the target post's shard; new posts split ~50/50 across shards.
		const perShard = new Map<SpaceLike, Fields[]>();
		for (let i = 0; i < burst; i++) {
			const agent = this.#randAgent();
			const channel = this.#pickChannel();
			const roll = this.#rng();
			const taskId = `swarm-${Date.now().toString(36)}-${Math.floor(this.#rng() * 1e6)}-${i}`;
			let replyTo: string | null = null;
			// A like names its post here: the task then runs on that post's shard, where the Like can leave with the post.
			if (roll >= 0.62 && this.#recentPosts.length > 0) {
				const target = this.#recentPosts[Math.floor(this.#rng() * Math.min(roll >= 0.88 ? 80 : 60, this.#recentPosts.length))]!;
				replyTo = target.postId;
			}
			const kind = roll >= 0.88 ? "like" : replyTo ? "reply" : "post";
			const target = replyTo ? this.#shardSpaceFor(replyTo) : this.#pickShardForNew();
			const fields = { taskId, kind, agentId: agent.agentId, channel, replyTo, llm: kind === "post" && target === this.space && this.#llmPost !== null && this.#rng() < LLM_POST_RATE, createdAt: Date.now() };
			const list = perShard.get(target) ?? [];
			list.push(fields);
			perShard.set(target, list);
		}
		// Logical grouping alone does not coalesce the PhiSpaces calls into one storage commit.
		for (const [space, tasks] of perShard) {
			try {
				const txn = await space.createTransaction(60_000);
				try {
					for (const fields of tasks) {
						await space.write({ type: "SwarmTask", fields }, txn.id, 60_000);
					}
					await space.commit(txn.id);
					if (space === this.#remote) this.#markRemoteUp();
				} catch (e) {
					// A limit refusal (too many calls or transactions) is back-pressure from a live shard, not a lost one.
					if (space === this.#remote && !(e instanceof ResourceExhausted)) this.#markRemoteDown();
					this.#shardWarn(`shard txn failed (${tasks.length} tasks, remote=${space !== this.space})`, e);
					try { await space.abort(txn.id); } catch { /* already gone */ }
				}
			} catch (e) {
				if (space === this.#remote && !(e instanceof ResourceExhausted)) this.#markRemoteDown();
				this.#shardWarn(`shard txn open failed (remote=${space !== this.space})`, e);
			}
		}
	}

	/** Two Durable commits per batch: reserve, then atomically publish prepared results. */
	async #workerLoop(workerId: number): Promise<void> {
		let batchSize = 4;
		while (!this.#closed) {
			let activeTxn: string | undefined;
			try {
				// Compatibility only: new batches include follow-ups in their final commit.
				if ((await this.space.readAll({ type: "PostEffect" }, { limit: 1 })).length) await this.#drainEffects();
				const batch = await reserveBatch(this, batchSize);
				if (!batch) {
					await new Promise(r => setTimeout(r, 500));
					continue;
				}
				activeTxn = batch.txn;
				const posts: SwarmPost[] = [], writes: BatchWrite[] = [];
				// Cache mutations run only after commit() – otherwise an aborted txn leaves phantom state.
				const postCommit: Array<() => void> = [];
				let usedModel = false;
				for (const task of batch.tasks) {
					const allowModel = !usedModel;
					if (task.fields.kind === "ai_reply" || task.fields.llm === true) usedModel = true;
					// At most one bounded provider call per 45-second batch transaction.
					const post = await this.#processTask(task, writes, postCommit, allowModel);
					if (post) {
						posts.push(post);
						await this.#afterPostCommit(String(task.fields.taskId), String(task.fields.agentId), String(task.fields.channel), post, batch.txn, writes);
					}
				}
				const counts = await finishBatch(this, batch.txn, posts, writes);
				activeTxn = undefined;
				for (const [channel, count] of Object.entries(counts)) this.#channelTotals.set(channel, count);
				for (const fn of postCommit) fn();
				for (const post of posts) if (isQuestion(post.text) && this.#answerWaiters < 4) {
					this.#answerWaiters++;
					void this.#waitForAnswer(post.postId, post.author).finally(() => this.#answerWaiters--);
				}
				// Yield between synchronous document serialization passes, even with a full queue.
				await new Promise(r => setTimeout(r, 25));
			} catch (e) {
				if (activeTxn) {
					try { await abortBatch(this, activeTxn); }
					catch (abortError) { console.error("[swarm] worker stopped; durable session requires recovery", abortError); return; }
				}
				if (e instanceof ResourceExhausted) batchSize = Math.max(1, Math.floor(batchSize / 2));
				if (e instanceof Error && e.message.includes("Session is poisoned")) { console.error("[swarm] worker stopped; reopen durable session", e); return; }
				console.warn("[swarm] batch failed; tasks not acknowledged", e);
				await new Promise((r) => setTimeout(r, 150 + workerId * 20));
			}
		}
	}

	async #drainEffects(): Promise<void> {
		const txn = await this.space.createTransaction(15_000);
		try {
			const entry = await this.space.take({ type: "PostEffect" }, 0, { txn: txn.id });
			if (!entry) { await this.space.abort(txn.id); return; }
			const f = entry.fields;
			const post = JSON.parse(String(f.post)) as SwarmPost;
			await this.#afterPostCommit(String(f.taskId), String(f.agentId), String(f.channel), post, txn.id);
			await this.space.commit(txn.id);
			if (isQuestion(post.text) && this.#answerWaiters < 4) {
				this.#answerWaiters++;
				void this.#waitForAnswer(post.postId, post.author).finally(() => this.#answerWaiters--);
			}
		} catch (e) { await this.space.abort(txn.id).catch(() => {}); throw e; }
	}

	/**
	 * Prepare results without storage writes or long-running work in a Durable callback.
	 * Cache changes run only after the final commit wins.
	 */
	async #processTask(task: { fields: Record<string, unknown> }, writes: BatchWrite[], postCommit: Array<() => void>, allowModel = true): Promise<SwarmPost | null> {
		const f = task.fields as { taskId: string; kind: string; agentId: string; channel: string; replyTo: string | null; userText?: string; userHandle?: string; llm?: boolean; imageUrl?: string; imageAlt?: string };
		// A remote shard never saw the web user register – rebuild "you" deterministically from the task fields.
		let agent = this.#agentIndex.get(f.agentId);
		if (!agent) {
			agent = f.agentId === "agent-you"
				? { agentId: "agent-you", name: "You (operator)", handle: String(f.userHandle ?? "you").slice(0, 24), hue: 145, bio: "human operator" }
				: this.#randAgent();
			this.#agentIndex.set(agent.agentId, agent);
		}
		if (f.kind === "like") {
			const target = f.replyTo ? this.#postById.get(f.replyTo) : this.#recentPosts[Math.floor(this.#rng() * Math.min(80, this.#recentPosts.length))];
			const likeId = `like-${f.taskId}`;
			if (!target) {
				// No likeable target left – still satisfy the CompletionProfile with a short-lived
				// dedup marker instead of aborting the whole batch txn (infinite retry otherwise).
				writes.push({ type: "Like", fields: { likeId, taskId: f.taskId, postId: String(f.replyTo ?? ""), agentId: agent.agentId, at: Date.now(), dedup: true }, lease: 60_000 });
				return null;
			}
			const already = this.#likeSets.get(target.postId)?.has(agent.agentId) === true || writes.some(w => w.type === "Like" && !w.fields.dedup && w.fields.postId === target.postId && w.fields.agentId === agent.agentId);
			// duplicate like – record a short-lived dedup marker instead
			writes.push({ type: "Like", fields: { likeId, taskId: f.taskId, postId: target.postId, agentId: agent.agentId, at: Date.now(), ...(already ? { dedup: true } : {}) }, lease: already ? 60_000 : FOREVER });
			if (!already) {
				postCommit.push(() => {
					if (!this.#likeSets.has(target.postId)) this.#likeSets.set(target.postId, new Set());
					this.#likeSets.get(target.postId)!.add(agent.agentId);
					target.likes = this.#likeSets.get(target.postId)!.size;
				});
			}
			return null;
		}
		const target = f.replyTo ? this.#postById.get(f.replyTo) ?? (await this.#lookupPost(f.replyTo)) : null;
		const seq = ++this.#seq;
		const postId = `${this.#shardTag}post-${seq}`;
		let viaLlm = false;
		let text: string;
		if (f.userText?.trim()) {
			text = f.userText;
		} else if (f.kind === "ai_reply" && target && this.#llm && allowModel) {
			const gen = await boundedPreparation(this.#generateLlmReply(agent, f.channel, target));
			text = gen ?? this.#renderReply();
			viaLlm = gen != null;
		} else if (f.kind === "answer" && target) {
			text = this.#renderAnswer(target.text);
		} else if (f.kind === "ack" && target) {
			text = ACK_TEMPLATES[Math.floor(this.#rng() * ACK_TEMPLATES.length)]!.replaceAll("{target}", `@${target.handle}`);
		} else if ((f.kind === "reply" || f.kind === "ai_reply") && target) {
			text = this.#renderReply();
		} else if (f.llm === true && this.#llmPost && allowModel) {
			const gen = await boundedPreparation(this.#generateLlmPost(agent, f.channel));
			text = gen ?? this.#renderText(f.channel);
			viaLlm = gen != null;
		} else {
			text = this.#renderText(f.channel);
		}
		const userImage = typeof f.imageUrl === "string" && (f.imageUrl.startsWith("http") || f.imageUrl.startsWith("/uploads/")) ? f.imageUrl : null;
		const withImage = !userImage && this.#rng() < IMAGE_CHANCE;
		const post: SwarmPost = {
			postId, seq, taskId: f.taskId,
			author: agent.agentId, handle: agent.handle, name: agent.name, hue: agent.hue,
			channel: f.channel, text,
			replyTo: target?.postId ?? null, replyToHandle: target?.handle ?? null,
			at: Date.now(), likes: 0, replies: 0,
			imageSeed: withImage ? Math.floor(this.#rng() * 1e9) : null,
			imageAlt: userImage ? (f.imageAlt ?? "attached image") : withImage ? IMG_ALTS[Math.floor(this.#rng() * IMG_ALTS.length)]! : null,
			imageUrl: userImage,
			viaLlm,
		};
		postCommit.push(() => {
			this.#indexPost(post);
			if (target) target.replies = this.#replyCounts.get(target.postId) ?? target.replies;
		});
		return post;
	}

	/** Stage follow-ups with their post; also drains legacy PostEffect outbox entries. */
	async #afterPostCommit(taskId: string, agentId: string, channel: string, post: SwarmPost, txn: string, staged?: BatchWrite[]): Promise<void> {
		const write: typeof this.space.write = staged
			? async (entry, _txn, lease) => { staged.push({ type: entry.type, fields: entry.fields, lease: lease ?? FOREVER }); return { id: "staged", expires: FOREVER }; }
			: this.space.write.bind(this.space);
		// Questions get a guaranteed deterministic answer – zero tokens, delivered as a thread reply.
		if (isQuestion(post.text)) {
			const answerer = this.#randAgent();
			if (answerer.agentId !== post.author) {
				try {
					await write(
						{ type: "SwarmTask", fields: { taskId: `answer-${post.postId}`, kind: "answer", agentId: answerer.agentId, channel, replyTo: post.postId, createdAt: Date.now() } },
						txn,
						60_000,
					);
				} catch (e) { throw e; }
			}
		}
		// A real user's post attracts live-LLM replies from two swarm agents.
		if (agentId === "agent-you" && this.#llm) {
			for (let i = 0; i < 2; i++) {
				const replier = this.#randAgent();
				try {
					await write(
						{ type: "SwarmTask", fields: { taskId: `aireply-${taskId}-${i}`, kind: "ai_reply", agentId: replier.agentId, channel, replyTo: post.postId, createdAt: Date.now() } },
						txn,
						60_000,
					);
				} catch (e) { throw e; }
			}
		}
	}

	/** Direct post commit for seeding (bypasses task queue). */
	async #commitPost(agent: SwarmAgent, channel: string, replyTarget: SwarmPost | null, seedTag: string): Promise<void> {
		const seq = ++this.#seq;
		const postId = `${this.#shardTag}post-${seq}`;
		const withImage = this.#rng() < IMAGE_CHANCE;
		const post: SwarmPost = {
			postId, seq, taskId: `direct-${seedTag}`,
			author: agent.agentId, handle: agent.handle, name: agent.name, hue: agent.hue,
			channel, text: replyTarget ? this.#renderReply() : this.#renderText(channel),
			replyTo: replyTarget?.postId ?? null, replyToHandle: replyTarget?.handle ?? null,
			at: Date.now(), likes: Math.floor(this.#rng() * 30), replies: 0,
			imageSeed: withImage ? Math.floor(this.#rng() * 1e9) : null,
			imageAlt: withImage ? IMG_ALTS[Math.floor(this.#rng() * IMG_ALTS.length)]! : null,
			imageUrl: null,
		};
		const txn = await this.space.createTransaction(30_000);
		let count: number;
		try {
			await appendHistory(this.space, post, txn.id);
			await this.space.write({ type: "Post", fields: { ...post } }, txn.id, FOREVER);
			count = await this.#bumpChannelCount(channel, txn.id);
			await this.space.commit(txn.id);
		} catch (e) { await this.space.abort(txn.id).catch(() => {}); throw e; }
		this.#channelTotals.set(channel, count);
		this.#indexPost(post);
		if (replyTarget) replyTarget.replies = this.#replyCounts.get(replyTarget.postId) ?? replyTarget.replies;
	}

	/**
	 * Self-triggering asker: polls `readAll({replyTo: questionId})` every few seconds until the
	 * answer entry is committed (or ~90s elapse), then delivers a receipt – an `ack` SwarmTask
	 * whose reply post appears under the answer. Polling, not blocking-read: a waiting read wakes
	 * on EVERY commit for an O(entries) probe, while a poll costs one bounded scan per interval.
	 */
	async #waitForAnswer(questionId: string, askerId: string): Promise<void> {
		const deadline = Date.now() + 90_000;
		try {
			while (!this.#closed && Date.now() < deadline) {
				await new Promise((r) => { const timer = setTimeout(r, 3_000); timer.unref(); });
				if (this.#closed) return;
				const entries = await this.space.readAll({ type: "Post", fields: { replyTo: questionId } }, { limit: 1 });
				const entry = entries[0];
				if (!entry) continue;
				const answerId = String(entry.fields.postId);
				const taskId = `ack-${questionId}-${Math.floor(Math.random() * 1e6)}`;
				await this.space.write(
					{ type: "SwarmTask", fields: { taskId, kind: "ack", agentId: askerId, channel: String(entry.fields.channel), replyTo: answerId, createdAt: Date.now() } },
					null,
					60_000,
				);
				return;
			}
		} catch {
			// closed or transient – the lease handles cleanup either way
		}
	}

	/** Load a post by id – routed to the owning shard by its id prefix. */
	async #lookupPost(postId: string): Promise<SwarmPost | null> {
		return this.#lookupPostIn(this.#shardSpaceFor(postId), postId);
	}

	/** Load a post by id within one shard space (durable fallback beyond the memory index). */
	async #lookupPostIn(space: SpaceLike, postId: string): Promise<SwarmPost | null> {
		const cached = this.#postById.get(postId);
		if (cached) return cached;
		try {
			const entries = await space.readAll({ type: "Post", fields: { postId } }, { limit: 1 });
			const p = (entries[0]?.fields ?? null) as unknown as SwarmPost | null;
			if (p) {
				p.likes = this.#likeSets.get(p.postId)?.size ?? p.likes;
				this.#postById.set(p.postId, p);
			}
			return p;
		} catch {
			return null; // shard unreachable
		}
	}

	/**
	 * One durable scan of the shard's posts, indexed as a thread graph. Every space read is a
	 * linear scan (no secondary index), so walking a thread hop-by-hop would cost one scan PER
	 * NODE – a 500-post thread blocked the event loop with ~500 scans. One scan + in-memory
	 * maps turns the whole query into a single O(posts) pass.
	 */
	async #postGraphIn(space: SpaceLike): Promise<{ byId: Map<string, SwarmPost>; children: Map<string, SwarmPost[]> }> {
		const entries = await this.#shardReadAll(space, { type: "Post" });
		const byId = new Map<string, SwarmPost>();
		const children = new Map<string, SwarmPost[]>();
		for (const e of entries) {
			const p = e.fields as unknown as SwarmPost;
			byId.set(p.postId, p);
			this.#postById.set(p.postId, p);
			if (p.replyTo) {
				const sibs = children.get(p.replyTo) ?? [];
				sibs.push(p);
				children.set(p.replyTo, sibs);
			}
		}
		for (const sibs of children.values()) sibs.sort((a, b) => a.at - b.at || String(a.postId).localeCompare(String(b.postId)));
		return { byId, children };
	}

	/** Walk replyTo up to the thread root inside an already-fetched graph (cycle-safe). */
	#rootInGraph(byId: Map<string, SwarmPost>, p: SwarmPost | null | undefined): SwarmPost | null {
		if (!p) return null;
		if (!byId.has(p.postId)) byId.set(p.postId, p);
		const seen = new Set<string>();
		let cur = byId.get(p.postId)!;
		while (cur.replyTo && !seen.has(cur.replyTo)) {
			seen.add(cur.postId);
			const parent = byId.get(cur.replyTo);
			if (!parent) break;
			cur = parent;
		}
		return cur;
	}

	/** Whole thread inside an already-fetched graph: in-memory BFS, each item depth-tagged. */
	#threadInGraph(byId: Map<string, SwarmPost>, children: Map<string, SwarmPost[]>, rootId: string): Array<SwarmPost & { depth: number }> {
		const root = byId.get(rootId);
		if (!root) return [];
		const out: Array<SwarmPost & { depth: number }> = [];
		const seen = new Set<string>([root.postId]);
		const queue: Array<{ p: SwarmPost; depth: number }> = [{ p: root, depth: 0 }];
		while (queue.length && out.length < 500) {
			const { p, depth } = queue.shift()!;
			out.push({ ...p, depth });
			for (const c of children.get(p.postId) ?? []) {
				if (seen.has(c.postId)) continue; // replyTo cycle/dupe guard
				seen.add(c.postId);
				queue.push({ p: c, depth: depth + 1 });
			}
		}
		// A thread contains every descendant – subtree child counts ARE the reply totals.
		const kids = new Map<string, number>();
		for (const p of out) if (p.replyTo) kids.set(p.replyTo, (kids.get(p.replyTo) ?? 0) + 1);
		for (const p of out) p.replies = kids.get(p.postId) ?? 0;
		return out;
	}

	/**
	 * Presence churn: rotate which subset of agents holds a live AgentPulse lease.
	 * Renew = take + fresh write; the whole tick commits as ONE transaction instead of ~70.
	 */
	async #pulseTick(): Promise<void> {
		if (!this.#running) return;
		try {
			const onlineArr = [...this.#online];
			const renewSet = onlineArr.slice(0, 40);
			const dropSet = new Set(onlineArr.slice(40, 55));
			const joiners: SwarmAgent[] = [];
			const picked = new Set<string>();
			const deficit = 140 - (onlineArr.length - dropSet.size);
			for (let i = 0; i < deficit; i++) {
				let agent = this.#randAgent();
				for (let tries = 0; tries < 20 && (this.#online.has(agent.agentId) && !dropSet.has(agent.agentId) || picked.has(agent.agentId)); tries++) agent = this.#randAgent();
				// Skip agents already online (not just "picked this tick") – otherwise an
				// agentCount below the 140 target would mint duplicate leases every pulse.
				if (picked.has(agent.agentId) || (this.#online.has(agent.agentId) && !dropSet.has(agent.agentId))) continue;
				picked.add(agent.agentId);
				joiners.push(agent);
			}
			const txn = await this.space.createTransaction(60_000);
			const newLeases = new Map<string, string>();
			try {
				for (const agentId of renewSet) {
					const taken = await this.space.take({ type: "AgentPulse", fields: { agentId } }, 0, { txn: txn.id });
					if (!taken) continue; // expired between ticks – lease is gone either way
					const f = taken.fields as { handle: string; name: string; hue: number; channel: string };
					const lease = await this.space.write(
						{ type: "AgentPulse", fields: { agentId, handle: f.handle, name: f.name, hue: f.hue, channel: f.channel, at: Date.now() } },
						txn.id,
						45_000,
					);
					newLeases.set(agentId, lease.id);
				}
				for (const agentId of dropSet) {
					await this.space.take({ type: "AgentPulse", fields: { agentId } }, 0, { txn: txn.id });
				}
				for (const agent of joiners) {
					const lease = await this.space.write(
						{ type: "AgentPulse", fields: { agentId: agent.agentId, handle: agent.handle, name: agent.name, hue: agent.hue, channel: this.#pickChannel(), at: Date.now() } },
						txn.id,
						45_000,
					);
					newLeases.set(agent.agentId, lease.id);
				}
				await this.space.commit(txn.id);
				for (const [agentId, id] of newLeases) this.#pulseLeases.set(agentId, id);
				for (const agentId of dropSet) { this.#pulseLeases.delete(agentId); this.#online.delete(agentId); }
				for (const agent of joiners) this.#online.add(agent.agentId);
			} catch {
				try { await this.space.abort(txn.id); } catch { /* already gone */ }
			}
		} catch {
			// transient
		}
	}

	/** Deliver committed deltas to feed clients via the space changes stream. */
	async #broadcastTick(): Promise<void> {
		if (this.clients.size === 0) return;
		try {
			const posts: SwarmPost[] = [];
			const pushedPosts = new Set<string>();
			const pushPost = (p: SwarmPost | undefined | null) => {
				if (p && !pushedPosts.has(p.postId)) { pushedPosts.add(p.postId); posts.push(p); }
			};
			const likeDeltas: Array<{ postId: string; agentId: string }> = [];
			const pulses: Array<{ agentId: string; handle: string; name: string; hue: number; channel: string }> = [];
			const likedPosts = new Map<string, number>();
			const repliedPosts = new Map<string, number>();

			let page;
			try { page = await this.space.changes(this.#rev, { maxBytes: 300_000 }); }
			catch (e) {
				if (!historyGone(e)) throw e;
				// The cursor fell behind the space's retained change history (no viewer for a while, or a burst of writes):
				// reading from it can only fail again. Start again from now and hand the viewers the current state.
				this.#rev = (await this.space.readPage(null, { maxBytes: 1_000 })).rev;
				const init = { type: "feed.init", ...this.snapshot(), onlineCount: this.#online.size, stats: await this.stats(), agentTotal: this.#agentCount };
				for (const c of this.clients) c.send(init);
				return;
			}
			if (page.batches.length > 0) {
				this.#rev = page.next;
				for (const b of page.batches) {
					for (const op of b.ops) {
						if (op.op !== "put") continue;
						if (op.type === "Post") {
							pushPost(this.#postById.get(String(op.fields.postId)));
						} else if (op.type === "Like" && !op.fields.dedup) {
							const postId = String(op.fields.postId);
							likeDeltas.push({ postId, agentId: String(op.fields.agentId) });
							const t = this.#postById.get(postId);
							if (t) likedPosts.set(postId, t.likes);
						} else if (op.type === "AgentPulse") {
							pulses.push({
								agentId: String(op.fields.agentId), handle: String(op.fields.handle),
								name: String(op.fields.name), hue: Number(op.fields.hue), channel: String(op.fields.channel),
							});
						}
					}
				}
			}
			// Remote shard: pull its committed deltas and merge them into the same broadcast.
			if (this.#shard) {
				if (this.#shard.rev === 0) {
					if (!this.#shard.down()) await this.#syncRemoteShard();
				} else {
					for (const b of (await this.#shard.pull(() => void this.#syncRemoteShard())) ?? []) {
						for (const op of b.ops) {
							if (op.op !== "put") continue;
							if (op.type === "Post") {
								const p = op.fields as unknown as SwarmPost;
								this.#indexPost(p);
								pushPost(p);
							} else if (op.type === "Like" && !op.fields.dedup) {
								const postId = String(op.fields.postId);
								const agentId = String(op.fields.agentId);
								likeDeltas.push({ postId, agentId });
								if (!this.#likeSets.has(postId)) this.#likeSets.set(postId, new Set());
								this.#likeSets.get(postId)!.add(agentId);
								const t = this.#postById.get(postId);
								if (t) {
									t.likes = this.#likeSets.get(postId)!.size;
									likedPosts.set(postId, t.likes);
								}
							}
						}
					}
				}
			}
			for (const p of posts) {
				if (p.replyTo) repliedPosts.set(p.replyTo, this.#replyCounts.get(p.replyTo) ?? 0);
			}
			if (posts.length || likeDeltas.length || pulses.length) {
				const msg = JSON.stringify({
					type: "feed.delta",
					rev: this.#rev,
					posts,
					likes: likeDeltas,
					likeCounts: Object.fromEntries(likedPosts),
					replyCounts: Object.fromEntries(repliedPosts),
					pulses,
					channelTotals: Object.fromEntries(this.#mergedChannelTotals()),
				});
				for (const c of this.clients) c.send(msg);
			}
		} catch {
			// transient
		}
	}

	async #statsTick(): Promise<void> {
		if (this.clients.size === 0) return;
		try {
			const stats = await this.stats();
			const msg = JSON.stringify({ type: "feed.stats", stats });
			for (const c of this.clients) c.send(msg);
		} catch {
			// transient (e.g. host closing)
		}
	}

	async stats(): Promise<SwarmStats> {
		const st = await this.space.stats();
		let pending = await this.space.count({ type: "SwarmTask" });
		const entries: Record<string, number> = { ...st.byType };
		let totalEntries = st.entries;
		let shardsUp = 1;
		const labels = this.#shardLabels();
		const reports = [await this.#shardReport(this.space, labels.local, false, st.entries, true)];
		if (this.#remote) {
			try {
				const rs = await this.#remoteCall(this.#remote.stats(), 8_000);
				totalEntries += rs.entries;
				reports.push(await this.#shardReport(this.#remote, labels.remote, true, rs.entries, true));
				shardsUp++;
				this.#markRemoteUp();
				for (const [t, n] of Object.entries(rs.byType)) entries[t] = (entries[t] ?? 0) + Number(n);
				pending += await this.#remoteCall(this.#remote.count({ type: "SwarmTask" }), 8_000);
			} catch {
				this.#markRemoteDown();
				// shard host unreachable – report the local shard only
				reports.push(await this.#shardReport(this.#remote, labels.remote, true, null, true));
			}
		}
		const minute = Date.now() - 60_000;
		this.#postTimestamps = this.#postTimestamps.filter((t) => t > minute);
		return {
			rev: this.#rev,
			entries: totalEntries,
			byType: entries,
			pendingTasks: pending,
			shards: this.#remote ? 2 : 1,
			shardsUp,
			posts: this.#postById.size,
			likes: [...this.#likeSets.values()].reduce((n, s) => n + s.size, 0),
			onlineAgents: this.#online.size,
			postsPerMin: this.#postTimestamps.length,
			retention: { cap: this.#retention?.cap ?? null, now: Date.now(), shards: reports },
			workerCount: WORKER_COUNT,
			running: this.#running,
			rate: this.#rate,
			agentCount: this.#agentCount,
			llmCalls: this.#llmCallsTotal,
			llmTokens: this.#llmTokens,
		};
	}

	snapshot(channel?: string): {
		posts: SwarmPost[];
		channels: ChannelDef[];
		online: SwarmAgent[];
		channelCounts: Record<string, number>;
		leaderboard: Array<{ handle: string; name: string; hue: number; posts: number }>;
	} {
		const posts = channel && channel !== "all"
			? this.#recentPosts.filter((p) => p.channel === channel).slice(0, 80)
			: this.#recentPosts.slice(0, 80);
		const byAuthor = new Map<string, { handle: string; name: string; hue: number; posts: number }>();
		for (const p of this.#recentPosts) {
			const a = byAuthor.get(p.handle) ?? { handle: p.handle, name: p.name, hue: p.hue, posts: 0 };
			a.posts++;
			byAuthor.set(p.handle, a);
		}
		return {
			posts,
			channels: this.#allChannels(),
			online: [...this.#online].map((id) => this.#agentIndex.get(id)).filter((a): a is SwarmAgent => Boolean(a)),
			// Durable per-channel totals (ChannelCount entries, merged across shards) – the
			// recent-window count would under-report everything that aged out of the window.
			channelCounts: Object.fromEntries(this.#mergedChannelTotals()),
			leaderboard: [...byAuthor.values()].sort((a, b) => b.posts - a.posts).slice(0, 8),
		};
	}

	async attachWebSocket(ws: WsConnection): Promise<void> {
		await this.whenReady();
		const lifetime = new AbortController();
		ws.onClose(() => lifetime.abort());
		this.clients.add(ws);
		ws.onClose(() => { this.clients.delete(ws); this.#admins.delete(ws); });
		const requireAdmin = (): boolean => {
			if (this.#admins.has(ws)) return true;
			ws.send({ type: "swarm.denied" });
			return false;
		};
		const stats = await this.stats();
		ws.send({
			type: "feed.init",
			...this.snapshot(),
			onlineCount: this.#online.size,
			stats,
			agentTotal: this.#agentCount,
		});
		ws.onMessage(async (raw) => {
			try {
				const msg = JSON.parse(raw);
				switch (msg.type) {
					case "post.submit": {
						const text = String(msg.text ?? "").slice(0, 280).trim();
						if (!text) return;
						const channel = this.#allChannels().some((c) => c.channelId === msg.channel) ? String(msg.channel) : "random";
						const taskId = `user-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
						const replyTo = typeof msg.replyTo === "string" && this.#postById.has(msg.replyTo) ? msg.replyTo : null;
						const imageUrl = typeof msg.imageUrl === "string" && (/^https?:\/\//.test(msg.imageUrl) || /^\/uploads\/[\w.-]+$/.test(msg.imageUrl)) ? msg.imageUrl.slice(0, 500) : undefined;
						const imageAlt = typeof msg.imageAlt === "string" ? msg.imageAlt.slice(0, 200) : undefined;
						// The user's own post also travels the SwarmTask pipeline – visibly queued, then processed
						let userAgent = this.#agentIndex.get("agent-you");
						if (!userAgent) {
							userAgent = { agentId: "agent-you", name: "You (operator)", handle: String(msg.author ?? "you").slice(0, 24), hue: 145, bio: "human operator" };
							this.#agentIndex.set(userAgent.agentId, userAgent);
						} else {
							userAgent.handle = String(msg.author ?? "you").slice(0, 24);
						}
						// Route the task to the shard owning the thread; fresh posts split across shards.
						const shard = replyTo ? this.#shardSpaceFor(replyTo) : this.#pickShardForNew();
						try {
							await shard.write(
								{ type: "SwarmTask", fields: { taskId, kind: replyTo ? "reply" : "post", agentId: userAgent.agentId, channel, replyTo, userText: text, userHandle: userAgent.handle, imageUrl, imageAlt, createdAt: Date.now() } },
								null,
								60_000,
								// Request claims are host-local machinery – only valid on the local shard.
								shard === this.space ? { request: await this.#requestFor("web-user", taskId) } : undefined,
							);
						} catch (err) {
							if (shard === this.#remote) {
								this.#markRemoteDown();
								await this.space.write(
									{ type: "SwarmTask", fields: { taskId, kind: replyTo ? "reply" : "post", agentId: userAgent.agentId, channel, replyTo, userText: text, userHandle: userAgent.handle, imageUrl, imageAlt, createdAt: Date.now() } },
									null,
									60_000,
									{ request: await this.#requestFor("web-user", taskId) },
								);
							} else {
								throw err;
							}
						}
						break;
					}
					case "post.like": {
						const postId = String(msg.postId ?? "");
						const target = this.#postById.get(postId);
						if (!target) return;
						const agentId = `user-${String(msg.author ?? "you").slice(0, 24)}`;
						if (this.#likeSets.get(postId)?.has(agentId)) return;
						const likeId = `like-user-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
						const shard = this.#shardSpaceFor(postId);
						try {
							await shard.write(
								{ type: "Like", fields: { likeId, taskId: "user-direct", postId, agentId, at: Date.now() } },
								null,
								FOREVER,
								shard === this.space ? { request: await this.#requestFor("web-user", likeId) } : undefined,
							);
						} catch (err) {
							if (shard === this.#remote) {
								this.#markRemoteDown();
							}
						}
						if (!this.#likeSets.has(postId)) this.#likeSets.set(postId, new Set());
						this.#likeSets.get(postId)!.add(agentId);
						target.likes = this.#likeSets.get(postId)!.size;
						break;
					}
					case "channel.create": {
						// User channels live on the hub space as durable Channel entries (createdBy = owner).
						const name = String(msg.name ?? "")
							.toLowerCase()
							.replace(/[^a-z0-9-]/g, "-")
							.replace(/-{2,}/g, "-")
							.replace(/^-+|-+$/g, "")
							.slice(0, 24);
						const author = String(msg.author ?? "you").slice(0, 24);
						const fail = (error: string) => { ws.send({ type: "channel.error", error }); return; };
						if (name.length < 2) return void fail("name-too-short");
						if (this.#allChannels().some((c) => c.channelId === name)) return void fail("channel-exists");
						if (this.#userChannels.size >= 50) return void fail("channel-limit");
						const topic = String(msg.topic ?? "").slice(0, 80).trim();
						const def = { channelId: name, label: `#${name}`, topic, createdBy: author };
						await this.space.write(
							{ type: "Channel", fields: { ...def, createdAt: Date.now() } },
							null,
							FOREVER,
							{ request: await this.#requestFor("web-user", `chan-${name}`) },
						);
						this.#userChannels.set(name, def);
						this.#broadcastChannels();
						break;
					}
					case "channel.delete": {
						// Only the creator may delete: the take template requires createdBy to match,
						// so builtin channels (no createdBy) and foreign channels can never be taken.
						const channelId = String(msg.channelId ?? "");
						const author = String(msg.author ?? "you").slice(0, 24);
						if (!this.#userChannels.has(channelId)) return void ws.send({ type: "channel.error", error: "not-yours" });
						const taken = await this.space.take({ type: "Channel", fields: { channelId, createdBy: author } }, 0);
						if (!taken) return void ws.send({ type: "channel.error", error: "not-yours" });
						this.#userChannels.delete(channelId);
						this.#broadcastChannels();
						break;
					}
					case "admin.auth": {
						// Swarm-control login – same password as AdminSpaces (PHI_SPACES_ADMIN_PASSWORD).
						if (this.#adminCheck?.(String(msg.password ?? ""))) {
							this.#admins.add(ws);
							ws.send({ type: "admin.ok" });
						} else {
							ws.send({ type: "admin.denied" });
						}
						break;
					}
					case "admin.session": {
						// An open AdminSpaces session is as good as the swarm-control password; nothing is sent when it is not.
						if (this.#sessionCheck?.(String(msg.sessionId ?? ""))) {
							this.#admins.add(ws);
							ws.send({ type: "admin.ok" });
						}
						break;
					}
					case "swarm.agentCount": {
						if (!requireAdmin()) break;
						const n = clampAgents(msg.count ?? this.#agentCount);
						if (n !== this.#agentCount) {
							const userAgent = this.#agentIndex.get("agent-you");
							this.#agentCount = n;
							this.#seedAgents(n);
							if (userAgent) this.#agentIndex.set(userAgent.agentId, userAgent);
							if (this.#seedContent) this.#saveAgentCount();
						}
						break;
					}
					case "swarm.rate":
						if (!requireAdmin()) break;
						this.#rate = Math.max(1, Math.min(40, Number(msg.rate ?? 5)));
						break;
					case "feed.more":
     case "agent.posts":
     case "ai.posts": {
      const kind = String(msg.type);
      const channel = String(msg.channel ?? "all");
      const handle = String(msg.handle ?? "");
      const limit = Math.max(10, Math.min(200, Math.round(Number(msg.limit ?? 100)) || 100));
      try {
       const scan = { kind, channel, handle, beforeAt: Number.isFinite(Number(msg.beforeAt)) ? Number(msg.beforeAt) : Infinity, beforeId: String(msg.beforeId ?? ""), limit };
       let result;
       // A filtered page (one channel, one author, AI only) is asked of the shards' own filter: walking the history chain looks
       // at 512 posts per round and on a busy feed the posts of a channel lie much further back (and over the socket to a
       // shard that is far too slow), so a chain walk answers empty while the posts exist.
       const filtered = (kind as string) !== "feed.more" || channel !== "all";
       if (this.#historyReady && !filtered) {
        try {
         result = await this.#remoteCall(mergedHistory(this.#remote ? [this.space, this.#remote] : [this.space], {
          beforeAt: scan.beforeAt, beforeId: scan.beforeId, limit,
          cursors: Array.isArray(msg.cursors) && msg.cursors.every((c: unknown) => typeof c === "string") ? msg.cursors : undefined,
          ...(kind === "feed.more" && channel !== "all" ? { channel } : {}),
          ...(kind === "agent.posts" ? { handle } : {}), ai: kind === "ai.posts",
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
          ...(this.#remoteDown() ? { skip: [1] } : {}),
         }));
        } catch {
         // A shard index still migrating (or down) must not dead-end paging – scan instead.
         result = await this.#pageScan(scan, AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]));
        }
       } else {
        result = await this.#pageScan(scan, AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]));
       }
       for (const p of result.posts) { p.likes = this.#likeSets.get(p.postId)?.size ?? p.likes; p.replies = this.#replyCounts.get(p.postId) ?? p.replies; }
       ws.send({ type: kind, channel, handle, ...result, threads: [], append: Array.isArray(msg.cursors) });
      } catch (e) {
       ws.send({ type: kind, channel, handle, posts: [], threads: [], complete: false, exhausted: false, retryable: true, error: String(e) });
      }
      return;
     }
     case "thread.fetch": {
      const postId = String(msg.postId ?? "");
      const space = this.#shardSpaceFor(postId);
      let root: SwarmPost | null = null, posts: unknown[] = [];
      try {
       const g = await this.#postGraphIn(space);
       const clicked = g.byId.get(postId) ?? this.#postById.get(postId) ?? null;
       root = this.#rootInGraph(g.byId, clicked);
       posts = root ? this.#threadInGraph(g.byId, g.children, root.postId) : [];
      } catch (e) {
       if (space === this.space) throw e; // only the local shard's failure is a real error
      }
      ws.send({ type: "thread", postId, rootId: root?.postId ?? postId, posts, inline: msg.inline === true });
      return;
     }
					case "swarm.pause":
						if (!requireAdmin()) break;
						this.#running = false;
						break;
					case "swarm.resume":
						if (!requireAdmin()) break;
						this.#running = true;
						break;
					case "swarm.burst": {
						if (!requireAdmin()) break;
						const n = Math.max(5, Math.min(200, Number(msg.n ?? 50)));
						for (let i = 0; i < n; i++) {
							const agent = this.#randAgent();
							const taskId = `burst-${Date.now().toString(36)}-${i}`;
							await this.#pickShardForNew().write(
								{ type: "SwarmTask", fields: { taskId, kind: "post", agentId: agent.agentId, channel: this.#pickChannel(), createdAt: Date.now() } },
								null,
								60_000,
							);
						}
						break;
					}
				}
				ws.send({ type: "swarm.state", running: this.#running, rate: this.#rate, agentCount: this.#agentCount });
			} catch (e) {
				// Malformed JSON is client noise; anything else is a handler bug the feed must see.
				if (e instanceof SyntaxError) return;
				this.#shardWarn("client frame failed", e);
				try { ws.send({ type: "feed.error", message: String((e as Error)?.message ?? e) }); } catch { /* socket gone */ }
			}
		});
	}
}
