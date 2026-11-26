// Short help for the "?" buttons beside the controls, German and English (docs/forum-seite-plan-2026-11-26.en.md,
// section 11). Each tip links to the help section that explains the control in full; tests/help.test.ts holds every
// tip to both languages, an existing article and anchor, and a use in the page.
import type { Lang } from "./theme.ts";

export type TipId = "signin" | "name" | "signout" | "rooms" | "newroom" | "invite" | "yourid";
type Tip = { text: Record<Lang, string>; article: string; anchor: string };

export const TIPS: Record<TipId, Tip> = {
	signin: {
		text: {
			de: "Du meldest dich beim Anmeldedienst an, nicht beim Forum selbst. Dasselbe Konto gilt auch für die Dateien.",
			en: "You sign in at the sign-in service, not at the forum itself. The same account also serves the files.",
		},
		article: "help.topic.signing_in", anchor: "account",
	},
	name: {
		text: {
			de: "So sehen dich die anderen am Tisch und in der Liste der Personen eines Raums. Du kannst ihn jederzeit ändern.",
			en: "This is how the others see you at the table and in a room's list of people. You can change it at any time.",
		},
		article: "help.topic.signing_in", anchor: "name",
	},
	signout: {
		text: {
			de: "Beendet deine Sitzung hier und beim Anmeldedienst. Beim nächsten Mal fragt er wieder nach deinem Passwort.",
			en: "Ends your session here and at the sign-in service. Next time it asks for your password again.",
		},
		article: "help.topic.signing_in", anchor: "signout",
	},
	rooms: {
		text: {
			de: "Die Räume, in denen du eine Rolle hast: Besitz, Mitglied oder mitlesend. Andere Räume gibt es für dich nicht.",
			en: "The rooms in which you have a role: owner, member or reading along. Other rooms do not exist for you.",
		},
		article: "help.topic.signing_in", anchor: "rooms",
	},
	newroom: {
		text: {
			de: "Ein neuer Raum gehört dir. Sein Name besteht aus Buchstaben, Ziffern, Punkten und Bindestrichen und ist für alle eindeutig.",
			en: "A new room belongs to you. Its name is made of letters, digits, dots and dashes and is unique for everyone.",
		},
		article: "help.topic.signing_in", anchor: "rooms",
	},
	invite: {
		text: {
			de: "Gib die ID der Person ein, die sie dir aus ihrem Menü nennt. Mitglieder schreiben im Raum mit, Mitlesende sehen nur zu.",
			en: "Enter the person's ID, which they read to you from their menu. Members write in the room, readers only watch.",
		},
		article: "help.topic.signing_in", anchor: "invite",
	},
	yourid: {
		text: {
			de: "Diese ID gibst du jemandem, der dich in einen Raum einladen will. Sie verrät weder Namen noch Adresse.",
			en: "You give this ID to someone who wants to invite you to a room. It tells neither your name nor your address.",
		},
		article: "help.topic.signing_in", anchor: "invite",
	},
};
