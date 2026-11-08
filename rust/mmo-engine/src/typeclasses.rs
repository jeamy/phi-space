//! Typeclasses (`server/engine/typeclasses.ts`): a type and its supertypes, nearest first.
use phi_json::{obj, Json};

use crate::j;
use crate::space::{Error, Result};

/// The engine's typeclasses and their parents.
const BASE: [(&str, Option<&str>); 5] = [("Object", None), ("Item", Some("Object")), ("Exit", Some("Object")), ("Character", Some("Object")), ("Room", Some("Object"))];

/// `typeChain`: `Coin` → ["Coin", "Item", "Object"]; unknown or cyclic: an error. `extra`: the world's typeclasses.
pub fn type_chain(name: &str, extra: &Json) -> Result<Vec<String>> {
	let parent = |t: &str| -> Option<Option<String>> {
		if let Some((_, p)) = BASE.iter().find(|(k, _)| *k == t) { return Some(p.map(str::to_owned)); }
		extra.get(t).map(|p| p.as_str().map(str::to_owned))
	};
	let mut chain: Vec<String> = Vec::new();
	let mut t = Some(name.to_owned());
	while let Some(cur) = t {
		let Some(p) = parent(&cur) else { return Err(Error::Other(format!("unbekannte Typklasse „{}“", crate::js::slice16(&cur, 0, Some(30))))) };
		if chain.contains(&cur) { return Err(Error::Other(format!("Typklasse „{name}“ erbt im Kreis"))); }
		chain.push(cur);
		t = p;
	}
	Ok(chain)
}

/// `draftOf`: the draft of an entry of typeclass `name`.
pub fn draft_of(name: &str, extra: &Json, fields: Json) -> Result<Json> {
	let chain = type_chain(name, extra)?;
	Ok(obj! { "type" => chain[0].as_str(), "types" => Json::Array(chain[1..].iter().map(|t| Json::from(t.as_str())).collect()), "fields" => fields })
}

/// The world's typeclasses (`w.typeclasses`, an empty set when it has none).
pub fn of_world(w: &Json) -> &Json { j::at(w, "typeclasses") }
