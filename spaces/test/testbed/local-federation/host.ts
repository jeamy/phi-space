// One process of the local federation: `management` (the directory, from /fed/peers.json), `control rust|ts` or `member rust|ts [NAME]` (store and config NAME, default member; the same for both runtimes).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { startConfiguredFederation } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";

const [role, impl, file] = process.argv.slice(2);
if (role === "management") {
	http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(readFileSync("/fed/peers.json")); }).listen(8080, "0.0.0.0");
} else if (impl === "rust") {
	// the Rust host on the same files; once ready it names the store, as the TypeScript one does (one line per start)
	const name = file ?? role;
	const child = spawn("phi-space-server", ["--store", `/fed/${name}.sqlite`, `--${role}`, `/fed/${name}.config.json`], { stdio: ["ignore", "pipe", "inherit"] });
	child.stdout!.on("data", (d: Buffer) => { process.stdout.write(d); const t = String(d); if (t.includes("ready on") && !t.includes(`${name} ready`)) console.log(`[phi-spaces] ${name} ready`); });
	child.on("exit", (code) => process.exit(code ?? 1));
	for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => child.kill(s));
} else {
	const name = role === "control" ? "control" : file ?? "member";
	const host = await openSqliteHost(`/fed/${name}.sqlite`);
	const runtime = await startConfiguredFederation(host, ctx, `/fed/${name}.config.json`);
	// a followed control host change: exit as the daemon does, and come back through the restart policy on the new endpoint
	void runtime.controlChanged.then((c) => { console.log(JSON.stringify({ controlHostChanged: c.targetHostId })); process.exit(75); });
	console.log(`[phi-spaces] ${name} ready`);
}
