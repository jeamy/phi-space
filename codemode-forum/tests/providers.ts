// A provider for the tests of the page's logins (FORUM_PROVIDER_MODULE, FORUM_TEST=1; tests/providers.test.ts): pi-ai's
// real Models and the real credential file around it, only the provider is made up. Its key login asks every kind of
// prompt pi-ai has (a choice, a line of text, a secret) and says what a flow says (info with a link, progress); its
// sign-in shows a link to open and a device code and asks for a pasted code, then hands out tokens that it refreshes,
// counting. A key must begin with "sk-test-" and a code must be "code-ok"; a wrong one fails the login with a message
// that quotes it, as some providers' messages do (the model process must scrub it).
//   FORUM_TEST_OAUTH_EXPIRES_MS   how long a signed-in token lives (default an hour; 0: expired at once, so the next use
//                                 refreshes it); a refreshed one lives an hour
import { createFauxCore, createProvider, fauxAssistantMessage } from "../../spaces/agent/src/live-models.ts";

export function providers(): unknown[] {
	const core = createFauxCore({ provider: "forum-test", api: "forum-test-api", models: [{ id: "echo", name: "Echo", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] });
	const answer = (fn: (...a: any[]) => any) => (...a: any[]) => { core.appendResponses([fauxAssistantMessage("OK")]); return fn(...a); };
	const lives = () => Number(process.env.FORUM_TEST_OAUTH_EXPIRES_MS ?? 3_600_000);
	const provider = createProvider({
		id: "forum-test", name: "FORUM test provider", api: { stream: answer(core.stream), streamSimple: answer(core.streamSimple) } as never,
		models: core.models as never,
		auth: {
			apiKey: {
				name: "Test key",
				async login(ia: any) {
					ia.notify({ type: "info", message: "Make a key in the test console", links: [{ url: "https://console.example.invalid/keys", label: "Test console" }] });
					const region = await ia.prompt({ type: "select", message: "Which region?", options: [{ id: "eu", label: "Europe" }, { id: "us", label: "America", description: "slower from here" }] });
					const account = await ia.prompt({ type: "text", message: "Account name", placeholder: "team" });
					const key = await ia.prompt({ type: "secret", message: "Paste the key", placeholder: "sk-test-…" });
					ia.notify({ type: "progress", message: "Checking the key" });
					if (!key.startsWith("sk-test-")) throw new Error(`The key ${key} is not a test key`);
					return { type: "api_key", key, env: { FORUM_TEST_REGION: region, FORUM_TEST_ACCOUNT: account } };
				},
				async resolve({ credential }: any) { return credential?.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined; },
			},
			oauth: {
				name: "FORUM test sign-in", loginLabel: "Sign in with the test account",
				async login(ia: any) {
					ia.notify({ type: "auth_url", url: "https://auth.example.invalid/authorize?client=forum", instructions: "Open the link and sign in" });
					ia.notify({ type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://auth.example.invalid/device", expiresInSeconds: 600 });
					const code = await ia.prompt({ type: "manual_code", message: "Paste the code the page shows you" });
					if (code !== "code-ok") throw new Error(`The code ${code} was refused`);
					return { type: "oauth", access: "access-1", refresh: "refresh-1", expires: Date.now() + lives() };
				},
				async refresh(c: any) {
					const n = Number(String(c.refresh).split("-")[1] ?? 1) + 1;
					return { ...c, access: `access-${n}`, refresh: `refresh-${n}`, expires: Date.now() + 3_600_000 };
				},
				async toAuth(c: any) { return { apiKey: c.access }; },
			},
		},
	});
	return [provider];
}
