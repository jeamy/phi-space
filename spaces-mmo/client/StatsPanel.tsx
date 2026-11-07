"use client";
// The statistics (GET /api/stats, server/stats.ts): how many play, what the world holds and how often it was travelled,
// and the list of players; a tap on a player shows where they stand, since when they play, their reputation and rides.
import { useEffect, useState } from "react";
import type { PlayerStat, Trips, WorldStats } from "../server/stats.ts";
import { language } from "./i18n/index.ts";

const TRIP_NAMES: Array<[keyof Trips, string]> = [["beam", "Beams"], ["ship", "Großes Schiff"], ["sail", "Segelboot"], ["row", "Ruderboot"], ["train", "Zug"]];
const GROUPS: Array<[PlayerStat["kind"], string]> = [["player", "Wer spielt"], ["settler", "Siedler"], ["ai", "KI-Figuren"]];
const date = (ms: number) => new Date(ms).toLocaleDateString(language() === "en" ? "en-GB" : "de-DE", { day: "numeric", month: "short", year: "numeric" });

export function StatsPanel({ me }: { me: string }) {
	const [s, setS] = useState<WorldStats | null>(null), [error, setError] = useState(""), [open, setOpen] = useState<string | null>(null);
	useEffect(() => {
		let gone = false;
		void fetch("/api/stats").then(async (r) => {
			const d = await r.json();
			if (!r.ok) throw new Error((d as { error?: string }).error ?? `HTTP ${r.status}`);
			if (!gone) setS(d as WorldStats);
		}).catch((e) => { if (!gone) setError((e as Error).message); });
		return () => { gone = true; };
	}, []);
	if (error) return <div className="panel stats"><h2>Statistik</h2><p className="error" style={{ margin: 0 }}>{error}</p></div>;
	if (!s) return <div className="panel stats"><h2>Statistik</h2><p className="muted" style={{ margin: 0 }}>Wird gezählt …</p></div>;
	const tile = (label: string, value: number) => <div className="stat-tile" key={label}><b>{value}</b><span>{label}</span></div>;
	return (
		<div className="panel stats">
			<h2>Statistik</h2>
			{s.missing.length > 0 && <p className="muted" style={{ margin: 0, fontSize: "max(12px, var(--min-font))" }}>{`Nicht erreichbar: ${s.missing.join(", ")}; die Zahlen sind ohne sie.`}</p>}
			<h3>Spieler</h3>
			<div className="stat-grid">{tile("Spieler", s.players.total)}{tile("Registriert", s.players.registered)}{tile("Gäste", s.players.guests)}{tile("Gerade online", s.players.online)}{tile("Siedler", s.players.settlers)}{tile("KI-Figuren", s.players.ai)}</div>
			<h3>Reisen</h3>
			<div className="stat-grid">{TRIP_NAMES.map(([k, n]) => tile(n, s.trips[k]))}</div>
			<h3>Bauten und Land</h3>
			<div className="stat-grid">{tile("Häuser", s.buildings.houses)}{tile("Bauten", s.buildings.total)}{tile("Felder", s.fields)}{tile("Beete", s.beds)}{tile("Baustellen", s.sites)}{tile("Siedlungen", s.settlements)}</div>
			{s.buildings.byPlan.length > 0 && <p className="muted stat-plans">{s.buildings.byPlan.map((b) => `${b.name} ${b.count}`).join(" · ")}</p>}
			{GROUPS.map(([kind, title]) => {
				const rows = s.list.filter((p) => p.kind === kind);
				return rows.length > 0 && <div key={kind} className="stat-group">
					<h3>{title}</h3>
					<ul className="stat-players">
						{rows.map((p) => <li key={p.charId}>
							<button aria-expanded={open === p.charId} onClick={() => setOpen(open === p.charId ? null : p.charId)}>
								<span className={`live${p.online ? " on" : ""}`} />
								<b data-no-tr>{p.name}</b>{p.charId === me && <small>du</small>}{p.guest && <small>Gast</small>}
							</button>
							{open === p.charId && <PlayerDetail p={p} />}
						</li>)}
					</ul>
				</div>;
			})}
			<p className="muted" style={{ margin: 0, fontSize: "max(11px, var(--min-font))" }}>{`Stand: ${new Date(s.at).toLocaleTimeString(language() === "en" ? "en-GB" : "de-DE", { hour: "2-digit", minute: "2-digit" })}`}</p>
		</div>
	);
}

function PlayerDetail({ p }: { p: PlayerStat }) {
	const where = !p.at ? "unbekannt" : "aboard" in p.at ? "an Bord des Großen Schiffs" : `${p.at.roomName}${p.at.island ? ` (${p.at.island})` : ""}, Feld ${p.at.x}/${p.at.y}`;
	const rides = TRIP_NAMES.filter(([k]) => p.trips[k] > 0).map(([k, n]) => `${n} ${p.trips[k]}`);
	return (
		<dl className="stat-detail">
			<dt>{p.online ? "Steht in" : "Zuletzt in"}</dt><dd>{where}</dd>
			<dt>{p.kind !== "player" ? "Im Spiel seit" : p.guest ? "Gast seit" : "Registriert seit"}</dt><dd>{date(p.since)}</dd>
			<dt>Ruf</dt><dd>{`${p.reputation.pieces} Scheite in ${p.reputation.beacons} Leuchtfeuern`}</dd>
			{p.reputation.parks > 0 && <><dt>Parks</dt><dd>{`${p.reputation.parks}× gepflegt`}</dd></>}
			<dt>Reisen</dt><dd>{rides.length ? rides.join(", ") : "noch keine"}</dd>
			<dt>Besitz</dt><dd>{`${p.owns.buildings} Bauten${p.owns.plans.length ? ` (${p.owns.plans.map((b) => `${b.count}× ${b.name}`).join(", ")})` : ""}, ${p.owns.fields} Felder, ${p.owns.beds} Beete`}
				<br />{(p.owns.carries ?? []).length ? `Gepäck: ${p.owns.carries.map((i) => `${i.count}× ${i.name}`).join(", ")}` : "Gepäck: nichts"}</dd>
		</dl>
	);
}
