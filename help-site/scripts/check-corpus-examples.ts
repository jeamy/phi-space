// Compile the actual fenced TypeScript, not a manually copied approximation.
import ts from "typescript";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_ARTICLES } from "./corpus.ts";
import type { ArticleSeed } from "./corpus-articles-data.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = `
 const space: api.PhiSpaces = undefined!;
 const remote: api.RemoteSpace = undefined!;
 const harness: durable.Harness = undefined!;
 const ctx: import("../../src/context.ts").Context = undefined!;
 const meter: api.Meter = undefined!;
 const models: ReturnType<typeof ai.createModels> = undefined!;
 const registry: ReturnType<typeof durable.createRegistry> = undefined!;
 const principal: api.Principal = {peerId:"reader"};
 const conversationId: core.Target = "reader";
 const generation: string = "generation", txnId: string | null = null;
 const lastSeq: number = 0, cursor: number = 0;
 const template: core.Template = {type:"Job"};
 const reqBegin: api.RequestRef = undefined!, reqCommit: api.RequestRef = undefined!;
 const socketPath: string = "/tmp/docs.sock";
 const FOREVER = api.FOREVER, NO_WAIT = api.NO_WAIT;
 const Harness = durable.Harness, MemoryStorage = durable.MemoryStorage;
 const PhiSpaces = api.PhiSpaces, RemoteSpace = api.RemoteSpace;
 const createRegistry = durable.createRegistry, createSpace = api.createSpace;
 const startService = api.startService, SpaceService = api.SpaceService;
 const serveSpace = api.serveSpace, socketTransport = api.socketTransport;
 const spaces = agent.spaces;
 type Json = core.Json;
 const handleEvent: (event: core.SpaceEvent) => Promise<void> = async () => {};
 const page: core.Page = undefined!;
 const service: api.SpaceService = undefined!;
 const connection: NonNullable<api.ServeOptions["connection"]> = undefined!;
 const GateIdentity = api.GateIdentity, DEFAULT_POLICY = api.DEFAULT_POLICY;
 const startFederationHost = api.startFederationHost;
 const createFederationController = api.createFederationController;
 const federationOptions: Parameters<typeof api.createFederationController>[0] = undefined!;
 const runController: api.RunController = undefined!;
 const spec: api.RunSpec = undefined!;
 const runId: string = "run-1", controlSpaceId: string = "control";
 const collectAlerts = api.collectAlerts;
 const hostId: string = "host", authorityId: string = "authority";
 const keyDirectory: api.FederationHostOptions["keys"] = undefined!;
 const grantVerifier: api.FederationHostOptions["verifier"] = undefined!;
 const directory: api.FederationHostOptions["directory"] = undefined!;
 const register: NonNullable<api.FederationHostOptions["boot"]>["external"] = undefined!;
 const installedRegister: NonNullable<api.FederationHostOptions["boot"]>["installed"] = undefined!;
`;

export function checkCorpusExamples(seeds: ArticleSeed[] = ALL_ARTICLES): { examples: number } {
	const virtual = new Map<string, string>();
	for (const article of seeds) for (const locale of ["de", "en"] as const) {
		let n = 0;
		for (const match of article[locale].body.matchAll(/```(?:ts|typescript)\n([\s\S]*?)\n```/g)) {
			const code = match[1]!;
			const file = resolve(ROOT, `help-site/examples/doc-${article.id}-${locale}-${++n}.ts`);
			if (/^export /m.test(code)) { virtual.set(file, code); continue; }
			const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
			const imports = ast.statements.filter(ts.isImportDeclaration);
			let body = code;
			for (const declaration of [...imports].reverse()) body = body.slice(0, declaration.getFullStart()) + body.slice(declaration.end);
			virtual.set(file, `import * as api from "../../src/index.ts";\nimport * as agent from "../../src/agent.ts";\nimport * as core from "../../src/core.ts";\nimport * as durable from "@earendil-works/pi-durable";\nimport * as ai from "@earendil-works/pi-ai/models";\n${imports.map(d => d.getText(ast)).join("\n")}\nasync function documentationExample() {\n${fixture}\n{\n${body}\n}\n}\n`);
		}
	}
	const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true, types: ["node"] };
	const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host);
	host.readFile = path => virtual.get(resolve(path)) ?? read(path);
	host.fileExists = path => virtual.has(resolve(path)) || exists(path);
	host.getSourceFile = (path, languageVersion) => {
		const text = host.readFile(path); return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true);
	};
	host.resolveModuleNames = (names, containingFile) => names.map(name => {
		if (name === "phi-spaces") return { resolvedFileName: resolve(ROOT, "src/index.ts"), extension: ts.Extension.Ts };
		if (name === "phi-spaces/agent") return { resolvedFileName: resolve(ROOT, "src/agent.ts"), extension: ts.Extension.Ts };
		if (name.startsWith("./help-site/")) return { resolvedFileName: resolve(ROOT, name), extension: ts.Extension.Ts };
		return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
	});
	const program = ts.createProgram([...virtual.keys()], options, host);
	const diagnostics = ts.getPreEmitDiagnostics(program);
	if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => ROOT, getNewLine: () => "\n" }));
	return { examples: virtual.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(checkCorpusExamples());
