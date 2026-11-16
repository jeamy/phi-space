import { test } from "node:test";
import assert from "node:assert/strict";
import { experimentPublication, experimentSource, EXPERIMENT_MEDIA } from "../server/experiments-content.ts";
import { GET as media } from "../app/experiments/media/[name]/route.ts";
import { GET as source } from "../app/experiments/source/[document]/route.ts";

test("published papers render their figures, navigation and code without raw image syntax", () => {
 for (const id of ["planning", "jev", "article"]) {
  const doc = experimentPublication(id)!;
  assert.ok(doc.bodies.en.toc.length > 3);
  for (const body of Object.values(doc.bodies)) {
   assert.match(body.html, /<figure><a href="\/experiments\/media\//);
   assert.doesNotMatch(body.html, /EXPERIMENTFIGURE|!\[/);
   for (const heading of body.toc) assert.ok(body.html.includes(`id="${heading.id}"`));
   for (const match of body.html.matchAll(/href="([^"]+)"/g)) assert.ok(/^(https?:|#|\/experiments\/)/.test(match[1]!), match[1]);
  }
 }
 const german = experimentPublication("article")!.bodies.de!;
 assert.ok(german.html.includes('/experiments/article?lang=en'));
 assert.match(experimentPublication("planning")!.bodies.en.html, /&lt;|<code>/);
});

test("publication and media endpoints use explicit allowlists", async () => {
 assert.equal(experimentSource("../../package.json"), null);
 assert.equal(experimentPublication("plan"), null);
 assert.ok(EXPERIMENT_MEDIA.includes("jev-workflow.svg"));
 const missing = await media(new Request("http://localhost/experiments/media/package.json"), { params: Promise.resolve({ name: "../../package.json" }) });
 assert.equal(missing.status, 404);
 const image = await media(new Request("http://localhost/experiments/media/experiment-design.svg"), { params: Promise.resolve({ name: "experiment-design.svg" }) });
 assert.equal(image.headers.get("content-type"), "image/svg+xml");
 assert.match(await image.text(), /<svg/);
 const article = await source(new Request("http://localhost/experiments/source/article?lang=de"), { params: Promise.resolve({ document: "article" }) });
 assert.equal(article.status, 200);
 assert.match(article.headers.get("content-disposition")!, /codemode-planning-article.md/);
 assert.match(await article.text(), /Planungsbots/);
 const invalid = await source(new Request("http://localhost/experiments/source/private"), { params: Promise.resolve({ document: "private" }) });
 assert.equal(invalid.status, 404);
});
