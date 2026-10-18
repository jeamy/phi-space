"use client";
// Slim bar below the live views: what the distributed test system runs on (hosts, CPU, memory) and how many
// entries each database may hold. Reads GET /api/system; the data comes from the hosts themselves.
import { useEffect, useState } from "react";

interface HostFacts { name: string; cpu: string; cores: number; memGiB: number }
interface ShardInfo { shard: string; up: boolean; entries: number | null; host?: HostFacts | null }
interface SystemInfo { cap: number | null; shards: ShardInfo[] }

const shortCpu = (cpu: string) => cpu.replace(/\((R|TM)\)/g, "").replace(/\b(\d+-Core )?Processor\b/i, "").replace(/\s+/g, " ").trim();

export function SystemBar({ locale }: { locale: "de" | "en" }) {
	const [info, setInfo] = useState<SystemInfo | null>(null);
	useEffect(() => {
		let dead = false;
		const load = () => void fetch("/api/system").then((r) => r.json()).then((d) => { if (!dead) setInfo(d); }).catch(() => {});
		load();
		const timer = setInterval(load, 15_000);
		return () => { dead = true; clearInterval(timer); };
	}, []);
	if (!info) return null;
	const num = (n: number) => n.toLocaleString(locale === "de" ? "de-DE" : "en-US");
	return (
		<div className="system-bar" role="contentinfo">
			<span className="system-bar__note">
				{locale === "de" ? "Testsystem" : "Test system"}
				{info.cap !== null ? (locale === "de" ? ` · max. ${num(info.cap)} Einträge je Datenbank` : ` · max ${num(info.cap)} entries per database`) : ""}
			</span>
			{info.shards.map((s) => (
				<span key={s.shard} className={`system-bar__host ${s.up ? "" : "system-bar__host--down"}`}>
					<b>{s.host?.name ?? s.shard}</b>
					{s.host ? ` · ${shortCpu(s.host.cpu)} · ${s.host.cores} vCPU · ${s.host.memGiB} GiB` : ""}
					{s.entries !== null ? ` · ${num(s.entries)}${info.cap !== null ? ` / ${num(info.cap)}` : ""} ${locale === "de" ? "Einträge" : "entries"}` : ""}
					{s.up ? "" : locale === "de" ? " · nicht erreichbar" : " · unreachable"}
				</span>
			))}
		</div>
	);
}
