// npm run world:load [-- --replace]: loads the world definition into the running world space (engine/loader.ts).
// Without --replace only what is missing is written (a world worker does that on its own when it starts, and loads a
// newer version by itself); --replace writes the definition's rooms, exits, prototypes and help again and places the
// items that exist nowhere. Rooms and things builders made stay.
import "./env.ts";
import { loadIntoSpace } from "./engine/loader.ts";
import { loadWorld } from "./engine/world.ts";
import { connectSpace, DEFAULT_SPACE } from "./space.ts";

const w = await loadWorld();
const conn = connectSpace(process.env.SPACES_MMO_SPACE || DEFAULT_SPACE);
try {
	const r = await loadIntoSpace(conn.space, w, { replace: process.argv.includes("--replace") });
	console.log(r.loaded ? `[world:load] ${w.id} version ${r.version} written${r.spawned.length ? `; placed ${r.spawned.join(", ")}` : ""}` : `[world:load] ${w.id} version ${r.version} is current; only missing parts written (--replace writes everything)`);
} finally { conn.close(); }
