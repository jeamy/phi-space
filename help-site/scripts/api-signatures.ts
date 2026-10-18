// Displayed API signatures come from the compiler, never a manually maintained string.
import ts from "typescript";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bindings: Record<string, string[]> = {
	phispaces_write: ["PhiSpaces.write"], phispaces_read: ["PhiSpaces.read", "PhiSpaces.readIfExists"],
	phispaces_take: ["PhiSpaces.take", "PhiSpaces.takeIfExists"],
	phispaces_txn: ["PhiSpaces.createTransaction", "PhiSpaces.commit", "PhiSpaces.abort"],
	phispaces_lease: ["PhiSpaces.renew", "PhiSpaces.cancel"],
	phispaces_read_page_changes: ["PhiSpaces.readPage", "PhiSpaces.changes", "PhiSpaces.readAll", "PhiSpaces.count", "PhiSpaces.stats"],
	phispaces_wait_notify_mailbox: ["PhiSpaces.wait", "PhiSpaces.notify", "PhiSpaces.events", "PhiSpaces.ack", "RemoteSpace.events", "RemoteSpace.ack"],
	phispaces_claims: ["PhiSpaces.issueGeneration", "PhiSpaces.pollOperation", "PhiSpaces.cancelOperation", "PhiSpaces.resolveOperation"],
	phispaces_completion_profiles: ["PhiSpaces.setCompletionProfiles", "PhiSpaces.setLimits"],
	agent_tools: ["createSpaces", "startService"],
	space_service_and_remote: ["SpaceService", "serveSpace", "RemoteSpace", "socketTransport"],
	gate_auth_grants: ["startFederationHost", "GrantAuthority.issue", "RemoteSpace.enroll", "RemoteSpace.rotateKey"],
	federation_controller: ["createFederationController", "FederatedSpace.write", "FederatedSpace.read", "FederatedSpace.take", "FederatedSpace.takeWaiting", "FederatedSpace.readAll"],
	operations_runs_workers: ["RunController.start", "RunController.pause", "RunController.resume", "RunController.stop", "collectAlerts"],
};

export function apiSignatures(): Map<string, string> {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), path = resolve(root, "src/index.ts");
	const program = ts.createProgram([path], {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strictNullChecks:true,skipLibCheck:true,allowImportingTsExtensions:true,noEmit:true});
	const checker = program.getTypeChecker(), source = program.getSourceFile(path)!;
	const exports = new Map(checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).map(s => [s.name,s]));
	const output = new Map<string,string>();
	for(const [id, names] of Object.entries(bindings)) {
		const signatures = names.map(binding => {
			const [name, method] = binding.split(".");
			let symbol = exports.get(name!);
			if(!symbol)throw new Error(`Missing documented API export ${binding}`);
			if(symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
			let type: ts.Type;
			if(method) {
				const instance = checker.getDeclaredTypeOfSymbol(symbol), property = checker.getPropertyOfType(instance,method);
				if(!property)throw new Error(`Missing documented API method ${binding}`);
				type=checker.getTypeOfSymbolAtLocation(property,property.valueDeclaration ?? source);
			} else type=checker.getTypeOfSymbolAtLocation(symbol,symbol.valueDeclaration ?? source);
			const call=checker.getSignaturesOfType(type,ts.SignatureKind.Call), construct=checker.getSignaturesOfType(type,ts.SignatureKind.Construct);
			const signatures=call.length?call:construct;
			if(!signatures.length)throw new Error(`No callable API signature ${binding}`);
			const signature = checker.signatureToString(signatures[0]!,source,ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
			// Anonymous inferred return types can still contain absolute import paths despite alias formatting.
			// Keep these references relative to src/ so builds are portable and expose no checkout paths.
			const portable = signature.replace(/import\("([^"]+)"\)/g, (original, modulePath: string) => {
				if (!isAbsolute(modulePath)) return original;
				const local = relative(resolve(root, "src"), modulePath).replaceAll("\\", "/");
				if (local.startsWith("../")) throw new Error(`Nonportable API type reference in ${binding}`);
				return `import("./${local}${local.endsWith(".ts") ? "" : ".ts"}")`;
			});
			return `${!call.length?"new ":""}${binding}${portable}`;
		});
		output.set(`help.api.${id}`,signatures.join("; "));
	}
	return output;
}
