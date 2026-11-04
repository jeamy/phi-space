"use client";
import type { AtlasState, AtlasView, CharView, ObjView, ServerFrame } from "../server/gateway.ts";
import type { WorldTimeView } from "../server/engine/worldtime.ts";
import { MapView } from "./MapView.tsx";
import { MapView3D } from "./MapView3D.tsx";

type Hello = Extract<ServerFrame, { t: "hello" }>;
export type MapMode = "text" | "2d" | "3d";
export type MapRendererProps = {
	world: Hello["world"];
	room: Hello["room"];
	chars: Map<string, CharView>;
	objs: Map<string, ObjView>;
	me: string;
	fog: number;
	viewReset?: number;
	onCell: (x: number, y: number) => void;
	onMenu: (x: number, y: number, clientX: number, clientY: number) => void;
	onFail: (why: string) => void;
	/** Drawn over the map, e.g. the touch pad. */
	controls?: React.ReactNode;
	/** The 3D view tells where its camera stands (the arrows then follow the view, client/walk.ts screenToGrid). */
	onTurn?: (angle: number) => void;
	/** The map fills its frame and the camera follows (a phone); the sheet covers this many px at the bottom. */
	fill?: boolean;
	insetBottom?: number;
	/** The end of the walk under way, marked on the map. */
	goal?: { x: number; y: number } | null;
	/** The world map and its state: the 3D view draws the other rooms of the island as blocks round this one. */
	atlas?: AtlasView | null;
	atlasState?: AtlasState | null;
	/** What was said lately (speaker name, text, time): the 3D view shows it as bubbles over the speakers up close. */
	said?: Array<{ from: string; text: string; at: number }>;
	/** The world's clock as last received (App), for the 3D view's day and night; absent: always day. */
	worldTime?: { v: WorldTimeView; at: number } | null;
};

/** The shared renderer boundary: both views consume the same server-authoritative room and emit the same cell input. */
export function MapRenderer({ mode, ...props }: MapRendererProps & { mode: Exclude<MapMode, "text"> }) {
	return mode === "3d" ? <MapView3D {...props} /> : <MapView {...props} />;
}
