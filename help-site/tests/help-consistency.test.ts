import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ALL_ARTICLES } from "../scripts/corpus.ts";
import { corpusHash, validateCorpus } from "../scripts/corpus-validation.ts";
import { checkCorpusExamples } from "../scripts/check-corpus-examples.ts";
import { apiSignatures } from "../scripts/api-signatures.ts";
import { renderMarkdownToHtml, splitTableRow } from "../client/lib/markdown.ts";
import { helpUrl, parseHelpView, resourceView } from "../client/lib/help-navigation.ts";
import { startIndexLoad } from "../client/lib/index-load.ts";
import { runTupleBasics } from "../examples/tuple-basics.ts";
import { refreshMirror, type LiveMirror } from "../examples/shared/live-mirror.ts";
import { SnapshotExpired, type Changes, type Page } from "../../src/core.ts";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { FOREVER, Meter, PhiSpaces, spaces } from "../../src/index.ts";
import { SocialSwarmHub } from "../server/social/swarm.ts";
import { previousArticlePaths, retireGeneratedArticles } from "../scripts/generated-articles.ts";

test("local shard defaults select the migrated store after original deletion", async () => {
	const script = await readFile(new URL("../scripts/swarm-shards.sh", import.meta.url), "utf8");
	const host = await readFile(new URL("../server/nano-host.ts", import.meta.url), "utf8");
	assert.ok(script.includes('NANO_DB="${NANO_DB:-$ROOT/help-site/.local/swarm-b.phi.sqlite}"'));
	assert.ok(host.includes('join(ROOT, ".local", "swarm-b.phi.sqlite")'));
});

test("help generation: renamed articles retire only owned output, unsafe manifests delete nothing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "phi-help-manifest-"));
	const old = "/help/articles/en/topics/retired.md", kept = "/help/articles/en/topics/current.md";
	try {
		await mkdir(join(dir, "help/articles/en/topics"), {recursive:true});
		for (const path of [old, kept, "/help/articles/en/topics/unowned.md"]) await writeFile(join(dir, path.slice(1)), "article");
		await writeFile(join(dir, "help/index.json"), JSON.stringify({schema:"phi-spaces-help-site-index-v1",articles:[{path:old},{path:kept}]}));
		const previous = await previousArticlePaths(dir);
		await assert.rejects(retireGeneratedArticles(dir, [old,"/help/articles/../../outside.md"],new Set([kept])),/Unsafe/);
		await access(join(dir,old.slice(1)));
		await retireGeneratedArticles(dir,previous,new Set([kept]));
		await assert.rejects(access(join(dir,old.slice(1))),{code:"ENOENT"});
		await access(join(dir,kept.slice(1)));
		await access(join(dir,"help/articles/en/topics/unowned.md"));
		await retireGeneratedArticles(dir,previous,new Set([kept]));
	} finally { await rm(dir,{recursive:true,force:true}); }
});

test("help corpus: identities, API facts, links, anchors and table structure are consistent", async () => {
	const catalog = JSON.parse(await readFile(new URL("../corpus/help_product_catalog.json", import.meta.url), "utf8"));
	const facts = JSON.parse(await readFile(new URL("../corpus/api_facts.json", import.meta.url), "utf8"));
	validateCorpus(ALL_ARTICLES, catalog, facts);
	assert.equal(ALL_ARTICLES.length, 45);
	const broken = structuredClone(ALL_ARTICLES);
	broken[0]!.de.body += "\n[broken](help.topic.overview#absent)";
	assert.throws(() => validateCorpus(broken, catalog, facts), /Broken link/);
	assert.throws(() => validateCorpus([...ALL_ARTICLES, ALL_ARTICLES[0]!], catalog, facts), /Duplicate article/);
	assert.throws(() => validateCorpus(ALL_ARTICLES, catalog, facts.slice(1)), /Missing API fact/);
	const translated = structuredClone(ALL_ARTICLES); translated[0]!.en.body += "\n## New {#only-in-en}";
	assert.throws(() => validateCorpus(translated, catalog, facts), /parity/);
	assert.notEqual(corpusHash("write completes"), corpusHash("write failsxxx"), "same-length content must affect the hash");
});

test("help examples: actual DE/EN TypeScript fences compile against the current API", () => {
	assert.ok(checkCorpusExamples().examples >= 40);
	const invalid = structuredClone(ALL_ARTICLES.filter(a => a.id === "help.api.phispaces_write"));
	invalid[0]!.de.body = '```ts\nawait space.write({type: "Broken", fields: { bad: undefined }});\n```';
	assert.throws(() => checkCorpusExamples(invalid), /undefined/);
});

test("help API index: displayed signatures are extracted from actual exports", () => {
	const signatures = apiSignatures();
	assert.equal(signatures.size, 14);
	assert.match(signatures.get("help.api.phispaces_write")!, /PhiSpaces.write\(entry:/);
	assert.match(signatures.get("help.api.operations_runs_workers")!, /start\(commandId: string, spec: RunSpec\)/);
	assert.match(signatures.get("help.api.phispaces_wait_notify_mailbox")!, /RemoteSpace.events\(/);
	assert.match(signatures.get("help.api.phispaces_read")!, /Promise<core.EntryView \| null>/);
	for (const signature of signatures.values()) assert.doesNotMatch(signature, /import\("(?:\/|[A-Za-z]:)/);
});

test("help renderer: code unions, nested lists, numbering and safe links", () => {
	assert.deepEqual(splitTableRow('| txn | `string | null` | allowed |'), ["txn", "`string | null`", "allowed"]);
	const html = renderMarkdownToHtml('| Type | Meaning |\n|---|---|\n| `string | null` | value |');
	assert.equal((html.match(/<td>/g) ?? []).length, 2);
	assert.match(renderMarkdownToHtml('6. Stage six'), /<ol start="6">/);
	assert.match(renderMarkdownToHtml('1. Parent\n   - Child\n2. Next'), /<li>Parent<ul><li>Child<\/li><\/ul><\/li><li>Next/);
	assert.doesNotMatch(renderMarkdownToHtml('[unsafe](javascript:alert) [bad](data:text/html)'), /href=/);
});

test("help navigation: filters, language, history and stage resources survive URL roundtrips", () => {
	const view = { kind: "api-finder", mode: "modules", query: "wait & notify", provider: "client", category: "mutation", execution: "atomic_commit", idempotency: "request_ref", scope: "single_space" } as const;
	const url = helpUrl(view, "de"); assert.deepEqual(parseHelpView(url), view);
	assert.equal(new URLSearchParams(url).get("lang"), "de");
	assert.deepEqual(parseHelpView(helpUrl(resourceView("v5"), "en")), resourceView("v5"));
	assert.equal(resourceView("invalid").kind, "space-chat");
	assert.match(helpUrl({kind:"article", id:"help.topic.overview"}, "en", "#overview"), /#overview$/);
});

test("help index: failure is visible, retry succeeds and stale completion is ignored", async () => {
	let errors = 0, loaded = 0;
	await new Promise<void>(resolve => {
		startIndexLoad({ content: () => assert.fail(), error: () => { errors++; resolve(); } }, async () => new Response("bad", {status:503}));
	});
	await new Promise<void>(resolve => {
		startIndexLoad({ content: () => { loaded++; resolve(); }, error: e => assert.fail(String(e)) }, async () => Response.json({schema:"phi-spaces-help-site-index-v1",articles:[],areas:[]}));
	});
	let finish!: (r: Response) => void;
	const stop = startIndexLoad({content:() => loaded++,error:() => errors++}, () => new Promise(r => {finish=r;}));
	stop(); finish(Response.json({schema:"phi-spaces-help-site-index-v1",articles:[],areas:[]}));
	await new Promise(r => setImmediate(r));
	assert.equal(errors, 1); assert.equal(loaded, 1);
});

test("help tutorial: full model-free program has the documented output", async () => {
	assert.deepEqual(await runTupleBasics(), {inspected:7, squared:49, jobsRemaining:0});
});

test("help lifecycle: close during background init cannot create orphan intervals", async t => {
	const registry = createRegistry(); registry.install(spaces);
	const host = await Harness.open(new MemoryStorage(), {models:createModels(),registry},ctx);
	const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
	const live = new Set<ReturnType<typeof setInterval>>();
	t.mock.method(globalThis, "setInterval", (...args: Parameters<typeof setInterval>) => { const id=realSet(...args); live.add(id); return id; });
	t.mock.method(globalThis, "clearInterval", (id: ReturnType<typeof setInterval>) => {live.delete(id);realClear(id);});
	const hub = new SocialSwarmHub(host,ctx,new Meter(),{produce:false,pulses:false,seedContent:false});
	try {
		const started = hub.init();
		await hub.close(); await started;
		await new Promise(r => setTimeout(r,20));
		assert.equal(live.size,0);
		await assert.rejects(hub.init(),/closed/);
	} finally { for(const id of live)realClear(id); await hub.close(); await host.close(ctx); }
});

const entry = (id: string) => ({id,type:"Job",types:["Job"],fields:{id},owner:null});
const page = (items: Page["items"], next: string | null = null): Page => ({items,next,token:"snapshot",rev:1,streamId:"stream"});
const delta = (next: number, more = false): Changes => ({streamId:"stream",batches:[],next,rev:next,more});

test("help live sync: multiple snapshot and delta pages, deletes and immutable publication", async () => {
	let pages=0, changes=0;
	const mirror = await refreshMirror({
		readPage: async (_template, opts) => { pages++; if(pages===1)return page([entry("a")],"next"); assert.equal(opts?.token,"snapshot"); return page([entry("b")]); },
		changes: async rev => {
			changes++;
			if(changes===1){assert.equal(rev,1);return {...delta(2,true),batches:[{rev:2,at:2,ops:[{op:"del",id:"a"}]}]};}
			assert.equal(rev,2); return delta(3);
		},
	});
	assert.deepEqual([...mirror.entries.keys()], ["b"]); assert.equal(mirror.rev,3);
	const next = await refreshMirror({readPage:async()=>assert.fail(),changes:async()=>delta(3)},mirror);
	assert.notEqual(next.entries, mirror.entries);
});

test("help live sync: expired/mismatched stream discards partial state, failure preserves old projection", async () => {
	const old: LiveMirror = {streamId:"old",rev:10,entries:new Map([["old",entry("old")]])};
	let rebuilt=0;
	const next=await refreshMirror({readPage:async()=>{rebuilt++;return page([entry("fresh")]);},changes:async rev=>rev===10 ? {...delta(11),streamId:"different"} : delta(1)},old);
	assert.equal(rebuilt,1); assert.deepEqual([...next.entries.keys()],["fresh"]);
	assert.deepEqual([...old.entries.keys()],["old"]);
	await assert.rejects(refreshMirror({readPage:async()=>{throw new SnapshotExpired("expired");},changes:async()=>assert.fail()},undefined,2),SnapshotExpired);
	await assert.rejects(refreshMirror({readPage:async()=>assert.fail(),changes:async()=>{throw new Error("offline");}},old),/offline/);
	assert.deepEqual([...old.entries.keys()],["old"]);
});

test("help live sync: actual PhiSpaces puts/deletes converge without mutating the old mirror", async () => {
	const registry = createRegistry(); registry.install(spaces);
	const host = await Harness.open(new MemoryStorage(),{models:createModels(),registry},ctx);
	try {
		const space = new PhiSpaces(host,ctx);
		const first = await space.write({type:"Job",fields:{n:1}},null,FOREVER);
		await space.write({type:"Job",fields:{n:2}},null,FOREVER);
		const old = await refreshMirror(space);
		await space.take({id:first.id},0);
		const fresh = await space.write({type:"Job",fields:{n:3}},null,FOREVER);
		const next = await refreshMirror(space,old);
		assert.equal(old.entries.has(first.id),true);
		assert.equal(next.entries.has(first.id),false);
		assert.equal(next.entries.has(fresh.id),true);
		assert.equal(next.entries.size,2);
	} finally { await host.close(ctx); }
});
