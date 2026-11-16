import assert from "node:assert/strict";
import { test } from "node:test";
import { jevDecider, playerActions, playerMemory, playJevEpisode } from "../server/jev-player.ts";
import { SHORE_EPISODES } from "../server/shores.ts";
import { episodeSeed } from "../server/bottask.ts";

test("direct player offers individual actions only from observed cells and the current room", () => {
	assert.equal(playerActions([]).move_9_9, undefined);
	const history = [{ action: { tool: "look" as const, args: {} }, result: { room: { id: "a" }, things: [{ x: 9, y: 9 }], fires: [{ x: 4, y: 4 }] } }];
	assert.equal(playerActions(history).move_9_9?.args.line, "move 9 9");
	assert.equal(playerActions(history).move_3_4?.args.line, "move 3 4");
	assert.equal(playerActions([...history, { action: { tool: "act", args: { line: "ost" } }, result: { at: { room: "b" } } }]).move_9_9, undefined);
});

test("direct player preserves tool replies, charges tools, and stops without a hidden look", async () => {
	let decisions = 0;
	const result = await playJevEpisode(SHORE_EPISODES[0]!, episodeSeed(SHORE_EPISODES[0]!.island!, 0), "task", async (state) => {
		assert.equal(state.history.length, decisions);
		return { choice: ["look", "logbook", "stop"][decisions++]!, model: "fake", costUsd: 0.001 };
	});
	assert.equal(result.calls, 2); assert.equal(result.decisions, 3); assert.equal(result.cost, 2);
	assert.equal(result.count, 0); assert.equal(result.end, "stop"); assert.equal(result.costUsd, 0.003);
	assert.ok(result.history[1]!.result.days);
});

test("direct player enforces tool and API failure limits", async () => {
	const episode = SHORE_EPISODES[0]!;
	const limited = await playJevEpisode(episode, 0, "task", async () => ({ choice: "look", model: "fake", costUsd: 0 }), { maxCalls: 2 });
	assert.equal(limited.calls, 2); assert.equal(limited.end, "tool limit");
	const broken = await playJevEpisode(episode, 0, "task", async () => { throw new Error("provider unavailable"); });
	assert.equal(broken.calls, 0); assert.match(broken.end, /provider unavailable/);
});

test("Decisions API validates choices and accounts usage before rejecting a bad answer", async () => {
	const original = globalThis.fetch;
	let spent = 0;
	try {
		globalThis.fetch = async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			assert.equal(request.questions.action.type, "choice");
			assert.equal(request.state.task, "task");
			return Response.json({ answers: { action: { choice: "invalid" } }, usage: { cost: 0.02 } });
		};
		const decide = jevDecider("test-key", "fake", (usd) => spent += usd);
		await assert.rejects(decide({ task: "task", callsRemaining: 300, history: [] }, playerActions([])), /invalid action/);
		assert.equal(spent, 0.02);
	} finally { globalThis.fetch = original; }
});

test("a scripted decision sequence can collect and score wood through the same action menu", async () => {
	const { genIsland, shoreLands } = await import("../server/toyisland.ts");
	const episode = SHORE_EPISODES[0]!, seed = episodeSeed(episode.island!, 0), world = genIsland(episode.island!);
	const landingRoom = Object.keys(world.rooms).find((room) => shoreLands(world, seed, 1, room));
	assert.ok(landingRoom);
	const piece = shoreLands(world, seed, 1, landingRoom)!;
	const route = (start: string, goal: string): string[] => {
		const queue = [{ room: start, steps: [] as string[] }], seen = new Set<string>();
		for (const item of queue) {
			if (item.room === goal) return item.steps;
			if (seen.has(item.room)) continue;
			seen.add(item.room);
			for (const [direction, room] of Object.entries(world.rooms[item.room]!.exits)) queue.push({ room, steps: [...item.steps, `go_${direction}`] });
		}
		throw new Error("no route");
	};
	const outbound = route(episode.start!.room, landingRoom), inbound = route(landingRoom, world.fire.room);
	const waitMinutes = 90 - outbound.length * 5;
	// Five-minute waits can express this interval without giving the adapter a macro action.
	const choices = [...outbound, ...Array(waitMinutes / 5).fill("wait_5"), "look", `move_${piece.x}_${piece.y}`, "take", ...inbound, "look", `move_${world.fire.x - 1}_${world.fire.y}`, "feed", "stop"];
	let index = 0;
	const result = await playJevEpisode(episode, seed, "task", async (_state, actions) => {
		const choice = choices[index++]!;
		assert.ok(actions[choice], choice);
		return { choice, costUsd: 0, model: "scripted-test" };
	});
	assert.equal(result.count, 1); assert.equal(result.end, "stop");
});


test("structured memory derives location, time, inventory and connections from successful replies", () => {
 const memory = playerMemory([
  { action: { tool: "look", args: {} }, result: { room: { id: "a" }, at: { x: 2, y: 3 }, pack: [], time: "Tag 1, 08:00" } },
  { action: { tool: "act", args: { line: "ost" } }, result: { at: { room: "b", x: 1, y: 8 }, said: ["Du gehst nach B."] } },
  { action: { tool: "act", args: { line: "nimm treibholz" } }, result: { at: { room: "b", x: 1, y: 8 }, said: ["Du hebst Treibholz auf."] } },
  { action: { tool: "wait", args: { minutes: 30 } }, result: { time: "Tag 1, 08:35" } },
  { action: { tool: "wait", args: { minutes: 120 } }, result: { error: "rejected" } },
 ]);
 assert.equal(memory.minute, 35); assert.equal(memory.minutesRemaining, 445);
 assert.equal(memory.carried, 1); assert.equal(memory.delivered, 0);
 assert.deepEqual(memory.at, { room: "b", x: 1, y: 8 });
 assert.deepEqual(memory.connections, { a: { ost: "b" }, b: { west: "a" } });
 assert.equal(memory.rooms.a?.observedMinute, 0);
 assert.equal(memory.rooms.b, undefined);
});

test("review makes two paid choices, can replace a proposal, and counts both requests", async () => {
 const original = globalThis.fetch;
 let requests = 0, spent = 0;
 try {
  globalThis.fetch = async (_url, init) => {
   const request = JSON.parse(String(init?.body));
   if (requests === 1) assert.equal(request.state.proposedAction.id, "wait_120");
   return Response.json({ answers: { action: { choice: requests++ === 0 ? "wait_120" : "stop" } }, usage: { cost: 0.01 } });
  };
  const result = await playJevEpisode(SHORE_EPISODES[0]!, 0, "task", jevDecider("test", "fake", (usd) => spent += usd, true), { memory: true });
  assert.equal(result.calls, 0); assert.equal(result.decisions, 2);
  assert.equal(result.costUsd, 0.02); assert.equal(spent, 0.02); assert.equal(result.end, "stop");
 } finally { globalThis.fetch = original; }
});
