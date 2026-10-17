export const SERVICES = ["runner", "host-a", "host-b", "member-1", "member-2"] as const;
export type Service = typeof SERVICES[number];
export type Action = {
	id: string; group: string; label: string; scope: "remote" | "local"; args: string[];
	test?: boolean; mutation?: boolean; confirm?: string; unavailable?: string; program?: "node";
};

export function actions(service: Service): Action[] {
	const remote = (id: string, group: string, label: string, args: string[], extra: Partial<Action> = {}): Action => ({ id, group, label, scope: "remote", args, ...extra });
	const local = (id: string, label: string, args: string[], test = true): Action => ({ id, group: "Quelltests (lokal)", label, scope: "local", args, test });
	const future = (id: string, label: string, why = "Backend-Vertrag geplant, noch nicht implementiert"): Action => remote(id, "Geplante Steuerung", label, [], { unavailable: why });
	return [
		remote("check", "Testumgebung", "Server und Docker prüfen", ["check"]),
		remote("status", "Testumgebung", "Containerstatus anzeigen", ["status"]),
		remote("logs", "Testumgebung", `Logs: ${service}`, ["logs", service, "100"]),
		remote("init", "Testumgebung", "Umgebung initialisieren", ["init"], { mutation: true }),
		local("build", "Produktionsartefakte bauen", ["run", "testbed", "--", "build"], false),
		remote("ship", "Testumgebung", "Artefakte bauen und übertragen", ["ship"], { mutation: true }),
		remote("up-core", "Testumgebung", "Runner bereitstellen/starten", ["up", "core"], { mutation: true }),
		remote("up-federation", "Testumgebung", "Federation-Container bereitstellen (Platzhalter)", ["up", "federation"], { mutation: true }),
		remote("start", "Container", `${service} starten (vorhandener Container)`, ["start", service], { mutation: true }),
		remote("stop", "Container", `${service} stoppen`, ["stop", service], { mutation: true, confirm: "Container stoppen? Laufende Arbeit wird unterbrochen; dies ist keine RunGate-Pause." }),
		remote("kill", "Container", `${service} abstürzen lassen und neu starten`, ["kill", service], { mutation: true, confirm: "SIGKILL und Neustart ausführen? Laufende Arbeit wird abrupt beendet." }),
		remote("partition", "Container", `${service} vom Testnetz trennen`, ["partition", service], { mutation: true }),
		remote("heal", "Container", `${service} wieder mit Testnetz verbinden`, ["heal", service], { mutation: true }),
		remote("down", "Container", "Alle Testcontainer herunterfahren (Volumes behalten)", ["down"], { mutation: true, confirm: "Alle Container dieses Testprojekts entfernen? Volumes bleiben erhalten." }),
		...(["smoke", "examples", "scenario", "all"] as const).map(suite => remote(`test-${suite}`, "Artefakttests (Server)", `Tests: ${suite}`, ["test", suite], { test: true, mutation: true, ...(suite === "scenario" || suite === "all" ? { confirm: "Dieser Test ersetzt den bisherigen sieve-mobile-Lauf. Fortfahren?" } : {}) })),
		...(["create", "run", "evaluate", "all"] as const).map(phase => remote(`sieve-${phase}`, "Primzahlsieb", `Szenario: ${phase}`, ["scenario", "sieve-mobile", phase], { test: phase === "evaluate" || phase === "all", mutation: true, ...(phase === "all" ? { confirm: "Der bisherige sieve-mobile-Lauf wird ersetzt. Fortfahren?" } : {}) })),
		local("typecheck", "TypeScript prüfen", ["run", "typecheck"]),
		local("test-local", "Alle lokalen Quelltests", ["test"]),
		local("test-examples-local", "Lokale Beispieltests", ["run", "test:examples"]),
		...(["core", "meter", "persistence", "spaces", "claims", "scenario", "tui"] as const).map(name => ({ ...local(`local-${name}`, `Quelltest: ${name}`, ["--experimental-strip-types", "--test", `test/test-${name}.test.ts`]), program: "node" as const })),
		{ ...local("local-integration", "Quelltest: integration", ["--experimental-strip-types", "--test", "test/integration.test.ts"]), program: "node" },
		future("space-create", "Space anlegen / Entry schreiben oder nehmen", "Lokaler Core vorhanden; administrativer Remote-Steuerpfad fehlt"),
		future("space-txn", "Txn beginnen/committen/abbrechen; Lease ändern", "Lokaler Core vorhanden; administrativer Remote-Steuerpfad fehlt"),
		future("space-lifecycle", "Space aufnehmen, drain, entfernen, archivieren, löschen"),
		future("run-start", "Produktiven Lauf starten"), future("run-pause", "Lauf pausieren / fortsetzen / stoppen (RunGate)"),
		future("worker", "Workerart und gewünschte Anzahl verwalten"), future("agent", "LLM-Agent / Conversation / Modell / Budget verwalten"),
		future("project", "Projekt provisionieren / Hosts pairen / Runtime aktualisieren"),
		future("recovery", "Promotion / Restore / Recovery-Entscheidung"),
	];
}
