"use client";
// The answer of the in-game `help` as a sidebar in the style of the help (HelpPanel): the intro, the commands as cards
// (every name, the arguments, what it does) with a search, the topics as buttons that ask for them; a topic opens in the
// same window. The text of the answer stays in the log for text mode; this is the same content, laid out.
import { useEffect, useState } from "react";
import type { HelpView } from "../shared/model.ts";
import { isTouch } from "./useShell.ts";
import { Rich, RichBlock } from "./RichText.tsx";

export function CommandHelp({ view, onTopic, onArticles, onClose, onInsert }: { view: HelpView; onTopic: (key: string | null) => void; onArticles: () => void; onClose: () => void; /** Puts a command into the command line (it never runs by itself). */ onInsert?: (command: string) => void }) {
	const [query, setQuery] = useState("");
	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);
	useEffect(() => setQuery(""), [view.topic?.key]);

	const q = query.trim().toLowerCase();
	const commands = (view.commands ?? []).filter((c) => !q || `${c.names.join(" ")} ${c.usage} ${c.text}`.toLowerCase().includes(q));
	const topics = (view.topics ?? []).filter((t) => !q || t.includes(q));

	return (
		// the game's keys (arrows, space) must not act while the window has the focus
		<aside className="help cmd-help" role="complementary" aria-label="Befehle" onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}>
			<div className="help-head">
				<strong>{view.topic ? "Hilfe" : "Befehle"}</strong>
				<span className="spacer" />
				<button className="help-more" onClick={onArticles} title="Die ausführliche Hilfe mit Anleitungen">Ausführliche Hilfe</button>
				<button className="help-x" onClick={onClose} aria-label="Schließen" title="Schließen">×</button>
			</div>
			<div className="help-seg" role="tablist"><button role="tab" aria-selected="false" onClick={onArticles}>Hilfe</button><button role="tab" aria-selected="true" className="on">Befehle</button></div>
			{!view.topic && (
				<div className="help-search">
					<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Befehl suchen …" aria-label="Befehl suchen" autoFocus={!isTouch()} />
				</div>
			)}
			<div className="help-scroll">
				{view.topic ? (
					<>
						{view.commands && <button className="help-back" onClick={() => onTopic(null)}>← Alle Befehle</button>}
						<article className="help-article">
							<h1>{view.topic.key}</h1>
							<p className="cmd-help-cat">{view.topic.category}</p>
							<div className="help-body"><RichBlock text={view.topic.text} onCommand={onInsert} /></div>
						</article>
					</>
				) : (
					<>
						{view.intro && !q && <p className="cmd-help-intro"><Rich text={view.intro} onCommand={onInsert} /></p>}
						{topics.length > 0 && (
							<section className="help-section">
								<h2>Themen</h2>
								<div className="help-toc">{topics.map((t) => <button key={t} onClick={() => onTopic(t)}>{t}</button>)}</div>
							</section>
						)}
						<section className="help-section">
							<h2>Befehle{q ? ` · ${commands.length}` : ""}</h2>
							{commands.length === 0 && <p className="muted">Kein Befehl passt.</p>}
							<ul className="cmd-help-list">
								{commands.map((c) => (
									<li key={c.names[0]}>
										<div className="cmd-help-sig"><code>{c.names[0]}{c.usage ? ` ${c.usage}` : ""}</code>{onInsert && <button className="cmd-insert" onClick={() => onInsert(c.names[0]!)} title="In die Befehlszeile setzen, ohne es auszuführen">Einfügen</button>}</div>
										{c.names.length > 1 && <div className="cmd-help-also">auch {c.names.slice(1).map((n, i) => <span key={n}>{i ? ", " : ""}<code>{n}</code></span>)}</div>}
										<div className="cmd-help-text"><Rich text={c.text} onCommand={onInsert} /></div>
									</li>
								))}
							</ul>
						</section>
					</>
				)}
			</div>
		</aside>
	);
}
