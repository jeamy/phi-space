// pi-server/pi-serverd integration without importing or installing another transport package.
// The host supplies pi-server and a connection identity from its trusted authentication boundary.
// Presentation and service arguments are client-controlled and must never be used as identity credentials.
import type { Connection, SpaceService } from "./service.ts";
import type { Transport } from "./remote.ts";

export type RoutedCall = { serviceId: string; member: string; args: readonly unknown[] };
export type RoutedAttachment = {
	invokeService(call: RoutedCall, ...context: any[]): Promise<unknown>;
	release(...context: any[]): unknown;
};
export type RoutedServices = { attachClient(presentation: any, context: any): RoutedAttachment | Promise<RoutedAttachment> };

/** Extend the existing server-services attachment; sessions/chat and all other services keep their original route. */
export function withSpaceService(base: RoutedServices, space: SpaceService, trustedConnection: () => Connection | Promise<Connection>): RoutedServices {
	return {
		async attachClient(presentation, context) {
			const original = await base.attachClient(presentation, context);
			const conn = await trustedConnection();
			return {
				async invokeService(call, ...rest) {
					if (call.serviceId !== "space") return original.invokeService(call, ...rest);
					const arg = call.args[0];
					if (!arg || typeof arg !== "object" || Array.isArray(arg) || (arg as { method?: unknown }).method !== call.member) return { ok: false, error: { code: "BadRequest", message: "space member and encoded method must agree" } };
					return space.handle(arg, conn);
				},
				release: (...rest) => original.release(...rest),
			};
		},
	};
}

/** Pass client.request({serverId: client.serverId}, call) as invoke; the normal pi-server RPC framing carries the space envelope. */
export function piServerTransport(invoke: (call: RoutedCall) => Promise<unknown>): Transport {
	return {
		async request(text) {
			const call = JSON.parse(text);
			return JSON.stringify(await invoke({ serviceId: "space", member: call.method, args: [call] }));
		},
	};
}
