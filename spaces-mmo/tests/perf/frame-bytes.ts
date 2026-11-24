// The sizes of the frames a page gets when it connects (docs/3d-welt-und-raster-plan-2026-11-21.en.md acceptance case 4:
// "the UTF-8 bytes of hello, atlas and atlasState separately for the same world, and within hello the share of the room
// for a base room and a maximal room"): a server as in production (tests/stack.ts startServer), one player; then every
// room grown to the largest size (growth with fullShare 0 until no room grows) and the player connected again.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/frame-bytes.ts
//   SPACES_MMO_SPACE_SERVER, SPACES_MMO_WORLD_CMD, SPACES_MMO_WEB_CMD: the Rust processes (tests/stack.ts).
//
// The gateway sends each frame as its JSON text, so the bytes are those of the frame as the page parsed it. Prints one
// JSON line per state ("base", "maximal"): the bytes of hello, of its room, of atlas and atlasState, the rooms in the
// atlas and the size of the player's room.
import type { ServerFrame } from "../../server/gateway.ts";
import { freeSide, growthTick } from "../../server/engine/commands/growth.ts";
import { loadWorld } from "../../server/engine/world.ts";
import { Player, startServer } from "../stack.ts";

const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");
type Frame<T extends ServerFrame["t"]> = Extract<ServerFrame, { t: T }>;

async function measure(p: Player, state: string): Promise<void> {
	const hello = await p.play() as unknown as Frame<"hello">;
	const atlas = await p.until((f) => f.t === "atlas", 30_000) as Frame<"atlas">;
	const atlasState = await p.until((f) => f.t === "atlasState", 30_000) as Frame<"atlasState">;
	const sizes = atlas.atlas.rooms.map((r) => r.ground.length * (r.ground[0]?.length ?? 0));
	console.log(JSON.stringify({
		state, helloBytes: bytes(hello), roomBytes: bytes(hello.room), atlasBytes: bytes(atlas), atlasStateBytes: bytes(atlasState),
		atlasRooms: atlas.atlas.rooms.length, room: `${hello.room.ground[0]!.length}x${hello.room.ground.length}`, atlasCells: sizes.reduce((a, b) => a + b, 0),
	}));
}

const w = await loadWorld();
const srv = await startServer();
const p = new Player(srv.url);
try {
	if ((await p.post("/api/register", { name: "Messung", password: "geheim-123" })).status !== 200) throw new Error("register");
	await measure(p, "base");
	// every room to the largest size: growth without the fill condition until no room can grow any more (a run that
	// finds the world lock taken stops early, so it is tried again)
	const any = { ...w, growth: { ...w.growth!, fullShare: 0 } }, s = srv.stack.space;
	const growing = async () => (await s.readAll({ type: "Room" })).filter((r) => freeSide(any, r.fields as never, []) !== null).length;
	for (let runs = 0; (await growing()) && runs < 60; runs++) if (!(await growthTick(s, any, 60_000))) await new Promise((ok) => setTimeout(ok, 500));
	await new Promise((ok) => setTimeout(ok, 2_000)); // the gateway's copy follows the commits
	await measure(p, "maximal");
} finally { await srv.close(); }
