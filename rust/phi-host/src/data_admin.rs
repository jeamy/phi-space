//! Trusted local admin effects (src/data-admin.ts): `purgeTasks` and the erasure of a principal's data in a Space of this
//! host's own store, audited in the journal `phi-spaces.data-admin` (a document per Space, `{commands}`). Every commit
//! writes the Space and its journal together; a deletion fences the Space (`adminMaintenance`) and goes on one bounded
//! batch per commit (`phi_core::admin`), so a crash resumes it and an old snapshot of the Space no longer reads.
use phi_core::space::{error, exhausted, illegal, CoreError, Space, Template};
use phi_json::{digest_json, obj, text, Json, Object};
use phi_service::Service;

type R<T> = Result<T, CoreError>;
pub const JOURNAL: &str = "phi-spaces.data-admin";
const JOURNAL_VERSION: i64 = 1;
const MAX_COMMANDS: usize = 128;
const KINDS: [&str; 2] = ["purgeTasks", "deletePrincipal"];
/// Properties every JavaScript object inherits whose names pass the id pattern: `d.commands[id]` finds a function there,
/// so TypeScript answers such an id as one used for another command.
const INHERITED: [&str; 6] = ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];

/// `authorize(admin, scope, spaceId)`: the separate admin scope.
pub type Authorize = Box<dyn Fn(&str, &str, &str) -> R<()>>;
/// `assertAuthority`: asked inside the commits too, so it cannot borrow the service.
pub type AuthorityCheck = Box<dyn Fn() -> R<()>>;

fn units(t: &str) -> usize { t.encode_utf16().count() }
fn valid_id(id: &str) -> bool { phi_json::ID_128.accepts(id) }

/// `commandHash`: the hash of what a command does; its id and identifiers checked first.
pub fn command_hash(id: &str, kind: &str, space_id: &str, admin: &str, input: &Json) -> R<String> {
	if !valid_id(id) || ["__proto__", "constructor", "prototype"].contains(&id) {
		return Err(illegal("invalid admin command ID"));
	}
	if space_id.is_empty() || units(space_id) > 128 || admin.is_empty() || units(admin) > 128 {
		return Err(illegal("invalid admin or Space identifier"));
	}
	if !KINDS.contains(&kind) {
		return Err(illegal("invalid admin command kind"));
	}
	digest_json(&obj! { "kind" => kind, "spaceId" => space_id, "admin" => admin, "input" => input.clone() }).map_err(|_| illegal("a value that cannot be hashed"))
}

/// `validPrincipal` (src/mailbox.ts): a peer of at most 128 characters, an agent likewise, nothing else.
pub(crate) fn valid_principal(p: &Json) -> bool {
	let Some(o) = p.as_object() else { return false };
	let part = |v: Option<&Json>| v.and_then(Json::as_str).is_some_and(|t| !t.is_empty() && units(t) <= 128);
	part(o.get("peerId")) && (!o.contains_key("agentId") || part(o.get("agentId"))) && o.keys().all(|k| k == "peerId" || k == "agentId")
}
fn validate_principal(p: &Json) -> R<()> { if valid_principal(p) { Ok(()) } else { Err(illegal("invalid deletion principal")) } }

/// `audit`: what a command reports.
fn audit(c: &Object) -> Object {
	let mut o = Object::new();
	for k in ["hash", "at", "kind", "admin", "count"] {
		if let Some(v) = c.get(k) {
			o.insert(k, v.clone());
		}
	}
	o
}
fn with_progress(c: &Object, phase: &str, batches: f64) -> Json {
	let mut o = audit(c);
	o.insert("phase", phase.into());
	o.insert("batches", batches.into());
	Json::Object(o)
}
fn incarnation(s: &Space) -> Json { s.state.incarnation.as_deref().map_or(Json::Null, Json::from) }
/// `s.acceptedAuthorityId ?? s.membership?.authorityId ?? null`.
fn authority(s: &Space) -> Json {
	let present = |v: Option<&Json>| v.filter(|v| !v.is_null()).cloned();
	present(s.state.rest.get("acceptedAuthorityId")).or_else(|| present(s.state.rest.get("membership").and_then(|m| m.get("authorityId")))).unwrap_or(Json::Null)
}
/// `assertTuple`: a command made in another incarnation or under another authority is not answered.
fn assert_tuple(c: &Object, s: &Space) -> R<()> {
	if c.contains_key("incarnation") && (c.get("incarnation") != Some(&incarnation(s)) || c.get("authorityId") != Some(&authority(s))) {
		return Err(error("TransactionError", "deletion incarnation or authority changed; restore review required"));
	}
	Ok(())
}
/// `stableSpace`.
fn stable_space(s: &Space, id: &str) -> R<()> {
	if s.state.space_id.as_deref() != Some(id) { Err(illegal("admin commands require the immutable Space ID")) } else { Ok(()) }
}
fn phase_of(c: &Object) -> Option<&str> { c.get("phase").and_then(Json::as_str) }
fn batches_of(c: &Object) -> f64 { c.get("batches").and_then(Json::as_f64).unwrap_or(0.0) }

/// What a command id names in the journal: a command, a property every object inherits, or nothing.
enum Found {
	Command(Object),
	Inherited,
	None,
}
fn find(commands: &Object, id: &str) -> Found {
	match commands.get(id) {
		Some(c) => Found::Command(c.as_object().cloned().unwrap_or_default()),
		None if INHERITED.contains(&id) => Found::Inherited,
		None => Found::None,
	}
}

pub struct DataAdminController {
	pub authorize: Authorize,
	pub assert_authority: AuthorityCheck,
	pub now: Box<dyn Fn() -> f64>,
}

impl DataAdminController {
	fn check(&self, admin: &str, kind: &str, space_id: &str) -> R<()> {
		(self.authorize)(admin, kind, space_id)?;
		(self.assert_authority)()
	}

	/// One commit on the Space `space_id` names, with its journal: `body` gets the commands and the Space (`None`: no Space
	/// by that name, `spaceDoc` refuses where it is asked for) and says whether it changed the commands.
	fn commit<T>(&self, service: &mut Service, space_id: &str, body: impl FnOnce(&mut Object, Option<&mut Space>) -> R<(T, bool)>) -> R<T> {
		let stored = service.store.stored_document(JOURNAL, Some(space_id)).map_err(|e| error("Unavailable", e.to_string()))?;
		let mut commands = stored.as_ref().and_then(|d| d.get("commands")).and_then(Json::as_object).cloned().unwrap_or_default();
		if service.store.space_info(space_id).is_none() {
			return body(&mut commands, None).map(|(t, _)| t);
		}
		let key = space_id.to_owned();
		let done = service.commit_on(Some(space_id), |s, _| {
			let (t, changed) = body(&mut commands, Some(&mut *s))?;
			if changed {
				let doc = obj! { "commands" => Json::Object(commands) };
				s.doc_writes.push((JOURNAL.to_owned(), key, JOURNAL_VERSION, doc.to_json_text()));
			}
			Ok(t)
		})?;
		service.store.drain().map_err(|e| error("Unavailable", e.to_string()))?;
		Ok(done)
	}

	/// `execute`: a purge in one commit, a principal deletion through all of its batches; the audit of the command.
	pub fn execute(&self, service: &mut Service, id: &str, kind: &str, space_id: &str, admin: &str, input: &Json) -> R<Json> {
		let hash = command_hash(id, kind, space_id, admin, input)?;
		if kind == "deletePrincipal" {
			self.start_deletion(service, id, space_id, admin, input)?;
			loop {
				let r = self.advance_deletion(service, id, space_id, admin, input)?;
				if text(&r, "phase") == Some("completed") {
					return Ok(Json::Object(audit(r.as_object().expect("an object"))));
				}
			}
		}
		self.check(admin, kind, space_id)?;
		self.commit(service, space_id, |commands, s| {
			self.check(admin, kind, space_id)?;
			match find(commands, id) {
				Found::Command(old) => {
					if text_of(&old, "hash") != Some(hash.as_str()) {
						return Err(illegal("admin command ID changed"));
					}
					let s = space_doc(s, space_id)?;
					stable_space(s, space_id)?;
					assert_tuple(&old, s)?;
					return Ok((Json::Object(audit(&old)), false));
				}
				Found::Inherited => return Err(illegal("admin command ID changed")),
				Found::None => {}
			}
			if commands.len() >= MAX_COMMANDS {
				return Err(exhausted("admin journal is full"));
			}
			let now = (self.now)();
			let s = space_doc(s, space_id)?;
			stable_space(s, space_id)?;
			s.assert_admin_idle()?;
			s.reserve_admin_header(now, id)?;
			let tmpl = Template::from_json(Some(input))?;
			let count = s.purge_tasks(now, &tmpl)?;
			let c = obj! { "hash" => hash.as_str(), "kind" => kind, "admin" => admin, "at" => now, "count" => count, "incarnation" => incarnation(s), "authorityId" => authority(s) };
			let c = c.as_object().cloned().expect("an object");
			let out = Json::Object(audit(&c));
			commands.insert(id, Json::Object(c));
			self.check(admin, kind, space_id)?;
			Ok((out, true))
		})
	}

	/// `startDeletion`: fences the Space for the deletion of `p` (the same command again answers where it is).
	pub fn start_deletion(&self, service: &mut Service, id: &str, space_id: &str, admin: &str, p: &Json) -> R<Json> {
		validate_principal(p)?;
		let hash = command_hash(id, "deletePrincipal", space_id, admin, p)?;
		let kind = "deletePrincipal";
		self.check(admin, kind, space_id)?;
		self.commit(service, space_id, |commands, s| {
			self.check(admin, kind, space_id)?;
			match find(commands, id) {
				Found::Command(old) => {
					if text_of(&old, "hash") != Some(hash.as_str()) {
						return Err(illegal("admin command ID changed"));
					}
					let s = space_doc(s, space_id)?;
					stable_space(s, space_id)?;
					assert_tuple(&old, s)?;
					return Ok((with_progress(&old, phase_of(&old).unwrap_or("completed"), batches_of(&old)), false));
				}
				Found::Inherited => return Err(illegal("admin command ID changed")),
				Found::None => {}
			}
			if commands.len() >= MAX_COMMANDS {
				return Err(exhausted("admin journal is full"));
			}
			let now = (self.now)();
			let s = space_doc(s, space_id)?;
			stable_space(s, space_id)?;
			s.assert_admin_idle()?;
			s.settle(now)?;
			s.assert_quiescent()?;
			s.reserve_admin_header(now, id)?;
			s.state.rest.insert("adminMaintenance", obj! { "commandId" => id, "hash" => hash.as_str() });
			let epoch = s.state.rest.get("snapshotEpoch").and_then(Json::as_f64).unwrap_or(0.0);
			s.state.rest.insert("snapshotEpoch", Json::Number(epoch + 1.0));
			if s.doc_bytes() > s.limits().max_doc_bytes {
				return Err(exhausted("admin fence exceeds maxDocBytes"));
			}
			let c = obj! { "hash" => hash.as_str(), "kind" => kind, "admin" => admin, "at" => now, "count" => 0.0, "phase" => "registrations", "principal" => p.clone(), "incarnation" => incarnation(s), "authorityId" => authority(s), "batches" => 0.0 };
			let c = c.as_object().cloned().expect("an object");
			s.touch(now);
			let out = with_progress(&c, "registrations", 0.0);
			commands.insert(id, Json::Object(c));
			self.check(admin, kind, space_id)?;
			Ok((out, true))
		})
	}

	/// `advanceDeletion`: one bounded batch of the deletion; the fence lifts with the last one.
	pub fn advance_deletion(&self, service: &mut Service, id: &str, space_id: &str, admin: &str, p: &Json) -> R<Json> {
		validate_principal(p)?;
		let hash = command_hash(id, "deletePrincipal", space_id, admin, p)?;
		let kind = "deletePrincipal";
		self.check(admin, kind, space_id)?;
		self.commit(service, space_id, |commands, s| {
			self.check(admin, kind, space_id)?;
			let mut c = match find(commands, id) {
				Found::Command(c) => c,
				Found::Inherited => return Err(illegal("admin command ID changed")),
				Found::None => return Err(illegal("unknown deletion command")),
			};
			if text_of(&c, "hash") != Some(hash.as_str()) {
				return Err(illegal("admin command ID changed"));
			}
			let now = (self.now)();
			let s = space_doc(s, space_id)?;
			stable_space(s, space_id)?;
			assert_tuple(&c, s)?;
			if phase_of(&c).is_none_or(|ph| ph == "completed" || ph.is_empty()) {
				return Ok((with_progress(&c, "completed", batches_of(&c)), false));
			}
			let fence = s.state.rest.get("adminMaintenance");
			let fenced = fence.and_then(|f| f.get("commandId")).and_then(Json::as_str) == Some(id) && fence.and_then(|f| f.get("hash")).and_then(Json::as_str) == Some(hash.as_str());
			if !fenced || c.get("incarnation") != Some(&incarnation(s)) || c.get("authorityId") != Some(&authority(s)) {
				return Err(error("TransactionError", "deletion fence or incarnation changed; restore review required"));
			}
			s.assert_quiescent()?;
			s.reserve_admin_header(now, id)?;
			s.erase_batch(&mut c, p, now, id)?;
			let batches = batches_of(&c) + 1.0;
			c.insert("batches", batches.into());
			let phase = phase_of(&c).unwrap_or("").to_owned();
			if phase == "completed" {
				c.remove("principal");
				s.state.rest.remove("adminMaintenance");
				s.state.rest.remove("maintenance");
				let epoch = s.state.rest.get("snapshotEpoch").and_then(Json::as_f64).unwrap_or(0.0);
				s.state.rest.insert("snapshotEpoch", Json::Number(epoch + 1.0));
			}
			s.touch(now);
			self.check(admin, kind, space_id)?;
			let out = with_progress(&c, &phase, batches);
			commands.insert(id, Json::Object(c));
			Ok((out, true))
		})
	}
}

fn text_of<'a>(c: &'a Object, k: &str) -> Option<&'a str> { c.get(k).and_then(Json::as_str) }
/// `spaceDoc`: the Space, or `UnknownSpaceError` where TypeScript resolves it.
fn space_doc<'a>(s: Option<&'a mut Space>, space: &str) -> R<&'a mut Space> { s.ok_or_else(|| error("UnknownSpaceError", format!("unknown space: {space}"))) }
