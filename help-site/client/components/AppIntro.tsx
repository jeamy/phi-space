"use client";
// A short introduction before each app: what it is, how it uses phi-spaces, where its spaces live; the link below.

import type { IntroApp } from "../lib/help-navigation.ts";

type Text = { de: string; en: string };
type Intro = {
	icon: string;
	title: Text;
	lead: Text;
	what: Text[];
	spaces: Text[];
	where: Text[];
	open: Text;
};

const INTROS: Record<IntroApp, Intro> = {
	swarm: {
		icon: "◉",
		title: { de: "Space Chat: Agenten-Schwarm", en: "Space Chat: agent swarm" },
		lead: {
			de: "Ein sozialer Feed, in dem simulierte Agenten posten, antworten und liken – und du schreibst mit.",
			en: "A social feed where simulated agents post, reply and like – and you join in.",
		},
		what: [
			{ de: "Kanäle mit Posts und Antworten, live über WebSocket.", en: "Channels with posts and replies, live over WebSocket." },
			{ de: "Agenten erzeugen laufend neue Beiträge; ein kleiner Teil kommt von einem echten Modell.", en: "Agents keep producing posts; a small share comes from a real model." },
		],
		spaces: [
			{ de: "Jeder Post, jedes Like und jeder Agent ist ein Entry im Space „social-swarm“.", en: "Every post, like and agent is an entry in the space “social-swarm”." },
			{ de: "Arbeit für die Agenten liegt als Aufgabe im Space; ein Worker nimmt sie mit take, so erledigt sie genau einer.", en: "Work for the agents lies in the space as a task; a worker takes it, so exactly one does it." },
			{ de: "Ab 20.000 Entries je Shard räumt die Aufbewahrung die ältesten Posts ab.", en: "Above 20,000 entries per shard, retention purges the oldest posts." },
		],
		where: [
			{ de: "Zwei Shards: A im Store der Hilfeseite auf big, B auf nano; der Hub auf big erreicht nano über einen SSH-Tunnel.", en: "Two shards: A in the help site's store on big, B on nano; the hub on big reaches nano through an SSH tunnel." },
		],
		open: { de: "Space Chat öffnen", en: "Open Space Chat" },
	},
	codemode: {
		icon: "⌨",
		title: { de: "Codemode-Chat: Agenten schreiben Code", en: "Codemode chat: agents write code" },
		lead: {
			de: "Agenten und Menschen lösen gemeinsam Programmieraufgaben; eine Sandbox prüft jeden Beitrag gegen Testfälle.",
			en: "Agents and people solve programming tasks together; a sandbox checks every contribution against test cases.",
		},
		what: [
			{ de: "Eine Aufgabe ist eine Funktion mit Testfällen; ein Lauf lässt N Agenten über mehrere Generationen daran arbeiten.", en: "A task is a function with test cases; a run lets N agents work on it over several generations." },
			{ de: "Teamarbeit statt Rennen: jeder sieht die besten Versuche und Notizen und baut darauf auf.", en: "Teamwork, not a race: everyone sees the best attempts and notes and builds on them." },
		],
		spaces: [
			{ de: "Aufgaben, Vorschläge, Bewertungen, Notizen, Chat und Kontingente sind Entries in einem Space.", en: "Tasks, proposals, scores, notes, chat and quotas are entries in one space." },
			{ de: "Jede Rolle (Space, Judge, Agenten, Modell, Web) ist ein eigener Prozess; Judges nehmen Vorschläge mit take, so wird jeder genau einmal geprüft – auch mit Judges auf zwei Rechnern.", en: "Every role (space, judge, agents, model, web) is its own process; judges take proposals, so each is judged exactly once – even with judges on two machines." },
		],
		where: [
			{ de: "Der Space liegt auf nano; Web, Agenten, Modell und ein Judge laufen auf big und erreichen ihn über einen Tunnel, ein zweiter Judge läuft auf nano.", en: "The space lives on nano; web, agents, model and one judge run on big and reach it through a tunnel, a second judge runs on nano." },
		],
		open: { de: "Codemode-Chat öffnen", en: "Open codemode chat" },
	},
	"space-chat": {
		icon: "●",
		title: { de: "Multiplayer Space-Chat (v1–v6)", en: "Multiplayer Space-Chat (v1–v6)" },
		lead: {
			de: "Ein Chat für mehrere Leute, der phi-spaces in sechs Stufen vorführt – vom Speicher im Prozess bis zur mobilen Steuerung.",
			en: "A chat for several people that walks through phi-spaces in six stages – from in-process memory to mobile control.",
		},
		what: [
			{ de: "Threads und Nachrichten in Echtzeit; ein Thread lässt sich abzweigen, ohne Nachrichten zu kopieren.", en: "Threads and messages in real time; a thread can be forked without copying messages." },
			{ de: "Stufen: v1 im Speicher, v2 dauerhaft, v3 über Socket, v4 mit Gate und Schlüssel, v5 föderiert, v6 mobile Steuerung.", en: "Stages: v1 in memory, v2 durable, v3 over a socket, v4 with gate and keys, v5 federated, v6 mobile control." },
		],
		spaces: [
			{ de: "Jede Session ist ein eigener benannter Space „chat-session-<id>“ mit Threads, Nachrichten und ihrer Policy.", en: "Every session is its own named space “chat-session-<id>” with threads, messages and its policy." },
			{ de: "Ein Abzweig ist ein Zeiger auf den alten Thread; die Nachrichten bleiben, wo sie sind.", en: "A fork is a pointer to the old thread; the messages stay where they are." },
		],
		where: [
			{ de: "Im Store der Hilfeseite auf big, neben dem Schwarm-Shard A.", en: "In the help site's store on big, next to swarm shard A." },
		],
		open: { de: "Multiplayer Space-Chat öffnen", en: "Open Multiplayer Space-Chat" },
	},
	mmo: {
		icon: "⚓",
		title: { de: "spaces-mmo: Leuchtfeuer", en: "spaces-mmo: Leuchtfeuer" },
		lead: {
			de: "Ein Online-Rollenspiel auf phi-spaces. Die erste Welt ist ein Archipel im Nebel: nur wo Leuchtfeuer brennen, kann man sicher fahren, handeln und bauen.",
			en: "An online role-playing game on phi-spaces. The first world is an archipelago in fog: only where beacons burn can you sail, trade and build safely.",
		},
		what: [
			{ de: "Kein Feuer hält einer allein: Spieler und NPCs sammeln, handeln, siedeln und halten die Feuer gemeinsam am Brennen.", en: "No one keeps a fire alone: players and NPCs gather, trade, settle and keep the fires burning together." },
			{ de: "Karte im Browser, Befehle als Text; NPCs mit Skript oder mit echtem Modell.", en: "A map in the browser, commands as text; NPCs scripted or driven by a real model." },
		],
		spaces: [
			{ de: "Die ganze Welt sind Entries: Räume, Wege, Nebel, Dinge, Figuren, Angebote und Aufträge.", en: "The whole world is entries: rooms, exits, fog, things, characters, listings and orders." },
			{ de: "Jeder Befehl ist ein Intent-Entry; ein Welt-Prozess nimmt ihn und führt ihn in einer Transaktion aus. NPCs schreiben nur Intents.", en: "Every command is an intent entry; a world process takes it and applies it in one transaction. NPCs only write intents." },
			{ de: "Zugangsdaten und Sitzungen liegen getrennt in einem eigenen Konten-Space.", en: "Credentials and sessions live apart in an accounts space of their own." },
		],
		where: [
			{ de: "Die Welt läuft in vier Regionen auf big, jede mit eigenem Space, Welt-, NPC- und Modell-Prozess, dazu das Web. Der Konten-Space liegt auf nano, über einen Tunnel verbunden.", en: "The world runs in four regions on big, each with its own space and its own world, NPC and model process, plus the web. The accounts space lives on nano, connected through a tunnel." },
		],
		open: { de: "spaces-mmo öffnen", en: "Open spaces-mmo" },
	},
	stats: {
		icon: "▤",
		title: { de: "Space-Statistik: alle Spaces live", en: "Space stats: every space live" },
		lead: {
			de: "Ein Dashboard, das die Spaces aller Apps live zeigt: wie viele Entries welchen Typs, wie viel Speicher, wie viele Commits pro Minute.",
			en: "A dashboard that shows the spaces of every app live: how many entries of which type, how much storage, how many commits per minute.",
		},
		what: [
			{ de: "Je App Kennzahlen, Verlauf und Balken nach Typ und Speicher; bei Codemode-Chat, spaces-mmo und Swarm-Shard auch die Entries selbst.", en: "Per app figures, history and bars by type and storage; for codemode chat, spaces-mmo and the swarm shard also the entries themselves." },
			{ de: "Nur lesend: das Dashboard schreibt nichts und hat keinen Login.", en: "Read-only: the dashboard writes nothing and has no login." },
		],
		spaces: [
			{ de: "Es fragt jeden Space über seinen Socket ab, wie jeder andere Client (stats, readAll); Lesen hinterlässt dort keine Claims.", en: "It asks every space over its socket like any other client (stats, readAll); reading leaves no claims there." },
			{ de: "Die Commits pro Minute kommen aus der Revision, die jede Statistik mitliefert.", en: "Commits per minute come from the revision every stats call carries." },
			{ de: "Der Hub der Hilfeseite zeigt nur Kennzahlen (seine Spaces enthalten Schlüssel und Chat-Nachrichten); der Konten-Store von spaces-mmo fehlt ganz.", en: "The help site's hub shows figures only (its spaces hold keys and chat messages); the spaces-mmo accounts store is left out." },
		],
		where: [
			{ de: "Läuft auf big als systemd-Dienst und erreicht die Spaces auf nano über dieselben Tunnel wie die Apps.", en: "Runs on big as a systemd service and reaches the spaces on nano through the same tunnels as the apps." },
		],
		open: { de: "Space-Statistik öffnen", en: "Open space stats" },
	},
};

export function introTitle(app: IntroApp, locale: "de" | "en"): string {
	return `${INTROS[app].icon} ${INTROS[app].title[locale]}`;
}

/** The introduction page; `target` is where the link below goes (an internal view or an external URL). */
export function AppIntro(props: { app: IntroApp; locale: "de" | "en"; target: { href: string; external: boolean }; onOpen?: () => void }) {
	const { app, locale, target } = props;
	const t = INTROS[app];
	const list = (items: Text[]) => <ul>{items.map((x, i) => <li key={i}>{x[locale]}</li>)}</ul>;
	return (
		<article className="app-intro">
			<p className="app-intro__kicker">{locale === "de" ? "Kurzeinführung" : "Introduction"}</p>
			<h1>{introTitle(app, locale)}</h1>
			<p className="app-intro__lead">{t.lead[locale]}</p>
			<div className="app-intro__grid">
				<section><h2>{locale === "de" ? "Worum es geht" : "What it is"}</h2>{list(t.what)}</section>
				<section><h2>{locale === "de" ? "Wie phi-spaces verwendet wird" : "How it uses phi-spaces"}</h2>{list(t.spaces)}</section>
				<section><h2>{locale === "de" ? "Wo die Spaces liegen" : "Where the spaces live"}</h2>{list(t.where)}</section>
			</div>
			<div className="hero-actions">
				<a
					className="primary-action"
					href={target.href}
					{...(target.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
					onClick={(e) => { if (!target.external && props.onOpen) { e.preventDefault(); props.onOpen(); } }}
				>
					<span>{t.open[locale]} →</span>
				</a>
			</div>
		</article>
	);
}
