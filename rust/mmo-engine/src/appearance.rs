//! What a player chose for the look of their figure in 3D (`shared/appearance.ts`, the `avatar` command): small indices
//! into fixed palettes. Only what the server needs: reading a line, the default, the words for the player.
use phi_json::{obj, Json};

use crate::j;
use crate::js;

const FIGURES: [&str; 4] = ["Wanderer", "Seefahrerin", "Kräftig", "Schlaksig"];
const COATS: [&str; 8] = ["Blau", "Rot", "Grün", "Violett", "Ocker", "Petrol", "Grau", "Weiß"];
const HAIRS: [&str; 8] = ["Schwarz", "Dunkelbraun", "Braun", "Blond", "Rot", "Grau", "Weiß", "Blau"];
const SKINS: [&str; 5] = ["Hell", "Rosig", "Mittel", "Gebräunt", "Dunkel"];
const HATS: [&str; 4] = ["ohne", "Hut", "Mütze", "Kapitänsmütze"];

/// `DEFAULT_APPEARANCE`.
pub fn default_appearance() -> Json { obj! { "body" => 0.0, "coat" => 0.0, "hair" => 1.0, "skin" => 0.0, "hat" => 0.0, "glasses" => false, "gloves" => false } }

/// `KEYS`: the field, its words, how many choices (None: ja/nein).
const KEYS: [(&str, &[&str], Option<usize>); 7] = [
	("body", &["figur", "figure", "typ"], Some(4)),
	("coat", &["farbe", "color", "colour", "kleidung"], Some(8)),
	("hair", &["haar", "haare", "hair"], Some(8)),
	("skin", &["haut", "skin"], Some(5)),
	("hat", &["hut", "hat"], Some(4)),
	("glasses", &["brille", "glasses"], None),
	("gloves", &["handschuhe", "gloves"], None),
];
const YES: [&str; 5] = ["ja", "yes", "an", "on", "1"];
const NO: [&str; 5] = ["nein", "no", "aus", "off", "0"];

/// `parseAppearance`: `figur 2 farbe 3 …` (numbers from 1, any subset, any order) on top of `base`; Err: why not.
pub fn parse_appearance(line: &str, base: &Json) -> Result<Json, String> {
	let lowered = js::lower(js::trim(line));
	let words: Vec<String> = js::re(r"\s+", "").split(&lowered).into_iter().map(|w| w.unwrap_or("").to_owned()).filter(|w| !w.is_empty()).collect();
	if words.is_empty() || words.len() % 2 == 1 { return Err("So geht es: avatar figur 1 farbe 2 haar 3 haut 1 hut 2 brille ja handschuhe nein".into()); }
	let mut out = j::object(base);
	for pair in words.chunks(2) {
		let (word, value) = (pair[0].as_str(), pair[1].as_str());
		let Some((key, names, count)) = KEYS.iter().find(|(_, names, _)| names.contains(&word)) else {
			return Err(format!("„{}“ kenne ich nicht; es gibt figur, farbe, haar, haut, hut, brille und handschuhe.", js::slice16(word, 0, Some(20))));
		};
		match count {
			None => {
				if !YES.contains(&value) && !NO.contains(&value) { return Err(format!("Bei {} geht ja oder nein.", names[0])); }
				out.insert(*key, Json::Bool(YES.contains(&value)));
			}
			Some(count) => {
				let n = js::to_number(value);
				if n.fract() != 0.0 || !n.is_finite() || n < 1.0 || n > *count as f64 { return Err(format!("Bei {} geht eine Zahl von 1 bis {count}.", names[0])); }
				out.insert(*key, Json::from(n - 1.0));
			}
		}
	}
	Ok(Json::Object(out))
}

fn pick<'a>(list: &[&'a str], v: &Json) -> &'a str { v.as_f64().filter(|x| x.fract() == 0.0 && *x >= 0.0).and_then(|x| list.get(x as usize)).copied().unwrap_or("undefined") }

/// `describeAppearance`: what the figure looks like now, in words.
pub fn describe_appearance(a: &Json) -> String {
	let hat = j::at(a, "hat");
	let mut extras: Vec<&str> = Vec::new();
	if j::truthy(hat) { extras.push(pick(&HATS, hat)); }
	if j::truthy(j::at(a, "glasses")) { extras.push("Brille"); }
	if j::truthy(j::at(a, "gloves")) { extras.push("Handschuhe"); }
	format!("Figur {}, Kleidung {}, Haar {}, Haut {}.{}", pick(&FIGURES, j::at(a, "body")), pick(&COATS, j::at(a, "coat")), pick(&HAIRS, j::at(a, "hair")), pick(&SKINS, j::at(a, "skin")), if extras.is_empty() { String::new() } else { format!(" Dazu: {}.", extras.join(", ")) })
}
