// The example dataset the data form offers for download (App.tsx, "Custom data task …"): a small CSV that shows the
// format server/datatask.ts reads. Twenty support tickets, the answer column says whether one asks for money back;
// tests/data.test.ts holds that the server takes it as it is.
import type { Lang } from "./theme.ts";

type Row = [string, string, string, boolean];

const DE: Row[] = [
	["Bestellung", "Ich möchte mein Geld für die Kopfhörer zurück.", "mail", true],
	["Lieferung", "Das Paket kam zwei Tage zu spät, sonst ist alles gut.", "chat", false],
	["Rechnung", "Auf der Rechnung steht der falsche Firmenname; bitte korrigieren.", "mail", false],
	["Rückgabe", "Ich habe den Rucksack vor drei Wochen zurückgeschickt und noch keine Gutschrift bekommen.", "telefon", true],
	["Konto", "Mein Passwort ist weg und die Mail zum Zurücksetzen kommt nicht an.", "mail", false],
	["Produktfrage", "Gibt es die Schreibtischlampe auch in Schwarz?", "chat", false],
	["Zahlung", "Bitte buchen Sie den Betrag auf meine Karte zurück.", "mail", true],
	["Lieferung", "Der Link zur Sendungsverfolgung funktioniert nicht.", "chat", false],
	["Gutschein", "Kann ich zwei Gutscheine in einer Bestellung einlösen?", "mail", false],
	["Bestellung", "Die Kaffeemaschine ist kaputt angekommen, ich will eine Erstattung.", "telefon", true],
	["Produktfrage", "Bitte schicken Sie mir die Anleitung für den Wasserkocher.", "mail", false],
	["Rückgabe", "Danke, die Ersatz-Laufschuhe passen perfekt.", "chat", false],
	["Zahlung", "Mir wurde die Yogamatte doppelt abgebucht, bitte einen Betrag erstatten.", "mail", true],
	["Lieferung", "Liefern Sie auch in die Schweiz?", "chat", false],
	["Bestellung", "Wie ändere ich die Lieferadresse meiner Bestellung?", "mail", false],
	["Rechnung", "Ich brauche die Rechnung als PDF, \"Mit freundlichen Grüßen\" reicht nicht.", "mail", false],
	["Rückgabe", "Die Handyhülle passt nicht; ich hätte gern mein Geld zurück.", "chat", true],
	["Konto", "Bitte löschen Sie meinen Newsletter-Eintrag.", "mail", false],
	["Produktfrage", "Ist der Rucksack wasserdicht?", "chat", false],
	["Zahlung", "Können Sie die Abbuchung für die Lampe rückgängig machen?", "telefon", true],
];

const EN: Row[] = [
	["Order", "I want my money back for the headphones.", "mail", true],
	["Delivery", "The parcel arrived two days late, otherwise all is fine.", "chat", false],
	["Invoice", "The invoice shows the wrong company name, please correct it.", "mail", false],
	["Return", "I sent the backpack back three weeks ago and have not been credited yet.", "phone", true],
	["Account", "I lost my password and the reset mail does not arrive.", "mail", false],
	["Product question", "Is the desk lamp also available in black?", "chat", false],
	["Payment", "Please refund the amount to my card.", "mail", true],
	["Delivery", "The tracking link does not work.", "chat", false],
	["Voucher", "Can I combine two vouchers in one order?", "mail", false],
	["Order", "The coffee machine arrived broken, I would like a refund.", "phone", true],
	["Product question", "Please send me the manual for the kettle.", "mail", false],
	["Return", "Thanks, the replacement running shoes fit perfectly.", "chat", false],
	["Payment", "I was charged twice for the yoga mat, please reimburse one payment.", "mail", true],
	["Delivery", "Do you ship to Switzerland?", "chat", false],
	["Order", "How do I change the delivery address of my order?", "mail", false],
	["Invoice", "I need the invoice as a PDF, \"Kind regards\" in a mail is not enough.", "mail", false],
	["Return", "The phone case does not fit, I would like my money back.", "chat", true],
	["Account", "Please take me off the newsletter.", "mail", false],
	["Product question", "Is the backpack waterproof?", "chat", false],
	["Payment", "Can you reverse the charge for the lamp?", "phone", true],
];

const HEAD = { de: ["id", "betreff", "text", "kanal", "rueckerstattung"], en: ["id", "subject", "text", "channel", "refund"] };

/** The example as CSV: semicolons in German (as a German spreadsheet writes it), commas in English; text in quotes. */
export function exampleCsv(lang: Lang): string {
	const sep = lang === "de" ? ";" : ",", yes = lang === "de" ? "ja" : "yes", no = lang === "de" ? "nein" : "no";
	const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
	const rows = (lang === "de" ? DE : EN).map(([subject, text, channel, hit], i) => [`T-${101 + i}`, q(subject), q(text), channel, hit ? yes : no].join(sep));
	return [HEAD[lang].join(sep), ...rows].join("\n") + "\n";
}

/** The example as a link target; the byte order mark lets spreadsheets read it as UTF-8 (the server drops it). */
export const exampleHref = (lang: Lang) => `data:text/csv;charset=utf-8,${encodeURIComponent("﻿" + exampleCsv(lang))}`;
