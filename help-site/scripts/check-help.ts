// Read-only documentation gate: no generated files or services are touched.
import { readFile } from "node:fs/promises";
import { ALL_ARTICLES } from "./corpus.ts";
import { validateCorpus } from "./corpus-validation.ts";
import { apiSignatures } from "./api-signatures.ts";
import { checkCorpusExamples } from "./check-corpus-examples.ts";

const catalog = JSON.parse(await readFile(new URL("../corpus/help_product_catalog.json", import.meta.url), "utf8"));
const facts = JSON.parse(await readFile(new URL("../corpus/api_facts.json", import.meta.url), "utf8"));
validateCorpus(ALL_ARTICLES, catalog, facts);
const signatures = apiSignatures();
for (const fact of facts) if (!signatures.has(fact.id)) throw new Error(`Missing API export binding ${fact.id}`);
console.log({ articles: ALL_ARTICLES.length, localizedRecords: ALL_ARTICLES.length * 2, apiSignatures: signatures.size, typecheckedExamples: checkCorpusExamples().examples });
