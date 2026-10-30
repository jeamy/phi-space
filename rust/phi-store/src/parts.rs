//! A document with parts (src/store/parts.ts): its head, everything but the parts, and one row per record of each part.
//! Arrays keep their order through an `ord` per row; maps are keyed.
use phi_json::{Json, Object};

/// The index columns of a map part kept on the disk (`PartDef.disk`): the fields that fill `at`, `grp` and `flag`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskIndex {
	pub at: &'static str,
	pub group: &'static str,
	pub flag: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PartKind {
	Array,
	Map,
}

/// A big collection of a document (`PartDef`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PartDef {
	pub path: &'static [&'static str],
	pub kind: PartKind,
	pub disk: Option<DiskIndex>,
}
impl PartDef {
	/// The part's name in the rows: its path, dotted.
	pub fn name(&self) -> String { self.path.join(".") }
}

const CLAIM_INDEX: DiskIndex = DiskIndex { at: "decidedAt", group: "generation", flag: "resultExpired" };
/// The parts of a Space document (src/doc.ts `SPACE_PARTS`), in that order.
pub const SPACE_PARTS: &[PartDef] = &[
	PartDef { path: &["entries"], kind: PartKind::Array, disk: None },
	PartDef { path: &["rpc", "claims"], kind: PartKind::Map, disk: Some(CLAIM_INDEX) },
	PartDef { path: &["restoredClaims"], kind: PartKind::Map, disk: Some(CLAIM_INDEX) },
	PartDef { path: &["rpc", "generations"], kind: PartKind::Map, disk: None },
	PartDef { path: &["stream", "log"], kind: PartKind::Array, disk: None },
];

/// One stored record of a part.
#[derive(Clone, Debug, PartialEq)]
pub struct PartRow {
	pub part: String,
	pub id: String,
	pub ord: i64,
	pub value: Json,
}

/// `partAt`: the value at `path`, if every step is an object.
pub fn part_at<'a>(v: &'a Json, path: &[&str]) -> Option<&'a Json> {
	let mut x = v;
	for k in path {
		x = x.as_object()?.get(k)?;
	}
	Some(x)
}

/// The object at `path`, if every step is an object.
fn object_at_mut<'a>(v: &'a mut Json, path: &[&str]) -> Option<&'a mut Object> {
	match (path.split_first(), v) {
		(None, Json::Object(o)) => Some(o),
		(Some((k, rest)), Json::Object(o)) => object_at_mut(o.get_mut(k)?, rest),
		_ => None,
	}
}

/// `headOf`: the value with each part present replaced by an empty one.
pub fn head_of(value: &Json, parts: &[PartDef]) -> Json {
	let mut head = value.clone();
	for p in parts {
		let (last, parent) = p.path.split_last().expect("a part has a path");
		if let Some(m) = object_at_mut(&mut head, parent) {
			if m.contains_key(last) {
				m.insert(*last, if p.kind == PartKind::Array { Json::Array(vec![]) } else { Json::Object(Object::new()) });
			}
		}
	}
	head
}

/// `joinParts`: the head with the rows of its parts put in (arrays in `ord` order; maps in row order). A part without
/// rows keeps the head's own value.
pub fn join_parts(head: &mut Json, parts: &[PartDef], rows: &std::collections::HashMap<String, Vec<PartRow>>) {
	for p in parts {
		let Some(list) = rows.get(&p.name()).filter(|l| !l.is_empty()) else { continue };
		let (last, parent) = p.path.split_last().expect("a part has a path");
		let Some(m) = object_at_mut(head, parent) else { continue };
		let value = match p.kind {
			PartKind::Array => {
				let mut sorted = list.clone();
				sorted.sort_by_key(|r| r.ord); // stable, as Array.prototype.sort
				Json::Array(sorted.into_iter().map(|r| r.value).collect())
			}
			PartKind::Map => Json::Object(list.iter().map(|r| (r.id.clone(), r.value.clone())).collect()),
		};
		m.insert(*last, value);
	}
}

/// `idOf`: the id of an array record (its `id` field, else its batch revision, else its JSON).
pub fn id_of(v: &Json) -> String {
	match v.get("id") {
		Some(Json::String(s)) => return s.clone(),
		Some(Json::Number(n)) => return phi_json::number_text(*n),
		_ => {}
	}
	if let Some(Json::Number(r)) = v.get("rev") {
		return format!("rev:{}", phi_json::number_text(*r));
	}
	format!("json:{}", v.to_json_text())
}
