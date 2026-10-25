// A scripted model for the tests (SPACES_MMO_LLM_MODULE): answers from fixed phrases, costs nothing. Translation
// prompts end with "The player typed: …"; NPC prompts name the NPC in the system prompt ("You are Ines").
export async function complete(system: string, user: string): Promise<string> {
	const typed = /The player typed: (.*)$/m.exec(user)?.[1]?.trim().toLowerCase() ?? "";
	if (typed) {
		if (typed.includes("holz") && typed.includes("feuer")) return "put treibholz in feuer";
		if (typed.includes("zeig mir")) return "look";
		if (typed.includes("kaputt")) return "rm -rf /";
		return "?";
	}
	if (/You are Ines/.test(system)) {
		const heard = /Heard: (.*)$/m.exec(user)?.[1] ?? "";
		return heard ? `say Hallo! ${heard.includes("öl") ? "Öl haben wir keins, aber Treibholz brennt." : "Bringt Treibholz, dann bleibt das Licht."}\nNOTE: hat mit jemandem über das Feuer gesprochen` : "say Das Feuer braucht Holz!\nNOTE: hat um Holz gebeten";
	}
	if (/You are Fremder/.test(system)) return "say Wo geht es hier aus dem Nebel?";
	return "?";
}
