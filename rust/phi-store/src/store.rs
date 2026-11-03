//! A store as the service sees it (src/spaces.ts): the registry with this host's identity, the default Space and the
//! named Spaces, all in one ledger. The registry is written once, with the first commit of the default Space; named
//! Spaces are created by host code and are served here as they stand in the file. Every Space is watched by the service,
//! so a document is never dropped from memory: the TypeScript host's memory budget has nothing to do here.
use crate::files::{Result, StoreError};
use crate::host::{Committed, Ledger, SharedLedger, SpaceHost};
use crate::ops::WriteOp;
use crate::writer::Waker;
use phi_core::space::{error, CoreError, Random, Space};
use phi_json::{hex, obj, Json, Object};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::rc::Rc;

pub const DEFAULT_ALIAS: &str = "default";
const REGISTRY: &str = "phi-spaces.registry";
const REGISTRY_VERSION: i64 = 1;
const DEFAULT_SPACE: &str = "phi-spaces.space";
const NAMED_SPACE: &str = "phi-spaces.named-space";

/// `randomUUID`: version 4 in the usual form.
/// One source of the system's randomness for a document.
pub fn system_random() -> Random {
	let mut source = std::fs::File::open("/dev/urandom").expect("the system has /dev/urandom");
	Box::new(move |n| {
		let mut out = vec![0; n];
		source.read_exact(&mut out).expect("/dev/urandom does not end");
		out
	})
}

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
	/// Where each id sits in `named`.
	named_at: HashMap<String, usize>,
	/// The randomness of the registry's ids.
	random: Random,
}

fn registry_doc(registry: &Json) -> WriteOp {
	WriteOp::Doc { kind: REGISTRY.into(), key: String::new(), version: REGISTRY_VERSION, value: registry.to_json_text() }
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
			// a deleted Space is opened when a snapshot read asks for it (`reader`)
			for (id, _) in spaces.iter().filter(|(id, i)| Some(*id) != default_id.as_deref() && i.get("deletedAt").is_none()) {
				named.push((id.to_owned(), SpaceHost::open_shared(shared.clone(), NAMED_SPACE, Some(id), random())?));
			}
		}
		let named_at = named.iter().enumerate().map(|(i, (id, _))| (id.clone(), i)).collect();
		Ok(Store { registry, default, named, named_at, random: random() })
	}

	pub fn registry(&self) -> Option<&Json> { self.registry.as_ref() }
	/// A primary/sync primary's sealed candidate that poisoned the store (every Space of it shares the ledger).
	pub fn sealed_candidate(&self) -> Option<(f64, String)> { self.default.sealed_candidate() }
	fn registry_copy(&self) -> Object { self.registry.as_ref().and_then(Json::as_object).cloned().unwrap_or_default() }
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
			Some(id) if Some(id) != self.default_id() => match self.named_at.get(id) {
				Some(&i) => &mut self.named[i].1,
				None => &mut self.default, // not reached: the registry and the opened documents agree
			},
			_ => &mut self.default,
		}
	}

	fn keep_named(&mut self, id: String, host: SpaceHost) {
		self.named_at.insert(id.clone(), self.named.len());
		self.named.push((id, host));
	}

	/// The host of a Space for a snapshot read: the default Space even before it is registered.
	pub fn reader(&mut self, space: Option<&str>) -> std::result::Result<&mut SpaceHost, CoreError> {
		let id = space.map(|n| self.read_id(n)).transpose()?;
		if let Some(id) = id.as_deref().filter(|id| Some(*id) != self.default_id() && !self.named_at.contains_key(*id)) {
			let host = SpaceHost::open_shared(self.default.ledger.clone(), NAMED_SPACE, Some(id), system_random()).map_err(|e| error("Error", e.to_string()))?;
			self.keep_named(id.to_owned(), host);
		}
		Ok(self.host_of(id.as_deref()))
	}

	/// Runs `op` as one commit on a Space (`spaceDoc`). The first commit of a new store registers the host and the default
	/// Space with it, in the same commit: one that fails leaves no trace of either.
	pub fn commit<T>(&mut self, space: Option<&str>, now: f64, op: impl FnOnce(&mut Space) -> std::result::Result<T, CoreError>) -> Result<std::result::Result<Committed<T>, CoreError>> { self.commit_keyed(space, now, |s, _| op(s)) }

	/// `commit`, with the host key at hand (`hostKey`).
	pub fn commit_keyed<T>(&mut self, space: Option<&str>, now: f64, op: impl FnOnce(&mut Space, &str) -> std::result::Result<T, CoreError>) -> Result<std::result::Result<Committed<T>, CoreError>> {
		let id = match self.commit_id(space) {
			Ok(id) => id,
			Err(e) => return Ok(Err(e)),
		};
		if let (Some(_), Some(key)) = (self.default_id(), self.host_key().map(str::to_owned)) {
			let registry = self.registry_copy();
			let renamed = std::cell::RefCell::new(None);
			let done = self.host_of(id.as_deref()).start_commit(|s| {
				s.clock = now;
				let out = op(s, &key)?;
				// a restore gave the Space a new incarnation: the registry names it in the same commit (src/recovery-controller.ts)
				if let (Some(inc), Some(id)) = (s.registry_incarnation.take(), s.state.space_id.clone()) {
					let mut r = registry;
					if let Some(Json::Object(info)) = r.get_mut("spaces").and_then(|m| m.as_object_mut()).and_then(|m| m.get_mut(&id)) {
						info.insert("incarnation", inc.into());
					}
					let r = Json::Object(r);
					s.doc_writes.push((REGISTRY.into(), String::new(), REGISTRY_VERSION, r.to_json_text()));
					*renamed.borrow_mut() = Some(r);
				}
				Ok(out)
			})?;
			if let (Ok(_), Some(r)) = (&done, renamed.into_inner()) {
				self.registry = Some(r);
			}
			return Ok(done);
		}
		let host_id = format!("host-{}", random_uuid(&mut self.random));
		let host_key = match self.host_key().map(str::to_owned) {
			Some(k) => k,
			None => hex(&(self.random)(32)),
		};
				let state = &self.default.space.state;
		let space_id = state.space_id.clone().unwrap_or_else(|| format!("sp-{}", random_uuid(&mut self.random)));
		let incarnation = state.incarnation.clone().unwrap_or_else(|| hex(&(self.random)(4)));
		let info = obj! { "spaceId" => space_id.as_str(), "alias" => DEFAULT_ALIAS, "incarnation" => incarnation.as_str(), "createdAt" => now };
		let mut r = self.registry_copy();
		for (k, v) in [("hostId", Json::from(host_id.as_str())), ("defaultSpaceId", Json::Null), ("spaces", Json::Object(Object::new())), ("aliases", Json::Object(Object::new())), ("hostKey", Json::from(host_key.as_str()))] {
			if r.get(k).is_none_or(|old| k == "defaultSpaceId" && old.is_null()) {
				r.insert(k, v);
			}
		}
		if self.default_id().is_none() {
			r.insert("defaultSpaceId", space_id.as_str().into());
			if let Some(Json::Object(s)) = r.get_mut("spaces") {
				s.insert(&space_id, info);
			}
			if let Some(Json::Object(a)) = r.get_mut("aliases") {
				a.insert(DEFAULT_ALIAS, space_id.as_str().into());
			}
		}
		let registry = Json::Object(r);
		self.default.also.push(registry_doc(&registry));
		let new_space = self.default_id().is_none();
		let done = self.default.start_commit(|s| {
			s.clock = now;
			if new_space {
				s.touch(now);
				s.state.space_id = Some(space_id);
				s.state.incarnation = Some(incarnation);
			}
			op(s, &host_key)
		})?;
		if done.is_ok() {
			self.registry = Some(registry);
		}
		Ok(done)
	}

	/// A document of the file beside the Spaces, as last made durable (`tx.doc` of a family).
	pub fn stored_document(&self, kind: &str, key: Option<&str>) -> Result<Option<Json>> {
		Ok(match &*self.default.ledger.borrow() {
			Ledger::Sqlite(l) => l.document(kind, key)?.map(|d| d.value),
			Ledger::Memory(l) => l.load(kind, key).map(|d| d.value),
		})
	}

	/// `createSpace`: a named Space, or the one with this alias. `random` is the new document's source.
	pub fn create_space(&mut self, alias: &str, now: f64, random: Random) -> Result<std::result::Result<Json, CoreError>> { self.create_space_with(alias, now, random, |_| Ok(())) }

	/// `create_space` with `op` in the commit that makes the Space, so what it sets exists with the Space or not at all. `op`
	/// does not run for an alias that exists: the caller finds that Space in the result.
	pub fn create_space_with(&mut self, alias: &str, now: f64, random: Random, op: impl FnOnce(&mut Space) -> std::result::Result<(), CoreError>) -> Result<std::result::Result<Json, CoreError>> { self.create_space_as(alias, None, now, random, op) }

	/// `createSpace` with `{spaceId, incarnation}` given (`identity`): a Space whose identity comes from elsewhere, such as a
	/// primary/sync Space, whose replicas all hold the same one.
	pub fn create_space_as(&mut self, alias: &str, identity: Option<(&str, &str)>, now: f64, random: Random, op: impl FnOnce(&mut Space) -> std::result::Result<(), CoreError>) -> Result<std::result::Result<Json, CoreError>> {
		let fine = alias.len() <= 64 && alias.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit()) && alias.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || ".-_".contains(c));
		if !fine {
			return Ok(Err(error("IllegalArgumentError", "alias: 1-64 of a-z 0-9 . _ - (starting with a letter or digit)")));
		}
		let hex_of = |t: &str, n: usize| t.len() == n && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
		let uuid = |t: &str| t.strip_prefix("sp-").is_some_and(|u| { let p: Vec<&str> = u.split('-').collect(); p.len() == 5 && [8, 4, 4, 4, 12].iter().zip(&p).all(|(n, x)| hex_of(x, *n)) });
		if let Some((id, incarnation)) = identity {
			if !uuid(id) || !hex_of(incarnation, 8) {
				return Ok(Err(error("IllegalArgumentError", "a fixed Space identity needs an sp-<uuid> ID and an 8-hex incarnation")));
			}
		}
		if let Some(id) = self.registry.as_ref().and_then(|r| r.get("aliases")?.get(alias)?.as_str()) {
			let info = self.registry.as_ref().and_then(|r| r.get("spaces")?.get(id)).cloned().unwrap_or(Json::Null);
			if identity.is_some_and(|(fixed, incarnation)| fixed != id || info.get("incarnation").and_then(Json::as_str) != Some(incarnation)) {
				return Ok(Err(error("IllegalArgumentError", "alias names another Space identity")));
			}
			return Ok(Ok(info));
		}
		if let Some((id, _)) = identity {
			if self.registry.as_ref().and_then(|r| r.get("spaces")?.get(id)).is_some() {
				return Ok(Err(error("IllegalArgumentError", "Space ID already registered under another alias")));
			}
		}
		if self.default_id().is_none() {
			if let Err(e) = self.commit(None, now, |_| Ok(()))? {
				return Ok(Err(e));
			}
		}
		let (id, incarnation) = match identity {
			Some((id, incarnation)) => (id.to_owned(), incarnation.to_owned()),
			None => (format!("sp-{}", random_uuid(&mut self.random)), hex(&(self.random)(4))),
		};
		let info = obj! { "spaceId" => id.as_str(), "alias" => alias, "incarnation" => incarnation.as_str(), "createdAt" => now };
		let mut registry = self.registry_copy();
		if let Some(Json::Object(s)) = registry.get_mut("spaces") {
			s.insert(&id, info.clone());
		}
		if let Some(Json::Object(a)) = registry.get_mut("aliases") {
			a.insert(alias, id.as_str().into());
		}
		let registry = Json::Object(registry);
		let mut host = SpaceHost::open_shared(self.default.ledger.clone(), NAMED_SPACE, Some(&id), random)?;
		host.also.push(registry_doc(&registry));
		let (space, carried) = (id.clone(), incarnation);
		let done = host.start_commit(|s| {
			s.clock = now;
			s.touch(now);
			s.state.space_id = Some(space);
			s.state.incarnation = Some(carried);
			op(s)
		})?;
		Ok(match done {
			Err(e) => Err(e),
			Ok(_) => {
				self.registry = Some(registry);
				self.keep_named(id, host);
				Ok(info)
			}
		})
	}

	/// The delete step of a Space's lifecycle: `op` decides in the commit that takes the alias, the id stays reserved in the
	/// registry and the document stays in the file.
	pub fn delete_space<T>(&mut self, id: &str, now: f64, op: impl FnOnce(&mut Space) -> std::result::Result<T, CoreError>) -> Result<std::result::Result<Committed<T>, CoreError>> {
		let mut registry = self.registry_copy();
		let Some(mut info) = registry.get("spaces").and_then(|s| s.get(id)).and_then(Json::as_object).cloned().filter(|i| i.get("deletedAt").is_none()) else { return Ok(Err(unknown(id))) };
		info.insert("deletedAt", now.into());
		if let (Some(Json::Object(a)), Some(alias)) = (registry.get_mut("aliases"), info.get("alias").and_then(Json::as_str)) {
			a.remove(alias);
		}
		if let Some(Json::Object(s)) = registry.get_mut("spaces") {
			s.insert(id, Json::Object(info));
		}
		let registry = Json::Object(registry);
		let host = self.host_of(Some(id));
		host.also.push(registry_doc(&registry));
		let done = host.start_commit(|s| {
			s.clock = now;
			op(s)
		})?;
		if done.is_ok() {
			self.registry = Some(registry);
		}
		Ok(done)
	}

	/// Commits handed to the store, and those durable. The writer works in the order they were handed over, so `durable()`
	/// reaching a count of `handed()` means all of those are on the disk, whichever Space they were of.
	pub fn handed(&self) -> u64 { self.default.handed_count() + self.named.iter().map(|(_, h)| h.handed_count()).sum::<u64>() }
	pub fn durable(&self) -> u64 { self.default.durable_count() + self.named.iter().map(|(_, h)| h.durable_count()).sum::<u64>() }
	/// The live Space with this alias or id.
	pub fn space_info(&self, name: &str) -> Option<&Json> {
		let r = self.registry.as_ref()?;
		let spaces = r.get("spaces")?;
		let id = r.get("aliases").and_then(|a| a.get(name)).and_then(Json::as_str).unwrap_or(name);
		spaces.get(id).filter(|i| i.get("deletedAt").is_none())
	}
	/// The registered Spaces in `listSpaces` order: the default first, then by creation; deleted ones are left out.
	pub fn spaces(&self) -> Vec<Json> {
		let Some(r) = &self.registry else { return vec![] };
		let def = self.default_id();
		let mut all: Vec<&Json> = r.get("spaces").and_then(Json::as_object).map_or(vec![], |s| s.iter().map(|(_, i)| i).filter(|i| i.get("deletedAt").is_none()).collect());
		let id = |i: &Json| i.get("spaceId").and_then(Json::as_str).map(str::to_owned);
		let created = |i: &Json| i.get("createdAt").and_then(Json::as_f64).unwrap_or(0.0);
		all.sort_by(|a, b| {
			let (x, y) = (id(a).as_deref() == def, id(b).as_deref() == def);
			y.cmp(&x).then(created(a).total_cmp(&created(b)))
		});
		all.into_iter().cloned().collect()
	}

	/// `SpaceHost::compact_begin`: the file is one, whichever Space asks.
	pub fn compact_begin(&self) -> Option<std::sync::mpsc::Receiver<crate::writer::Compaction>> { self.default.compact_begin() }
	/// The ids of the named Spaces that were not deleted.
	pub fn named_ids(&self) -> Vec<String> {
		let live = |id: &str| self.registry.as_ref().and_then(|r| r.get("spaces")?.get(id)).is_some_and(|i| i.get("deletedAt").is_none());
		self.named.iter().map(|(id, _)| id.clone()).filter(|id| live(id)).collect()
	}
	/// `waker` runs on the writer's thread when commits have become durable; a store in memory has none, its commits
	/// are durable at once.
	pub fn set_waker(&self, waker: Waker) {
		self.default.set_waker(waker);
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
