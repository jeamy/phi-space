//! The control primary's durable receipt for a data transition the register holds (src/control-ack.ts), behind the
//! signed private endpoint: given only while this host is the independently active authority, the transition, the
//! target's permit and the source's fence agree, and kept in the control Space's store once.
use crate::control::{listed, CONTROL_SPACE};
use crate::recovery_rpc::{blocked, RecoveryError, RR};
use crate::recovery_store::StoreLine;
use crate::register::Register;
use phi_core::space::bytes;
use phi_json::{obj, text, Json, Object};
use std::rc::Rc;

pub const RECEIPTS: &str = "phi-spaces.control-recovery-receipts";
const ROUTING: &str = "phi-spaces.federation-routing";
const TUPLE: [&str; 6] = ["recoveryId", "incarnation", "primaryEpoch", "targetHostId", "argsHash", "authorityId"];

fn version(r: &Json) -> Option<f64> { r.get("version").and_then(Json::as_f64) }
fn value(r: &Json) -> Json { r.get("value").cloned().unwrap_or(Json::Null) }
fn fields(e: &Json) -> Json { e.get("fields").cloned().unwrap_or(Json::Null) }
fn has(list: Option<&Json>, v: &str) -> bool { list.and_then(Json::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(v))) }

pub struct ControlAck {
	pub store: StoreLine,
	pub register: Rc<dyn Register>,
	pub host_id: String,
	pub authority_id: String,
	pub control_space_id: String,
}

impl ControlAck {
	/// The key of the control Space's directory for `peer`/`key_id`, from its last durable state.
	fn directory_key(&self, peer: &str, key_id: &str) -> Option<Json> {
		let now = self.store.now();
		self.store.with(|s| {
			let host = s.store.reader(Some(CONTROL_SPACE)).ok()?;
			listed(&host.space, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer, "keyId" => key_id } }).ok()?.first().map(fields)
		})
	}

	/// `hostKey`: the register's record of the key a target host signs `controlAck` with, if the register and the control
	/// Space both hold it active.
	pub async fn host_key(&self, args: &Json) -> RR<Option<Json>> {
		let Some(target) = text(args, "targetHostId") else { return Ok(None) };
		let key = self.register.get(&format!("host-key:{target}")).await?;
		let k = value(&key);
		let (Some(peer), Some(key_id)) = (text(&k, "peerId"), text(&k, "keyId")) else { return Ok(None) };
		let Some(app) = self.directory_key(peer, key_id) else { return Ok(None) };
		let fine = text(&app, "state") == Some("active") && has(app.get("roles"), "host") && app.get("algorithm") == k.get("algorithm") && app.get("publicKey") == k.get("publicKey") && text(&k, "state") == Some("active") && text(&k, "authorityId") == Some(self.authority_id.as_str()) && matches!(text(&k, "algorithm"), Some("ed25519" | "ecdsa-p256")) && text(&k, "publicKey").is_some();
		Ok(if fine { Some(k) } else { None })
	}

	/// `acknowledge`: the receipt for `args`; a host's call (`require_host_key`) also needs its key still authorized.
	pub async fn acknowledge(&self, args: &Json, require_host_key: bool) -> RR<Json> {
		let short = |k: &str| text(args, k).is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 512);
		let epoch = args.get("primaryEpoch").and_then(Json::as_f64).filter(|n| phi_json::safe_integer(*n) && *n >= 1.0);
		if !["recoveryId", "space", "incarnation", "authorityId", "targetHostId", "argsHash"].iter().all(|k| short(k)) || epoch.is_none() || text(args, "authorityId") != Some(self.authority_id.as_str()) {
			return Err(blocked("invalid control acknowledgement tuple"));
		}
		let (space, target_host) = (text(args, "space").expect("checked"), text(args, "targetHostId").expect("checked"));
		let authority = self.register.get(&format!("authority:{}", self.control_space_id)).await?;
		let transition = self.register.get(&format!("data-transition:{space}")).await?;
		let target = self.register.get(&format!("boot:{target_host}")).await?;
		let a = value(&authority);
		if authority.is_null() || text(&a, "state") != Some("active") || text(&a, "hostId") != Some(self.host_id.as_str()) || text(&a, "authorityId") != Some(self.authority_id.as_str()) {
			return Err(blocked("control is not the independently active authority"));
		}
		let t = value(&transition);
		if transition.is_null() || !matches!(text(&t, "state"), Some("restoring" | "completed")) || TUPLE.iter().any(|k| t.get(k) != args.get(k)) {
			return Err(blocked("control receipt disagrees with the independent data transition"));
		}
		let tb = value(&target);
		let permit = tb.get("spaces").and_then(|s| s.get(space)).cloned().unwrap_or(Json::Null);
		let revoked = text(&permit, "state") == Some("revoked") && permit.get("dataIncarnation") == t.get("expectedDataIncarnation");
		let active = text(&permit, "state") == Some("active") && permit.get("dataIncarnation") == args.get("incarnation") && permit.get("primaryEpoch") == args.get("primaryEpoch") && permit.get("transitionId") == args.get("recoveryId");
		if target.is_null() || text(&tb, "state") != Some("active") || permit.is_null() || permit.get("authorityId") != args.get("authorityId") || !(revoked || active) {
			return Err(blocked("target boot permission disagrees with recovery"));
		}
		let source_host = text(&t, "sourceHostId").unwrap_or("").to_owned();
		let source = self.register.get(&format!("boot:{source_host}")).await?;
		if source.is_null() || text(&value(&source), "state") != Some("fenced") {
			return Err(blocked("source host is not independently fenced"));
		}
		let host_key = if require_host_key { Some(self.register.get(&format!("host-key:{target_host}")).await?) } else { None };
		if let Some(k) = &host_key {
			let v = value(k);
			if k.is_null() || text(&v, "state") != Some("active") || text(&v, "authorityId") != Some(self.authority_id.as_str()) {
				return Err(blocked("target host key is no longer independently authorized"));
			}
		}
		let routing = self.store.document(ROUTING, Some(&self.control_space_id))?;
		let managed = routing.as_ref().and_then(|r| r.get("members")).and_then(Json::as_object).is_some_and(|m| m.iter().any(|(_, m)| m.get("target").and_then(|t| t.get("spaceId")).and_then(Json::as_str) == Some(space)));
		if managed {
			return Err(blocked("managed Data restore requires Router/parent reconciliation before acknowledgement"));
		}
		if let Some(k) = &host_key {
			let v = value(k);
			let app = self.directory_key(text(&v, "peerId").unwrap_or(""), text(&v, "keyId").unwrap_or(""));
			let fine = app.as_ref().is_some_and(|f| text(f, "state") == Some("active") && has(f.get("roles"), "host") && f.get("algorithm") == v.get("algorithm") && f.get("publicKey") == v.get("publicKey"));
			if !fine || version(&self.register.get(&format!("host-key:{target_host}")).await?) != version(k) {
				return Err(blocked("target host key changed before control receipt commit"));
			}
		}
		// the records are read again right before the commit, which runs at once: nothing changes between the two
		let unchanged = version(&self.register.get(&format!("authority:{}", self.control_space_id)).await?) == version(&authority)
			&& version(&self.register.get(&format!("data-transition:{space}")).await?) == version(&transition)
			&& version(&self.register.get(&format!("boot:{target_host}")).await?) == version(&target)
			&& version(&self.register.get(&format!("boot:{source_host}")).await?) == version(&source);
		if !unchanged {
			return Err(blocked("recovery authorization changed before control receipt commit"));
		}
		let doc = self.store.document(RECEIPTS, None)?.unwrap_or_else(|| obj! { "receipts" => Object::new() });
		let id = text(args, "recoveryId").expect("checked").to_owned();
		let now = self.store.now();
		self.store
			.commit(Some(&self.control_space_id), now, |s| {
				if !s.maintenance_step(bytes(args) + 512.0, now, "control-recovery-ack") {
					return Err(blocked("control receipt exceeds commit budget"));
				}
				let mut receipts = doc.get("receipts").and_then(Json::as_object).cloned().unwrap_or_default();
				if let Some(existing) = receipts.get(&id) {
					if existing.canonical().ok() != args.canonical().ok() {
						return Err(RecoveryError::Conflict("recovery receipt identity has different arguments".into()));
					}
					return Ok(existing.clone());
				}
				receipts.insert(&id, args.clone());
				let mut next = doc.as_object().cloned().unwrap_or_default();
				next.insert("receipts", Json::Object(receipts));
				s.doc_writes.push((RECEIPTS.to_owned(), String::new(), 1, Json::Object(next).to_json_text()));
				Ok(args.clone())
			})
			.await
	}
}
