// Codemode chat client: plain ES module, no build step. All text goes through textContent (agent code is untrusted).
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (v === true) e.setAttribute(k, "");
		else if (v !== false && v != null) e.setAttribute(k, v);
	}
	for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
	return e;
};
const T = {
	de: { title: "Codemode-Chat", eyebrow: "AGENTEN UND MENSCHEN SCHREIBEN CODE IN EINEN GEMEINSAMEN SPACE", lead: "Jeder Beitrag ist ein Eintrag im Space; die Codemode-Sandbox bewertet ihn. Gezeigt wird der Code jedes Beitrags.", task: "Aufgabe", run: "Lauf", agents: "Agenten", gens: "Generationen", per: "Beiträge je Agent", mode: "Agenten", scripted: "skriptgesteuert", llm: "Modell", start: "Lauf starten", stop: "Stoppen", custom: "Eigene Aufgabe", fn: "Funktionsname", cases: "Testfälle (JSON: [{\"args\":[2],\"expect\":4}])", useTask: "Aufgabe setzen", yours: "Eigener Code", submit: "Code einreichen", you: "Name", say: "Nachricht", send: "Senden", board: "Rangliste", best: "Bester Code", none: "Noch keine Beiträge.", wait: "wartet", ok: "korrekt", bad: "falsch", code: "Code", gen: "Gen.", live: "live", offline: "getrennt", session: "Raum", model: "Modell", off: "Modell-Agenten aus", notask: "keine korrekten Beiträge" },
	en: { title: "Codemode chat", eyebrow: "AGENTS AND PEOPLE WRITE CODE INTO A SHARED SPACE", lead: "Every contribution is an entry in the space; the codemode sandbox judges it. The code of each contribution is shown.", task: "Task", run: "Run", agents: "Agents", gens: "Generations", per: "Contributions per agent", mode: "Agents", scripted: "scripted", llm: "model", start: "Start run", stop: "Stop", custom: "Custom task", fn: "Function name", cases: "Test cases (JSON: [{\"args\":[2],\"expect\":4}])", useTask: "Set task", yours: "Your code", submit: "Submit code", you: "Name", say: "Message", send: "Send", board: "Leaderboard", best: "Best code", none: "No contributions yet.", wait: "waiting", ok: "correct", bad: "wrong", code: "code", gen: "gen", live: "live", offline: "disconnected", session: "Room", model: "Model", off: "model agents off", notask: "no correct contribution" },
};
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };
const state = { lang: store("cm.lang") || (navigator.language.startsWith("de") ? "de" : "en"), mode: store("cm.mode") || "dark", name: store("cm.name") || "guest-" + Math.random().toString(36).slice(2, 5), session: decodeURIComponent(location.hash.slice(1)) || "lobby", snap: null, live: false, llm: null, error: "", draft: { code: "", msg: "", cases: "", fn: "", prompt: "" }, params: { ragents: 4, rgens: 3, rper: 1, rmode: "scripted" } };
const tr = () => T[state.lang];
document.documentElement.dataset.mode = state.mode;

async function api(path, body) {
	const r = await fetch("/api" + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || r.statusText);
	return data;
}
const act = async (path, body) => { state.error = ""; try { await api(path, body); } catch (e) { state.error = e.message; } render(); };

let ws, retry = 0;
function connect() {
	ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + encodeURIComponent(state.session));
	ws.onopen = () => { state.live = true; retry = 0; renderStatus(); };
	ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === "snapshot") { state.snap = d; render(); } };
	ws.onclose = () => { state.live = false; renderStatus(); setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++)); };
}

const verdict = (c) => c.ok === null ? el("span", { class: "chip chip--wait" }, tr().wait) : c.ok ? el("span", { class: "chip chip--ok" }, `${tr().ok} · ${c.ms} ms`) : el("span", { class: "chip chip--bad" }, tr().bad);
function card(c, best) {
	const isBest = best && best.candidateId === c.candidateId;
	return el("div", { class: "card" + (isBest ? " card--best" : "") + (c.ok === false ? " card--bad" : "") },
		el("div", { class: "card__head" }, el("span", { class: "who" }, c.author), el("span", { class: "chip" }, c.via), c.gen ? el("span", { class: "chip" }, `${tr().gen} ${c.gen}`) : null, verdict(c), isBest ? el("span", { class: "chip chip--best" }, "best") : null),
		c.error ? el("div", { class: "err" }, c.error) : null,
		el("details", { open: isBest || c.ok === null }, el("summary", {}, tr().code), el("pre", { class: "code" }, c.source)));
}

function renderStatus() { const s = $("status"); if (s) { s.textContent = state.live ? tr().live : tr().offline; s.className = "pill" + (state.live ? " pill--accent" : ""); } }

function render() {
	const s = state.snap, t = tr(), app = $("app");
	const keep = document.activeElement?.id;
	const draft = (id) => (e) => { state.draft[id] = e.target.value; };
	const run = s?.run;
	const board = (s?.contributions ?? []).filter((c) => c.ok).sort((a, b) => a.ms - b.ms).slice(0, 8);
	const items = [...(s?.messages ?? []).map((m) => ({ ts: m.ts, m })), ...(s?.contributions ?? []).map((c) => ({ ts: c.ts, c }))].sort((a, b) => a.ts - b.ts);
	app.replaceChildren(
		el("header", { class: "top" },
			el("span", { class: "brand" }, "PHI-SPACES / ", el("b", {}, "CODEMODE CHAT")), el("span", { class: "spacer" }),
			el("span", { class: "pill" }, `${t.session}: ${state.session}`), el("span", { id: "status", class: "pill" }, ""),
			state.llm?.enabled ? el("select", { id: "llm", onchange: (e) => api("/llm", { model: e.target.value }).then((x) => { state.llm = x; render(); }) }, state.llm.models.map((m) => el("option", { value: m.label, selected: m.label === state.llm.current }, m.label))) : el("span", { class: "pill" }, t.off),
			el("button", { class: "btn", onclick: () => { state.lang = state.lang === "de" ? "en" : "de"; store("cm.lang", state.lang); render(); } }, state.lang.toUpperCase()),
			el("button", { class: "btn", onclick: () => { state.mode = state.mode === "dark" ? "light" : "dark"; store("cm.mode", state.mode); document.documentElement.dataset.mode = state.mode; } }, state.mode === "dark" ? "☀" : "☾")),
		el("main", {},
			el("aside", {},
				el("div", { class: "panel" }, el("h2", {}, t.task),
					el("div", { class: "row" }, el("select", { id: "taskSel", onchange: (e) => act(`/sessions/${encodeURIComponent(state.session)}/task`, { taskId: e.target.value }) }, (s?.tasks ?? []).map((x) => el("option", { value: x.id, selected: s.task.id === x.id }, x.title[state.lang])), s?.task.id === "custom" ? el("option", { value: "custom", selected: true }, t.custom) : null)),
					s ? el("p", { class: "lead" }, s.task.prompt[state.lang], " ", el("code", {}, s.task.fn)) : null,
					el("details", {}, el("summary", {}, t.custom),
						el("div", { class: "row" }, el("input", { id: "cfn", placeholder: t.fn, value: state.draft.fn, oninput: draft("fn") })),
						el("div", { class: "row" }, el("input", { id: "cprompt", placeholder: t.task, value: state.draft.prompt, oninput: draft("prompt"), style: "width:100%" })),
						el("textarea", { id: "ccases", rows: 4, placeholder: t.cases, oninput: draft("cases") }, state.draft.cases),
						el("div", { class: "row" }, el("button", { class: "btn", onclick: () => { let cases; try { cases = JSON.parse(state.draft.cases); } catch { state.error = "JSON?"; return render(); } act(`/sessions/${encodeURIComponent(state.session)}/task`, { custom: { fn: state.draft.fn, prompt: state.draft.prompt, cases } }); } }, t.useTask)))),
				el("div", { class: "panel" }, el("h2", {}, t.run),
					["agents", "gens", "per"].map((k) => el("div", { class: "row" }, el("label", { for: "r" + k }, t[k]), el("input", { id: "r" + k, type: "number", min: 1, max: k === "agents" ? 8 : k === "gens" ? 6 : 3, value: state.params["r" + k], oninput: (e) => { state.params["r" + k] = e.target.value; } }))),
					el("div", { class: "row" }, el("label", { for: "rmode" }, t.mode), el("select", { id: "rmode", onchange: (e) => { state.params.rmode = e.target.value; } }, el("option", { value: "scripted", selected: state.params.rmode === "scripted" }, t.scripted), el("option", { value: "llm", disabled: !state.llm?.enabled, selected: state.params.rmode === "llm" }, t.llm))),
					el("div", { class: "row" },
						el("button", { class: "btn btn--primary", disabled: !!run?.active, onclick: () => act(`/sessions/${encodeURIComponent(state.session)}/run`, { agents: +$("ragents").value, gens: +$("rgens").value, perAgent: +$("rper").value, mode: $("rmode").value, lang: state.lang }) }, t.start),
						el("button", { class: "btn", disabled: !run?.active, onclick: () => act(`/sessions/${encodeURIComponent(state.session)}/stop`, {}) }, t.stop)),
					run ? el("div", { class: "pill" + (run.active ? " pill--accent" : "") }, `${run.mode} · ${run.gen}/${run.gens}`) : null,
					run?.note ? el("div", { class: "notice" }, run.note) : null),
				el("div", { class: "panel" }, el("h2", {}, t.yours),
					el("textarea", { id: "code", rows: 7, spellcheck: false, placeholder: s ? `function ${s.task.fn}(...) { ... }` : "", oninput: draft("code") }, state.draft.code),
					el("div", { class: "row" }, el("button", { class: "btn btn--primary", onclick: () => { const src = state.draft.code; state.draft.code = ""; act(`/sessions/${encodeURIComponent(state.session)}/code`, { author: state.name, source: src }); } }, t.submit)))),
			el("section", {},
				el("span", { class: "eyebrow" }, t.eyebrow), el("h1", {}, t.title), el("p", { class: "lead" }, t.lead),
				state.error ? el("div", { class: "notice" }, state.error) : null,
				items.length ? el("div", { class: "timeline" }, items.map((i) => i.m ? el("div", { class: "msg" + (i.m.author === "system" ? " msg--system" : "") }, el("b", {}, i.m.author), i.m.text) : card(i.c, s.best))) : el("div", { class: "empty" }, t.none),
				el("div", { class: "panel", style: "margin-top:14px" },
					el("div", { class: "row" }, el("label", { for: "name" }, t.you), el("input", { id: "name", value: state.name, oninput: (e) => { state.name = e.target.value.slice(0, 40); store("cm.name", state.name); } })),
					el("div", { class: "row" }, el("input", { id: "msg", style: "flex:1", placeholder: t.say, value: state.draft.msg, oninput: draft("msg"), onkeydown: (e) => { if (e.key === "Enter" && state.draft.msg.trim()) { const text = state.draft.msg; state.draft.msg = ""; act(`/sessions/${encodeURIComponent(state.session)}/message`, { author: state.name, text }); } } }), el("button", { class: "btn", onclick: () => { const text = state.draft.msg; if (!text.trim()) return; state.draft.msg = ""; act(`/sessions/${encodeURIComponent(state.session)}/message`, { author: state.name, text }); } }, t.send)))),
			el("aside", {},
				el("div", { class: "panel" }, el("h2", {}, t.board),
					board.length ? el("table", { class: "board" }, board.map((c, i) => el("tr", {}, el("td", {}, `${i + 1}. ${c.author}`), el("td", {}, `${c.ms} ms`)))) : el("div", { class: "empty" }, t.notask)),
				el("div", { class: "panel" }, el("h2", {}, t.best), s?.best ? el("pre", { class: "code" }, s.best.source) : el("div", { class: "empty" }, t.notask)))));
	renderStatus();
	if (keep && $(keep) && !["llm", "rmode", "taskSel"].includes(keep)) { const e = $(keep); e.focus?.(); if (e.setSelectionRange && e.value != null) e.setSelectionRange(e.value.length, e.value.length); }
}

render();
api("/llm").then((x) => { state.llm = x; render(); }).catch(() => {});
connect();
