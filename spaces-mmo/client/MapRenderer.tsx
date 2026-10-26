"use client";
import type { CharView, ObjView, ServerFrame } from "../server/gateway.ts";
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
	onCell: (x: number, y: number) => void;
	onMenu: (x: number, y: number, clientX: number, clientY: number) => void;
	onFail: (why: string) => void;
	/** Drawn over the map, e.g. the touch pad. */
	controls?: React.ReactNode;
	/** The 3D view tells where its camera stands (the arrows then follow the view, client/walk.ts screenToGrid). */
	onTurn?: (angle: number) => void;
};

/** The shared renderer boundary: both views consume the same server-authoritative room and emit the same cell input. */
export function MapRenderer({ mode, ...props }: MapRendererProps & { mode: Exclude<MapMode, "text"> }) {
	return mode === "3d" ? <MapView3D {...props} /> : <MapView {...props} />;
}
