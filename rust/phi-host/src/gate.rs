//! The space gate (src/gate.ts): a TCP front that listens on the overlay address only and decides who may talk to it from
//! the NetBird management API. The source address names the peer, its groups give the roles, and privileged roles wait for
//! a proof of layer B (`auth`). Answers of the API are cached for at most 60 s; open connections are checked again on each
//! refresh.
use crate::auth::{AuthState, KeyDirectory, PeerKey, Proving};
use crate::control::{Control, Enrolling};
use phi_json::{obj, parse_repairing, Json};
use phi_service::{Conn, Identity, Service};
use phi_wire::{Front, Local, Owner, Session};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::net::IpAddr;
use std::rc::Rc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{watch, Notify};
use tokio::task::spawn_local;
use tokio::time::{sleep, timeout};

pub type Now = Rc<dyn Fn() -> f64>;
type Fetched = watch::Receiver<Option<Result<(), String>>>;

#[derive(Clone, Debug)]
pub struct PeerInfo {
	pub id: String,
	pub name: String,
	pub ip: String,
	pub groups: Vec<String>,
}

fn bare(ip: &str) -> &str { ip.strip_prefix("::ffff:").or_else(|| ip.strip_prefix("::FFFF:")).unwrap_or(ip) }

/// Layer A against the management API: `GET /api/peers`, cached as a whole.
pub struct Netbird {
	url: String,
	token: String,
	cache_ms: f64,
	timeout_ms: u64,
	now: Now,
	by_ip: RefCell<HashMap<String, PeerInfo>>,
	fetched_at: Cell<f64>,
	/// One request at a time; it outlives the caller that started it.
	inflight: RefCell<Option<Fetched>>,
	pub requests: Cell<u64>,
}

impl Netbird {
	pub fn new(url: &str, token: &str, cache_ms: Option<f64>, now: Now) -> Result<Rc<Netbird>, String> {
		let cache_ms = cache_ms.unwrap_or(60_000.0).min(60_000.0);
		if cache_ms.is_nan() || cache_ms < 1.0 {
			return Err("cacheMs must be between 1 and 60000".to_owned());
		}
		Ok(Rc::new(Netbird { url: url.trim_end_matches('/').to_owned(), token: token.to_owned(), cache_ms, timeout_ms: 4_000, now, by_ip: RefCell::default(), fetched_at: Cell::new(f64::NEG_INFINITY), inflight: RefCell::default(), requests: Cell::new(0) }))
	}

	pub fn cache_ms(&self) -> f64 { self.cache_ms }

	/// A fresh list now.
	pub async fn refresh(self: &Rc<Self>) -> Result<(), String> {
		let running = self.inflight.borrow().clone();
		let mut done = running.unwrap_or_else(|| {
			let (tell, done) = watch::channel(None);
			*self.inflight.borrow_mut() = Some(done.clone());
			self.requests.set(self.requests.get() + 1);
			let me = Rc::clone(self);
			spawn_local(async move {
				let r = me.fetch().await;
				*me.inflight.borrow_mut() = None;
				let _ = tell.send(Some(r));
			});
			done
		});
		loop {
			if let Some(r) = done.borrow_and_update().clone() {
				return r;
			}
			done.changed().await.map_err(|_| "the management API could not be reached: the request ended".to_owned())?;
		}
	}

	async fn fetch(&self) -> Result<(), String> {
		let unreachable = |e: String| format!("the management API could not be reached: {e}");
		let got = timeout(Duration::from_millis(self.timeout_ms), get(&self.url, &self.token)).await;
		let (status, body) = got.map_err(|_| unreachable("timed out".to_owned()))?.map_err(unreachable)?;
		if !(200..300).contains(&status) {
			return Err(format!("the management API answered HTTP {status}"));
		}
		let list = phi_json::parse(&body).map_err(|e| unreachable(e.to_string()))?;
		let list = list.as_array().ok_or("the management API did not return a list of peers")?;
		let mut next = HashMap::new();
		for p in list {
			let (Some(id), Some(ip)) = (p.get("id").and_then(Json::as_str), p.get("ip").and_then(Json::as_str)) else { continue };
			let groups = p.get("groups").and_then(Json::as_array).map_or(vec![], |g| g.iter().filter_map(|g| g.get("name")?.as_str()).filter(|n| !n.is_empty()).map(str::to_owned).collect());
			let ip = bare(ip).to_owned();
			next.insert(ip.clone(), PeerInfo { id: id.to_owned(), name: p.get("name").and_then(Json::as_str).unwrap_or(id).to_owned(), ip, groups });
		}
		*self.by_ip.borrow_mut() = next;
		self.fetched_at.set((self.now)());
		Ok(())
	}

	/// The peer that owns this address; an error when no answer younger than the cache time exists.
	pub async fn lookup(self: &Rc<Self>, ip: &str) -> Result<Option<PeerInfo>, String> {
		if (self.now)() - self.fetched_at.get() >= self.cache_ms {
			if let Err(e) = self.refresh().await {
				if (self.now)() - self.fetched_at.get() >= self.cache_ms {
					return Err(e);
				}
			}
		}
		Ok(self.by_ip.borrow().get(bare(ip)).cloned())
	}
}

/// `GET {url}/api/peers`: status and body. Plain HTTP only for now; https comes with the TLS register (R5).
async fn get(url: &str, token: &str) -> Result<(u16, String), String> {
	let Some(rest) = url.strip_prefix("http://") else { return Err(format!("{url}: only http:// is implemented yet")) };
	let (authority, base) = rest.split_once('/').map_or((rest, String::new()), |(a, p)| (a, format!("/{p}")));
	let address = if authority.contains(':') { authority.to_owned() } else { format!("{authority}:80") };
	let mut socket = TcpStream::connect(&address).await.map_err(|e| e.to_string())?;
	let request = format!("GET {base}/api/peers HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Token {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n");
	socket.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
	let mut raw = vec![];
	socket.read_to_end(&mut raw).await.map_err(|e| e.to_string())?;
	let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("an answer without headers")?;
	let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
	let status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("an answer without a status")?;
	let body = &raw[end + 4..];
	let chunked = head.lines().any(|l| l.starts_with("transfer-encoding:") && l.contains("chunked"));
	Ok((status, String::from_utf8_lossy(&if chunked { unchunked(body)? } else { body.to_vec() }).into_owned()))
}

fn unchunked(mut body: &[u8]) -> Result<Vec<u8>, String> {
	let mut out = vec![];
	loop {
		let line = body.windows(2).position(|w| w == b"\r\n").ok_or("a cut chunk")?;
		let size = String::from_utf8_lossy(&body[..line]);
		let size = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "a bad chunk size")?;
		if size == 0 {
			return Ok(out);
		}
		let data = body.get(line + 2..line + 2 + size).ok_or("a cut chunk")?;
		out.extend_from_slice(data);
		body = body.get(line + 2 + size + 2..).ok_or("a cut chunk")?;
	}
}

/// Group name -> roles. A peer gets the union over its groups; no mapped group, no access.
pub type GroupRoles = HashMap<String, Vec<String>>;

pub fn default_group_roles() -> GroupRoles {
	[("space-hosts", "member"), ("space-admin", "admin"), ("space-observer", "observer"), ("space-enroll", "unpaired")].map(|(g, r)| (g.to_owned(), vec![r.to_owned()])).into()
}

pub fn roles_of(groups: &[String], map: &GroupRoles) -> Vec<String> {
	groups.iter().filter_map(|g| map.get(g)).flatten().cloned().collect::<BTreeSet<_>>().into_iter().collect()
}

/// The control space's keys, looked at in the service's store.
pub trait Keys {
	fn find(&self, service: &mut Service, peer_id: &str, key_id: &str) -> Option<PeerKey>;
}

/// `Keys` where `Proving` asks a `KeyDirectory`.
struct InService<'a> {
	keys: &'a dyn Keys,
	service: RefCell<&'a mut Service>,
}
impl KeyDirectory for InService<'_> {
	fn find(&self, peer_id: &str, key_id: &str) -> Option<PeerKey> { self.keys.find(&mut self.service.borrow_mut(), peer_id, key_id) }
}

pub struct GateOptions {
	pub directory: Rc<Netbird>,
	pub group_roles: GroupRoles,
	/// Layer B and the key directory; without it nobody can prove anything.
	pub proving: Option<(Proving, Rc<dyn Keys>)>,
	/// Pairing, and with it the rules of the control space.
	pub enrolling: Option<Enrolling>,
	pub control: Option<Control>,
	pub handshake_ms: u64,
	pub max_per_peer: usize,
	pub connections_per_second: f64,
	/// 0: only when asked.
	pub revalidate_ms: u64,
	pub now: Now,
	pub on_event: Box<dyn Fn(&Json)>,
}

impl GateOptions {
	pub fn new(directory: Rc<Netbird>, now: Now) -> GateOptions {
		GateOptions { directory, group_roles: default_group_roles(), proving: None, enrolling: None, control: None, handshake_ms: 5_000, max_per_peer: 32, connections_per_second: 32.0, revalidate_ms: 15_000, now, on_event: Box::new(|_| ()) }
	}
}

struct Open {
	session: Rc<GateSession>,
}

pub struct Gate {
	o: GateOptions,
	open: RefCell<BTreeMap<u64, Open>>,
	next: Cell<u64>,
	buckets: RefCell<HashMap<String, (f64, f64)>>,
	busy: Cell<bool>,
}

/// One connection through the gate: what `Connection` is there, with the identity of `GateIdentity`.
pub struct GateSession {
	id: u64,
	gate: Rc<Gate>,
	peer_id: String,
	ip: String,
	roles: Vec<String>,
	state: RefCell<AuthState>,
	end: Notify,
}

impl Gate {
	/// The address is the gate's own check: on a wildcard address it would answer on other interfaces.
	pub fn new(host: &str, o: GateOptions) -> Result<Rc<Gate>, String> {
		if ["0.0.0.0", "::", "", "*"].contains(&host) {
			return Err("the gate listens on the overlay address only, not on a wildcard address".to_owned());
		}
		Ok(Rc::new(Gate { o, open: RefCell::default(), next: Cell::new(0), buckets: RefCell::default(), busy: Cell::new(false) }))
	}

	fn event(&self, event: &str, ip: &str, peer: Option<&str>, reason: Option<&str>) {
		let mut e = obj! { "event" => event, "ip" => ip };
		if let Json::Object(o) = &mut e {
			if let Some(p) = peer {
				o.insert("peerId", p.into());
			}
			if let Some(r) = reason {
				o.insert("reason", r.into());
			}
		}
		(self.o.on_event)(&e);
	}

	fn take(&self, key: &str) -> bool {
		let (t, rate) = ((self.o.now)(), self.o.connections_per_second);
		let mut buckets = self.buckets.borrow_mut();
		let b = buckets.entry(key.to_owned()).or_insert((rate, t));
		b.0 = rate.min(b.0 + (t - b.1) / 1000.0 * rate);
		b.1 = t;
		if b.0 < 1.0 {
			return false;
		}
		b.0 -= 1.0;
		true
	}

	async fn identify(self: Rc<Self>, ip: String) -> Option<Rc<dyn Session>> {
		if !self.take(&ip) {
			self.event("refused", &ip, None, Some("too many new connections from this address"));
			return None;
		}
		let looked = timeout(Duration::from_millis(self.o.handshake_ms), self.o.directory.lookup(&ip)).await;
		let peer = match looked {
			Err(_) => Err("the peer was not identified in time".to_owned()),
			Ok(r) => r,
		};
		let peer = match peer {
			Err(reason) => {
				self.event("refused", &ip, None, Some(&reason));
				return None;
			}
			Ok(None) => {
				self.event("refused", &ip, None, Some("no peer owns this address"));
				return None;
			}
			Ok(Some(p)) => p,
		};
		let roles = roles_of(&peer.groups, &self.o.group_roles);
		if roles.is_empty() {
			self.event("refused", &ip, Some(&peer.id), Some("no group of this peer grants a role"));
			return None;
		}
		if self.open.borrow().values().filter(|c| c.session.peer_id == peer.id).count() >= self.o.max_per_peer {
			self.event("refused", &ip, Some(&peer.id), Some(&format!("already {} connections", self.o.max_per_peer)));
			return None;
		}
		let id = self.next.replace(self.next.get() + 1);
		let session = Rc::new(GateSession { id, gate: Rc::clone(&self), peer_id: peer.id.clone(), ip: ip.clone(), roles, state: RefCell::default(), end: Notify::new() });
		self.open.borrow_mut().insert(id, Open { session: Rc::clone(&session) });
		self.event("accepted", &ip, Some(&peer.id), None);
		Some(session)
	}

	/// Checks every open connection against a fresh directory; closes those whose peer is gone or whose rights changed.
	pub async fn revalidate(self: &Rc<Self>, owner: &Owner) -> usize {
		if self.busy.replace(true) {
			return 0;
		}
		let down = self.o.directory.refresh().await.is_err();
		let mut closed = 0;
		let open: Vec<Rc<GateSession>> = self.open.borrow().values().map(|c| Rc::clone(&c.session)).collect();
		for c in open {
			let reason = match self.o.directory.lookup(&c.ip).await {
				Err(_) if down => Some("the directory is unreachable and its cache has expired"),
				Err(_) => Some("the directory could not be read"),
				Ok(None) => Some("the peer is gone"),
				Ok(Some(p)) if p.id != c.peer_id => Some("the peer is gone"),
				Ok(Some(p)) if roles_of(&p.groups, &self.o.group_roles) != c.roles => Some("the roles of the peer changed"),
				Ok(Some(_)) => owner.with(|service| self.key_gone(service, &c)),
			};
			if let Some(reason) = reason {
				self.event("revoked", &c.ip, Some(&c.peer_id), Some(reason));
				c.end.notify_one();
				self.open.borrow_mut().remove(&c.id);
				closed += 1;
			}
		}
		self.busy.set(false);
		closed
	}

	fn key_gone(&self, service: &mut Service, c: &GateSession) -> Option<&'static str> {
		let state = c.state.borrow();
		let (proof, (_, keys)) = (state.proof.as_ref()?, self.o.proving.as_ref()?);
		match keys.find(service, &c.peer_id, &proof.key_id) {
			Some(k) if k.active && k.roles == proof.roles => None,
			Some(k) if k.active => Some("the roles of the key changed"),
			_ => Some("the key of this connection was revoked"),
		}
	}

	pub fn peers(&self) -> Json {
		Json::Array(self.open.borrow().values().map(|c| {
			let s = &c.session;
			obj! { "peerId" => s.peer_id.as_str(), "ip" => s.ip.as_str(), "roles" => Json::Array(s.roles.iter().map(|r| r.as_str().into()).collect()), "proven" => s.state.borrow().proof.is_some() }
		}).collect())
	}
}

impl Front for Gate {
	fn admit(self: Rc<Self>, ip: IpAddr) -> Local<Option<Rc<dyn Session>>> {
		let ip = match ip {
			IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or_else(|| v6.to_string(), |v4| v4.to_string()),
			v4 => v4.to_string(),
		};
		Box::pin(self.identify(ip))
	}

	fn run(self: Rc<Self>, owner: Owner) -> Local<()> {
		Box::pin(async move {
			if self.o.control.as_ref().is_some_and(|c| c.supervisor.is_some()) {
				spawn_local(supervise(Rc::clone(&self), owner.clone()));
			}
			if self.o.revalidate_ms == 0 {
				return;
			}
			loop {
				sleep(Duration::from_millis(self.o.revalidate_ms)).await;
				self.revalidate(&owner).await;
			}
		})
	}

	fn hook(self: Rc<Self>, owner: Owner, text: &str) -> Option<Local<String>> {
		let line = phi_json::parse(text).ok()?;
		let answered = |v: Json| obj! { "ok" => true, "result" => v }.to_json_text();
		match line.get("hook")?.as_str()? {
			"revalidate" => Some(Box::pin(async move {
				let closed = self.revalidate(&owner).await;
				answered(Json::Number(closed as f64))
			})),
			"peers" => Some(Box::pin(async move { answered(self.peers()) })),
			_ => None,
		}
	}
}

/// The supervisor: a pass after commits, and now and then so that none is missed.
async fn supervise(gate: Rc<Gate>, owner: Owner) {
	let mut seen = None;
	loop {
		if seen != Some(owner.handed()) {
			let supervisor = gate.o.control.as_ref().and_then(|c| c.supervisor.as_ref()).expect("started with one");
			if let Err(e) = owner.with(|service| supervisor.tick(service, (gate.o.now)())) {
				eprintln!("phi-spaces supervisor: {}", e.message);
			}
			seen = Some(owner.handed());
		}
		tokio::select! {
			_ = owner.commit() => {}
			_ = sleep(Duration::from_millis(100)) => {}
		}
	}
}

impl GateSession {
	/// `GateIdentity.authenticate`: with a proof the intersection with the key's roles, without one no privileged role.
	fn identity(&self) -> Identity {
		let state = self.state.borrow();
		let privileged = self.gate.o.proving.as_ref().map_or_else(|| crate::auth::DEFAULT_PRIVILEGED.map(String::from).to_vec(), |(p, _)| p.privileged.clone());
		let roles = match &state.proof {
			Some(p) => self.roles.iter().filter(|r| p.roles.contains(r)).cloned().collect(),
			None => self.roles.iter().filter(|r| !privileged.contains(r)).cloned().collect(),
		};
		Identity { principal: obj! { "peerId" => self.peer_id.as_str() }, roles }
	}
}

impl Session for GateSession {
	fn conn(&self) -> Conn { Conn { peer_id: Some(self.peer_id.clone()), identity: Some(self.identity()) } }

	fn call(&self, service: &mut Service, text: &str) -> Option<String> {
		let (proving, keys) = self.gate.o.proving.as_ref()?;
		let call = parse_repairing(text).ok()?;
		let method = call.as_object().and_then(|_| call.get("method")).and_then(Json::as_str)?;
		let now = (self.gate.o.now)();
		if let (Some(enrolling), "enroll" | "enrollStatus") = (&self.gate.o.enrolling, method) {
			let unpaired = self.roles.iter().any(|r| r == crate::control::UNPAIRED_ROLE);
			let proven = self.state.borrow().proof.as_ref().map(|p| p.key_id.clone()).is_some_and(|k| keys.find(service, &self.peer_id, &k).is_some_and(|k| k.active));
			return Some(enrolling.handle(service, &call, &self.peer_id, (unpaired, proven), &mut self.state.borrow_mut(), now).to_json_text());
		}
		if let Some(control) = &self.gate.o.control {
			if let Some(denied) = control.check(service, &call, &self.identity()) {
				return Some(denied.to_json_text());
			}
		}
		if method != "challenge" && method != "prove" {
			return None;
		}
		let mut nonce = [0u8; 32];
		getrandom::getrandom(&mut nonce).expect("the system gives random bytes");
		let found = InService { keys: keys.as_ref(), service: RefCell::new(service) };
		let reply = proving.proof(method, call.get("args"), Some(&self.peer_id), &mut self.state.borrow_mut(), &found, (now, nonce));
		Some(reply.to_json_text())
	}

	fn reply(&self, text: String) -> String {
		match &self.gate.o.proving {
			Some((proving, _)) => proving.annotate(text, &self.state.borrow(), &self.roles),
			None => text,
		}
	}

	fn ended(&self) -> Local<()> {
		let session = self.gate.open.borrow().get(&self.id).map(|c| Rc::clone(&c.session));
		Box::pin(async move {
			match session {
				Some(s) => s.end.notified().await,
				None => std::future::pending().await,
			}
		})
	}

	fn closed(&self) { self.gate.open.borrow_mut().remove(&self.id); }
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_cache_time_stays_within_a_minute() {
		let now: Now = Rc::new(|| 0.0);
		assert_eq!(Netbird::new("http://x", "t", Some(600_000.0), Rc::clone(&now)).map(|d| d.cache_ms()), Ok(60_000.0));
		assert!(Netbird::new("http://x", "t", Some(0.0), now).is_err());
	}

	#[test]
	fn chunks_join_and_a_cut_one_is_refused() {
		assert_eq!(unchunked(b"3\r\n[1,\r\n2;x=y\r\n2]\r\n0\r\n\r\n"), Ok(b"[1,2]".to_vec()));
		assert!(unchunked(b"9\r\n[1").is_err());
	}

	#[test]
	fn roles_are_the_sorted_union_of_the_mapped_groups() {
		let map = default_group_roles();
		assert_eq!(roles_of(&["space-observer".into(), "other".into(), "space-hosts".into()], &map), ["member", "observer"]);
		assert!(roles_of(&["other".into()], &map).is_empty());
	}
}
