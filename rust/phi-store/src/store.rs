//! A store as the service sees it (src/spaces.ts): the registry with this host's identity, the default Space and the
//! named Spaces, all in one ledger. The registry is written once, with the first commit of the default Space; named
//! Spaces are created by host code and are served here as they stand in the file. Every Space is watched by the service,
//! so a document is never dropped from memory: the TypeScript host's memory budget has nothing to do here.
use crate::files::{Result, StoreError};
use crate::host::{Committed, Ledger, SharedLedger, SpaceHost};
use crate::ops::WriteOp;
use phi_core::space::{error, CoreError, Random, Space};
use phi_json::{hex, obj, Json, Object};
use std::cell::RefCell;
use std::rc::Rc;

pub const DEFAULT_ALIAS: &str = "default";
const REGISTRY: &str = "phi-spaces.registry";
const REGISTRY_VERSION: i64 = 1;
const DEFAULT_SPACE: &str = "phi-spaces.space";
const NAMED_SPACE: &str = "phi-spaces.named-space";

/// `randomUUID`: version 4 in the usual form.
pub fn random_uuid(random: &mut Random) -> String {
	let mut b = random(16);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	let h = hex(&b);
	format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

fn unknown(space: &str) -> CoreError { error("UnknownSpaceError", format!("unknown space: {space}")) }

pub struct Store {
	/// The registry as stored; `None` before the first commit of a new store.
	registry: Option<Json>,
	default: SpaceHost,
	/// Named Spaces by id, deleted ones too (their ids stay reserved and a snapshot read still finds them).
	named: Vec<(String, SpaceHost)>,
	/// The randomness of the registry's ids.
	random: Random,
}

impl Store {
	/// Opens every Space of `ledger`. `random` makes one source of randomness per document.
	pub fn open(ledger: Ledger, mut random: impl FnMut() -> Random) -> Result<Store> {
		let registry = match &ledger {
			Ledger::Sqlite(l) => l.document(REGISTRY, None)?,
			Ledger::Memory(_) => None,
		};
		if let Some(doc) = &registry {
			if doc.version != REGISTRY_VERSION {
				return Err(StoreError::Unavailable(format!("the registry has version {}; the Rust store reads version {REGISTRY_VERSION} only", doc.version)));
			}
		}
		let registry = registry.map(|d| d.value);
		let shared: SharedLedger = Rc::new(RefCell::new(ledger));
		let default = SpaceHost::open_shared(shared.clone(), DEFAULT_SPACE, None, random())?;
		let default_id = registry.as_ref().and_then(|r| r.get("defaultSpaceId")).and_then(Json::as_str).map(str::to_owned);
		let mut named = vec![];
		if let Some(spaces) = registry.as_ref().and_then(|r| r.get("spaces")).and_then(Json::as_object) {
			for (id, _) in spaces.iter().filter(|(id, _)| Some(*id) != default_id.as_deref()) {
				named.push((id.to_owned(), SpaceHost::open_shared(shared.clone(), NAMED_SPACE, Some(id), random())?));
			}
		}
		Ok(Store { registry, default, named, random: random() })
	}

	pub fn registry(&self) -> Option<&Json> { self.registry.as_ref() }
	fn default_id(&self) -> Option<&str> { self.registry.as_ref()?.get("defaultSpaceId")?.as_str() }
	/// `hostId` of the registry.
	pub fn host_id(&self) -> Option<&str> { self.registry.as_ref()?.get("hostId")?.as_str() }
	/// `hostKey` of the registry: it signs generations, and is never shown.
	pub fn host_key(&self) -> Option<&str> { self.registry.as_ref()?.get("hostKey")?.as_str() }

	/// `resolveSpaceId`: the id a name means in a commit (`None`: the default Space). A deleted Space is not resolved.
	fn commit_id(&self, space: Option<&str>) -> std::result::Result<Option<String>, CoreError> {
		let Some(name) = space else { return Ok(None) };
		let r = self.registry.as_ref().ok_or_else(|| unknown(name))?;
		if let Some(id) = r.get("aliases").and_then(|a| a.get(name)).and_then(Json::as_str) {
			return Ok(Some(id.to_owned()));
		}
		let live = r.get("spaces").and_then(|s| s.get(name)).is_some_and(|i| i.get("deletedAt").is_none());
		if live { Ok(Some(name.to_owned())) } else { Err(unknown(name)) }
	}
	/// `idOf`: the id a name means to a snapshot read, which does not ask whether a Space was deleted.
	fn read_id(&self, name: &str) -> std::result::Result<String, CoreError> {
		let r = self.registry.as_ref().ok_or_else(|| unknown(name))?;
		if let Some(id) = r.get("aliases").and_then(|a| a.get(name)).and_then(Json::as_str) {
			return Ok(id.to_owned());
		}
		if r.get("spaces").and_then(|s| s.get(name)).is_some() { Ok(name.to_owned()) } else { Err(unknown(name)) }
	}
	fn host_of(&mut self, id: Option<&str>) -> &mut SpaceHost {
		match id {
			Some(id) if Some(id) != self.default_id() => match self.named.iter().position(|(n, _)| n == id) {
				Some(i) => &mut self.named[i].1,
				None => &mut self.default, // not reached: the registry and the opened documents agree
			},
			_ => &mut self.default,
		}
	}

	/// The host of a Space for a snapshot read: the default Space even before it is registered.
	pub fn reader(&mut self, space: Option<&str>) -> std::result::Result<&mut SpaceHost, CoreError> {
		let id = space.map(|n| self.read_id(n)).transpose()?;
		Ok(self.host_of(id.as_deref()))
	}

	/// Runs `op` as one commit on a Space (`spaceDoc`). The first commit of a new store registers the host and the default
	/// Space with it, in the same commit: one that fails leaves no trace of either.
	pub fn commit<T>(&mut self, space: Option<&str>, now: f64, op: impl FnOnce(&mut Space) -> std::result::Result<T, CoreError>) -> Result<std::result::Result<Committed<T>, CoreError>> {
		let id = match self.commit_id(space) {
			Ok(id) => id,
			Err(e) => return Ok(Err(e)),
		};
		if self.default_id().is_some() {
			return self.host_of(id.as_deref()).start_commit(op);
		}
		let host_id = format!("host-{}", random_uuid(&mut self.random));
		let host_key = hex(&(self.random)(32));
		let existing = self.registry.clone().and_then(|r| r.as_object().cloned());
		let state = &self.default.space.state;
		let space_id = state.space_id.clone().unwrap_or_else(|| format!("sp-{}", random_uuid(&mut self.random)));
		let incarnation = state.incarnation.clone().unwrap_or_else(|| hex(&(self.random)(4)));
		let info = obj! { "spaceId" => space_id.as_str(), "alias" => DEFAULT_ALIAS, "incarnation" => incarnation.as_str(), "createdAt" => now };
		let mut r = existing.unwrap_or_default();
		for (k, v) in [("hostId", Json::from(host_id.as_str())), ("defaultSpaceId", Json::Null), ("spaces", Json::Object(Object::new())), ("aliases", Json::Object(Object::new())), ("hostKey", Json::from(host_key.as_str()))] {
			if r.get(k).is_none_or(|old| k == "defaultSpaceId" && old.is_null()) {
				r.insert(k, v);
			}
		}
		r.insert("defaultSpaceId", space_id.as_str().into());
		if let Some(Json::Object(s)) = r.get_mut("spaces") {
			s.insert(&space_id, info);
		}
		if let Some(Json::Object(a)) = r.get_mut("aliases") {
			a.insert(DEFAULT_ALIAS, space_id.as_str().into());
		}
		let registry = Json::Object(r);
		self.default.also.push(WriteOp::Doc { kind: REGISTRY.into(), key: String::new(), version: REGISTRY_VERSION, value: registry.to_json_text() });
		let done = self.default.start_commit(|s| {
			s.touch(now);
			s.state.space_id = Some(space_id);
			s.state.incarnation = Some(incarnation);
			op(s)
		})?;
		if done.is_ok() {
			self.registry = Some(registry);
		}
		Ok(done)
	}

	/// Every host of the store.
	pub fn hosts(&mut self) -> impl Iterator<Item = &mut SpaceHost> { std::iter::once(&mut self.default).chain(self.named.iter_mut().map(|(_, h)| h)) }
	/// Takes in what the store has made durable.
	pub fn pump(&mut self) -> Result<()> { self.hosts().try_for_each(SpaceHost::pump) }
	/// Waits for everything handed over.
	pub fn drain(&mut self) -> Result<()> { self.hosts().try_for_each(SpaceHost::drain) }
	/// Writes what is pending and closes the store.
	pub fn close(self) {
		for (_, h) in self.named {
			h.close();
		}
		self.default.close();
	}
}
