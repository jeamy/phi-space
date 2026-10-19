"use client";
// Slim bar below the live views: what the distributed test system runs on (hosts, CPU, memory) and how many
// entries each database may hold. Reads GET /api/system; the data comes from the hosts themselves.
import { useEffect, useState } from "react";

interface HostFacts { name: string; cpu: string; cores: number; memGiB: number }
interface ShardInfo { shard: string; up: boolean; entries: number | null; host?: HostFacts | null; cap?: number | null }
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
	// Every host enforces its own SWARM_MAX_ENTRIES; fall back to the hub's cap only when a host does not report one.
	const capOf = (s: ShardInfo) => s.cap ?? info.cap;
	const caps = new Set(info.shards.filter((s) => s.up).map(capOf));
	return (
		<div className="system-bar" role="contentinfo">
			<span className="system-bar__note">
				{locale === "de" ? "Testsystem" : "Test system"}
				{info.cap !== null && caps.size <= 1 ? (locale === "de" ? ` · max. ${num(info.cap)} Einträge je Datenbank` : ` · max ${num(info.cap)} entries per database`) : ""}
			</span>
			{info.shards.map((s) => s.up ? (
				<span key={s.shard} className="system-bar__host">
					<b>{s.host?.name ?? s.shard}</b>
					{s.host ? ` · ${shortCpu(s.host.cpu)} · ${s.host.cores} vCPU · ${s.host.memGiB} GiB` : ""}
					{s.entries !== null ? ` · ${num(s.entries)}${capOf(s) != null ? ` / ${num(capOf(s)!)}` : ""} ${locale === "de" ? "Einträge" : "entries"}` : ""}
				</span>
			) : (
				<span key={s.shard} className="system-bar__host system-bar__host--down">
					<b>{s.shard}</b>: {locale === "de" ? "nicht erreichbar" : "unreachable"}
				</span>
			))}
		</div>
	);
}
