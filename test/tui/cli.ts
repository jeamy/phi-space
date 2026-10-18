// Dependency-free terminal control panel for the production-artifact test bed.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emitKeypressEvents } from "node:readline";
import { actions, SERVICES, type Action, type Service } from "./actions.ts";
import { Backend, clean } from "./backend.ts";
import { itemList, render, type ScreenState } from "./view.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = `phi-spaces TUI
  npm run tui -- [--service runner|host-a|host-b|member-1|member-2] [--dry-run]
  npm run tui -- --local-dir /path/to/scenario-or-jsonl-storage
  npm run tui -- --once [--json] [--local-dir DIR]
  npm run tui -- --list-actions
  npm run tui -- --action ID [--dry-run | --allow-remote]

Remote server/settings: test/testbed/testbed.env (same as npm run testbed).
--dry-run previews actions; no remote connection or command is executed.
--allow-remote explicitly authorizes the selected remote mutation (including any reset in that action).
Without it, the interactive TUI asks before its first remote mutation and destructive actions.
--local-dir enables read-only inspection of JSONL state; no remote controls.
Keys: 1-4 views, Tab, arrows, s host, r refresh, / filter, i item kind,
      PgUp/PgDn details/log, Enter action/report, x cancel call, q quit.
Remote cancellation has an unknown outcome: server-side work may continue.
Unimplemented federation/run/worker/agent functions remain disabled.`;

type Options = { service: Service; dry: boolean; localDir?: string; once: boolean; json: boolean; action?: string; allowRemote: boolean; list: boolean };
function options(argv: string[]): Options {
	const o: Options = { service: "runner", dry: false, once: false, json: false, allowRemote: false, list: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (["--service", "--local-dir", "--action"].includes(a)) {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error(`${a} benötigt einen Wert`);
			if (a === "--service") { if (!(SERVICES as readonly string[]).includes(value)) throw new Error("Unbekannter Dienst"); o.service = value as Service; }
			if (a === "--local-dir") o.localDir = resolve(value);
			if (a === "--action") o.action = value;
		} else if (a === "--dry-run") o.dry = true;
		else if (a === "--once") o.once = true;
		else if (a === "--json") o.json = true;
		else if (a === "--allow-remote") o.allowRemote = true;
		else if (a === "--list-actions") o.list = true;
		else throw new Error(`Unbekannte Option ${a}`);
	}
	if (o.json && !o.once) throw new Error("--json benötigt --once");
	return o;
}

async function main(): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) { console.log(usage); return; }
	const o = options(process.argv.slice(2)), backend = new Backend(root);
	const catalog = () => actions(o.service).map(a => o.localDir && a.scope === "remote" && !a.unavailable ? { ...a, unavailable: "Lokale Leseansicht: keine Serversteuerung" } : a);
	if (o.list) { for (const a of catalog()) console.log(`${a.id.padEnd(24)} ${a.label}${a.unavailable ? ` [gesperrt: ${a.unavailable}]` : ""}`); return; }
	if (o.action) {
		const a = catalog().find(a => a.id === o.action);
		if (!a) throw new Error(`Unbekannte Aktion ${o.action}; --list-actions zeigt die Auswahl`);
		if (a.unavailable) throw new Error(a.unavailable);
		if (!o.dry && a.scope === "remote" && a.mutation && !o.allowRemote) throw new Error("Erster Servereingriff benötigt Freigabe (AGENTS.md): --allow-remote oder interaktive TUI verwenden");
		const record = await backend.run(a, o.dry, s => process.stdout.write(s));
		console.log(`\n${record.status.toUpperCase()} | Protokoll: ${record.log}`);
		process.exitCode = record.status === "failed" ? 1 : 0;
		return;
	}
	const state: ScreenState = { tab: 0, service: o.service, localDir: o.localDir, dry: o.dry, space: 0, item: 0, itemFocus: false, filter: "", itemsKind: "entry", detailOffset: 0, actions: catalog(), action: 0, history: await backend.history(), report: 0, log: [], logOffset: 0, notice: "r lädt Spaces; Aktionen öffnen mit 2", input: "" };
	if (o.once) {
		if (!o.dry || o.localDir) {
			state.snapshot = await backend.snapshot(o.service, o.localDir);
			state.space = Math.max(0, state.snapshot.spaces.findIndex(s => s.items.length > 0));
		}
		if (o.json) console.log(JSON.stringify(state.snapshot ?? { preview: true, spaces: [] }, null, 2));
		else console.log(render(state, 120, 36));
		process.exitCode = state.snapshot?.errors.length ? 1 : 0;
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interaktive TUI benötigt ein Terminal; --once, --action oder --help verwenden");
	let refreshing = false, closing = false, authorised = o.allowRemote;
	let answer: ((value: string | null) => void) | undefined;
	const draw = () => { if (!closing) process.stdout.write(`\x1b[H${render(state, process.stdout.columns, process.stdout.rows)}\x1b[J`); };
	const append = (text: string) => { state.log = [...state.log, ...clean(text).split("\n")].slice(-5000); state.logOffset = 0; draw(); };
	const ask = (prompt: string): Promise<string | null> => { state.prompt = prompt; state.input = ""; draw(); return new Promise(resolve => { answer = resolve; }); };
	async function refresh(): Promise<void> {
		if (refreshing || closing || (o.dry && !o.localDir)) return;
		refreshing = true;
		const service = o.service;
		try {
			const snapshot = await backend.snapshot(service, o.localDir);
			if (service !== o.service) return;
			if (snapshot.errors.length) throw new Error(snapshot.errors.join("; "));
			const selectedId = state.snapshot?.spaces[state.space]?.spaceId;
			state.snapshot = snapshot;
			const selected = snapshot.spaces.findIndex(s => s.spaceId === selectedId);
			state.space = selected < 0 ? Math.max(0, snapshot.spaces.findIndex(s => s.items.length > 0)) : selected;
			state.item = Math.min(state.item, Math.max(0, itemList(state).length - 1));
			state.stale = undefined;
		} catch (e) { if (service === o.service) state.stale = (e as Error).message; }
		finally { refreshing = false; draw(); }
	}
	async function execute(a: Action): Promise<void> {
		if (state.busy) { state.notice = "Ein Vorgang läuft bereits. x bricht dessen lokalen Aufruf ab."; draw(); return; }
		if (a.unavailable) { state.notice = a.unavailable; draw(); return; }
		state.busy = a.label;
		try {
			if (!o.dry && a.scope === "remote" && a.mutation && !authorised) {
				if ((await ask(`Erster Servereingriff (${a.label}). Freigeben? ja/nein:`)) !== "ja") return;
				authorised = true;
			}
			if (!o.dry && a.confirm && (await ask(`${a.confirm} ja/nein:`)) !== "ja") return;
			state.tab = 3; state.log = []; state.notice = "x beendet den lokalen Aufruf; bei Remote-Arbeit bleibt der Ausgang unbekannt."; draw();
			const record = await backend.run(a, o.dry, append);
			state.notice = `${record.status.toUpperCase()} | ${a.label} | ${record.log}`;
			state.history = await backend.history(); state.report = 0;
			append(`\n${record.status.toUpperCase()}${record.status === "unknown" ? ": Serverarbeit kann weiterlaufen; Status und Szenario evaluate prüfen." : ""}\n`);
			await refresh();
		} catch (e) { state.notice = (e as Error).message; append(`${state.notice}\n`); }
		finally { state.busy = undefined; draw(); }
	}
	const quit = () => {
		closing = true; clearInterval(timer); answer?.(null); answer = undefined;
		backend.cancel(); process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.removeListener("keypress", keypress);
		process.removeListener("SIGTERM", quit); process.removeListener("SIGINT", quit); process.stdout.removeListener("resize", draw);
		process.stdout.write("\x1b[?25h\x1b[?1049l");
	};
	const keypress = (_text: string, key: { name?: string; sequence?: string; ctrl?: boolean }) => {
		if (key.ctrl && key.name === "c") { quit(); return; }
		if (state.prompt) {
			if (key.name === "return" || key.name === "escape") {
				const value = key.name === "escape" ? null : state.input, resolve = answer;
				state.prompt = undefined; state.input = ""; answer = undefined; resolve?.(value);
			} else if (key.name === "backspace") state.input = state.input.slice(0, -1);
			else if (key.sequence && !key.ctrl && !key.sequence.includes("\x1b")) state.input += clean(key.sequence);
			draw(); return;
		}
		if (key.name === "q") { if (state.busy) { state.notice = "Vorgang läuft: x zum Abbrechen oder Strg-C zum Verlassen."; draw(); } else quit(); return; }
		if (key.name === "x") { backend.cancel(); state.notice = "Aufrufabbruch angefordert; Remote-Ausgang kann unbekannt bleiben."; }
		if (["1", "2", "3", "4"].includes(key.name ?? "")) state.tab = Number(key.name) - 1;
		if (key.name === "tab") state.tab = (state.tab + 1) % 4;
		if (key.name === "r") void refresh();
		if (key.name === "s" && !o.localDir && !state.busy) {
			o.service = SERVICES[(SERVICES.indexOf(o.service) + 1) % SERVICES.length]; state.service = o.service;
			state.snapshot = undefined; state.space = 0; state.item = 0; state.actions = catalog(); state.stale = undefined;
			void refresh();
		}
		if (state.tab === 0) {
			if (key.name === "left") state.itemFocus = false;
			if (key.name === "right") state.itemFocus = true;
			if (key.name === "i") { const kinds = ["entry", "txn", "notify", "waiter", "outbox", "claim", "all"]; state.itemsKind = kinds[(kinds.indexOf(state.itemsKind) + 1) % kinds.length]; state.item = 0; state.detailOffset = 0; }
			if (key.sequence === "/") void ask("Filter (Typ/ID/Felder; leer = alle):").then(v => { if (v !== null) state.filter = v; state.item = 0; state.detailOffset = 0; draw(); });
			if (key.name === "up" || key.name === "down") {
				const delta = key.name === "up" ? -1 : 1;
				if (state.itemFocus) state.item = Math.max(0, Math.min(itemList(state).length - 1, state.item + delta));
				else { state.space = Math.max(0, Math.min((state.snapshot?.spaces.length ?? 0) - 1, state.space + delta)); state.item = 0; }
				state.detailOffset = 0;
			}
			if (key.name === "pageup") state.detailOffset = Math.max(0, state.detailOffset - 5);
			if (key.name === "pagedown") state.detailOffset += 5;
		} else if (state.tab === 1) {
			if (key.name === "up") state.action = Math.max(0, state.action - 1);
			if (key.name === "down") state.action = Math.min(state.actions.length - 1, state.action + 1);
			if (key.name === "pageup") state.action = Math.max(0, state.action - 10);
			if (key.name === "pagedown") state.action = Math.min(state.actions.length - 1, state.action + 10);
			if (key.name === "return") void execute(state.actions[state.action]);
		} else if (state.tab === 2) {
			if (key.name === "up") state.report = Math.max(0, state.report - 1);
			if (key.name === "down") state.report = Math.max(0, Math.min(state.history.length - 1, state.report + 1));
			if (key.name === "return" && state.history[state.report]) void readFile(state.history[state.report].log, "utf8").then(text => { state.log = clean(text).split("\n").slice(-5000); state.tab = 3; draw(); }).catch(e => { state.notice = e.message; draw(); });
		} else {
			if (key.name === "pageup" || key.name === "up") state.logOffset = Math.min(state.log.length, state.logOffset + 5);
			if (key.name === "pagedown" || key.name === "down") state.logOffset = Math.max(0, state.logOffset - 5);
		}
		draw();
	};
	emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
	process.stdin.on("keypress", keypress); process.stdout.on("resize", draw); process.on("SIGTERM", quit); process.on("SIGINT", quit);
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	const timer = setInterval(() => void refresh(), 3000);
	draw(); void refresh();
}

main().catch(e => { console.error(`tui: ${(e as Error).message}`); process.exitCode = 1; });
