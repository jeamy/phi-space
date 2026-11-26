// Imported first by a test file that runs its stack at scale 2: the engine processes it starts inherit the variable
// and load worlds/<id>/world-scale2.json (server/engine/world.ts worldFile), and this process sets its rule values to it.
import { useGridScale } from "../shared/rules.ts";

process.env.SPACES_MMO_GRID_SCALE = "2";
useGridScale(2);
