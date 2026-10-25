"use client";
// The game's help as a sidebar, in the style of the phi-spaces help systems: a search box, the topics grouped by section,
// the article with its table of contents. Opened by the "?" in the header bar. The article text is authored in
// help/articles.ts (trusted); `help.<topic>#anchor` links inside it switch articles without leaving the game.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ARTICLES, DEFAULT_ARTICLE, SECTIONS, articleById, tocOf, type Article, type Lang } from "./help/articles.ts";
import { renderMarkdownToHtml } from "./lib/markdown.ts";

const T = {
	de: { title: "Hilfe", close: "Hilfe schließen", search: "Hilfe durchsuchen …", topics: "Alle Themen", toc: "Auf dieser Seite", none: "Keine Treffer.", lang: "Sprache" },
	en: { title: "Help", close: "Close help", search: "Search the help …", topics: "All topics", toc: "On this page", none: "No results.", lang: "Language" },
} as const;

const LANG_KEY = "mmo-help-lang";
const initialLang = (): Lang => {
	try { const v = localStorage.getItem(LANG_KEY); if (v === "de" || v === "en") return v; } catch { /* storage may be blocked */ }
	return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
};

const textOf = (a: Article, lang: Lang) => `${a.title[lang]} ${a.short[lang]} ${a.body[lang]}`.toLowerCase();

export function HelpPanel({ onClose }: { onClose: () => void }) {
	const [lang, setLang] = useState<Lang>(initialLang);
	const [articleId, setArticleId] = useState<string | null>(null); // null: the topic list
	const [query, setQuery] = useState("");
	const scroller = useRef<HTMLDivElement>(null);
	const t = T[lang];

	const changeLang = (l: Lang) => { setLang(l); try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ } };
	const open = useCallback((id: string, anchor?: string) => {
		setArticleId(id); setQuery("");
		requestAnimationFrame(() => {
			const el = anchor && anchor !== "overview" ? scroller.current?.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`) : null;
			if (el) el.scrollIntoView({ block: "start" }); else scroller.current?.scrollTo({ top: 0 });
		});
	}, []);

	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);

	const article = articleId ? articleById(articleId) ?? articleById(DEFAULT_ARTICLE)! : null;
	const html = useMemo(() => (article ? renderMarkdownToHtml(article.body[lang]) : ""), [article, lang]);
	const toc = useMemo(() => (article ? tocOf(article.body[lang]) : []), [article, lang]);
	const q = query.trim().toLowerCase();
	const matches = q ? ARTICLES.filter((a) => textOf(a, lang).includes(q)) : ARTICLES;

	const onBodyClick = (e: React.MouseEvent) => {
		const a = (e.target as HTMLElement).closest<HTMLElement>("[data-help-link]");
		if (!a) return;
		e.preventDefault();
		const [id, anchor] = a.dataset.helpLink!.split("#");
		if (id && articleById(id)) open(id, anchor);
	};

	return (
		// the game's keys (arrows, space) must not act while the help has the focus
		<aside className="help" role="complementary" aria-label={t.title} onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}>
			<div className="help-head">
				<strong>{t.title}</strong>
				<span className="spacer" />
				<div className="help-lang" role="group" aria-label={t.lang}>
					{(["de", "en"] as const).map((l) => <button key={l} className={l === lang ? "on" : ""} aria-pressed={l === lang} onClick={() => changeLang(l)}>{l.toUpperCase()}</button>)}
				</div>
				<button className="help-x" onClick={onClose} aria-label={t.close} title={t.close}>×</button>
			</div>
			<div className="help-search">
				<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.search} aria-label={t.search} autoFocus />
			</div>
			<div className="help-scroll" ref={scroller}>
				{article && !q ? (
					<>
						<button className="help-back" onClick={() => setArticleId(null)}>← {t.topics}</button>
						<article className="help-article">
							<h1>{article.title[lang]}</h1>
							{toc.length > 1 && (
								<nav className="help-toc" aria-label={t.toc}>
									{toc.map((h) => <button key={h.id} onClick={() => open(article.id, h.id)}>{h.title}</button>)}
								</nav>
							)}
							<div className="help-body" onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: html }} />
						</article>
					</>
				) : q ? (
					<ul className="help-list">
						{matches.length === 0 && <li className="muted">{t.none}</li>}
						{matches.map((a) => <li key={a.id}><button onClick={() => open(a.id)}><strong>{a.title[lang]}</strong><span>{a.short[lang]}</span></button></li>)}
					</ul>
				) : (
					(Object.keys(SECTIONS) as Array<Article["section"]>).map((s) => (
						<section key={s} className="help-section">
							<h2>{SECTIONS[s][lang]}</h2>
							<ul className="help-list">
								{ARTICLES.filter((a) => a.section === s).map((a) => <li key={a.id}><button onClick={() => open(a.id)}><strong>{a.title[lang]}</strong><span>{a.short[lang]}</span></button></li>)}
							</ul>
						</section>
					))
				)}
			</div>
		</aside>
	);
}
