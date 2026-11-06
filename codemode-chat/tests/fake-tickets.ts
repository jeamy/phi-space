// A made-up dataset for the data tasks (server/datatask.ts): support tickets of an online shop, some of them about a
// refund. Generated from a fixed seed, so every test sees the same rows. `refund` is the answer column: the ticket asks
// for money back, in one of several wordings (some appear only in a few tickets, so code that knows only the sample's
// wordings misses some of the hidden ones).
//   node --experimental-strip-types tests/fake-tickets.ts > tickets.csv     writes the CSV
const SUBJECTS = ["Order", "Delivery", "Invoice", "Account", "Product question", "Return", "Payment", "Voucher"];
const PRODUCTS = ["headphones", "coffee machine", "running shoes", "desk lamp", "backpack", "phone case", "kettle", "yoga mat"];
const PLAIN = [
	"The parcel arrived two days late but everything is fine.",
	"How do I change the delivery address of my order?",
	"The invoice shows the wrong company name, please correct it.",
	"Can I combine two vouchers in one order?",
	"I forgot my password and the reset mail does not arrive.",
	"Is the {p} also available in black?",
	"The tracking link does not work.",
	"Please send me the manual for the {p}.",
	"Thanks, the replacement {p} works perfectly.",
	"Do you ship to Switzerland?",
];
/** The refund wordings; the last ones are rare. */
const REFUND = [
	"I want a refund for the {p}.",
	"Please refund the amount to my card.",
	"I would like my money back, the {p} is broken.",
	"Can you reimburse me for the damaged {p}?",
	"I returned the {p} three weeks ago and still have not been credited.",
	"Please reverse the charge for the {p}.",
];
const CHANNELS = ["mail", "chat", "phone"];
const PRIORITY = ["low", "normal", "high"];

export type Ticket = { id: string; subject: string; body: string; channel: string; priority: string; refund: "yes" | "no" };

export function tickets(n = 500, seed = 4242): Ticket[] {
	let s = seed >>> 0;
	const r = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
	const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
	return Array.from({ length: n }, (_, i) => {
		const p = pick(PRODUCTS), refund = r() < 0.22;
		// common wordings four times as often as the rare ones
		const wording = refund ? REFUND[r() < 0.8 ? Math.floor(r() * 3) : 3 + Math.floor(r() * 3)]! : pick(PLAIN);
		const filler = pick(PLAIN).replace("{p}", pick(PRODUCTS));
		const body = (r() < 0.5 ? `${wording} ${filler}` : `${filler} ${wording}`).replace("{p}", p);
		return { id: `T-${1000 + i}`, subject: `${pick(SUBJECTS)}: ${p}`, body, channel: pick(CHANNELS), priority: pick(PRIORITY), refund: refund ? "yes" : "no" };
	});
}

/** The tickets as CSV (comma, quotes around every text). */
export function ticketsCsv(rows = tickets()): string {
	const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
	return ["id,subject,body,channel,priority,refund", ...rows.map((t) => [t.id, q(t.subject), q(t.body), t.channel, t.priority, t.refund].join(","))].join("\n") + "\n";
}

/** Contributions for the tests: what each one does is in its name. */
export const SOLUTIONS = {
	/** reads every ticket and looks for every wording: correct, many points */
	readAll: `async function solve(){const ids=[];let after;do{const p=await tools.list({after,limit:50});for(const it of p.items){const t=await tools.get({id:it.id});const b=t.body.toLowerCase();if(["refund","money back","reimburse","credited","reverse the charge"].some(w=>b.includes(w)))ids.push(t.id)}after=p.next}while(after);return ids}`,
	/** asks search for every wording: correct, few points */
	searchAll: `async function solve(){const all=await Promise.all(["refund","money back","reimburse","credited","reverse the charge"].map(q=>tools.search({q,limit:200})));return [...new Set(all.flat())]}`,
	/** only the word "refund": misses the other wordings */
	onlyRefund: `async function solve(){return tools.search({q:"refund",limit:200})}`,
};

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(ticketsCsv());
