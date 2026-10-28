"use client";
// Main PHI-SPACES / HELP React Application.
import { useEffect, useMemo, useRef, useState } from "react";
import { applyThemeToDocument, PALETTES } from "./lib/palettes.ts";
import { scoreArticle, searchAreas, searchArticles } from "./lib/search.ts";
import { renderMarkdownToHtml } from "./lib/markdown.ts";
import { startArticleLoad } from "./lib/article-load.ts";
import { helpUrl, parseHelpView, resourceView, type ViewState } from "./lib/help-navigation.ts";
import { startIndexLoad } from "./lib/index-load.ts";
import { SpaceChatWorkbench } from "./components/SpaceChatWorkbench.tsx";
import { AdminSpacesView } from "./components/AdminSpacesView.tsx";
import { SocialFeedView } from "./components/SocialFeedView.tsx";
import { AppIntro } from "./components/AppIntro.tsx";
import { SystemBar } from "./components/SystemBar.tsx";

/** The codemode chat (its own site: agents and people write code into a shared space, a sandbox judges it). */
const CODEMODE_CHAT_URL = "https://codemode.eibrain.org";
const SPACES_MMO_URL = "https://spaces-mmo.eibrain.org";

const PROVIDERS = ["core", "client", "tools", "remote", "security", "federation", "ops"] as const;

export function HelpApp(props: { initialIndex?: any } = {}) {
	const [indexError, setIndexError] = useState<string | null>(null);
	const [indexAttempt, setIndexAttempt] = useState(0);
	const [indexData, setIndexData] = useState<any>(props.initialIndex ?? null);
	const [locale, setLocale] = useState<"de" | "en">("en");
	const [mode, setMode] = useState<"dark" | "light">("dark");
	const [palette, setPalette] = useState<string>("spaces_default");
	const [view, setView] = useState<ViewState>({ kind: "home" });
	const [searchInput, setSearchInput] = useState<string>("");
	const [articleMarkdown, setArticleMarkdown] = useState<string>("");
	const [loadingArticle, setLoadingArticle] = useState<boolean>(false);
	// Below 1024 px the sidebar is a drawer; it opens from the menu button and closes on any navigation.
	const [menuOpen, setMenuOpen] = useState<boolean>(false);
	// A mostly horizontal swipe to the left closes the drawer; vertical scrolling in it stays untouched.
	const swipeStart = useRef<{ x: number; y: number } | null>(null);
	const drawerSwipe = {
		onTouchStart: (e: any) => { const t = e.touches[0]; swipeStart.current = t ? { x: t.clientX, y: t.clientY } : null; },
		onTouchEnd: (e: any) => {
			const s = swipeStart.current, t = e.changedTouches[0];
			swipeStart.current = null;
			if (!s || !t) return;
			const dx = t.clientX - s.x, dy = t.clientY - s.y;
			if (dx < -50 && Math.abs(dx) > Math.abs(dy) * 1.5) setMenuOpen(false);
		},
	};
	const searchRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		const savedLocale = new URLSearchParams(window.location.search).get("lang") ?? window.localStorage.getItem("phi-spaces-help-locale");
		if (savedLocale === "de" || savedLocale === "en") setLocale(savedLocale);
		const savedMode = window.localStorage.getItem("phi-spaces-help-mode");
		if (savedMode === "dark" || savedMode === "light") setMode(savedMode);
		const savedPalette = window.localStorage.getItem("phi-spaces-help-palette");
		if (savedPalette) setPalette(savedPalette);
		setView(parseHelpView(window.location.search));


		const onPop = () => { setView(parseHelpView(window.location.search)); const language = new URLSearchParams(window.location.search).get("lang"); if (language === "de" || language === "en") setLocale(language); };
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

 useEffect(() => {
  if(props.initialIndex) return;
  setIndexError(null);
  return startIndexLoad({content:setIndexData,error:e=>setIndexError(String(e))});
 }, [indexAttempt]);
 const changeLocale = (value: "de" | "en") => {
  setLocale(value);
  const url=new URL(window.location.href); url.searchParams.set("lang",value);
  window.history.replaceState(null,"",url.pathname+url.search+url.hash);
 };

	useEffect(() => {
		applyThemeToDocument(mode, palette);
		window.localStorage.setItem("phi-spaces-help-mode", mode);
		window.localStorage.setItem("phi-spaces-help-palette", palette);
	}, [mode, palette]);

	useEffect(() => {
		document.documentElement.lang = locale;
		window.localStorage.setItem("phi-spaces-help-locale", locale);
	}, [locale]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const tag = (e.target as HTMLElement | null)?.tagName;
			const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
			if ((e.key === "/" && !inInput) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
				e.preventDefault();
				searchRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);


 const navigate = (next: ViewState, hash = "") => {
  window.history.pushState(null,"",window.location.pathname+helpUrl(next,locale,hash));
  setView(next);
  setMenuOpen(false);
 };
 useEffect(() => {
  if (!menuOpen) return;
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
 }, [menuOpen]);
 const updateFilters = (next: ViewState) => {
  window.history.replaceState(null,"",window.location.pathname+helpUrl(next,locale));
  setView(next);
 };

	const openArticle = (id: string, anchor?: string) => {
		navigate({ kind: "article", id }, anchor ? `#${anchor.replace(/^#/, "")}` : "");
		if (anchor && view.kind === "article" && view.id === id) requestAnimationFrame(() => document.getElementById(anchor.replace(/^#/, ""))?.scrollIntoView());
	};

	const localizedArticles = useMemo(() => {
		if (!indexData?.articles) return [];
		return indexData.articles.filter((a: any) => a.locale === locale);
	}, [indexData, locale]);

	const articleById = useMemo(
		() => new Map<string, any>(localizedArticles.map((a: any) => [a.id, a])),
		[localizedArticles],
	);
	const areas = indexData?.areas ?? [];
	const areaById = useMemo(() => new Map<string, any>(areas.map((a: any) => [a.id, a])), [areas]);

	const areaByArticleId = useMemo(() => {
		const map = new Map<string, any>();
		for (const area of areas) {
			for (const id of area.articleIds ?? []) map.set(id, area);
		}
		return map;
	}, [areas]);

	const currentArticle = view.kind === "article" ? articleById.get(view.id) : undefined;

	useEffect(() => {
		if (!currentArticle) return;
		setArticleMarkdown("");
		setLoadingArticle(true);
		return startArticleLoad(currentArticle.path, {
			content: (md, signal) => {
				setArticleMarkdown(md);
				requestAnimationFrame(() => {
					if (signal.aborted) return;
					const hash = window.location.hash.slice(1);
					if (hash) document.getElementById(hash)?.scrollIntoView();
					else document.querySelector(".content-scroll")?.scrollTo(0, 0);
				});
			},
			error: e => setArticleMarkdown(`Artikel konnte nicht geladen werden: ${String(e)}`),
			done: () => setLoadingArticle(false),
		});
	}, [currentArticle?.path]);

	const apiArticles = useMemo(
		() => localizedArticles.filter((a: any) => a.type === "api" && a.api),
		[localizedArticles],
	);

	const filteredApiArticles = useMemo(() => {
		if (view.kind !== "api-finder") return apiArticles;
		return apiArticles.filter((a: any) => {
			const api = a.api;
			if (view.provider !== "all" && a.provider !== view.provider) return false;
			if (view.category !== "all" && api.category !== view.category) return false;
			if (view.execution !== "all" && api.execution !== view.execution) return false;
			if (view.idempotency !== "all" && api.idempotency !== view.idempotency) return false;
			if (view.scope !== "all" && api.scope !== view.scope) return false;
			if (view.query.trim()) {
				if (scoreArticle(a, view.query) < 0) return false;
			}
			return true;
		});
	}, [apiArticles, view]);

	if (!indexData) {
		return (
			<main className="corpus-bootstrap" style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
				<div>
					<strong>PHI-SPACES / HELP</strong>
					<p role={indexError ? "alert" : "status"}>{indexError ? (locale === "de" ? `Hilfe konnte nicht geladen werden: ${indexError}` : `Help could not be loaded: ${indexError}`) : (locale === "de" ? "Help-Corpus wird geladen …" : "Loading help corpus …")}</p>
					{indexError ? <button type="button" onClick={() => setIndexAttempt(n => n + 1)}>{locale === "de" ? "Erneut versuchen" : "Retry"}</button> : null}
				</div>
			</main>
		);
	}

	// an app's entries are active on its introduction and on the app itself
	const isApp = (app: "swarm" | "codemode" | "space-chat" | "mmo") =>
		(view.kind === "intro" && view.app === app) || (app === "swarm" && view.kind === "feed") || (app === "space-chat" && view.kind === "space-chat");
	const introTarget = (app: "swarm" | "codemode" | "space-chat" | "mmo") =>
		app === "codemode" ? { href: CODEMODE_CHAT_URL, external: true }
			: app === "mmo" ? { href: SPACES_MMO_URL, external: true }
				: { href: helpUrl(app === "swarm" ? { kind: "feed" } : { kind: "space-chat", sessionId: "lobby" }, locale), external: false };

	const hasRightToc = view.kind === "article" && currentArticle && (currentArticle.toc?.length ?? 0) > 0;

	return (
		<div className="help-app">
			{/* Topbar */}
			<header className="topbar">
				<button
					type="button"
					className="topbar__menu"
					aria-label={locale === "de" ? "Navigation öffnen" : "Open navigation"}
					aria-expanded={menuOpen}
					aria-controls="help-sidebar"
					onClick={() => setMenuOpen(!menuOpen)}
				>
					{menuOpen ? "✕" : "☰"}
				</button>
				<button type="button" className="brand" onClick={() => navigate({ kind: "home" })}>
					<span className="brand__name">PHI-SPACES</span>
					<span className="brand__divider">/</span>
					<span className="brand__section">HELP</span>
				</button>

				<form
					className="global-search"
					role="search"
					onSubmit={(e) => {
						e.preventDefault();
						const q = searchInput.trim();
						if (!q) navigate({ kind: "home" });
						else navigate({ kind: "search", query: q });
					}}
				>
					<span style={{ color: "var(--muted)" }}>⌕</span>
					<input
						id="global-help-search"
						ref={searchRef}
						value={searchInput}
						onChange={(e: any) => setSearchInput(e.target.value)}
						placeholder={
							locale === "de"
								? "Systeme, API-Methoden, Entry-Typen, Stufen v1–v6, Fehler …"
								: "Systems, API methods, entry types, stages v1–v6, errors …"
						}
					/>
					<kbd>Ctrl K</kbd>
				</form>

				<div className="topbar__actions">
					<button
						type="button"
						className={isApp("swarm") ? "nav-pill-btn is-active" : "nav-pill-btn"}
						onClick={() => navigate({ kind: "intro", app: "swarm" })}
					>
						<span>◉ Space Chat</span>
					</button>
					<button
						type="button"
						className={isApp("space-chat") ? "nav-pill-btn is-active" : "nav-pill-btn"}
						onClick={() => navigate({ kind: "intro", app: "space-chat" })}
					>
						<span>● Multiplayer Chat (v1–v6)</span>
					</button>
					<button
						type="button"
						className={view.kind === "admin" ? "nav-pill-btn is-active" : "nav-pill-btn"}
						onClick={() => navigate({ kind: "admin" })}
					>
						<span>⚙ ADMINSPACES</span>
					</button>

					<div className="locale-switch">
						<button
							type="button"
							className={locale === "de" ? "is-active" : ""}
							onClick={() => changeLocale("de")}
						>
							DE
						</button>
						<button
							type="button"
							className={locale === "en" ? "is-active" : ""}
							onClick={() => changeLocale("en")}
						>
							EN
						</button>
					</div>

					<div className="mode-switch">
						<button
							type="button"
							className={mode === "dark" ? "is-active" : ""}
							onClick={() => setMode("dark")}
							title="Dark Mode"
						>
							☾
						</button>
						<button
							type="button"
							className={mode === "light" ? "is-active" : ""}
							onClick={() => setMode("light")}
							title="Light Mode"
						>
							☀
						</button>
					</div>

					<div className="theme-picker">
						<select
							className="theme-picker__select"
							value={palette}
							onChange={(e: any) => setPalette(e.target.value)}
							aria-label="Color Palette"
						>
							{PALETTES.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label[locale]}
								</option>
							))}
						</select>
					</div>
				</div>
			</header>

			{/* 3-Column Workspace */}
			<div className={hasRightToc ? "workspace has-toc" : "workspace"}>
				{menuOpen ? <div className="drawer-backdrop" onClick={() => setMenuOpen(false)} {...drawerSwipe} aria-hidden="true" /> : null}
				<aside id="help-sidebar" className={menuOpen ? "sidebar is-open" : "sidebar"} {...(menuOpen ? drawerSwipe : {})}>
					<nav className="nav-section">
						<span className="nav-section__label">
							{locale === "de" ? "NAVIGATION" : "NAVIGATION"}
						</span>
						<button
							type="button"
							className={view.kind === "home" ? "nav-link is-active" : "nav-link"}
							onClick={() => navigate({ kind: "home" })}
						>
							<span>{locale === "de" ? "Help-Übersicht" : "Help Overview"}</span>
						</button>
						<button
							type="button"
							className={view.kind === "browse" && view.owner === "all" ? "nav-link is-active" : "nav-link"}
							onClick={() => navigate({ kind: "browse", owner: "all" })}
						>
							<span>{locale === "de" ? "Alle Inhalte" : "All Content"}</span>
							<span className="nav-link__badge">{indexData.stats.uniqueArticles}</span>
						</button>
						<button
							type="button"
							className={view.kind === "api-finder" ? "nav-link is-active" : "nav-link"}
							onClick={() =>
								navigate({
									kind: "api-finder",
									mode: "api",
									query: "",
									provider: "all",
									category: "all",
									execution: "all",
									idempotency: "all",
									scope: "all",
								})
							}
						>
							<span>{locale === "de" ? "API & Tool Finder" : "API & Tool Finder"}</span>
							<span className="nav-link__badge">{indexData.stats.apiArticles}</span>
						</button>
						<button
							type="button"
							className={isApp("swarm") ? "nav-link is-active" : "nav-link"}
							onClick={() => navigate({ kind: "intro", app: "swarm" })}
						>
							<span>{locale === "de" ? "Space Chat Feed (Agenten-Schwarm)" : "Space Chat Feed (agent swarm)"}</span>
							<span className="nav-link__badge">SWARM</span>
						</button>
						<button
							type="button"
							className={isApp("codemode") ? "nav-link is-active" : "nav-link"}
							onClick={() => navigate({ kind: "intro", app: "codemode" })}
						>
							<span>{locale === "de" ? "Codemode-Chat (Agenten schreiben Code)" : "Codemode chat (agents write code)"}</span>
							<span className="nav-link__badge">CODE</span>
						</button>
						<button
							type="button"
							className={isApp("space-chat") ? "nav-link is-active" : "nav-link"}
							onClick={() => navigate({ kind: "intro", app: "space-chat" })}
						>
							<span>{locale === "de" ? "Multiplayer Space-Chat (v1–v6)" : "Multiplayer Space-Chat (v1–v6)"}</span>
							<span className="nav-link__badge">LIVE</span>
						</button>
						<button
							type="button"
							className={isApp("mmo") ? "nav-link is-active" : "nav-link"}
							onClick={() => navigate({ kind: "intro", app: "mmo" })}
						>
							<span>{locale === "de" ? "spaces-mmo (Rollenspiel im Nebel)" : "spaces-mmo (role-playing in the fog)"}</span>
							<span className="nav-link__badge">MMO</span>
						</button>
						<button
							type="button"
							className={view.kind === "admin" ? "nav-link is-active" : "nav-link"}
							onClick={() => navigate({ kind: "admin" })}
						>
							<span>{locale === "de" ? "AdminSpaces Steuerung" : "AdminSpaces Control"}</span>
							<span className="nav-link__badge">LOGIN</span>
						</button>
					</nav>

					<nav className="nav-section">
						<span className="nav-section__label">
							{locale === "de" ? "9 KANONISCHE SYSTEME" : "9 CANONICAL SYSTEMS"}
						</span>
						{areas.map((area: any, idx: number) => (
							<button
								key={area.id}
								type="button"
								className={
									view.kind === "area" && view.id === area.id ? "nav-link is-active" : "nav-link"
								}
								onClick={() => navigate({ kind: "area", id: area.id })}
							>
								<span>{area.title[locale]}</span>
								<span style={{ font: "600 9px/1 var(--font-geist-mono)", color: "var(--muted)" }}>
									{String(idx + 1).padStart(2, "0")}
								</span>
							</button>
						))}
					</nav>

					{/* Only in the drawer: the palette, which the topbar has no room for on a phone */}
					<div className="nav-section sidebar__display">
						<span className="nav-section__label">{locale === "de" ? "DARSTELLUNG" : "APPEARANCE"}</span>
						<select
							className="theme-picker__select"
							value={palette}
							onChange={(e: any) => setPalette(e.target.value)}
							aria-label="Color Palette"
						>
							{PALETTES.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label[locale]}
								</option>
							))}
						</select>
					</div>

					<div className="sidebar__footer">
						<span className="status-dot" />
						<span>spaces.eibrain.org · {indexData.corpus.hash.slice(0, 8)}</span>
					</div>
				</aside>

				<main className="content-scroll">
					{/* HOME VIEW */}
					{view.kind === "home" ? (
						<div className="home-view">
							<section className="home-hero">
								<div className="eyebrow">
									<span>PHI-SPACES</span>
									<span className="eyebrow__line" />
									<span>
										{locale === "de"
											? `HELP-CORPUS · SPACES.EIBRAIN.ORG · ${indexData.corpus.frozenOn}`
											: `HELP CORPUS · SPACES.EIBRAIN.ORG · ${indexData.corpus.frozenOn}`}
									</span>
								</div>
								<h1>
									{locale === "de" ? (
										<>
											Schreiben.
											<br />
											Koordinieren. <em>Überleben.</em>
										</>
									) : (
										<>
											Write.
											<br />
											Coordinate. <em>Survive.</em>
										</>
									)}
								</h1>
								<p className="home-hero__lead">
									{locale === "de"
										? "Die technische Produktreferenz und interaktive Entwicklungsplattform für phi-spaces: Vom lokalen Tuple-Space über RequestRef-Claims, CompletionProfiles, Overlay-Gate (Schicht A/B) und HRW-Federation bis zum 6-stufigen Multiplayer Space-Chat und der mobilen Steuerung."
										: "The technical product reference and interactive workbench for phi-spaces: from local tuple spaces through RequestRef claims, CompletionProfiles, overlay gate (Layer A/B), and HRW federation to the 6-stage Multiplayer Space-Chat and mobile control."}
								</p>
								<div className="hero-actions">
									<button
										type="button"
										className="primary-action"
										onClick={() => openArticle("help.topic.first_running_space")}
									>
										<span>
											{locale === "de"
												? "Ersten vollständigen Space starten →"
												: "Start Your First Complete Space →"}
										</span>
									</button>
									<button
										type="button"
										className="secondary-action"
										onClick={() => navigate({ kind: "intro", app: "swarm" })}
									>
										<span>
											{locale === "de"
												? "◉ Space Chat: Agenten-Schwarm live"
												: "◉ Space Chat: agent swarm live"}
										</span>
									</button>
									<button
										type="button"
										className="secondary-action"
										onClick={() => navigate({ kind: "intro", app: "codemode" })}
									>
										<span>
											{locale === "de"
												? "⌨ Codemode-Chat: Agenten schreiben Code"
												: "⌨ Codemode chat: agents write code"}
										</span>
									</button>
									<button
										type="button"
										className="secondary-action"
										onClick={() => navigate({ kind: "intro", app: "space-chat" })}
									>
										<span>
											{locale === "de"
												? "● Multiplayer Space-Chat live"
												: "● Live Multiplayer Space-Chat"}
										</span>
									</button>
									<button
										type="button"
										className="secondary-action"
										onClick={() => navigate({ kind: "intro", app: "mmo" })}
									>
										<span>
											{locale === "de"
												? "⚓ spaces-mmo: Rollenspiel im Nebel"
												: "⚓ spaces-mmo: role-playing in the fog"}
										</span>
									</button>
									<button
										type="button"
										className="secondary-action"
										onClick={() => navigate({ kind: "admin" })}
									>
										<span>
											{locale === "de" ? "⚙ AdminSpaces Login" : "⚙ AdminSpaces Login"}
										</span>
									</button>
									<a
										className="secondary-action"
										href="https://github.com/jeamy/phi-space"
										target="_blank"
										rel="noopener noreferrer"
									>
										<span>{locale === "de" ? "⌥ GitHub-Repository" : "⌥ GitHub Repository"}</span>
									</a>
								</div>
							</section>

							{/* Section 01: 2-Lane Execution Model */}
							<section className="system-model">
								<div className="section-heading">
									<span>01</span>
									<div>
										<p>{locale === "de" ? "Kanonisches Modell" : "Canonical Model"}</p>
										<h2>
											{locale === "de"
												? "Lokal atomar. Föderiert journalisiert."
												: "Locally atomic. Federatedly journaled."}
										</h2>
									</div>
								</div>
								<figure className="execution-model">
									<div className="execution-model__bar">
										<span>PHI-SPACES EXECUTION FLOW</span>
										<span>SINGLE-HOST VS. FEDERATED CLUSTER</span>
									</div>
									<div className="execution-lane execution-lane--rt">
										<div className="execution-lane__identity">
											<strong>LOCAL</strong>
											<span>V1–V3 SINGLE SPACE</span>
										</div>
										<ol className="execution-sequence">
											<li className="process-plate">
												<span className="process-plate__meta">
													<b>01</b> <em>Input &amp; Claim</em>
												</span>
												<strong>Entry + RequestRef</strong>
												<small>
													{locale === "de"
														? "Template-Match, Lease & RFC-8785 Hash"
														: "Template match, lease & RFC-8785 hash"}
												</small>
											</li>
											<li className="process-plate">
												<span className="process-plate__meta">
													<b>02</b> <em>Atomic Commit</em>
												</span>
												<strong>Txn + CompletionProfile</strong>
												<small>
													{locale === "de"
														? "Mutation, Claim, rev & Budget in 1 Commit"
														: "Mutation, claim, rev & budget in 1 commit"}
												</small>
											</li>
											<li className="process-plate">
												<span className="process-plate__meta">
													<b>03</b> <em>Reactive Stream</em>
												</span>
												<strong>readPage / changes / Mailbox</strong>
												<small>
													{locale === "de"
														? "Konsistente Snapshots & Präfix-ACK"
														: "Consistent snapshots & prefix ACK"}
												</small>
											</li>
										</ol>
									</div>
									<div className="execution-lane">
										<div className="execution-lane__identity">
											<strong>CLUSTER</strong>
											<span>V4 GATE · V5 ROUTING · V6 OPS</span>
										</div>
										<ol className="execution-sequence">
											<li className="process-plate">
												<span className="process-plate__meta">
													<b>01</b> <em>Zero-Trust Gate</em>
												</span>
												<strong>Layer A/B + 60s Grant</strong>
												<small>
													{locale === "de"
														? "NetBird-Peer + Ed25519 Challenge"
														: "NetBird peer + Ed25519 challenge"}
												</small>
											</li>
											<li className="process-plate">
												<span className="process-plate__meta">
													<b>02</b> <em>Router &amp; Sharding</em>
												</span>
												<strong>HRW Policy &amp; Journal</strong>
												<small>
													{locale === "de"
														? "Partitionierte Journale & takeWaiting"
														: "Partitioned journals & takeWaiting"}
												</small>
											</li>
											<li className="process-plate">
												<span className="process-plate__meta">
													<b>03</b> <em>Operations Control</em>
												</span>
												<strong>RunGate &amp; AdminSpaces</strong>
												<small>
													{locale === "de"
														? "Steuerung via Smartphone & Web-Admin"
														: "Control via smartphone & web admin"}
												</small>
											</li>
										</ol>
									</div>
									<figcaption className="model-note">
										{locale === "de"
											? "PhiSpaces und RemoteSpace teilen denselben SpaceLike-Vertrag. Lokaler und Remote-Client teilen den Basisvertrag; Federation benötigt einen eigenen Request-/Routing-Adapter."
											: "PhiSpaces and RemoteSpace share the exact same SpaceLike contract. Application concepts transfer between local and remote clients; federation needs its own request/routing adapter."}
									</figcaption>
								</figure>
							</section>

							{/* Section 02: 9 Canonical Systems */}
							<section className="topic-grid-section">
								<div className="section-heading">
									<span>02</span>
									<div>
										<p>{locale === "de" ? "Klare Inhaltsordnung" : "Clear Content Model"}</p>
										<h2>
											{locale === "de"
												? "Neun Systeme. Eine kanonische Ordnung."
												: "Nine systems. One canonical order."}
										</h2>
									</div>
								</div>
								<div className="help-area-grid">
									{areas.map((area: any, idx: number) => (
										<article key={area.id} className="help-area-card">
											<header className="help-area-card__header">
												<span className="help-area-card__number">
													{String(idx + 1).padStart(2, "0")}
												</span>
												<span className="help-area-card__kind">
													{area.kind === "reference" ? "REFERENCE" : "SYSTEM"} · CANONICAL
												</span>
											</header>
											<div className="help-area-card__copy">
												<button
													type="button"
													className="help-area-card__title"
													onClick={() => navigate({ kind: "area", id: area.id })}
												>
													<span>{area.title[locale]}</span>
													<span>→</span>
												</button>
												<p>{area.short[locale]}</p>
											</div>
											<div className="help-area-card__links">
												{(area.articleIds ?? []).slice(0, 4).map((aid: string) => {
													const art = articleById.get(aid);
													if (!art) return null;
													return (
														<button key={aid} type="button" onClick={() => openArticle(aid)}>
															<span>{art.title}</span>
															<span>›</span>
														</button>
													);
												})}
											</div>
										</article>
									))}
								</div>
							</section>

							{/* Section 03: Corpus Metrics */}
							<section className="corpus-strip">
								<div className="section-heading">
									<span>03</span>
									<div>
										<p>{locale === "de" ? "Source-eigener Bestand" : "Source-Owned Corpus"}</p>
										<h2>
											{locale === "de"
												? "Vertrag, Code und Live-Nachweis vereint."
												: "Contract, code, and live evidence united."}
										</h2>
									</div>
								</div>
								<div className="corpus-metrics">
									<button
										type="button"
										onClick={() =>
											navigate({
												kind: "api-finder",
												mode: "api",
												query: "",
												provider: "all",
												category: "all",
												execution: "all",
												idempotency: "all",
												scope: "all",
											})
										}
									>
										<strong>{indexData.stats.apiArticles}</strong>
										<span>
											{locale === "de"
												? "kanonische API- & Agent-Tool-Referenzen"
												: "canonical API & agent tool references"}
										</span>
									</button>
									<button
										type="button"
										onClick={() => navigate({ kind: "browse", owner: "all", articleType: "workflow" })}
									>
										<strong>{locale === "de" ? "6 Stufen" : "6 Stages"}</strong>
										<span>
											{locale === "de"
												? "ausführbare Space-Chat-Versionen (v1 bis v6)"
												: "runnable Space-Chat stages (v1 to v6)"}
										</span>
									</button>
									<button type="button" onClick={() => navigate({ kind: "browse", owner: "all" })}>
										<strong>{indexData.stats.uniqueArticles}</strong>
										<span>
											{locale === "de"
												? "validierte Help-Identitäten im Corpus"
												: "validated help identities in corpus"}
										</span>
									</button>
									<div>
										<strong>DE / EN</strong>
										<span>
											{locale === "de"
												? "100 % Anker-Parität & Offline-Index"
												: "100% anchor parity & offline index"}
										</span>
									</div>
								</div>
							</section>
						</div>
					) : null}

					{/* AREA VIEW */}
					{view.kind === "area" ? (
						<div className="listing-view">
							{(() => {
								const area = areaById.get(view.id);
								if (!area) return <p>Area not found</p>;
								const items = (area.articleIds ?? [])
									.map((id: string) => articleById.get(id))
									.filter(Boolean);
								return (
									<>
										<div className="listing-heading">
											<div>
												<span className="eyebrow-copy">{area.id.toUpperCase()}</span>
												<h1>{area.title[locale]}</h1>
												<p>{area.short[locale]}</p>
											</div>
											<span className="meta-pill meta-pill--accent">CANONICAL</span>
										</div>
										<div className="result-list">
											{items.map((art: any) => (
												<button
													key={art.id}
													type="button"
													className="result-card"
													onClick={() => openArticle(art.id)}
												>
													<span className="result-card__meta">
														<span>_{art.provider.toUpperCase()}</span>
														<span>{art.type.toUpperCase()}</span>
													</span>
													<span className="result-card__primary">
														<strong>{art.title}</strong>
														<code>{art.id}</code>
													</span>
													<span className="result-card__short">{art.short}</span>
												</button>
											))}
										</div>
									</>
								);
							})()}
						</div>
					) : null}

					{/* API & TOOL FINDER VIEW */}
					{view.kind === "api-finder" ? (
						<div className="listing-view">
							<div className="listing-heading">
								<div>
									<span className="eyebrow-copy">
										{locale === "de" ? "TECHNISCHER INDEX" : "TECHNICAL INDEX"}
									</span>
									<h1>
										{locale === "de"
											? "API, Agent-Tools & Module"
											: "API, Agent Tools & Modules"}
									</h1>
									<p>
										{locale === "de"
											? "Facettierte Referenz über PhiSpaces, RemoteSpace, SpaceService, die 8 LLM-Agent-Tools, Gate/Grants, Federation und Betrieb."
											: "Faceted reference across PhiSpaces, RemoteSpace, SpaceService, the 8 LLM agent tools, Gate/Grants, Federation, and Operations."}
									</p>
								</div>
								<span className="meta-pill meta-pill--accent">{apiArticles.length} API ENTRIES</span>
							</div>

							<div className="operator-mode-switch">
								<button
									type="button"
									className={view.mode === "api" ? "is-active" : ""}
									onClick={() => navigate({ ...view, mode: "api" })}
								>
									<span>API &amp; Tools</span>
									<b>{apiArticles.length}</b>
								</button>
								<button
									type="button"
									className={view.mode === "modules" ? "is-active" : ""}
									onClick={() => navigate({ ...view, mode: "modules" })}
								>
									<span>{locale === "de" ? "Architektur-Pakete" : "Architecture Packages"}</span>
									<b>{(indexData.modulePackages ?? []).length}</b>
								</button>
							</div>

							{view.mode === "api" ? (
								<>
									<section className="operator-finder">
										<div className="operator-finder__search">
											<input
												id="api-finder-query"
												value={view.query}
												onChange={(e: any) => updateFilters({ ...view, query: e.target.value })}
												placeholder={
													locale === "de"
														? "Methode, Signatur, Tool oder Fehlerklasse filtern …"
														: "Filter method, signature, tool, or error class …"
												}
											/>
										</div>
										<div className="operator-provider-filter">
											{["all", ...PROVIDERS].map((prov) => (
												<button
													key={prov}
													type="button"
													className={view.provider === prov ? "is-active" : ""}
													onClick={() => updateFilters({ ...view, provider: prov })}
												>
													<span>{prov === "all" ? "ALL" : `_${prov.toUpperCase()}`}</span>
												</button>
											))}
										</div>
										<div className="operator-facet-grid">
											<label>
												<span>Category</span>
												<select
													value={view.category}
													onChange={(e: any) => updateFilters({ ...view, category: e.target.value })}
												>
													<option value="all">All categories</option>
													<option value="mutation">Mutation</option>
													<option value="query_snapshot">Query / Snapshot</option>
													<option value="transaction_lease">Transaction / Lease</option>
													<option value="wait_stream_mailbox">Wait / Mailbox</option>
													<option value="security_grant">Security / Grant</option>
													<option value="federation_routing">Federation / Routing</option>
													<option value="operations_run">Operations / RunGate</option>
												</select>
											</label>
											<label>
												<span>Execution</span>
												<select
													value={view.execution}
													onChange={(e: any) => updateFilters({ ...view, execution: e.target.value })}
												>
													<option value="all">All execution modes</option>
													<option value="atomic_commit">Atomic Commit</option>
													<option value="blocking_wait">Blocking Wait</option>
													<option value="non_blocking_event">Non-Blocking Event</option>
													<option value="snapshot_stream">Snapshot / Stream</option>
													<option value="replay_safe_tool">Replay-Safe Tool</option>
													<option value="rpc_retry">RPC Retry</option>
													<option value="crypto_challenge">Crypto Challenge</option>
													<option value="journaled_command">Journaled Command</option>
													<option value="ack_barrier">ACK Barrier</option>
												</select>
											</label>
											<label>
												<span>Idempotency</span>
												<select
													value={view.idempotency}
													onChange={(e: any) => updateFilters({ ...view, idempotency: e.target.value })}
												>
													<option value="all">All idempotency models</option>
													<option value="request_ref">RequestRef Claim</option>
													<option value="task_claim">Task Claim (replay: safe)</option>
													<option value="read_only">Read-Only Snapshot</option>
													<option value="cas_epoch">CAS / Epoch-Bound</option>
												</select>
											</label>
											<label>
												<span>Scope</span>
												<select
													value={view.scope}
													onChange={(e: any) => updateFilters({ ...view, scope: e.target.value })}
												>
													<option value="all">All scopes</option>
													<option value="single_or_remote">Single or RemoteSpace</option>
													<option value="single_space">Single Space</option>
													<option value="conversation_owned">Conversation-Owned</option>
													<option value="unix_or_tcp">Unix Socket / TCP</option>
													<option value="control_and_data">Control &amp; Data Host</option>
													<option value="multi_member_cluster">Multi-Member Cluster</option>
													<option value="coordinator_control">Coordinator Control</option>
												</select>
											</label>
										</div>
									</section>

									<div className="result-list">
										{filteredApiArticles.map((art: any) => (
											<button
												key={art.id}
												type="button"
												className="result-card"
												onClick={() => openArticle(art.id)}
											>
												<span className="result-card__meta">
													<span>_{art.provider.toUpperCase()}</span>
													<span>{art.api?.idempotency}</span>
												</span>
												<span className="result-card__primary">
													<strong>{art.title}</strong>
													<code>{art.api?.signature}</code>
												</span>
												<span className="result-card__short">{art.short}</span>
											</button>
										))}
									</div>
								</>
							) : (
								<div className="result-list">
									{(indexData.modulePackages ?? []).map((pkg: any) => (
										<div key={pkg.id} className="result-card" style={{ cursor: "default" }}>
											<span className="result-card__meta">
												<span>_{pkg.owner.toUpperCase()}</span>
												<span>{pkg.kind}</span>
											</span>
											<span className="result-card__primary">
												<strong>{pkg.title[locale]}</strong>
												<code>{pkg.repository}</code>
											</span>
											<span className="result-card__short">{pkg.short[locale]}</span>
										</div>
									))}
								</div>
							)}
						</div>
					) : null}

					{/* BROWSE VIEW */}
					{view.kind === "browse" ? (
						<div className="listing-view">
							<div className="listing-heading">
								<div>
									<span className="eyebrow-copy">PHI-SPACES CORPUS</span>
									<h1>
										{view.articleType === "workflow"
											? locale === "de"
												? "Alle 6 Stufen-Workflows (v1–v6)"
												: "All 6 Stage Workflows (v1–v6)"
											: locale === "de"
												? "Alle Hilfethemen & Referenzen"
												: "All Help Topics & References"}
									</h1>
								</div>
								<span className="meta-pill">MAIN CORPUS</span>
							</div>
							<div className="result-list">
								{localizedArticles
									.filter(
										(a: any) =>
											(view.owner === "all" || a.provider === view.owner) &&
											(!view.articleType || a.type === view.articleType),
									)
									.map((art: any) => (
										<button
											key={art.id}
											type="button"
											className="result-card"
											onClick={() => openArticle(art.id)}
										>
											<span className="result-card__meta">
												<span>_{art.provider.toUpperCase()}</span>
												<span>{art.type.toUpperCase()}</span>
											</span>
											<span className="result-card__primary">
												<strong>{art.title}</strong>
												<code>{art.id}</code>
											</span>
											<span className="result-card__short">{art.short}</span>
										</button>
									))}
							</div>
						</div>
					) : null}

					{/* SEARCH VIEW */}
					{view.kind === "search" ? (
						<div className="listing-view">
							{(() => {
								const matchedAreas = searchAreas(areas, view.query, locale);
								const matchedArticles = searchArticles(localizedArticles, view.query);
								return (
									<>
										<div className="listing-heading">
											<div>
												<span className="eyebrow-copy">
													{locale === "de"
														? "TOKEN- & ALIAS-VOLLTEXTSUCHE"
														: "TOKEN & ALIAS FULL-TEXT SEARCH"}
												</span>
												<h1>{locale === "de" ? "Suchergebnisse" : "Search Results"}</h1>
												<p>
													{matchedAreas.length + matchedArticles.length}{" "}
													{locale === "de" ? "Treffer für" : "results for"}{" "}
													<code>{view.query}</code>
												</p>
											</div>
											<span className="meta-pill meta-pill--accent">OFFLINE INDEX</span>
										</div>
										<div className="result-list">
											{matchedAreas.map((area: any) => (
												<button
													key={area.id}
													type="button"
													className="result-card"
													onClick={() => navigate({ kind: "area", id: area.id })}
												>
													<span className="result-card__meta">
														<span>SYSTEM AREA</span>
													</span>
													<span className="result-card__primary">
														<strong>{area.title[locale]}</strong>
														<code>{area.id}</code>
													</span>
													<span className="result-card__short">{area.short[locale]}</span>
												</button>
											))}
											{matchedArticles.map((art: any) => (
												<button
													key={art.id}
													type="button"
													className="result-card"
													onClick={() => openArticle(art.id)}
												>
													<span className="result-card__meta">
														<span>_{art.provider.toUpperCase()}</span>
														<span>{art.type.toUpperCase()}</span>
													</span>
													<span className="result-card__primary">
														<strong>{art.title}</strong>
														<code>{art.id}</code>
													</span>
													<span className="result-card__short">{art.short}</span>
												</button>
											))}
										</div>
									</>
								);
							})()}
						</div>
					) : null}

					{/* ARTICLE VIEW */}
					{view.kind === "article" ? (
						<article className="article-view">
							{currentArticle ? (
								<>
									<div className="article-meta">
										<div className="breadcrumbs">
											<button type="button" onClick={() => navigate({ kind: "home" })}>
												HELP
											</button>
											{areaByArticleId.get(currentArticle.id) ? (
												<>
													<span>›</span>
													<button
														type="button"
														onClick={() =>
															navigate({
																kind: "area",
																id: areaByArticleId.get(currentArticle.id).id,
															})
														}
													>
														{areaByArticleId.get(currentArticle.id).title[locale].toUpperCase()}
													</button>
												</>
											) : null}
											<span>›</span>
											<span>{currentArticle.title}</span>
										</div>
										<div className="article-meta__pills">
											<span className="meta-pill">_{currentArticle.provider.toUpperCase()}</span>
											<span className="meta-pill">{currentArticle.standard}</span>
											<span className="meta-pill meta-pill--accent">MAIN CORPUS</span>
										</div>
									</div>

									{(currentArticle.toc?.length ?? 0) > 0 ? (
										<details className="toc-mobile">
											<summary>{locale === "de" ? "Auf dieser Seite" : "On this page"}</summary>
											<nav onClick={(e: any) => { if ((e.target as HTMLElement).closest("a")) (e.currentTarget.parentElement as HTMLDetailsElement).open = false; }}>
												{currentArticle.toc.map((item: any) => (
													<a key={item.anchor} href={`#${item.anchor}`} className={item.level === 3 ? "toc__subitem" : ""}>
														{item.title}
													</a>
												))}
											</nav>
										</details>
									) : null}
									{loadingArticle ? (
										<p style={{ color: "var(--muted)" }}>Loading article …</p>
									) : (
										<div
											className="markdown-body"
											onClick={(e: any) => {
												const link = (e.target as HTMLElement | null)?.closest("[data-help-link]");
												if (link) {
													e.preventDefault();
													const target = link.getAttribute("data-help-link") ?? "";
													const [id, anchor] = target.split("#");
													if (id) openArticle(id, anchor);
												}
											}}
											dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(articleMarkdown) }}
										/>
									)}

									{/* Canonical Stage Resources */}
									{(currentArticle.resources ?? []).length > 0 ? (
										<section style={{ borderTop: "1px solid var(--line)", marginTop: "42px", paddingTop: "24px" }}>
											<span className="eyebrow-copy">
												{locale === "de"
													? "KANONISCHE RESSOURCEN & AUSFÜHRUNG"
													: "CANONICAL RESOURCES & EXECUTION"}
											</span>
											{currentArticle.resources.map((res: any) => (
												<div
													key={res.id}
													style={{
														border: "1px solid var(--line-strong)",
														background: "var(--surface-raised)",
														padding: "18px",
														marginTop: "14px",
														borderRadius: "6px",
													}}
												>
													<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
														<strong>{res.title}</strong>
														<button
															type="button"
															className="wb-btn"
															onClick={() => navigate(resourceView(res.stage))}
														>
															{locale === "de"
																? "In der Live-Workbench starten →"
																: "Launch in Live Workbench →"}
														</button>
													</div>
													<p style={{ color: "var(--muted-strong)", fontSize: "13px", margin: "8px 0" }}>
														{res.summary}
													</p>
													<code style={{ fontSize: "12px", color: "var(--accent-readable)" }}>
														$ {res.command}
													</code>
												</div>
											))}
										</section>
									) : null}

									<nav aria-label={locale === "de" ? "Weiterführende Artikel" : "Related articles"} className="article-related">
										{(currentArticle.related ?? []).map((id: string) => articleById.has(id) ? <button type="button" key={id} onClick={() => openArticle(id)}>{articleById.get(id).title} →</button> : null)}
									</nav>
									<footer className="article-footer">
										<div>
											<span>HELP-ID</span>
											<code>{currentArticle.id}</code>
										</div>
										<div>
											<span>{locale === "de" ? "WÖRTER" : "WORDS"}</span>
											<strong>{currentArticle.wordCount}</strong>
										</div>
										<div>
											<span>LOCALE</span>
											<strong>{currentArticle.locale.toUpperCase()}</strong>
										</div>
										<div>
											<span>SOURCE</span>
											<strong>
												{currentArticle.source.repository}@{currentArticle.source.commit}{currentArticle.source.dirty ? "+dirty" : ""}
											</strong>
										</div>
									</footer>
								</>
							) : (
								<p>Article not found: {view.id}</p>
							)}
						</article>
					) : null}

					{/* LIVE VIEWS: multiplayer space-chat workbench (v1..v6) and the self-running social swarm feed, with the test-system bar below */}
					{view.kind === "space-chat" || view.kind === "feed" ? (
						<div className="live-frame">
							<div className="live-frame__body">
								{view.kind === "space-chat" ? (
									<SpaceChatWorkbench
										locale={locale}
										sessionId={view.sessionId}
										initialStage={view.stage}
										onOpenArticle={(id) => openArticle(id)}
									/>
								) : (
									<SocialFeedView locale={locale} />
								)}
							</div>
							<SystemBar locale={locale} />
						</div>
					) : null}

					{/* A short introduction before each app, its link below */}
					{view.kind === "intro" ? (
						<AppIntro
							app={view.app}
							locale={locale}
							target={introTarget(view.app)}
							onOpen={() => { if (view.app === "swarm") navigate({ kind: "feed" }); else if (view.app === "space-chat") navigate({ kind: "space-chat", sessionId: "lobby" }); }}
						/>
					) : null}

					{/* LOGIN-PROTECTED ADMINSPACES PORTAL */}
					{view.kind === "admin" ? <AdminSpacesView locale={locale} /> : null}
				</main>

				{/* Right TOC Column */}
				{hasRightToc ? (
					<aside className="toc">
						<span className="toc__label">
							{locale === "de" ? "AUF DIESER SEITE" : "ON THIS PAGE"}
						</span>
						<nav>
							{currentArticle.toc.map((item: any) => (
								<a
									key={item.anchor}
									href={`#${item.anchor}`}
									className={item.level === 3 ? "toc__subitem" : ""}
								>
									{item.title}
								</a>
							))}
						</nav>
						<div className="toc__rule">
							<span>Help ≠ Live State</span>
							<p>
								{locale === "de"
									? "Stabile Semantik und Verträge hier. Aktuelle Laufzeitdaten im Multiplayer-Chat-Inspector und in AdminSpaces."
									: "Stable semantics and contracts here. Current runtime facts live in the Chat Inspector and AdminSpaces."}
							</p>
						</div>
					</aside>
				) : null}
			</div>
		</div>
	);
}

export default HelpApp;
