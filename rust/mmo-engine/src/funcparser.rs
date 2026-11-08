//! `$you()` and `$conj(mine|theirs)` in a message, rendered per reader (`server/engine/funcparser.ts`).
use crate::js::JsRegex;

/// Who reads, who acted, and the actor's name.
pub struct View<'a> { pub viewer: &'a str, pub actor: &'a str, pub actor_name: &'a str }

/// `render`.
pub fn render(text: &str, v: &View) -> String {
	thread_local! {
		static CALL: JsRegex = JsRegex::new(r"\$(you|conj)\(([^()]*)\)", "g").expect("the call pattern");
		static START: JsRegex = JsRegex::new(r"(^|[.!?:]\s+)$", "").expect("the start pattern");
	}
	let me = v.viewer == v.actor;
	CALL.with(|call| call.replace_with(text, |s, m| {
		let (f, arg) = (m.group(s, 1).unwrap_or(""), m.group(s, 2).unwrap_or(""));
		if f == "you" {
			if !me { return v.actor_name.to_owned(); }
			return if START.with(|st| st.test(&text[..m.start])) { "Du".into() } else { "du".into() };
		}
		let mut parts = arg.split('|');
		match (parts.next(), parts.next()) {
			(Some(mine), Some(theirs)) => (if me { mine } else { theirs }).to_owned(),
			_ => s[m.start..m.end].to_owned(),
		}
	}))
}
