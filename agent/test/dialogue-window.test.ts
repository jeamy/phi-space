// A dialogue shows the model only its recent answered turns (src/dialogue-window.ts); the stored conversation keeps all.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableAgentClient } from "../src/durable-client.ts";
import { dialogueWindow } from "../src/dialogue-window.ts";

const user = (content: string) => ({ role: "user", content });
const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const failed = () => ({ role: "assistant", content: [], stopReason: "error" });

test("the window: the current prompt, before it the newest answered turns within count and size; unanswered ones left out", () => {
  const big = "x".repeat(13_000);
  // like a role whose dialogue outgrew the model: answered turns long ago, then dozens of situations its calls failed on
  const messages = [user("a"), said("A"), user("b"), said("B"), user("c"), said("C"), user("d"), said("D"), user("e"), said("E"),
    ...Array.from({ length: 40 }, (_, i) => [user(`${big}${i}`), failed()]).flat(), user("now")];
  assert.deepEqual(dialogueWindow(messages, { turns: 4, maxChars: 150_000 }).map((m) => m.role === "user" ? m.content : "·"), ["b", "·", "c", "·", "d", "·", "e", "·", "now"]);
  // the size bounds it as well: the newest turns first, whole turns only
  const long = [user("y".repeat(60_000)), said("Y"), user("z".repeat(60_000)), said("Z"), user("now")];
  assert.deepEqual(dialogueWindow(long, { turns: 4, maxChars: 100_000 }).map((m) => String(m.content).slice(0, 1)), ["z", "[", "n"]);
  // a turn without an answer at all (cut off) is left out; nothing before a first user message is lost
  assert.deepEqual(dialogueWindow([user("a"), user("b"), said("B"), user("now")], { turns: 4, maxChars: 1000 }).map((m) => m.role === "user" ? m.content : "·"), ["b", "·", "now"]);
  assert.deepEqual(dialogueWindow([said("hi")]), [said("hi")]);
});

test("a long dialogue sends the model only its last answered turns, a failed one not at all", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-window-"));
  const client = new DurableAgentClient(join(dir, "agent.sqlite"), { modelsModule: fileURLToPath(new URL("./durable-models.ts", import.meta.url)) });
  const run = (prompt: string, n: number) => client.run({ session: "npc", requestId: `r${n}`, model: "faux/faux-1", system: "Scripted offline agent.", prompt, mode: "dialogue" }, { permit: async () => {} });
  try {
    for (let i = 1; i <= 6; i++) await run(`t${i}`, i);
    await assert.rejects(run("fail:too long", 7), /too long/);
    // the fake answers with every user message it was sent: the four newest answered turns and the prompt
    assert.equal((await run("now", 8)).text, "answer:now; previous:t3|t4|t5|t6|now");
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
