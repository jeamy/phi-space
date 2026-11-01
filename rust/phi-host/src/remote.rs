//! A Member's line to its control host (`RemoteSpace` of src/remote.ts as far as a Member needs it): it proves the host's key,
//! asks for keys and the routing policy. What the owner thread needs of them is read before a call and kept for moments only.
use crate::auth::{to_base64, PeerKey, Signer};
use crate::gate::Keys;
use phi_json::{obj, parse, Json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpSocket, TcpStream};
use tokio::sync::Mutex;
use tokio::time::timeout;

/// Peer and key id.
type KeyName = (String, String);
const KEEP_MS: f64 = 5_000.0;
const CALL_MS: u64 = 8_000;

pub struct ControlClient {
	pub address: (String, u16),
	/// The overlay address of this host: the control host knows it by that.
	pub source: String,
	pub peer_id: String,
	pub control_host_id: String,
	pub signer: Signer,
	pub key_id: String,
	line: Mutex<Option<(TcpStream, u32)>>,
}

fn ok(reply: Json) -> Result<Json, String> {
	if reply.get("ok") == Some(&Json::Bool(true)) {
		return Ok(reply.get("result").cloned().unwrap_or(Json::Null));
	}
	Err(reply.get("error").and_then(|e| e.get("message")).and_then(Json::as_str).unwrap_or("the control host refused").to_owned())
}

async fn exchange(s: &mut TcpStream, id: u32, call: &Json) -> Result<Json, String> {
	let mut out = Vec::new();
	phi_wire::put(&mut out, id, &call.to_json_text());
	s.write_all(&out).await.map_err(|e| e.to_string())?;
	let text = phi_wire::read_frame(s).await.map_err(|e| e.to_string())?;
	parse(&String::from_utf8_lossy(&text)).map_err(|e| e.to_string())
}

impl ControlClient {
	pub fn new(address: (String, u16), source: &str, peer_id: &str, control_host_id: &str, signer: Signer, key_id: &str) -> ControlClient {
		ControlClient { address, source: source.to_owned(), peer_id: peer_id.to_owned(), control_host_id: control_host_id.to_owned(), signer, key_id: key_id.to_owned(), line: Mutex::new(None) }
	}

	async fn open(&self) -> Result<(TcpStream, u32), String> {
		let to = tokio::net::lookup_host((self.address.0.as_str(), self.address.1)).await.map_err(|e| e.to_string())?.next().ok_or("no address")?;
		let socket = if to.is_ipv4() { TcpSocket::new_v4() } else { TcpSocket::new_v6() }.map_err(|e| e.to_string())?;
		let from: std::net::IpAddr = self.source.parse().map_err(|_| format!("{}: not an address", self.source))?;
		socket.bind((from, 0).into()).map_err(|e| e.to_string())?;
		let mut s = socket.connect(to).await.map_err(|e| e.to_string())?;
		s.set_nodelay(true).map_err(|e| e.to_string())?;
		let asked = ok(exchange(&mut s, 1, &obj! { "method" => "challenge", "args" => obj! { "protocol" => crate::auth::AUTH_PROTOCOL } }).await?)?;
		if asked.get("gateHostId").and_then(Json::as_str) != Some(&self.control_host_id) || asked.get("observedPeerId").and_then(Json::as_str) != Some(&self.peer_id) {
			return Err("the challenge is not from the control host, or not for this peer".to_owned());
		}
		let mut challenge = asked.as_object().cloned().unwrap_or_default();
		challenge.remove("expiresAt");
		let challenge = Json::Object(challenge);
		let text = crate::auth::signed_text(&challenge).ok_or("a challenge that cannot be signed")?;
		let signature = to_base64(&self.signer.sign(text.as_bytes()));
		ok(exchange(&mut s, 2, &obj! { "method" => "prove", "args" => obj! { "keyId" => self.key_id.as_str(), "signature" => signature, "challenge" => challenge } }).await?)?;
		Ok((s, 3))
	}

	/// One call; a lost connection is opened again once.
	pub async fn call(&self, call: &Json) -> Result<Json, String> {
		let mut line = self.line.lock().await;
		for attempt in 0..2 {
			if line.is_none() {
				*line = Some(timeout(Duration::from_millis(CALL_MS), self.open()).await.map_err(|_| "the control host does not answer".to_owned())??);
			}
			let (s, id) = line.as_mut().expect("just opened");
			*id += 1;
			let id = *id;
			match timeout(Duration::from_millis(CALL_MS), exchange(s, id, call)).await {
				Ok(Ok(reply)) => return ok(reply),
				failed => {
					*line = None;
					if attempt == 1 {
						return Err(match failed {
							Ok(Err(e)) => e,
							_ => "the control host does not answer".to_owned(),
						});
					}
				}
			}
		}
		unreachable!("the second attempt returns")
	}

	/// A grant for this host's own calls.
	pub async fn grant(&self) -> Result<Json, String> { self.call(&obj! { "method" => "grant", "space" => "control", "args" => obj! { "purpose" => "effect" } }).await }

	/// `routingPolicy`: the signed policy.
	pub async fn routing_policy(&self) -> Result<Json, String> {
		let grant = self.grant().await?;
		self.call(&obj! { "method" => "routingPolicy", "space" => "control", "frame" => obj! { "grant" => grant } }).await
	}
}

/// Keys of the control space, as a Member sees them: asked before a call, gone after moments.
pub struct RemoteKeys {
	pub client: Rc<ControlClient>,
	pub now: crate::gate::Now,
	held: RefCell<HashMap<KeyName, (f64, Option<PeerKey>)>>,
	/// The routing policy as last read, signed.
	pub policy: RefCell<Option<Json>>,
	/// Why the signed policy could not be brought to the Member just now: its calls wait for the next read.
	pub policy_failed: RefCell<Option<String>>,
}

impl RemoteKeys {
	pub fn new(client: Rc<ControlClient>, now: crate::gate::Now) -> RemoteKeys {
		RemoteKeys { client, now, held: RefCell::default(), policy: RefCell::new(None), policy_failed: RefCell::new(None) }
	}

	/// Asks the control host for these keys. One it does not answer for is unknown: nothing is served on an old answer.
	pub async fn fetch(&self, wanted: Vec<(String, String)>) {
		for (peer, key) in wanted {
			let reply = self.client.call(&obj! { "method" => "keyLookup", "args" => obj! { "peerId" => peer.as_str(), "keyId" => key.as_str() } }).await;
			let found = reply.ok().and_then(|v| PeerKey::from_json(&v));
			self.held.borrow_mut().insert((peer, key), ((self.now)(), found));
		}
	}

	pub async fn fetch_policy(&self) {
		let read = self.client.routing_policy().await.ok();
		*self.policy.borrow_mut() = read;
	}
}

impl Keys for RemoteKeys {
	fn find(&self, _: &mut phi_store::Store, peer_id: &str, key_id: &str) -> Option<PeerKey> {
		let held = self.held.borrow();
		let (at, key) = held.get(&(peer_id.to_owned(), key_id.to_owned()))?;
		if (self.now)() - at > KEEP_MS { None } else { key.clone() }
	}
}
