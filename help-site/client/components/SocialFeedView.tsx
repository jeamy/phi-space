"use client";
// Social Swarm live feed – a social-feed multiplayer chat surface where
// ~1000 autonomous agents post, reply, and like across topic channels. Everything
// visible here is backed by real phi-spaces entries (SwarmTask -> Post/Like, AgentPulse
// leases, changes(rev) live stream).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { LlmModelPicker } from "./LlmModelPicker.tsx";

interface ChannelDef { channelId: string; label: string; topic: string; createdBy?: string }
interface SwarmPost {
	postId: string; seq: number; taskId: string; author: string; handle: string; name: string;
	hue: number; channel: string; text: string; replyTo: string | null; replyToHandle: string | null;
	at: number; likes: number; replies: number;
	imageSeed?: number | null; imageAlt?: string | null; imageUrl?: string | null;
	viaLlm?: boolean;
}
interface SwarmAgent { agentId: string; name: string; handle: string; hue: number; bio: string }
interface SwarmStats {
	rev: number; entries: number; byType: Record<string, number>; pendingTasks: number;
	posts: number; likes: number; onlineAgents: number; postsPerMin: number;
	workerCount: number; running: boolean; rate: number; agentCount: number;
	llmCalls: number; llmTokens: number;
}
interface LeaderRow { handle: string; name: string; hue: number; posts: number }

function timeAgo(at: number, locale: "de" | "en"): string {
	const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
	if (s < 5) return locale === "de" ? "jetzt" : "now";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function Avatar({ name, hue, size = 40 }: { name: string; hue: number; size?: number }) {
	const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
	return (
		<div
			className="sf-avatar"
			style={{
				width: size, height: size, fontSize: size * 0.36,
				background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 60) % 360} 75% 32%))`,
			}}
		>
			{initials}
		</div>
	);
}

// Deterministic generative image card – the seed travels inside the Post entry,
// so every client renders the same artwork without any external image service.
function srand(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function SwarmImage({ seed, alt }: { seed: number; alt: string }) {
	const r = srand(seed);
	const hue = Math.floor(r() * 360);
	const hue2 = (hue + 60 + Math.floor(r() * 120)) % 360;
	const circles = Array.from({ length: 7 }, (_, i) => ({
		key: i, cx: r() * 560, cy: r() * 300, rad: 18 + r() * 90,
		op: 0.12 + r() * 0.3, fill: r() > 0.5 ? "#ffffff" : `hsl(${(hue + Math.floor(r() * 90)) % 360} 90% 70%)`,
	}));
	const path = `M0 ${200 + r() * 80} C ${120 + r() * 80} ${120 + r() * 120}, ${300 + r() * 80} ${140 + r() * 120}, 560 ${80 + r() * 160} L560 300 L0 300 Z`;
	return (
		<figure className="sf-media">
			<svg viewBox="0 0 560 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label={alt}>
				<defs>
					<linearGradient id={`g${seed}`} x1="0" y1="0" x2="1" y2="1">
						<stop offset="0%" stopColor={`hsl(${hue} 65% 32%)`} />
						<stop offset="100%" stopColor={`hsl(${hue2} 75% 18%)`} />
					</linearGradient>
				</defs>
				<rect width="560" height="300" fill={`url(#g${seed})`} />
				{circles.map((c) => <circle key={c.key} cx={c.cx} cy={c.cy} r={c.rad} fill={c.fill} opacity={c.op} />)}
				<path d={path} fill="#000000" opacity="0.22" />
				<g stroke="#ffffff" strokeOpacity="0.25" fill="none">
					{[40, 110, 180, 250].map((y) => <line key={y} x1="0" y1={y} x2="560" y2={y} />)}
				</g>
			</svg>
			<figcaption className="sf-media__cap">🖼 {alt}</figcaption>
		</figure>
	);
}

function RichText({ text }: { text: string }) {
	const parts = text.split(/([@#][a-zA-Z0-9_.-]+)/g);
	return (
		<>
			{parts.map((p, i) =>
				p.startsWith("@") || p.startsWith("#") ? (
					<span key={i} className="sf-link">{p}</span>
				) : (
					<React.Fragment key={i}>{p}</React.Fragment>
				),
			)}
		</>
	);
}

function PostCard({
	post,
	onOpen,
	onReply,
	onLike,
	onToggleThread,
	threadOpen,
	onAuthor,
	locale,
}: {
	post: SwarmPost;
	onOpen: (p: SwarmPost) => void;
	onReply: (p: SwarmPost) => void;
	onLike: (p: SwarmPost) => void;
	onToggleThread?: (p: SwarmPost) => void;
	threadOpen?: boolean;
	onAuthor?: (p: SwarmPost) => void;
	locale: "de" | "en";
}) {
	return (
		<article className={post.viaLlm ? "sf-post sf-post--llm" : "sf-post"} onClick={() => onOpen(post)}>
			<Avatar name={post.name} hue={post.hue} />
			<div className="sf-post__body">
				<div className="sf-post__head">
					<button
						type="button"
						className="sf-post__author"
						title={locale === "de" ? `Alle Posts von @${post.handle}` : `All posts by @${post.handle}`}
						onClick={(e) => { e.stopPropagation(); onAuthor?.(post); }}
					>
						<span className="sf-post__name">{post.name}</span>
						<span className="sf-post__handle">@{post.handle}</span>
					</button>
					<span className="sf-post__dot">·</span>
					<span className="sf-post__time">{timeAgo(post.at, locale)}</span>
					{post.viaLlm ? <span className="sf-post__llm" title={locale === "de" ? "Von einem echten LLM generiert" : "Generated by a live LLM"}>🤖 AI</span> : null}
					<span className="sf-post__channel">{`#${post.channel}`}</span>
				</div>
				{post.replyTo ? (
					<div className="sf-post__reply-to">
						{locale === "de" ? "Antwort an" : "Replying to"} <span className="sf-link">@{post.replyToHandle ?? post.replyTo}</span>
					</div>
				) : null}
				<p className="sf-post__text"><RichText text={post.text} /></p>
				{post.imageUrl ? (
					<figure className="sf-media">
						<img className="sf-media__img" src={post.imageUrl} alt={post.imageAlt ?? "attached image"} loading="lazy" />
						{post.imageAlt ? <figcaption className="sf-media__cap">🖼 {post.imageAlt}</figcaption> : null}
					</figure>
				) : post.imageSeed != null ? (
					<SwarmImage seed={post.imageSeed} alt={post.imageAlt ?? "generated media"} />
				) : null}
				<div className="sf-post__foot">
					{onToggleThread && post.replies > 0 ? (
						<button
							type="button"
							className="sf-action sf-action--btn sf-action--thread"
							title={locale === "de" ? (threadOpen ? "Thread zuklappen" : "Thread aufklappen") : (threadOpen ? "Collapse thread" : "Expand thread")}
							onClick={(e) => { e.stopPropagation(); onToggleThread(post); }}
						>
							{threadOpen ? "▾" : "▸"} {post.replies}
						</button>
					) : null}
					<button
						type="button"
						className="sf-action sf-action--btn"
						title={locale === "de" ? "Antworten" : "Reply"}
						onClick={(e) => { e.stopPropagation(); onReply(post); }}
					>
						💬 {post.replies}
					</button>
					<button
						type="button"
						className="sf-action sf-action--btn sf-action--like"
						title={locale === "de" ? "Gefällt mir (schreibt Like-Entry)" : "Like (writes a Like entry)"}
						onClick={(e) => { e.stopPropagation(); onLike(post); }}
					>
						♥ {post.likes}
					</button>
					<span className="sf-action sf-action--meta" title="Committed via SwarmTask → Post">⚡ {post.taskId.slice(-6)}</span>
				</div>
			</div>
		</article>
	);
}

export function SocialFeedView({ locale }: { locale: "de" | "en" }) {
	const [connected, setConnected] = useState(false);
	const [posts, setPosts] = useState<SwarmPost[]>([]);
	const [postMap, setPostMap] = useState<Map<string, SwarmPost>>(new Map());
	const [channels, setChannels] = useState<ChannelDef[]>([]);
	const [channelCounts, setChannelCounts] = useState<Record<string, number>>({});
	const [leaderboard, setLeaderboard] = useState<LeaderRow[]>([]);
	const [online, setOnline] = useState<SwarmAgent[]>([]);
	const [onlineCount, setOnlineCount] = useState(0);
	const [agentFilter, setAgentFilter] = useState<SwarmAgent | null>(null);
	const [agentPosts, setAgentPosts] = useState<SwarmPost[]>([]);
	const [agentPostsLoading, setAgentPostsLoading] = useState(false);
	const [aiOnly, setAiOnly] = useState(false);
	const [aiPosts, setAiPosts] = useState<SwarmPost[]>([]);
	const [aiLoading, setAiLoading] = useState(false);
	const [agentTotal, setAgentTotal] = useState(1000);
	const [stats, setStats] = useState<SwarmStats | null>(null);
	const [channel, setChannel] = useState<string>("home");
	const [draft, setDraft] = useState("");
	const [handle, setHandle] = useState("you");
	const [attachOpen, setAttachOpen] = useState(false);
	const [imgUrl, setImgUrl] = useState("");
	const [imgAlt, setImgAlt] = useState("");
	const [imgUploading, setImgUploading] = useState(false);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const [openThread, setOpenThread] = useState<SwarmPost | null>(null);
	const [threadItems, setThreadItems] = useState<Array<SwarmPost & { depth: number }>>([]);
	const [threadLoading, setThreadLoading] = useState(false);
	const [agentThreads, setAgentThreads] = useState<Array<{ rootId: string; posts: Array<SwarmPost & { depth: number }> }>>([]);
	const [threadDraft, setThreadDraft] = useState("");
	const [chanForm, setChanForm] = useState(false);
	const [newChanName, setNewChanName] = useState("");
	const [newChanTopic, setNewChanTopic] = useState("");
	const [chanError, setChanError] = useState("");
	const [showInternals, setShowInternals] = useState(true);
	const [isAdmin, setIsAdmin] = useState(false);
	const [adminDlg, setAdminDlg] = useState(false);
	const [adminPwd, setAdminPwd] = useState("");
	const [adminErr, setAdminErr] = useState("");
	// Inline-expanded threads: postId -> descendants (depth relative to that post).
	const [expandedThreads, setExpandedThreads] = useState<ReadonlyMap<string, Array<SwarmPost & { depth: number }>>>(new Map());
	const [expanding, setExpanding] = useState<ReadonlySet<string>>(new Set());
	const expDepthRef = useRef<Map<string, { root: string; depth: number }>>(new Map());
	const expandWantedRef = useRef<Set<string>>(new Set());
	const [showHelp, setShowHelp] = useState(false);
	const [agentCountInput, setAgentCountInput] = useState("1000");
	const wsRef = useRef<WebSocket | null>(null);
	const feedRef = useRef<HTMLDivElement | null>(null);
	const threadIdsRef = useRef<Set<string>>(new Set());
	const threadDepthRef = useRef<Map<string, number>>(new Map());
	// Scroll-back paging: older pages live outside the capped live window.
	const [pagedPosts, setPagedPosts] = useState<SwarmPost[]>([]);
	const [loadingMore, setLoadingMore] = useState(false);
	const morePendingRef = useRef(false);
	const exhaustedRef = useRef<Set<string>>(new Set());
	const historyCursors = useRef<Map<string, string[]>>(new Map());
	const [historyError, setHistoryError] = useState("");
	const seenIdsRef = useRef<Set<string>>(new Set());
	// Agent view: thread groups start collapsed (▸); expanding shows the full context tree.
	const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(new Set());
	// Submit acknowledgment beam: "sent" fires instantly so the user sees the post
	// was handed to the space; "delivered" fires once it materializes in the feed.
	const [beam, setBeam] = useState<"sent" | "delivered" | null>(null);
	const pendingPostRef = useRef<{ text: string; handle: string; at: number } | null>(null);
	const beamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const proto = window.location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${proto}://${window.location.host}/ws/feed`);
		wsRef.current = ws;
		ws.onopen = () => setConnected(true);
		ws.onclose = () => { setConnected(false); setIsAdmin(false); };
		ws.onmessage = (ev) => {
			try {
				const msg = JSON.parse(ev.data);
				if (msg.type === "feed.init") {
					setPosts(msg.posts);
					setChannels(msg.channels);
					setChannelCounts(msg.channelCounts);
					setLeaderboard(msg.leaderboard);
					setOnline(msg.online);
					setOnlineCount(msg.onlineCount);
					setAgentTotal(msg.agentTotal);
					setAgentCountInput(String(msg.agentTotal));
					setStats(msg.stats);
					setPostMap(new Map(msg.posts.map((p: SwarmPost) => [p.postId, p])));
					setPagedPosts([]);
					setLoadingMore(false);
					morePendingRef.current = false;
					exhaustedRef.current.clear();
						historyCursors.current.clear();
					seenIdsRef.current = new Set((msg.posts as SwarmPost[]).map((p) => p.postId));
				} else if (msg.type === "feed.channels") {
					setChannels(msg.channels);
					setChannel((cur) => ((msg.channels as ChannelDef[]).some((c) => c.channelId === cur) ? cur : "home"));
				} else if (msg.type === "channel.error") {
					setChanError(String(msg.error ?? ""));
				} else if (msg.type === "admin.ok") {
					setIsAdmin(true); setAdminDlg(false); setAdminPwd(""); setAdminErr("");
				} else if (msg.type === "admin.denied") {
					setAdminErr(locale === "de" ? "Falsches Passwort" : "Wrong password");
				} else if (msg.type === "swarm.denied") {
					setAdminDlg(true);
				} else if (msg.type === "feed.delta") {
					if (msg.posts?.length) {
						// dedupe inside the batch AND against prev – duplicate ids made React
						// render a stale duplicate card stuck at the top of the feed
						const inBatch = new Set<string>();
						const fresh: SwarmPost[] = (msg.posts as SwarmPost[]).filter((p) => !inBatch.has(p.postId) && !!inBatch.add(p.postId));
						setPosts((prev) => {
							const seen = new Set(fresh.map((p) => p.postId));
							return [...fresh, ...prev.filter((p) => !seen.has(p.postId))].slice(0, 400);
						});
						setPostMap((prev) => {
							const next = new Map(prev);
							for (const p of msg.posts as SwarmPost[]) next.set(p.postId, p);
							return next;
						});
						for (const p of msg.posts as SwarmPost[]) seenIdsRef.current.add(p.postId);
						// A pending own submission just materialized in the space → "delivered".
						const pend = pendingPostRef.current;
						if (pend && (msg.posts as SwarmPost[]).some((p) => p.handle === pend.handle && p.text === pend.text && p.at >= pend.at - 60_000)) {
							pendingPostRef.current = null;
							fireBeam("delivered", 2_400);
						}
						if (agentFilterRef.current) {
							const h = agentFilterRef.current.handle;
							const mine = (msg.posts as SwarmPost[]).filter((p) => p.handle === h);
							if (mine.length) {
								setAgentPosts((prev) => {
									const seen = new Set(mine.map((p) => p.postId));
									return [...mine, ...prev.filter((p) => !seen.has(p.postId))];
								});
							}
						}
						if (aiOnlyRef.current) {
							const llmNew = (msg.posts as SwarmPost[]).filter((p) => p.viaLlm);
							if (llmNew.length) {
								setAiPosts((prev) => {
									const seen = new Set(llmNew.map((p) => p.postId));
									return [...llmNew, ...prev.filter((p) => !seen.has(p.postId))];
								});
							}
						}
						// Live-append replies that belong to the open thread.
						const threadNew = (msg.posts as SwarmPost[]).filter((p) => p.replyTo && threadIdsRef.current.has(p.replyTo) && !threadIdsRef.current.has(p.postId));
						if (threadNew.length) {
							for (const p of threadNew) {
								const d = (threadDepthRef.current.get(p.replyTo!) ?? 0) + 1;
								threadIdsRef.current.add(p.postId);
								threadDepthRef.current.set(p.postId, d);
							}
							setThreadItems((prev) => [...prev, ...threadNew.map((p) => ({ ...p, depth: threadDepthRef.current.get(p.postId)! }))]);
						}
						// Live-append replies into inline-expanded threads.
						for (const p of msg.posts as SwarmPost[]) {
							if (!p.replyTo) continue;
							const meta = expDepthRef.current.get(p.replyTo);
							if (!meta || expDepthRef.current.has(p.postId)) continue;
							expDepthRef.current.set(p.postId, { root: meta.root, depth: meta.depth + 1 });
							const item = { ...p, depth: meta.depth + 1 };
							setExpandedThreads((prev) => {
								if (!prev.has(meta.root)) return prev;
								const n = new Map(prev);
								n.set(meta.root, [...n.get(meta.root)!, item]);
								return n;
							});
						}
					}
					// Authoritative durable channel totals (ChannelCount entries, merged across shards).
					if (msg.channelTotals) setChannelCounts(msg.channelTotals);
					if (msg.likeCounts) {
						setPostMap((prev) => {
							const next = new Map(prev);
							for (const [id, likes] of Object.entries(msg.likeCounts)) {
								const p = next.get(id);
								if (p) next.set(id, { ...p, likes: likes as number });
							}
							return next;
						});
						setPosts((prev) => prev.map((p) => (msg.likeCounts[p.postId] !== undefined ? { ...p, likes: msg.likeCounts[p.postId] } : p)));
						setThreadItems((prev) => prev.map((p) => (msg.likeCounts[p.postId] !== undefined ? { ...p, likes: msg.likeCounts[p.postId] } : p)));
					}
					if (msg.replyCounts) {
						setPostMap((prev) => {
							const next = new Map(prev);
							for (const [id, replies] of Object.entries(msg.replyCounts)) {
								const p = next.get(id);
								if (p) next.set(id, { ...p, replies: replies as number });
							}
							return next;
						});
						setPosts((prev) => prev.map((p) => (msg.replyCounts[p.postId] !== undefined ? { ...p, replies: msg.replyCounts[p.postId] } : p)));
						setThreadItems((prev) => prev.map((p) => (msg.replyCounts[p.postId] !== undefined ? { ...p, replies: msg.replyCounts[p.postId] } : p)));
					}
					if (msg.pulses?.length) {
						setOnline((prev) => {
							const seen = new Set(prev.map((a) => a.agentId));
							const added = (msg.pulses as any[])
								.filter((a) => !seen.has(a.agentId) && !!seen.add(a.agentId))
								.map((a) => ({ agentId: a.agentId, name: a.name, handle: a.handle, hue: a.hue, bio: "" }));
							return [...added, ...prev].slice(0, 300);
						});
						setOnlineCount((c) => Math.max(c, Math.min(160, c + msg.pulses.length)));
					}
				} else if (msg.type === "feed.more") {
					setHistoryError(msg.complete === false ? String(msg.error ?? "Incomplete history; retry") : "");
					morePendingRef.current = false;
					setLoadingMore(false);
					const page = (msg.posts ?? []) as SwarmPost[];
					if (msg.complete && msg.cursors) historyCursors.current.set(String(msg.channel ?? "all"), msg.cursors);
					if (msg.complete && msg.exhausted) exhaustedRef.current.add(String(msg.channel ?? "all"));
					const fresh = page.filter((p) => !seenIdsRef.current.has(p.postId));
					for (const p of fresh) seenIdsRef.current.add(p.postId);
					if (fresh.length) {
						setPagedPosts((prev) => [...prev, ...fresh]);
						setPostMap((prev) => {
							const next = new Map(prev);
							for (const p of fresh) next.set(p.postId, p);
							return next;
						});
					}
				} else if (msg.type === "agent.posts") {
					morePendingRef.current = false; setLoadingMore(false);
					const key = "agent:" + String(msg.handle);
					if (msg.complete) { historyCursors.current.set(key, msg.cursors); if (msg.exhausted) exhaustedRef.current.add(key); }
					setHistoryError(msg.complete === false ? String(msg.error ?? "Incomplete history; retry") : "");
					setAgentPostsLoading(false);
					if (msg.complete !== false) setAgentPosts(prev => msg.append ? [...prev, ...msg.posts.filter((p: SwarmPost) => !prev.some(x => x.postId === p.postId))] : msg.posts);
					setAgentThreads((msg.threads as Array<{ rootId: string; posts: Array<SwarmPost & { depth: number }> }>) ?? []);
					// Threads arrive collapsed – toggle on the group header expands the tree.
					setCollapsedThreads(new Set(((msg.threads ?? []) as Array<{ rootId: string }>).map((t) => t.rootId)));
					setPostMap((prev) => {
						const next = new Map(prev);
						for (const p of msg.posts as SwarmPost[]) next.set(p.postId, p);
						for (const t of (msg.threads ?? []) as Array<{ posts: Array<SwarmPost> }>) for (const p of t.posts) next.set(p.postId, p);
						return next;
					});
				} else if (msg.type === "thread") {
					// Full durable thread: root first, all descendants depth-tagged.
					const items = (msg.posts ?? []) as Array<SwarmPost & { depth: number }>;
					if (msg.inline === true) {
						// Late collapse while the fetch was in flight -> ignore the response.
						if (!expandWantedRef.current.has(String(msg.postId))) return;
						// Inline expansion under the clicked card: only that post's subtree.
						const kids = new Map<string, Array<SwarmPost & { depth: number }>>();
						for (const it of items) {
							if (!it.replyTo) continue;
							const arr = kids.get(it.replyTo) ?? [];
							arr.push(it);
							kids.set(it.replyTo, arr);
						}
						const sub: Array<SwarmPost & { depth: number }> = [];
						const walk = (id: string, d: number) => {
							for (const c of kids.get(id) ?? []) { sub.push({ ...c, depth: d }); walk(c.postId, d + 1); }
						};
						walk(String(msg.postId), 1);
						expDepthRef.current.set(String(msg.postId), { root: String(msg.postId), depth: 0 });
						for (const s of sub) expDepthRef.current.set(s.postId, { root: String(msg.postId), depth: s.depth });
						setExpandedThreads((prev) => new Map(prev).set(String(msg.postId), sub));
						setExpanding((prev) => { const n = new Set(prev); n.delete(String(msg.postId)); return n; });
						setPostMap((prev) => {
							const next = new Map(prev);
							for (const p of items) next.set(p.postId, p);
							return next;
						});
						return;
					}
					threadIdsRef.current = new Set(items.map((p) => p.postId));
					threadDepthRef.current = new Map(items.map((p) => [p.postId, p.depth]));
					setThreadItems(items);
					setThreadLoading(false);
					setPostMap((prev) => {
						const next = new Map(prev);
						for (const p of items) next.set(p.postId, p);
						return next;
					});
				} else if (msg.type === "ai.posts") {
					morePendingRef.current = false; setLoadingMore(false);
					if (msg.complete) { historyCursors.current.set("ai", msg.cursors); if (msg.exhausted) exhaustedRef.current.add("ai"); }
					setHistoryError(msg.complete === false ? String(msg.error ?? "Incomplete history; retry") : "");
					setAiLoading(false);
					if (msg.complete !== false) setAiPosts(prev => msg.append ? [...prev, ...msg.posts.filter((p: SwarmPost) => !prev.some(x => x.postId === p.postId))] : msg.posts);
					setPostMap((prev) => {
						const next = new Map(prev);
						for (const p of msg.posts as SwarmPost[]) next.set(p.postId, p);
						return next;
					});
				} else if (msg.type === "feed.stats") {
					setStats(msg.stats);
					if (msg.stats.agentCount) setAgentTotal(msg.stats.agentCount);
				} else if (msg.type === "swarm.state") {
					setStats((s) => (s ? { ...s, running: msg.running, rate: msg.rate, agentCount: msg.agentCount ?? s.agentCount } : s));
					if (msg.agentCount) setAgentTotal(msg.agentCount);
				}
			} catch {
				// ignore malformed frames
			}
		};
		return () => ws.close();
	}, []);

	const send = (obj: unknown) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(obj));
	};

	const agentFilterRef = useRef<SwarmAgent | null>(null);
	const aiOnlyRef = useRef(false);
	useEffect(() => {
		agentFilterRef.current = agentFilter;
		if (!agentFilter) {
			setAgentPosts([]);
			setAgentThreads([]);
			return;
		}
		setAiOnly(false); // agent filter and AI-only view are exclusive
		// Durable lookup: ask the space for ALL posts by this agent, not just the cached window.
		setAgentPosts([]);
		setAgentThreads([]);
		setAgentPostsLoading(true);
		send({ type: "agent.posts", handle: agentFilter.handle });
	}, [agentFilter]);

	useEffect(() => {
		aiOnlyRef.current = aiOnly;
		if (!aiOnly) {
			setAiPosts([]);
			return;
		}
		setAgentFilter(null);
		setAiPosts([]);
		setAiLoading(true);
		send({ type: "ai.posts" });
	}, [aiOnly]);

	const visiblePosts = useMemo(() => {
		const source = aiOnly ? aiPosts : agentFilter ? agentPosts : [...posts, ...pagedPosts];
		const filtered = source.filter(
			(p) =>
				p.channel === channel &&
				(!agentFilter || p.handle === agentFilter.handle) &&
				(!aiOnly || p.viaLlm === true),
		);
		// Flat feed = top-level cards; replies collapse under their ancestor (▸ toggle).
		if (!aiOnly && !agentFilter) {
			const ids = new Set(filtered.map((p) => p.postId));
			return filtered.filter((p) => {
				let cur: SwarmPost | undefined = p;
				for (let hops = 0; cur?.replyTo && hops < 25; hops++) {
					if (ids.has(cur.replyTo)) return false;
					cur = postMap.get(cur.replyTo);
				}
				return true;
			});
		}
		return filtered;
	}, [posts, pagedPosts, agentPosts, aiPosts, channel, agentFilter, aiOnly, postMap]);

	// Scroll-back paging: fetch the next 100 durable posts older than the oldest visible one.
	const loadMore = () => {
		const key = aiOnly ? "ai" : agentFilter ? "agent:" + agentFilter.handle : channel;
		if (openThread || morePendingRef.current || exhaustedRef.current.has(key)) return;
		const tail = visiblePosts[visiblePosts.length - 1];
		if (!tail && !agentFilter && !aiOnly) return;
		morePendingRef.current = true;
		setLoadingMore(true);
		send({ type: aiOnly ? "ai.posts" : agentFilter ? "agent.posts" : "feed.more", handle: agentFilter?.handle, channel, beforeAt: tail?.at, beforeId: tail?.postId, cursors: historyCursors.current.get(key), limit: 100 });
	};

	const onFeedScroll = (e: React.UIEvent<HTMLDivElement>) => {
		const el = e.currentTarget;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 500) loadMore();
	};

	// Open the full durable thread (root + all descendants) via the server.
	const openThreadView = (p: SwarmPost) => {
		setOpenThread(p);
		setThreadItems([]);
		setThreadLoading(true);
		threadIdsRef.current = new Set();
		threadDepthRef.current = new Map();
		send({ type: "thread.fetch", postId: p.postId });
	};

	const closeThreadView = () => {
		setOpenThread(null);
		setThreadItems([]);
		threadIdsRef.current = new Set();
		threadDepthRef.current = new Map();
	};

	// Focus a different post inside the already-loaded thread (no refetch).
	const focusPost = (p: SwarmPost) => setOpenThread(p);

	// Inline thread expand/collapse: ▸ fetches the post's subtree (durable, shard-aware),
	// ▾ removes it. Live deltas keep appending via expDepthRef.
	const toggleExpand = (p: SwarmPost) => {
		if (expandedThreads.has(p.postId) || expanding.has(p.postId)) {
			expandWantedRef.current.delete(p.postId);
			setExpandedThreads((prev) => {
				const n = new Map(prev);
				n.delete(p.postId);
				return n;
			});
			setExpanding((prev) => { const n = new Set(prev); n.delete(p.postId); return n; });
			for (const [id, meta] of expDepthRef.current) {
				if (meta.root === p.postId) expDepthRef.current.delete(id);
			}
		} else {
			expandWantedRef.current.add(p.postId);
			setExpanding((prev) => new Set(prev).add(p.postId));
			send({ type: "thread.fetch", postId: p.postId, inline: true });
		}
	};

	// Channel navigation always returns to the live feed – post filters would otherwise
	// make the list look frozen (e.g. a static "AI posts only" snapshot).
	const selectChannel = (id: string) => {
		setChannel(id);
		setAiOnly(false);
		setAgentFilter(null);
		setAgentThreads([]);
	};

	const fireBeam = (phase: "sent" | "delivered", hideAfterMs: number) => {
		if (beamTimerRef.current) clearTimeout(beamTimerRef.current);
		setBeam(phase);
		beamTimerRef.current = setTimeout(() => setBeam(null), hideAfterMs);
	};

	const submitPost = () => {
		const text = draft.trim();
		if (!text) return;
		const imageUrl = imgUrl.trim();
		pendingPostRef.current = { text, handle, at: Date.now() };
		fireBeam("sent", 8_000);
		send({
			type: "post.submit", text, channel, author: handle,
			imageUrl: /^https?:\/\//.test(imageUrl) || imageUrl.startsWith("/uploads/") ? imageUrl : undefined,
			imageAlt: imgAlt.trim() || undefined,
		});
		setDraft("");
		setImgUrl("");
		setImgAlt("");
		setAttachOpen(false);
	};

	// Clicking any user (post author, thread participant, online list, leaderboard, own
	// avatar) ALWAYS shows that user's posts — it overrides the AI view, an open thread
	// and any previous filter, instead of toggling off or doing nothing.
	const selectUser = (u: { agentId?: string; name: string; handle: string; hue: number; bio?: string }) => {
		setAiOnly(false);
		setOpenThread(null);
		setAgentFilter({ agentId: u.agentId ?? "", name: u.name, handle: u.handle, hue: u.hue, bio: u.bio ?? "" });
	};

	// Clicking your own avatar filters the feed to all your posts (same durable query as agents).
	const toggleSelfFilter = () => {
		selectUser({ agentId: "agent-you", name: "You (operator)", handle, hue: 145, bio: "human operator" });
	};

	const submitReply = (parent: SwarmPost) => {
		const text = threadDraft.trim();
		if (!text) return;
		pendingPostRef.current = { text, handle, at: Date.now() };
		fireBeam("sent", 8_000);
		send({ type: "post.submit", text, channel: parent.channel, replyTo: parent.postId, author: handle });
		setThreadDraft("");
	};

	const likePost = (p: SwarmPost) => {
		send({ type: "post.like", postId: p.postId, author: handle });
	};

	const applyAgentCount = (n: number) => {
		const count = Math.max(100, Math.min(50000, Math.round(n)) || 100);
		setAgentCountInput(String(count));
		send({ type: "swarm.agentCount", count });
	};

	const openReply = (p: SwarmPost) => {
		if (openThread) {
			setOpenThread(p);
		} else {
			openThreadView(p);
		}
		setThreadDraft(`@${p.handle} `);
	};

	const byType = stats?.byType ?? {};
	const typeTotal = Object.values(byType).reduce((n, v) => n + v, 0) || 1;

	return (
		<div className="sf-root">
			{/* Left column: channels + swarm controls */}
			<aside className="sf-col sf-col--left">
				<div className="sf-panel">
					<div className="sf-panel__title">
						<span className={`sf-live-dot ${connected && stats?.running !== false ? "" : "sf-live-dot--off"}`} />
						{locale === "de" ? "KANÄLE" : "CHANNELS"}
					</div>
					{channels.map((c) => (
						<div key={c.channelId} className={`sf-channel-row ${channel === c.channelId ? "is-active" : ""}`}>
							<button
								type="button"
								className={`sf-channel ${channel === c.channelId ? "is-active" : ""}`}
								onClick={() => selectChannel(c.channelId)}
								title={c.createdBy ? `${c.topic} · ${locale === "de" ? "von" : "by"} @${c.createdBy}` : c.topic}
							>
								<span>{c.label}</span>
								<span className="sf-channel__count">{channelCounts[c.channelId] ?? 0}</span>
							</button>
							{c.createdBy === handle ? (
								<button
									type="button"
									className="sf-channel__del"
									title={locale === "de" ? "Channel löschen (nur eigene)" : "Delete channel (own only)"}
									onClick={() => send({ type: "channel.delete", channelId: c.channelId, author: handle })}
								>
									✕
								</button>
							) : null}
						</div>
					))}
					<button
						type="button"
						className="sf-channel sf-channel--add"
						onClick={() => { setChanForm((v) => !v); setChanError(""); }}
					>
						<span>{chanForm ? "–" : "+"} {locale === "de" ? "Neuer Channel" : "New channel"}</span>
					</button>
					{chanForm ? (
						<div className="sf-channel-form">
							<input
								className="sf-input"
								placeholder={locale === "de" ? "name (a-z, 0-9, -)" : "name (a-z, 0-9, -)"}
								value={newChanName}
								maxLength={24}
								onChange={(e) => setNewChanName(e.target.value)}
							/>
							<input
								className="sf-input"
								placeholder={locale === "de" ? "Thema (optional)" : "Topic (optional)"}
								value={newChanTopic}
								maxLength={80}
								onChange={(e) => setNewChanTopic(e.target.value)}
							/>
							<button
								type="button"
								className="sf-btn sf-btn--primary"
								onClick={() => {
									send({ type: "channel.create", name: newChanName, topic: newChanTopic, author: handle });
									setNewChanName(""); setNewChanTopic("");
								}}
							>
								{locale === "de" ? "Anlegen" : "Create"}
							</button>
							{chanError ? <span className="sf-channel-error">{chanError}</span> : null}
						</div>
					) : null}
				</div>

				<div className="sf-panel">
					<div className="sf-panel__title">
						{locale === "de" ? "SWARM-STEUERUNG" : "SWARM CONTROLS"}
						{isAdmin ? <span className="sf-admin-badge">🔐 admin</span> : null}
					</div>
					{!isAdmin ? (
						<div className="sf-admin-lock">
							{adminDlg ? (
								<form
									className="sf-admin-login"
									onSubmit={(e) => { e.preventDefault(); send({ type: "admin.auth", password: adminPwd }); }}
								>
									<input
										className="sf-input"
										type="password"
										autoFocus
										placeholder={locale === "de" ? "Admin-Passwort (.env)" : "Admin password (.env)"}
										value={adminPwd}
										onChange={(e) => setAdminPwd(e.target.value)}
									/>
									<button type="submit" className="sf-btn sf-btn--primary" disabled={!adminPwd}>
										{locale === "de" ? "Login" : "Login"}
									</button>
									{adminErr ? <span className="sf-channel-error">{adminErr}</span> : null}
								</form>
							) : (
								<button type="button" className="sf-btn" onClick={() => setAdminDlg(true)}>
									🔐 {locale === "de" ? "Admin-Login zum Steuern" : "Admin login to control"}
								</button>
							)}
						</div>
					) : null}
					<div className="sf-controls__row" style={isAdmin ? undefined : { opacity: 0.45, pointerEvents: "none" }}>
						<button
							type="button"
							className="sf-btn sf-btn--primary"
							disabled={!isAdmin}
							onClick={() => send({ type: stats?.running === false ? "swarm.resume" : "swarm.pause" })}
						>
							{stats?.running === false ? (locale === "de" ? "▶ Fortsetzen" : "▶ Resume") : (locale === "de" ? "⏸ Pausieren" : "⏸ Pause")}
						</button>
						<button type="button" className="sf-btn" disabled={!isAdmin} onClick={() => send({ type: "swarm.burst", n: 60 })}>
							{locale === "de" ? "⚡ Burst ×60" : "⚡ Burst ×60"}
						</button>
					</div>
					<label className="sf-slider">
						<span>{locale === "de" ? "Agenten-Aktivität" : "Agent activity"}: {stats?.rate ?? 9}/s</span>
						<input
							type="range" min={1} max={40} value={stats?.rate ?? 9}
							disabled={!isAdmin}
							onChange={(e) => send({ type: "swarm.rate", rate: Number(e.target.value) })}
						/>
					</label>
					<label className="sf-slider">
						<span>{locale === "de" ? "Agenten" : "Agents"}: {agentTotal.toLocaleString(locale === "de" ? "de-DE" : "en-US")}</span>
						<input
							type="range" min={100} max={50000} step={100}
							value={Number(agentCountInput) || 100}
							disabled={!isAdmin}
							onChange={(e) => setAgentCountInput(e.target.value)}
							onMouseUp={() => isAdmin && applyAgentCount(Number(agentCountInput))}
							onTouchEnd={() => isAdmin && applyAgentCount(Number(agentCountInput))}
							onKeyUp={(e) => { if (isAdmin && (e.key === "ArrowLeft" || e.key === "ArrowRight")) applyAgentCount(Number(agentCountInput)); }}
						/>
						<span className="sf-agent-presets">
							<input
								className="sf-agent-num" type="number" min={100} max={50000}
								value={agentCountInput}
								disabled={!isAdmin}
								onChange={(e) => setAgentCountInput(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") applyAgentCount(Number(agentCountInput)); }}
							/>
							{[1000, 5000, 10000, 50000].map((n) => (
								<button key={n} type="button" className="sf-mini-preset" disabled={!isAdmin} onClick={() => applyAgentCount(n)}>
									{`${n / 1000}k`}
								</button>
							))}
						</span>
					</label>
					<p className="sf-hint">
						{locale === "de"
							? "Pause stoppt nur die Produzenten – die Worker leeren die Task-Queue sichtbar weiter (Entkopplung!)."
							: "Pause stops only producers – workers keep draining the visible task queue (decoupling!)."}
					</p>
					<div className="sf-controls__row">
						<LlmModelPicker locale={locale} />
					</div>
					<div className="sf-controls__row">
						<button
							type="button"
							className={aiOnly ? "sf-btn sf-btn--ai active" : "sf-btn sf-btn--ai"}
							onClick={() => setAiOnly(!aiOnly)}
						>
							{aiOnly
								? (locale === "de" ? "🤖 Alle Posts anzeigen" : "🤖 Show all posts")
								: (locale === "de" ? "🤖 AI-Posts anzeigen" : "🤖 Show AI posts")}
						</button>
					</div>
				</div>
			</aside>

			{/* Center column: composer + feed */}
			<div className="sf-col sf-col--center" ref={feedRef} onScroll={onFeedScroll}>
				<div className="sf-composer">
					<button
						type="button"
						className={`sf-avatar-btn ${agentFilter?.handle === handle ? "is-active" : ""}`}
						title={locale === "de" ? "Alle deine Posts anzeigen" : "Show all your posts"}
						onClick={toggleSelfFilter}
					>
						<Avatar name="You" hue={145} size={44} />
					</button>
					<div className="sf-composer__box">
						<textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitPost(); }}
							placeholder={locale === "de" ? `Poste als @${handle} in #${channel} …` : `Post as @${handle} in #${channel} …`}
							rows={2}
							maxLength={280}
						/>
						{attachOpen ? (
							<div className="sf-attach">
								<div className="sf-attach__row">
									<input
										className="sf-attach__url"
										value={imgUrl}
										onChange={(e) => setImgUrl(e.target.value.slice(0, 500))}
										placeholder={locale === "de" ? "Bild-URL (https://…) oder Datei →" : "Image URL (https://…) or file →"}
									/>
									<input
										ref={fileRef}
										type="file"
										accept="image/png,image/jpeg,image/gif,image/webp"
										style={{ display: "none" }}
										onChange={async (e) => {
											const f = e.target.files?.[0];
											e.target.value = "";
											if (!f) return;
											if (f.size > 2 * 1024 * 1024) { setImgUrl(""); alert(locale === "de" ? "Bild zu groß (max 2 MB)" : "Image too large (max 2 MB)"); return; }
											setImgUploading(true);
											try {
												const r = await fetch("/api/upload", { method: "POST", headers: { "content-type": f.type }, body: f });
												const d = await r.json();
												if (d.url) setImgUrl(d.url);
											} catch { /* keep URL field usable */ }
											setImgUploading(false);
										}}
									/>
									<button
										type="button"
										className="sf-btn"
										disabled={imgUploading}
										onClick={() => fileRef.current?.click()}
										title={locale === "de" ? "Lokale Datei hochladen (max 2 MB)" : "Upload local file (max 2 MB)"}
									>
										{imgUploading ? "…" : "📁"} {locale === "de" ? "Datei" : "File"}
									</button>
								</div>
								{imgUrl.startsWith("/uploads/") || /^https?:\/\//.test(imgUrl) ? (
									<img className="sf-attach__preview" src={imgUrl} alt={imgAlt || "preview"} />
								) : null}
								<input
									className="sf-attach__alt"
									value={imgAlt}
									onChange={(e) => setImgAlt(e.target.value.slice(0, 200))}
									placeholder={locale === "de" ? "Alt-Text (Beschreibung)" : "Alt text (description)"}
								/>
							</div>
						) : null}
						<div className="sf-composer__row">
							<input
								className="sf-handle-input"
								value={handle}
								onChange={(e) => setHandle(e.target.value.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24) || "you")}
								title="handle"
							/>
							<button
								type="button"
								className={`sf-btn sf-btn--icon ${attachOpen ? "is-active" : ""}`}
								title={locale === "de" ? "Bild anhängen" : "Attach image"}
								onClick={() => setAttachOpen((v) => !v)}
							>
								🖼
							</button>
							<span className="sf-hint">{280 - draft.length} · ⌘⏎</span>
							<button type="button" className="sf-btn sf-btn--primary" onClick={submitPost} disabled={!draft.trim()}>
								{locale === "de" ? "Posten (via SwarmTask)" : "Post (via SwarmTask)"}
							</button>
						</div>
					</div>
				</div>

				{beam ? (
					<div className={`sf-beam ${beam === "delivered" ? "is-delivered" : "is-sent"}`} role="status">
						{beam === "delivered"
							? (locale === "de" ? "◉ Delivered — Post im Space materialisiert" : "◉ Delivered — post materialized in the space")
							: (locale === "de" ? "⟫ Übertragung — Post wird in den Space gebeamt …" : "⟫ Transmitting — beaming post into the space …")}
					</div>
				) : null}

				{openThread ? (
					<div className="sf-thread">
						<button type="button" className="sf-btn sf-thread__back" onClick={closeThreadView}>
							← {locale === "de" ? "Zurück zum Feed" : "Back to feed"}
						</button>
						{threadLoading ? (
							<div className="sf-empty">{locale === "de" ? "Lade Thread aus dem Space …" : "Loading thread from the space …"}</div>
						) : (
							<>
								<div className="sf-thread__sep">
									{locale === "de" ? `Thread · ${threadItems.length} Posts` : `Thread · ${threadItems.length} posts`}
								</div>
								{threadItems.map((p) => (
									<div
										key={p.postId}
										className={`sf-post--depth ${p.postId === openThread.postId ? "is-focus" : ""}`}
										style={{ paddingLeft: `${Math.min(p.depth, 8) * 20}px` }}
										onClick={() => focusPost(p)}
									>
										<PostCard post={p} onOpen={focusPost} onReply={openReply} onLike={likePost} onAuthor={(a) => selectUser(a)} locale={locale} />
									</div>
								))}
								{threadItems.length === 0 ? (
									<PostCard post={openThread} onOpen={() => {}} onReply={openReply} onLike={likePost} onAuthor={(a) => selectUser(a)} locale={locale} />
								) : null}
							</>
						)}
						<div className="sf-composer">
							<Avatar name="You" hue={145} size={36} />
							<div className="sf-composer__box">
								<textarea
									value={threadDraft}
									onChange={(e) => setThreadDraft(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitReply(openThread); }}
									placeholder={locale === "de" ? `Antwort an @${openThread.handle} …` : `Reply to @${openThread.handle} …`}
									rows={2}
									maxLength={280}
								/>
								<div className="sf-composer__row">
									<span className="sf-hint">{280 - threadDraft.length} · ⌘⏎</span>
									<button type="button" className="sf-btn sf-btn--primary" onClick={() => submitReply(openThread)} disabled={!threadDraft.trim()}>
										{locale === "de" ? "Antworten (via SwarmTask)" : "Reply (via SwarmTask)"}
									</button>
								</div>
							</div>
						</div>
					</div>
				) : (
					<div className="sf-feed">
						{aiOnly ? (
							<div className="sf-agentfilter sf-agentfilter--ai">
								<span>🤖</span>
								<span>
									{locale === "de" ? "Nur AI-generierte Posts" : "AI-generated posts only"}
									{aiLoading ? (locale === "de" ? " – lade aus dem Space …" : " – loading from space …") : ` (${visiblePosts.length})`}
								</span>
								<button type="button" onClick={() => setAiOnly(false)} title={locale === "de" ? "Filter aufheben" : "Clear filter"}>✕</button>
							</div>
						) : null}
						{agentFilter ? (
							<div className="sf-agentfilter">
								<Avatar name={agentFilter.name} hue={agentFilter.hue} size={22} />
								<span>
									{locale === "de" ? `Alle Posts von @${agentFilter.handle}` : `All posts by @${agentFilter.handle}`}
									{agentPostsLoading ? (locale === "de" ? " – lade aus dem Space …" : " – loading from space …") : ` (${visiblePosts.length})`}
								</span>
								<button type="button" onClick={() => setAgentFilter(null)} title={locale === "de" ? "Filter aufheben" : "Clear filter"}>✕</button>
							</div>
						) : null}
						{agentFilter && agentThreads.length > 0 ? (
							<>
								<div className="sf-thread__sep">
									{locale === "de" ? `${agentThreads.length} Threads mit @${agentFilter.handle}` : `${agentThreads.length} threads with @${agentFilter.handle}`}
								</div>
								{agentThreads.map((t) => {
									const collapsed = collapsedThreads.has(t.rootId);
									const shown = collapsed ? t.posts.filter((p) => p.handle === agentFilter.handle) : t.posts;
									return (
										<div key={t.rootId} className="sf-agentthread">
											<button
												type="button"
												className="sf-action sf-action--btn sf-action--thread sf-agentthread__toggle"
												title={locale === "de" ? (collapsed ? "Thread aufklappen" : "Thread zuklappen") : (collapsed ? "Expand thread" : "Collapse thread")}
												onClick={() => setCollapsedThreads((prev) => {
													const n = new Set(prev);
													if (n.has(t.rootId)) n.delete(t.rootId); else n.add(t.rootId);
													return n;
												})}
											>
												{collapsed ? "▸" : "▾"} {t.posts.length}
											</button>
											{shown.map((p) => (
												<div
													key={p.postId}
													className={`sf-post--depth ${p.handle !== agentFilter.handle ? "is-ctx" : ""}`}
													style={{ paddingLeft: `${collapsed ? 0 : Math.min(p.depth, 8) * 16}px` }}
												>
													<PostCard post={p} onOpen={openThreadView} onReply={openReply} onLike={likePost} onAuthor={(a) => selectUser(a)} locale={locale} />
												</div>
											))}
										</div>
									);
								})}
							</>
						) : null}
						{!(agentFilter && agentThreads.length > 0) ? visiblePosts.map((p) => (
							<React.Fragment key={p.postId}>
								<PostCard post={p} onOpen={openThreadView} onReply={openReply} onLike={likePost} onToggleThread={toggleExpand} threadOpen={expandedThreads.has(p.postId)} onAuthor={(a) => selectUser(a)} locale={locale} />
								{expanding.has(p.postId) ? <div className="sf-inline-loading">…</div> : null}
								{expandedThreads.has(p.postId) ? (
									<div className="sf-inline-thread">
										{(expandedThreads.get(p.postId) ?? []).map((c) => (
											<div key={c.postId} style={{ paddingLeft: `${Math.min(c.depth, 8) * 16}px` }}>
												<PostCard post={c} onOpen={openThreadView} onReply={openReply} onLike={likePost} onAuthor={(a) => selectUser(a)} locale={locale} />
											</div>
										))}
									</div>
								) : null}
							</React.Fragment>
						)) : null}
						{loadingMore ? <div className="sf-inline-loading">{locale === "de" ? "Lade ältere Posts …" : "Loading older posts …"}</div> : null}
						{historyError ? <div role="alert">{historyError}</div> : null}
						{!loadingMore && !exhaustedRef.current.has(aiOnly ? "ai" : agentFilter ? "agent:" + agentFilter.handle : channel) && (visiblePosts.length > 0 || agentFilter || aiOnly) ? (
							<button type="button" className="sf-loadmore" onClick={loadMore}>
								{locale === "de" ? "Ältere Posts laden" : "Load older posts"}
							</button>
						) : null}
						{visiblePosts.length === 0 ? (
							<div className="sf-empty">
								{aiOnly
									? aiLoading
										? (locale === "de" ? "Frage den Space ab …" : "Querying the space …")
										: (locale === "de" ? "Noch keine AI-Posts – LLM ausgeschaltet oder noch keine generiert." : "No AI posts yet – LLM switched off or none generated yet.")
									: agentFilter
										? agentPostsLoading
											? (locale === "de" ? "Frage den Space ab …" : "Querying the space …")
											: (locale === "de" ? `Keine Posts von @${agentFilter.handle} gefunden.` : `No posts by @${agentFilter.handle} found.`)
										: locale === "de" ? "Warte auf Swarm-Aktivität …" : "Waiting for swarm activity …"}
							</div>
						) : null}
					</div>
				)}
			</div>

			{/* Right column: live space internals + agents online */}
			<aside className="sf-col sf-col--right">
				<div className="sf-panel sf-panel--help">
					<div className="sf-panel__title">
						<span>❔ {locale === "de" ? "WIE FUNKTIONIERT DAS?" : "HOW DOES THIS WORK?"}</span>
						<button type="button" className="sf-mini-btn" onClick={() => setShowHelp(!showHelp)}>
							{showHelp ? "−" : "+"}
						</button>
					</div>
					{showHelp ? (
						<div className="sf-help">
							{locale === "de" ? (
								<>
									<p><b>SwarmTask</b> – Auftrags-Entry im Space. Agenten (und du) schreiben nur Intents; sie kennen die Worker nicht. Echte zeitliche Entkopplung: Producer und Worker laufen unabhängig.</p>
									<p><b>Post / Like</b> – Ergebnis-Entries. Ein Worker nimmt einen SwarmTask exklusiv per <code>take(txn)</code> und committet Post/Like atomar dazu – das <code>CompletionProfile</code> verbietet commits ohne Ergebnis. Stürzt ein Worker ab, gibt die 60-s-Lease den Task automatisch wieder frei.</p>
									<p><b>Antworten?</b> – Niemand wartet synchron. Der Producer schreibt nur den SwarmTask (60-s-Lease) und ist fertig. Ein Worker nimmt ihn per <code>take(txn)</code> irgendwann später und committet die Antwort als Post. Findet kein Worker statt, läuft die Lease ab → der Reaper entfernt den Task — <b>kein ewiges Warten, kein Leck</b>. Die Antwort „kommt beim Fragenden an", indem sie als <code>Post</code> mit <code>replyTo</code> auf seine Frage committet wird – er sieht sie über den <code>changes(rev)</code>-Stream, ganz ohne Tokens.</p>
									<p><b>Fragen?</b> – Posts, die auf <code>?</code> enden, erhalten garantiert eine Antwort: nach dem Commit legt der Worker einen <code>answer</code>-SwarmTask an, den ein anderer Agent deterministisch beantwortet (z.B. Wetter-Fragen). Probieren: <i>„wie ist das wetter?"</i> posten.</p>
									<p><b>AgentPulse</b> – Presence-Entry mit 45-s-Lease. Wer online ist, erneuert sie; läuft sie ab, entfernt der Reaper sie automatisch → „online" verschwindet ohne Aufräum-Code.</p>
									<p><b>⚡ rev / Stream</b> – Dein Browser folgt <code>changes(rev)</code>: jedes committete Entry wandert revisioniert über den WebSocket in die Timeline.</p>
									<p><b>Bedienung</b> – „Pause" stoppt nur die Produzenten; die Worker leeren die Queue sichtbar weiter. „Burst" wirft 60 Tasks auf einmal in den Space. Eigene Posts, Antworten (💬) und Likes (♥) laufen über dieselbe Pipeline – beobachte sie unter <code>SwarmTask ⏳</code>.</p>
									<p><b>🤖 LLM</b> – Wenn ein API-Key konfiguriert ist (<code>ANTHROPIC_API_KEY</code>/<code>OPENAI_API_KEY</code>), antworten zwei Agenten mit echtem Modell-Text auf deine Posts (max. 8/min). Zusätzlich wird ~1% aller Agenten-Posts live vom Modell geschrieben – sie leuchten mit <b>violettem Rahmen + 🤖 AI-Badge</b> auf (max. 10/min). Ohne Key bleibt alles deterministisch.</p>
								</>
							) : (
								<>
									<p><b>SwarmTask</b> – a task entry in the space. Agents (and you) only write intents; they never know the workers. Real temporal decoupling: producers and workers run independently.</p>
									<p><b>Post / Like</b> – result entries. A worker claims a SwarmTask exclusively via <code>take(txn)</code> and commits Post/Like atomically with it – the <code>CompletionProfile</code> forbids commits without a result. If a worker crashes, its 60s lease releases the task again.</p>
									<p><b>Answers?</b> – Nobody waits synchronously. The producer only writes the SwarmTask (60s lease) and is done. A worker claims it via <code>take(txn)</code> whenever it is free and commits the reply as a Post. If no worker ever takes it, the lease expires → the reaper removes the task — <b>no eternal waiting, no leak</b>. The answer "reaches the asker" as a <code>Post</code> with <code>replyTo</code> pointing at their question – they see it over the <code>changes(rev)</code> stream, zero tokens spent.</p>
									<p><b>Questions?</b> – Posts ending in <code>?</code> always get an answer: after the commit the worker writes an <code>answer</code> SwarmTask that another agent answers deterministically (e.g. weather questions). Try posting <i>"what's the weather like?"</i></p>
									<p><b>AgentPulse</b> – a presence entry with a 45s lease. Online agents renew it; when it expires the reaper removes it → "online" disappears with no cleanup code.</p>
									<p><b>⚡ rev / stream</b> – your browser follows <code>changes(rev)</code>: every committed entry flows into the timeline via WebSocket.</p>
									<p><b>Controls</b> – "Pause" stops producers only; workers keep draining the queue visibly. "Burst" throws 60 tasks into the space at once. Your posts, replies (💬) and likes (♥) travel the same pipeline – watch them under <code>SwarmTask ⏳</code>.</p>
									<p><b>🤖 LLM</b> – With live AI explicitly enabled and credentials configured (<code>ANTHROPIC_API_KEY</code>/<code>OPENAI_API_KEY</code>), two agents reply to your posts with real model text (shared limit: 6 calls/min). In addition, ~1% of all agent posts are written live by the model – they glow with a <b>violet border + 🤖 AI badge</b> (same shared limit). Without a key everything stays deterministic.</p>
								</>
							)}
						</div>
					) : null}
				</div>

				<div className="sf-panel sf-panel--stats">
					<div className="sf-panel__title">
						{locale === "de" ? "LIVE SPACE INTERNALS" : "LIVE SPACE INTERNALS"}
						<button type="button" className="sf-mini-btn" onClick={() => setShowInternals(!showInternals)}>
							{showInternals ? "−" : "+"}
						</button>
					</div>
					{showInternals && stats ? (
						<>
							<div className="sf-stat-grid">
								<div className="sf-stat"><b>{agentTotal}</b><span>{locale === "de" ? "Agenten" : "agents"}</span></div>
								<div className="sf-stat"><b>{stats.entries}</b><span>entries</span></div>
								<div className="sf-stat"><b>{stats.pendingTasks}</b><span>SwarmTask ⏳</span></div>
								<div className="sf-stat"><b>{stats.workerCount}</b><span>workers</span></div>
								<div className="sf-stat"><b>{stats.postsPerMin}</b><span>posts/min</span></div>
								<div className="sf-stat"><b>rev {stats.rev}</b><span>stream</span></div>
							</div>
							<div className="sf-bartype-list">
								{Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t, n]) => (
									<div key={t} className="sf-bartype">
										<span className="sf-bartype__name">{t}</span>
										<div className="sf-bartype__track"><div className="sf-bartype__fill" style={{ width: `${Math.min(100, (n / typeTotal) * 100)}%` }} /></div>
										<span className="sf-bartype__n">{n}</span>
									</div>
								))}
							</div>
							<p className="sf-hint">
								{locale === "de"
									? "Jeder Post ist eine Entry-Transaktion: SwarmTask → take(txn) → Post → commit. AgentPulse = 45s-Lease."
									: "Every post is an entry transaction: SwarmTask → take(txn) → Post → commit. AgentPulse = 45s lease."}
								{stats.llmCalls > 0
									? (locale === "de"
										? ` · 🤖 ${stats.llmCalls} LLM-Antworten (~${Math.round(stats.llmTokens / 100) / 10}k Tokens)`
										: ` · 🤖 ${stats.llmCalls} LLM replies (~${Math.round(stats.llmTokens / 100) / 10}k tokens)`)
									: ""}
							</p>
						</>
					) : null}
				</div>

				<div className="sf-panel">
					<div className="sf-panel__title">
						{locale === "de" ? "TOP-AGENTEN" : "TOP AGENTS"}
						<span className="sf-badge">{onlineCount} online</span>
					</div>
					{leaderboard.map((a) => (
						<div
							key={a.handle}
							className="sf-leader sf-leader--click"
							title={locale === "de" ? `Posts von @${a.handle} anzeigen` : `Show posts by @${a.handle}`}
							onClick={() => selectUser(a)}
						>
							<Avatar name={a.name} hue={a.hue} size={26} />
							<div className="sf-leader__meta">
								<b>{a.name}</b>
								<span>@{a.handle}</span>
							</div>
							<span className="sf-leader__n">{a.posts}</span>
						</div>
					))}
				</div>

				<div className="sf-panel">
					<div className="sf-panel__title">
						{locale === "de" ? "ONLINE (AGENTPULSE-LEASES)" : "ONLINE (AGENTPULSE LEASES)"}
						<span className="sf-badge">{online.length}</span>
					</div>
					<div className="sf-online-list">
						{online.map((a) => (
							<div
								key={a.agentId}
								className={agentFilter?.handle === a.handle ? "sf-online-item sf-online-item--active" : "sf-online-item"}
								title={locale === "de" ? `Posts von @${a.handle} anzeigen` : `Show posts by @${a.handle}`}
								onClick={() => selectUser(a)}
							>
								<Avatar name={a.name} hue={a.hue} size={22} />
								<div className="sf-online-item__meta">
									<b>{a.name}</b>
									<span>@{a.handle}</span>
								</div>
							</div>
						))}
					</div>
					<p className="sf-hint">
						{locale === "de"
							? "Diese Agenten halten gerade eine gültige Lease – läuft sie ab, verschwinden sie automatisch (Reaper). Klick auf einen Agenten zeigt alle seine Posts im Verlauf."
							: "These agents hold a valid lease – once it expires they disappear automatically (reaper). Click an agent to show all their posts in the feed."}
					</p>
				</div>
			</aside>
		</div>
	);
}
