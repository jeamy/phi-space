"use client";
// Help pages of the codemode chat, in the style of the phi-spaces help system: navigation on the left, the article in
// the middle, the table of contents on the right, a search box, and addresses like /help?lang=en&article=help.topic.overview.
// The article text is authored in client/help/articles.ts (trusted); everything else is rendered as React text.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThemeControls } from "./ThemeControls.tsx";
import { ARTICLES, DEFAULT_ARTICLE, SECTIONS, articleById, tocOf, type Article } from "./help/articles.ts";
import { renderMarkdownToHtml } from "./lib/markdown.ts";
import { useTheme, type Lang } from "./lib/theme.ts";

const T = {
	de: { chat: "← Chat", search: "Hilfe durchsuchen …", nav: "NAVIGATION", toc: "AUF DIESER SEITE", results: "Treffer", none: "Keine Treffer.", brand: "HILFE", home: "Alle Hilfethemen", eyebrow: "CODEMODE-CHAT · HILFE" },
	en: { chat: "← Chat", search: "Search the help …", nav: "NAVIGATION", toc: "ON THIS PAGE", results: "results", none: "No results.", brand: "HELP", home: "All help topics", eyebrow: "CODEMODE CHAT · HELP" },
} as const;

const textOf = (a: Article, lang: Lang) => `${a.title[lang]} ${a.short[lang]} ${a.body[lang]}`.toLowerCase();

export function HelpApp() {
	const theme = useTheme();
	const { lang } = theme;
	const t = T[lang];
	const [articleId, setArticleId] = useState(DEFAULT_ARTICLE);
	const [query, setQuery] = useState("");
	const [ready, setReady] = useState(false);
	const articleRef = useRef<HTMLElement>(null);

	// the address is the state: ?lang=…&article=… (and #anchor)
	const readUrl = useCallback(() => {
		const p = new URLSearchParams(location.search);
		const l = p.get("lang");
		if (l === "de" || l === "en") theme.setLang(l);
		const a = p.get("article");
		setArticleId(a && articleById(a) ? a : DEFAULT_ARTICLE);
	}, [theme.setLang]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		readUrl(); setReady(true);
		window.addEventListener("popstate", readUrl);
		return () => window.removeEventListener("popstate", readUrl);
	}, [readUrl]);

	const urlFor = (id: string, l: Lang, anchor?: string) => `/help?lang=${l}&article=${id}${anchor ? `#${anchor}` : ""}`;
	const go = useCallback((id: string, anchor?: string) => {
		history.pushState(null, "", urlFor(id, lang, anchor));
		setArticleId(id);
		// the first section ("overview") sits right under the title: show the whole top of the article instead
		requestAnimationFrame(() => (anchor && anchor !== "overview" ? document.getElementById(anchor)?.scrollIntoView({ block: "start" }) : window.scrollTo({ top: 0 })));
	}, [lang]);
	useEffect(() => { if (ready) history.replaceState(null, "", urlFor(articleId, lang, location.hash.slice(1) || undefined)); }, [lang, articleId, ready]);
	useEffect(() => { document.title = `${articleById(articleId)?.title[lang] ?? t.brand} · PHI-SPACES / CODEMODE CHAT`; }, [articleId, lang, t.brand]);

	const article = articleById(articleId) ?? articleById(DEFAULT_ARTICLE)!;
	const html = useMemo(() => renderMarkdownToHtml(article.body[lang]), [article, lang]);
	const toc = useMemo(() => tocOf(article.body[lang]), [article, lang]);
	useEffect(() => { // arrive on an anchor from a link
		const anchor = location.hash.slice(1);
		if (ready && anchor && anchor !== "overview") requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }));
	}, [articleId, lang, ready]);

	const q = query.trim().toLowerCase();
	const matches = q ? ARTICLES.filter((a) => textOf(a, lang).includes(q)) : ARTICLES;
	const sections = (Object.keys(SECTIONS) as Article["section"][]).map((s) => ({ id: s, items: matches.filter((a) => a.section === s) })).filter((s) => s.items.length);

	const onArticleClick = (e: React.MouseEvent) => {
		const a = (e.target as HTMLElement).closest("a[data-help-link]") as HTMLAnchorElement | null;
		if (!a) return;
		e.preventDefault();
		const [id, anchor] = (a.dataset.helpLink ?? "").split("#");
		if (id && articleById(id)) go(id, anchor);
	};

	return (
		<div className="help">
			<header className="top">
				<a className="brand" href={`/help?lang=${lang}`} onClick={(e) => { e.preventDefault(); go(DEFAULT_ARTICLE); }}>PHI-SPACES / <b>CODEMODE CHAT</b> <span className="help__brand">{t.brand}</span></a>
				<span className="spacer" />
				<input className="help__search" type="search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t.search} />
				<a className="toplink" href="/">{t.chat}</a>
				<ThemeControls lang={theme.lang} setLang={theme.setLang} mode={theme.mode} changeMode={theme.changeMode} palette={theme.palette} changePalette={theme.changePalette} />
			</header>
			<div className="help__layout">
				<aside className="help__nav" aria-label={t.nav}>
					<span className="help__label">{t.nav}</span>
					{q ? <div className="help__count">{matches.length} {t.results}</div> : null}
					{sections.length ? sections.map((s) => (
						<nav key={s.id} className="help__section">
							<span className="help__sectionlabel">{SECTIONS[s.id][lang]}</span>
							{s.items.map((a) => (
								<a key={a.id} href={urlFor(a.id, lang)} className={"help__link" + (a.id === article.id ? " is-active" : "")} aria-current={a.id === article.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(a.id); }}>{a.title[lang]}</a>
							))}
						</nav>
					)) : <div className="empty">{t.none}</div>}
				</aside>
				<article className="article" ref={articleRef} onClick={onArticleClick}>
					<span className="eyebrow">{t.eyebrow}</span>
					<h1>{article.title[lang]}</h1>
					<p className="lead">{article.short[lang]}</p>
					<div className="article__body" dangerouslySetInnerHTML={{ __html: html }} />
				</article>
				<aside className="help__toc" aria-label={t.toc}>
					<span className="help__label">{t.toc}</span>
					{toc.map((h) => (
						<a key={h.id} href={`#${h.id}`} onClick={(e) => { e.preventDefault(); history.replaceState(null, "", urlFor(article.id, lang, h.id)); document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{h.title}</a>
					))}
				</aside>
			</div>
		</div>
	);
}
