import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { think } from "../server/npc/minds.ts";
import { closeDurableNpcs, npcDialogueOptions } from "../server/npc/durable.ts";
import { saveModelChoice, saveSettings } from "../server/settings.ts";
import { calls } from "./durable-fallback.ts";
import { ROOT } from "../server/env.ts";

process.env.SPACES_MMO_LLM = "1";
process.env.SPACES_MMO_LLM_MODULE = "tests/durable-fallback.ts";
process.env.SPACES_MMO_TEST = "1";
delete process.env.SPACES_MMO_DURABLE_NPCS;
process.env.SPACES_MMO_DURABLE_MODELS_MODULE = fileURLToPath(new URL("../../agent/test/durable-npc-models.ts", import.meta.url));

test("NPC dialogues default on with world/region stores, explicit opt-out and independent paid-model permission", () => {
  const env = { SPACES_MMO_LLM: "1" };
  assert.equal(npcDialogueOptions("ines", "one", env)?.store, join(ROOT, ".local", "npc-agents", "one", "world.sqlite"));
  assert.equal(npcDialogueOptions("bo", "one", { ...env, SPACES_MMO_DATA: "/tmp/npc-data", SPACES_MMO_REGION: "west" })?.store, "/tmp/npc-data/npc-agents/one/west.sqlite");
  assert.notEqual(npcDialogueOptions("ines", "one", env)?.store, npcDialogueOptions("ines", "two", env)?.store);
  assert.notEqual(npcDialogueOptions("ines", "one", env)?.store, npcDialogueOptions("ines", "one", { ...env, SPACES_MMO_REGION: "west" })?.store);
  assert.equal(npcDialogueOptions("ines", "one", {}), undefined);
  for (const value of ["0", "false", "off", "none"]) assert.equal(npcDialogueOptions("ines", "one", { ...env, SPACES_MMO_DURABLE_NPCS: value }), undefined);
  assert.equal(npcDialogueOptions("ines", "..", env)?.store, join(ROOT, ".local", "npc-agents", "%2E%2E", "world.sqlite"));
  assert.equal(npcDialogueOptions("bo", "one", { ...env, SPACES_MMO_DURABLE_NPCS: "ines" }), undefined);
});

test("default NPC dialogues retain history after agent reopen, isolated by world and role, within the same Space budgets", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-npcs-"));
  process.env.SPACES_MMO_DURABLE_STORE = join(dir, "npc.sqlite");
  const host = openOwnMemoryHost(), space = new PhiSpaces(host, ctx);
  const npc = { npcId: "ines", name: "Ines", persona: "Keep the beacon.", budgetDay: 20, worldId: "one" };
  const situation = (heard: string) => ({ room: "Hafen", people: ["Anna"], event: "talk", heard: [heard] });
  try {
    await saveSettings(space, { "npc.budgetDay": 20, "llm.perDay": 500, "llm.perMin": 20 });
    const first = await think(space, npc, situation("Ich hei\u00dfe Anna."));
    assert.deepEqual(typeof first === "object" ? first.lines : first, ["say Du hei\u00dft Anna."]);
    await closeDurableNpcs();
    const question = { ...situation("Wie hei\u00dfe ich?"), people: [] };
    const second = await think(space, npc, question);
    assert.deepEqual(typeof second === "object" ? second.lines : second, ["say Du hei\u00dft Anna."]);
    const other = await think(space, { ...npc, npcId: "bo" }, question);
    assert.deepEqual(typeof other === "object" ? other.lines : other, ["say Das wei\u00df ich nicht."]);
    const world = await think(space, { ...npc, worldId: "two" }, question);
    assert.deepEqual(typeof world === "object" ? world.lines : world, ["say Das wei\u00df ich nicht."]);
    assert.equal(calls(), 0, "selected NPCs use their agent rather than the one-shot backend");
    process.env.SPACES_MMO_DURABLE_NPCS = "ines,bo";
    const normal = await think(space, { ...npc, npcId: "fremder" }, question);
    assert.deepEqual(typeof normal === "object" ? normal.lines : normal, ["say fallback"]);
    assert.equal(calls(), 1);
    process.env.SPACES_MMO_DURABLE_NPCS = "0";
    const disabled = await think(space, { ...npc, npcId: "bo" }, question);
    assert.deepEqual(typeof disabled === "object" ? disabled.lines : disabled, ["say fallback"]);
    assert.equal(calls(), 2);
    process.env.SPACES_MMO_DURABLE_NPCS = "ines,bo";
    const counts = await space.readAll({ type: "LlmCount" });
    assert.equal(counts.find(e => String(e.fields.key).startsWith("npc:ines:"))?.fields.used, 3, JSON.stringify(counts));
    await saveSettings(space, { "npc.budgetDay": 3 });
    assert.equal(await think(space, npc, question), "budget");
    await saveModelChoice(space, { on: false, allowed: null, model: null });
    assert.equal(await think(space, { ...npc, npcId: "bo" }, question), "budget");
    assert.equal(await space.count({ type: "Intent" }), 0, "agent replies do not execute world commands");
  } finally { await closeDurableNpcs(); await host.close(ctx); rmSync(dir, { recursive: true, force: true }); }
});
