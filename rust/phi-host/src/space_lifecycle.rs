//! The host side of Space lifecycle (src/space-lifecycle.ts): idempotent creation, archiving and checked deletion of named Spaces
//! on this host, per signed instruction of the control host. Each step is one commit with its line in the journal, so a
//! repeated command gets the result it got before. The admin commands of the control side stay in TypeScript (R6).
use phi_json::text;
use phi_core::space::{illegal, permission as denied, conflict};
use crate::auth::{seal, verify_value, Signer};
use crate::control::held_document;
use crate::control::CONTROL_SPACE;
use crate::run_member::{AuthorityCheck, Pin};
use phi_core::space::{error, CoreError, Space};
use phi_json::{digest_json, obj, Json, Object};
use phi_service::Service;
use phi_store::{system_random, DEFAULT_ALIAS};
use std::cell::RefCell;

type R<T> = Result<T, CoreError>;
const JOURNAL: &str = "phi-spaces.space-lifecycle";
const MAX_COMMANDS: usize = 4096;
fn in_use(m: impl Into<String>) -> CoreError { error("TransactionError", m) }
/// JavaScript's truth, for an optional field an instruction may send empty.
fn given<'a>(q: &'a Json, k: &str) -> Option<&'a Json> {
	q.get(k).filter(|v| !matches!(v, Json::Null | Json::Bool(false)) && v.as_f64() != Some(0.0) && v.as_str() != Some(""))
}
fn canonical(v: &Json) -> R<String> { v.canonical().map_err(|_| illegal("a value that cannot be hashed")) }
fn valid_id(id: &str) -> bool {
	let mut c = id.chars();
	c.next().is_some_and(|f| f.is_ascii_alphanumeric()) && id.chars().count() <= 96 && c.all(|x| x.is_ascii_alphanumeric() || "._:-".contains(x))
}

/// `verifyLifecycle`.
fn verify_lifecycle(kind: &str, t: &Json, pin: &Pin) -> R<Json> {
	verify_value(t, &format!("space-lifecycle-{kind}"), &pin.issuer, pin.algorithm, &pin.public_key)
		.cloned().ok_or_else(|| denied(format!("invalid Space lifecycle {kind} signature")))
}

/// `signLifecycle`.
fn sign_lifecycle(kind: &str, value: Json, issuer: &str, signer: &Signer) -> R<Json> {
	seal("value", value, &format!("space-lifecycle-{kind}"), issuer, signer).ok_or_else(|| illegal("a value that cannot be hashed"))
}

/// `why`: what still holds a Space that is to be deleted.
fn holds(s: &Space) -> Option<String> {
	let state = &s.state;
	if let Some(m) = state.rest.get("membership").filter(|m| text(m, "state") != Some("detached")) {
		return Some(format!("it is a federation Member ({}); removeMember first", text(m, "state").unwrap_or("undefined")));
	}
	if !state.entries.is_empty() {
		return Some(format!("it still holds {} entries; export and purge them first", state.entries.len()));
	}
	let rest_of = |k: &str| state.rest.get(k).and_then(Json::as_array).is_some_and(|a| !a.is_empty());
	if !state.txns.is_empty() || !state.waiters.is_empty() || !state.regs.is_empty() || rest_of("jobs") || rest_of("releaseQueue") {
		return Some("it still has open transactions, waits, registrations or follow-up work".into());
	}
	if state.rpc.as_ref().is_some_and(|r| r.claims.any()) {
		return Some("it retains request claims until their results expire".into());
	}
	if state.mailboxes.iter().flatten().any(|(_, b)| !b.events.is_empty()) {
		return Some("mailboxes still hold undelivered results".into());
	}
	if s.state.rest.get("runGates").and_then(Json::as_object).is_some_and(|g| g.iter().any(|(_, g)| text(g, "state") != Some("stopped") || g.get("recovery").is_some())) {
		return Some("a run on it is not stopped".into());
	}
	None
}

/// `reason` of archive: less than deletion asks.
fn archive_holds(s: &Space) -> Option<String> {
	if let Some(m) = s.state.rest.get("membership").filter(|m| text(m, "state") != Some("detached")) {
		return Some(format!("it is a federation Member ({}); removeMember first", text(m, "state").unwrap_or("undefined")));
	}
	if !s.state.txns.is_empty() {
		return Some("it has open transactions".into());
	}
	s.state.rest.get("runGates").and_then(Json::as_object).filter(|g| g.iter().any(|(_, g)| text(g, "state") != Some("stopped"))).map(|_| "a run on it is not stopped".into())
}

/// One per host: `SpaceLifecycle` and `SpaceLifecycleService` of TypeScript.
pub struct SpaceLifecycleService {
	host_id: String,
	authority_id: String,
	peer_id: String,
	signer: Signer,
	control: Pin,
	assert_authority: AuthorityCheck,
	/// The journal: what the file says, and what this process added since.
	journal: RefCell<Option<Object>>,
}

impl SpaceLifecycleService {
	pub fn new(host_id: &str, authority_id: &str, peer_id: &str, signer: Signer, control: Pin, assert_authority: AuthorityCheck) -> SpaceLifecycleService {
		SpaceLifecycleService { host_id: host_id.to_owned(), authority_id: authority_id.to_owned(), peer_id: peer_id.to_owned(), signer, control, assert_authority, journal: RefCell::new(None) }
	}

	fn commands(&self, service: &Service) -> R<Object> {
		held_document(&self.journal, &service.store, JOURNAL, None, |d| d.as_ref().and_then(|d| d.get("commands")).and_then(Json::as_object).cloned().unwrap_or_default())
	}

	/// `SpaceLifecycle.apply`.
	pub fn local(&self, service: &mut Service, q: &Json) -> R<Json> {
		let command = text(q, "commandId").unwrap_or("");
		let action = text(q, "action").unwrap_or("");
		if !valid_id(command) || !["create", "archive", "reactivate", "delete"].contains(&action) {
			return Err(illegal("invalid Space lifecycle request"));
		}
		if action == "create" {
			if text(q, "alias").is_none() {
				return Err(illegal("create needs an alias"));
			}
		} else if text(q, "spaceId").is_none() {
			return Err(illegal(format!("{action} needs a spaceId")));
		}
		let part = |k: &str| q.get(k).cloned().unwrap_or(Json::Null);
		let hash = digest_json(&obj! { "action" => action, "alias" => part("alias"), "spaceId" => part("spaceId"), "limits" => part("limits"), "profiles" => part("profiles") }).map_err(|_| illegal("a value that cannot be hashed"))?;
		let commands = self.commands(service)?;
		if let Some(old) = commands.get(command) {
			if text(old, "hash") != Some(&hash) {
				return Err(illegal("command ID was used for another lifecycle request"));
			}
			return Ok(old.get("result").cloned().unwrap_or(Json::Null));
		}
		if commands.len() >= MAX_COMMANDS {
			return Err(error("ResourceExhausted", "lifecycle journal is full"));
		}
		let line = |s: &mut Space, result: &Json| {
			let mut next = commands.clone();
			next.insert(command, obj! { "hash" => hash.as_str(), "result" => result.clone() });
			let doc = obj! { "commands" => Json::Object(next.clone()) };
			s.doc_writes.push((JOURNAL.to_owned(), String::new(), 1, doc.to_json_text()));
			next
		};
		let (result, next) = if action == "create" { self.create(service, q, command, &line)? } else { self.change(service, q, command, action, &line)? };
		*self.journal.borrow_mut() = Some(next);
		Ok(result)
	}

	fn create(&self, service: &mut Service, q: &Json, command: &str, line: &dyn Fn(&mut Space, &Json) -> Object) -> R<(Json, Object)> {
		let alias = text(q, "alias").unwrap_or("");
		let (limits, profiles) = (given(q, "limits"), given(q, "profiles"));
		let result = |info: &Json, existed: bool| {
			let mut r = Object::new();
			r.insert("commandId", command.into());
			r.insert("action", "create".into());
			r.insert("spaceId", info.get("spaceId").cloned().unwrap_or(Json::Null));
			r.insert("alias", info.get("alias").cloned().unwrap_or(Json::Null));
			r.insert("state", "active".into());
			if existed {
				r.insert("existed", true.into());
			}
			Json::Object(r)
		};
		let existing = service.store.registry().and_then(|r| r.get("aliases")?.get(alias)?.as_str()).map(str::to_owned);
		if let Some(id) = existing {
			let info = service.store.registry().and_then(|r| r.get("spaces")?.get(&id)).cloned().unwrap_or(Json::Null);
			return service.commit_on(Some(&id), |s, _| {
				if s.state.rest.get("archived").is_some() {
					return Err(conflict(format!("alias {alias} names an archived Space; reactivate it instead")));
				}
				let effective = s.limits().to_json();
				let other_limits = limits.and_then(Json::as_object).is_some_and(|l| l.iter().any(|(k, v)| effective.get(k) != Some(v)));
				let held = s.state.rest.get("completionProfiles").cloned().unwrap_or(Json::Array(vec![]));
				if other_limits || profiles.is_some_and(|p| canonical(p).ok() != canonical(&held).ok()) {
					return Err(conflict(format!("Space {alias} exists with other limits or profiles; it is reused only unchanged")));
				}
				let r = result(&info, true);
				let next = line(s, &r);
				Ok((r, next))
			});
		}
		let made = RefCell::new(None);
		service.create_space_with(alias, system_random(), |s, now| {
			if let Some(l) = limits {
				s.set_limits(now, l)?;
			}
			if let Some(p) = profiles {
				s.set_completion_profiles(now, Some(p))?;
			}
			let info = obj! { "spaceId" => s.state.space_id.clone().unwrap_or_default(), "alias" => alias };
			let r = result(&info, false);
			*made.borrow_mut() = Some((r.clone(), line(s, &r)));
			Ok(())
		})?;
		Ok(made.into_inner().expect("the alias was free, so the commit ran"))
	}

	fn change(&self, service: &mut Service, q: &Json, command: &str, action: &str, line: &dyn Fn(&mut Space, &Json) -> Object) -> R<(Json, Object)> {
		let id = text(q, "spaceId").unwrap_or("").to_owned();
		let registry = service.store.registry().cloned().unwrap_or(Json::Null);
		let Some(info) = registry.get("spaces").and_then(|s| s.get(&id)).filter(|i| i.get("deletedAt").is_none()) else { return Err(illegal(format!("no Space {id} on this host"))) };
		let alias = text(info, "alias").unwrap_or("");
		if text(&registry, "defaultSpaceId") == Some(&id) || alias == DEFAULT_ALIAS || alias == CONTROL_SPACE {
			return Err(denied("the default and the control Space have no lifecycle"));
		}
		let result = |state: &str| obj! { "commandId" => command, "action" => action, "spaceId" => id.as_str(), "alias" => alias, "state" => state };
		if action == "delete" {
			return service.delete_space(&id, |s, now| {
				s.settle(now)?;
				if s.state.rest.get("archived").is_none() {
					return Err(in_use("cannot delete: archive the Space first"));
				}
				if let Some(reason) = holds(s) {
					return Err(in_use(format!("cannot delete: {reason}")));
				}
				let r = result("deleted");
				let next = line(s, &r);
				Ok((r, next))
			});
		}
		service.commit_on(Some(&id), |s, now| {
			s.settle(now)?;
			let archived = s.state.rest.get("archived").is_some();
			let r = if action == "archive" {
				if !archived {
					if let Some(reason) = archive_holds(s) {
						return Err(in_use(format!("cannot archive: {reason}")));
					}
					s.state.rest.insert("archived", obj! { "at" => now, "commandId" => command });
					s.touch(now);
				}
				result("archived")
			} else {
				if archived {
					s.state.rest.remove("archived");
					s.touch(now);
				}
				result("active")
			};
			let next = line(s, &r);
			Ok((r, next))
		})
	}

	/// `SpaceLifecycleService.apply`: the control signature and the binding, the effect here, the signed result.
	pub fn apply(&self, service: &mut Service, t: &Json) -> R<Json> {
		let q = verify_lifecycle("instruction", t, &self.control)?;
		if text(&q, "authorityId") != Some(&self.authority_id) || text(&q, "hostId") != Some(&self.host_id) {
			return Err(denied("Space lifecycle instruction belongs to another authority or host"));
		}
		(self.assert_authority)(service)?;
		let result = self.local(service, &q)?;
		(self.assert_authority)(service)?;
		sign_lifecycle("result", result, &self.peer_id, &self.signer)
	}
}
