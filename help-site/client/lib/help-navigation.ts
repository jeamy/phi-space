// Shared URL contract for the Help UI; pure helpers are tested without a browser.
export function validStage(value: string | null | undefined): string | undefined {
	return value && /^v[1-6]$/.test(value) ? value : undefined;
}

export type ViewState =
	| { kind: "home" }
	| { kind: "area"; id: string }
	| { kind: "article"; id: string }
	| { kind: "search"; query: string }
	| { kind: "browse"; owner: string; articleType?: string }
	| {
			kind: "api-finder";
			mode: "api" | "modules";
			query: string;
			provider: string;
			category: string;
			execution: string;
			idempotency: string;
			scope: string;
	  }
	| { kind: "space-chat"; sessionId: string; stage?: string }
	| { kind: "feed" }
	| { kind: "admin" }
	| { kind: "intro"; app: IntroApp };

/** The apps that get a short introduction before their link (client/components/AppIntro.tsx). */
export type IntroApp = "swarm" | "codemode" | "space-chat" | "mmo" | "stats";
const INTRO_APPS: readonly string[] = ["swarm", "codemode", "space-chat", "mmo", "stats"];

export function parseHelpView(search: string): ViewState {
	const params = new URLSearchParams(search);
	const view = params.get("view");
	if (view === "space-chat") {
		return { kind: "space-chat", sessionId: params.get("session") ?? "lobby", stage: validStage(params.get("stage")) };
	}
	if (view === "feed") {
		return { kind: "feed" };
	}
	if (view === "admin") {
		return { kind: "admin" };
	}
	if (view === "intro" && INTRO_APPS.includes(params.get("app") ?? "")) {
		return { kind: "intro", app: params.get("app") as IntroApp };
	}
	if (view === "api-finder" || params.get("area") === "step_by_step_and_api_reference" && params.get("tab") === "api") {
		return {
			kind: "api-finder",
			mode: params.get("mode") === "modules" ? "modules" : "api",
			query: params.get("oq") ?? "",
			provider: params.get("provider") ?? "all",
			category: params.get("category") ?? "all",
			execution: params.get("execution") ?? "all",
			idempotency: params.get("idempotency") ?? "all",
			scope: params.get("scope") ?? "all",
		};
	}
	const article = params.get("article");
	if (article) return { kind: "article", id: article };
	const area = params.get("area");
	if (area) return { kind: "area", id: area };
	const q = params.get("q");
	if (q) return { kind: "search", query: q };
	const owner = params.get("owner");
	const type = params.get("type");
	if (owner || type) return { kind: "browse", owner: owner ?? "all", articleType: type ?? undefined };
	return { kind: "home" };
}


export function helpUrl(view: ViewState, locale: "de" | "en", hash = ""): string {
 const p = new URLSearchParams({ lang: locale });
 if (view.kind === "article") p.set("article", view.id);
 else if (view.kind === "area") p.set("area", view.id);
 else if (view.kind === "search") p.set("q", view.query);
 else if (view.kind === "browse") { p.set("owner", view.owner); if(view.articleType) p.set("type",view.articleType); }
 else if (view.kind === "api-finder") {
  p.set("view","api-finder"); if(view.mode!=="api") p.set("mode",view.mode);
  if(view.query) p.set("oq",view.query);
  for(const key of ["provider","category","execution","idempotency","scope"] as const) if(view[key]!=="all") p.set(key,view[key]);
 } else if (view.kind === "space-chat") {
  p.set("view","space-chat"); p.set("session",view.sessionId);
  if(validStage(view.stage)) p.set("stage",view.stage!);
 } else if(view.kind==="feed" || view.kind==="admin") p.set("view",view.kind);
 else if(view.kind==="intro") { p.set("view","intro"); p.set("app",view.app); }
 return `?${p}${hash ? "#"+hash.replace(/^#/,"") : ""}`;
}

export function resourceView(stage: string): ViewState {
 return {kind:"space-chat",sessionId:"lobby",stage:validStage(stage)};
}
