// One process of the local federation: `management` (the directory, from /fed/peers.json), `control rust|ts` or `member rust|ts`.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { startConfiguredFederation } from "../../../src/index.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { openSqliteHost } from "../../../src/store/sqlite.ts";

const [role, impl] = process.argv.slice(2);
if (role === "management") {
	http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(readFileSync("/fed/peers.json")); }).listen(8080, "0.0.0.0");
} else if (impl === "rust") {
	const child = spawn("phi-space-server", ["--store", `/fed/${role}.sqlite`, `--${role}`, `/fed/${role}.config.json`], { stdio: "inherit" });
	child.on("exit", (code) => process.exit(code ?? 1));
	for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => child.kill(s));
} else {
	const name = role === "control" ? "control" : "member";
	const host = await openSqliteHost(`/fed/${name}.sqlite`);
	await startConfiguredFederation(host, ctx, `/fed/${name}.config.json`);
	console.log(`[phi-spaces] ${name} ready`);
}
