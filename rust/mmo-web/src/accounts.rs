//! Accounts, guests and web logins (`server/accounts.ts`). The account and its character live in the world space; the
//! credential (salted scrypt hash) and the web sessions in the accounts space. A registration runs in three idempotent
//! steps: claim the name as a pending credential under the names lock, make the account a registered one in the world,
//! activate the credential.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use mmo_engine::j;
use mmo_engine::js::JsRegex;
use mmo_engine::model::actor_token;
use mmo_engine::occupancy::{cell_key, free_cell_near, occupied_in};
use mmo_engine::room_growth::{pin_terrain, spatial_world};
use mmo_engine::source::{hex, random_bytes, random_int, time_now};
use mmo_engine::space::{fields, tmpl, Error, Space};
use mmo_engine::world::walkable;
use phi_json::{obj, Json};
use sha2::{Digest, Sha256};

use crate::regions::RegionSpaces;
use crate::{env_ms, WebError, WebResult};

const FOREVER: f64 = -1.0;
const NO_WAIT: f64 = 0.0;
const HELD_WAIT_MS: f64 = 2_000.0;

/// scrypt N=16384, r=8, p=1, 64 bytes, as node's `crypto.scrypt`; on a thread of its own, so the game sockets go on.
pub async fn scrypt(password: String, salt: Vec<u8>) -> Vec<u8> {
	tokio::task::spawn_blocking(move || {
		let params = scrypt::Params::new(14, 8, 1, 64).expect("scrypt parameters");
		let mut out = vec![0u8; 64];
		scrypt::scrypt(password.as_bytes(), &salt, &params, &mut out).expect("scrypt");
		out
	}).await.expect("the scrypt thread")
}
pub fn sha256_hex(s: &str) -> String { hex(&Sha256::digest(s.as_bytes())) }
fn equal_time(a: &[u8], b: &[u8]) -> bool { a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0 }
fn unhex(s: &str) -> Vec<u8> { (0..s.len() / 2).filter_map(|i| u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()).collect() }
fn id(prefix: &str) -> String { format!("{prefix}-{}", hex(&random_bytes(8))) }
fn name_ok(name: &str) -> bool { JsRegex::new(r"^[\p{L}\p{N}_-]{3,20}$", "u").is_ok_and(|r| r.test(name)) }
fn sid_ok(sid: &str) -> bool { sid.len() == 48 && sid.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn auth<T>(status: u16, text: impl Into<String>) -> WebResult<T> { Err(WebError::Auth(status, text.into())) }
fn names_lock() -> Json { tmpl("Lock", obj! { "name" => "names" }) }

#[derive(Clone, Debug)]
pub struct Me { pub account_id: String, pub name: String, pub guest: bool, pub admin: bool, pub char_id: String, pub alias: Option<String> }

pub struct Accounts {
	pub guest_ttl_ms: f64,
	pub pending_ms: f64,
	pub web_session_ms: f64,
	setup_token: Option<String>,
	looked: RefCell<HashMap<String, f64>>,
	regions: Rc<RegionSpaces>,
	store: Space,
	w: Json,
}

fn pick(a: &Json) -> (String, String, bool, bool) { (j::s(a, "accountId").to_owned(), j::s(a, "name").to_owned(), j::truthy(j::at(a, "guest")), j::truthy(j::at(a, "admin"))) }

impl Accounts {
	pub fn new(regions: Rc<RegionSpaces>, store: Space, w: Json) -> Self {
		Self {
			guest_ttl_ms: env_ms("SPACES_MMO_GUEST_TTL_MS", 7.0 * 24.0 * 3_600_000.0),
			pending_ms: env_ms("SPACES_MMO_PENDING_MS", 120_000.0),
			web_session_ms: env_ms("SPACES_MMO_WEB_SESSION_MS", 12.0 * 3_600_000.0),
			setup_token: std::env::var("SPACES_MMO_SETUP_TOKEN").ok().filter(|s| !s.is_empty()),
			looked: RefCell::default(), regions, store, w,
		}
	}
	fn guest_name(&self) -> &str { j::s(&self.w, "guestName") }
	fn npc_named(&self, key: &str) -> bool { j::a(&self.w, "npcs").iter().any(|n| j::s(n, "name").to_lowercase() == key) }

	/// A new guest: an account with a lease and a character at the start of the world.
	pub async fn create_guest(&self) -> WebResult<Me> {
		let now = time_now();
		let account = obj! { "accountId" => id("a"), "name" => format!("{}-{}", self.guest_name(), phi_json::number_text(random_int(1000.0, 10000.0))), "guest" => true, "admin" => false, "createdAt" => now, "touchedAt" => now };
		let (_, world, room) = self.regions.next_start();
		let txn = world.create_transaction(10_000.0).await?;
		let r: WebResult<Json> = async {
			pin_terrain(&world, &txn).await?;
			let char = self.new_character(&account, &room, &world).await?;
			world.write(&tmpl("Account", account.clone()), Some(&txn), self.guest_ttl_ms).await?;
			world.write(&tmpl("Character", char.clone()), Some(&txn), FOREVER).await?;
			world.write(&actor_token(j::s(&char, "charId")), Some(&txn), FOREVER).await?;
			world.commit(&txn).await?;
			Ok(char)
		}.await;
		let char = match r { Ok(c) => c, Err(e) => { let _ = world.abort(&txn).await; return Err(e); } };
		let (account_id, name, guest, admin) = pick(&account);
		Ok(Me { account_id, name, guest, admin, char_id: j::s(&char, "charId").to_owned(), alias: None })
	}

	/// Registers `name`; with `guest_account_id` the guest's own account becomes the registered one.
	pub async fn register(&self, name: &Json, password: &Json, guest_account_id: Option<&str>, setup_token: Option<&str>) -> WebResult<Me> {
		let name = name.as_str().map(|s| s.trim().to_owned()).unwrap_or_else(|| text_of(name).trim().to_owned());
		if !name_ok(&name) { return auth(400, "Name: 3 bis 20 Buchstaben, Ziffern, _ oder -"); }
		let gn = self.guest_name().to_owned();
		if name.to_lowercase().starts_with(&format!("{}-", gn.to_lowercase())) { return auth(400, format!("Namen wie „{gn}-…“ sind Gästen vorbehalten")); }
		let Some(password) = password.as_str().filter(|p| { let n = p.encode_utf16().count(); (8..=200).contains(&n) }) else { return auth(400, "Passwort: 8 bis 200 Zeichen") };
		let key = name.to_lowercase();
		if self.npc_named(&key) { return auth(409, "Dieser Name gehört einer Figur der Welt"); }
		let guest = match guest_account_id { Some(g) => self.account(g).await?, None => None };
		if guest_account_id.is_some() && !guest.as_ref().is_some_and(|g| j::truthy(j::at(g, "guest"))) { return auth(409, "Dieses Gastkonto gibt es nicht mehr; bitte neu als Gast beginnen oder ohne Gast registrieren"); }
		let account_id = guest.as_ref().map_or_else(|| id("a"), |g| j::s(g, "accountId").to_owned());
		let admin = match setup_token { Some(t) if self.token_ok(t) => self.regions.find(&tmpl("Account", obj! { "admin" => true }), 0.0).await?.is_none(), _ => false };
		let salt = random_bytes(16);
		let hash = scrypt(password.to_owned(), salt.clone()).await;

		// step 1: claim the name under the names lock
		let cred = obj! { "key" => key.as_str(), "name" => name.as_str(), "accountId" => account_id.as_str(), "salt" => hex(&salt), "hash" => hex(&hash), "state" => "pending" };
		let t1 = self.store.create_transaction(15_000.0).await?;
		let r: WebResult<()> = async {
			if self.store.take(&names_lock(), 10_000.0, Some(&t1)).await?.is_none() { return auth(503, "Die Namensvergabe ist gerade belegt; bitte gleich noch einmal"); }
			let taken = match self.store.read_existing(&tmpl("Credential", obj! { "key" => key.as_str() }), Some(&t1), HELD_WAIT_MS).await {
				Ok(t) => t,
				Err(Error::StillHeld(_)) => return auth(503, "Die Namensvergabe ist gerade belegt; bitte gleich noch einmal"),
				Err(e) => return Err(e.into()),
			};
			if self.store.peek(&tmpl("NameAlias", obj! { "key" => key.as_str() }), None).await?.is_some() { return auth(409, "Dieser Name ist schon vergeben"); }
			if let Some(t) = taken {
				let c = fields(&t);
				if j::s(c, "state") != "pending" || j::s(c, "accountId") != account_id { return auth(409, "Dieser Name ist schon vergeben"); }
				self.store.take(&obj! { "type" => "Credential", "id" => t.get("id").cloned().unwrap_or(Json::Null) }, NO_WAIT, Some(&t1)).await?;
			}
			self.store.write(&tmpl("Credential", cred.clone()), Some(&t1), self.pending_ms).await?;
			self.store.write(&names_lock(), Some(&t1), FOREVER).await?;
			self.store.commit(&t1).await?;
			Ok(())
		}.await;
		if let Err(e) = r { let _ = self.store.abort(&t1).await; return Err(e); }

		// step 2: the account in the world becomes (or is created as) a registered one
		let start = if guest.is_some() { None } else { Some(self.regions.next_start()) };
		let world = match &start { Some((_, s, _)) => s.clone(), None => self.space_of(&account_id).await? };
		let t2 = world.create_transaction(15_000.0).await?;
		let r: WebResult<String> = async {
			pin_terrain(&world, &t2).await?;
			if guest.is_some() {
				let Some(a) = world.take(&tmpl("Account", obj! { "accountId" => account_id.as_str(), "guest" => true }), 5_000.0, Some(&t2)).await? else { return auth(409, "Dieses Gastkonto gibt es nicht mehr") };
				let mut f = fields(&a).clone();
				let now = time_now();
				j::set(&mut f, "name", name.as_str()); j::set(&mut f, "guest", false); j::set(&mut f, "admin", admin); j::set(&mut f, "touchedAt", now); j::set(&mut f, "registeredAt", now);
				world.write(&tmpl("Account", f), Some(&t2), FOREVER).await?;
				let Some(c) = world.take(&tmpl("Character", obj! { "accountId" => account_id.as_str() }), 5_000.0, Some(&t2)).await? else { return auth(409, "Zu diesem Gastkonto gibt es keine Figur mehr") };
				let mut ch = fields(&c).clone();
				j::set(&mut ch, "name", name.as_str()); j::set(&mut ch, "guest", false);
				world.write(&tmpl("Character", ch.clone()), Some(&t2), FOREVER).await?;
				world.commit(&t2).await?;
				Ok(j::s(&ch, "charId").to_owned())
			} else {
				let now = time_now();
				let account = obj! { "accountId" => account_id.as_str(), "name" => name.as_str(), "guest" => false, "admin" => admin, "createdAt" => now, "touchedAt" => now, "registeredAt" => now };
				let char = self.new_character(&account, &start.as_ref().expect("a start").2, &world).await?;
				world.write(&tmpl("Account", account), Some(&t2), FOREVER).await?;
				world.write(&tmpl("Character", char.clone()), Some(&t2), FOREVER).await?;
				world.write(&actor_token(j::s(&char, "charId")), Some(&t2), FOREVER).await?;
				world.commit(&t2).await?;
				Ok(j::s(&char, "charId").to_owned())
			}
		}.await;
		let char_id = match r { Ok(c) => c, Err(e) => { let _ = world.abort(&t2).await; return Err(e); } };
		// step 3: the credential becomes permanent
		self.activate(&key, &account_id).await?;
		Ok(Me { account_id, name, guest: false, admin, char_id, alias: None })
	}

	/// The name the game shows for this account; empty goes back to the login name.
	pub async fn set_alias(&self, account_id: &str, wanted: &Json) -> WebResult<Me> {
		let Some(account) = self.account(account_id).await? else { return auth(403, "Dieses Konto gibt es nicht mehr") };
		if j::truthy(j::at(&account, "guest")) { return auth(403, "Einen Alias gibt es für registrierte Konten"); }
		let wanted = text_of(wanted);
		let name = if wanted.trim().is_empty() { j::s(&account, "name").to_owned() } else { wanted.trim().to_owned() };
		let key = name.to_lowercase();
		let own = key == j::s(&account, "name").to_lowercase();
		if !name_ok(&name) { return auth(400, "Name: 3 bis 20 Buchstaben, Ziffern, _ oder -"); }
		let gn = self.guest_name().to_owned();
		if key.starts_with(&format!("{}-", gn.to_lowercase())) { return auth(400, format!("Namen wie „{gn}-…“ sind Gästen vorbehalten")); }
		if self.npc_named(&key) { return auth(409, "Dieser Name gehört einer Figur der Welt"); }
		let t1 = self.store.create_transaction(15_000.0).await?;
		let r: WebResult<()> = async {
			if self.store.take(&names_lock(), 10_000.0, Some(&t1)).await?.is_none() { return auth(503, "Die Namensvergabe ist gerade belegt; bitte gleich noch einmal"); }
			if let Some(l) = self.store.peek(&tmpl("Credential", obj! { "key" => key.as_str() }), None).await? { if j::s(fields(&l), "accountId") != account_id { return auth(409, "Dieser Name ist schon vergeben"); } }
			if let Some(o) = self.store.peek(&tmpl("NameAlias", obj! { "key" => key.as_str() }), None).await? { if j::s(fields(&o), "accountId") != account_id { return auth(409, "Dieser Name ist schon vergeben"); } }
			for e in self.store.read_all(&tmpl("NameAlias", obj! { "accountId" => account_id }), None).await? { self.store.take_if_exists(&obj! { "type" => "NameAlias", "id" => e.get("id").cloned().unwrap_or(Json::Null) }, NO_WAIT, Some(&t1)).await?; }
			if !own { self.store.write(&tmpl("NameAlias", obj! { "key" => key.as_str(), "name" => name.as_str(), "accountId" => account_id }), Some(&t1), FOREVER).await?; }
			self.store.write(&names_lock(), Some(&t1), FOREVER).await?;
			self.store.commit(&t1).await?;
			Ok(())
		}.await;
		if let Err(e) = r { let _ = self.store.abort(&t1).await; return Err(e); }
		let world = self.space_of(account_id).await?;
		let t2 = world.create_transaction(15_000.0).await?;
		let r: WebResult<()> = async {
			pin_terrain(&world, &t2).await?;
			let Some(c) = world.take(&tmpl("Character", obj! { "accountId" => account_id }), 5_000.0, Some(&t2)).await? else { return auth(409, "Deine Figur ist gerade nicht greifbar; bitte noch einmal") };
			let char = fields(&c).clone();
			let mut f = char.clone();
			j::set(&mut f, "name", name.as_str());
			world.write(&tmpl("Character", f), Some(&t2), FOREVER).await?;
			world.commit(&t2).await?;
			self.rename_owned(j::s(&char, "charId"), account_id, j::s(&char, "name"), &name).await?;
			Ok(())
		}.await;
		if let Err(e) = r { let _ = world.abort(&t2).await; return Err(e); }
		self.me(&account).await
	}

	/// What a character owns keeps its owner's name for the world's sentences: they follow the alias, in every region.
	async fn rename_owned(&self, char_id: &str, account_id: &str, from: &str, to: &str) -> WebResult<()> {
		for (_, space) in self.regions.entries() {
			let mut owned: Vec<(Json, &str)> = Vec::new();
			for ty in ["Site", "Building", "Ruin", "Bed", "Field", "Tree"] { for e in space.read_all(&tmpl(ty, obj! { "owner" => char_id }), None).await? { owned.push((e, "ownerName")); } }
			for e in space.read_all(&tmpl("Estate", obj! { "accountId" => account_id }), None).await? { owned.push((e, "ownerName")); }
			for e in space.read_all(&tmpl("SiteOrder", obj! { "ownerName" => from }), None).await? { owned.push((e, "ownerName")); }
			for e in space.read_all(&tmpl("Listing", obj! { "seller" => char_id }), None).await? { owned.push((e, "sellerName")); }
			for e in space.read_all(&tmpl("Wanted", obj! { "buyer" => char_id }), None).await? { owned.push((e, "buyerName")); }
			for (e, key) in owned {
				let t = obj! { "type" => j::at(&e, "type").clone(), "id" => j::at(&e, "id").clone() };
				if let Some(taken) = space.take_if_exists(&t, NO_WAIT, None).await? {
					let mut f = fields(&taken).clone();
					j::set(&mut f, key, to);
					let types: Vec<Json> = j::a(&taken, "types").iter().skip(1).cloned().collect();
					space.write(&obj! { "type" => j::at(&taken, "type").clone(), "types" => Json::Array(types), "fields" => f }, None, FOREVER).await?;
				}
			}
		}
		Ok(())
	}

	/// The account a name and password belong to; a pending credential of a registration that got to the world is completed.
	pub async fn login(&self, name: &Json, password: &Json, setup_token: Option<&str>) -> WebResult<Me> {
		let key = text_of(name).trim().to_lowercase();
		let pw = password.as_str().filter(|p| p.encode_utf16().count() <= 200);
		let e = match pw { Some(_) if name_ok(&key) => self.store.read_existing(&tmpl("Credential", obj! { "key" => key.as_str() }), None, HELD_WAIT_MS).await?, _ => None };
		let Some(e) = e else { scrypt(text_of(password), random_bytes(16)).await; return auth(403, "Name oder Passwort stimmt nicht") };
		let c = fields(&e).clone();
		let got = scrypt(pw.unwrap_or("").to_owned(), unhex(j::s(&c, "salt"))).await;
		if !equal_time(&got, &unhex(j::s(&c, "hash"))) { return auth(403, "Name oder Passwort stimmt nicht"); }
		let account = self.account(j::s(&c, "accountId")).await?;
		if j::s(&c, "state") == "pending" {
			if !account.as_ref().is_some_and(|a| !j::truthy(j::at(a, "guest"))) { return auth(403, "Diese Registrierung ist nicht abgeschlossen; bitte noch einmal registrieren"); }
			self.activate(&key, j::s(&c, "accountId")).await?;
		}
		let Some(account) = account else { return auth(403, "Zu diesem Namen gibt es kein Konto mehr") };
		if let Some(t) = setup_token {
			if !self.token_ok(t) { return auth(403, "Das Einrichtungstoken stimmt nicht"); }
			if !j::truthy(j::at(&account, "admin")) { let a = self.make_admin(j::s(&account, "accountId")).await?; return self.me(&a).await; }
		}
		self.me(&account).await
	}

	async fn make_admin(&self, account_id: &str) -> WebResult<Json> {
		let world = self.space_of(account_id).await?;
		let txn = world.create_transaction(10_000.0).await?;
		let r: WebResult<Json> = async {
			let Some(a) = world.take(&tmpl("Account", obj! { "accountId" => account_id, "guest" => false }), 5_000.0, Some(&txn)).await? else { return auth(409, "Dieses Konto ist gerade nicht greifbar; bitte noch einmal") };
			let mut f = fields(&a).clone();
			j::set(&mut f, "admin", true);
			world.write(&tmpl("Account", f.clone()), Some(&txn), FOREVER).await?;
			world.commit(&txn).await?;
			Ok(f)
		}.await;
		if r.is_err() { let _ = world.abort(&txn).await; }
		r
	}

	/// A web session for an account: the cookie value (only its hash is stored).
	pub async fn open_session(&self, account_id: &str) -> WebResult<String> {
		let sid = hex(&random_bytes(24));
		self.store.write(&tmpl("WebSession", obj! { "key" => sha256_hex(&sid), "accountId" => account_id, "at" => time_now() }), None, self.web_session_ms).await?;
		Ok(sid)
	}

	/// Who a session cookie belongs to, or None; a session older than a twelfth of its lifetime is renewed.
	pub async fn resolve(&self, sid: Option<&str>) -> WebResult<Option<Me>> {
		let Some(sid) = sid.filter(|s| sid_ok(s)) else { return Ok(None) };
		let Some(e) = self.store.peek(&tmpl("WebSession", obj! { "key" => sha256_hex(sid) }), None).await? else { return Ok(None) };
		let s = fields(&e).clone();
		let Some(account) = self.account(j::s(&s, "accountId")).await? else { return Ok(None) };
		if time_now() - j::n(&s, "at") > self.web_session_ms / 12.0
			&& self.store.take_if_exists(&obj! { "type" => "WebSession", "id" => j::at(&e, "id").clone() }, NO_WAIT, None).await?.is_some() {
			let mut f = s.clone();
			j::set(&mut f, "at", time_now());
			self.store.write(&tmpl("WebSession", f), None, self.web_session_ms).await?;
		}
		Ok(Some(self.me(&account).await?))
	}

	pub async fn close_session(&self, sid: Option<&str>) -> WebResult<()> {
		let Some(sid) = sid.filter(|s| sid_ok(s)) else { return Ok(()) };
		while self.store.take_if_exists(&tmpl("WebSession", obj! { "key" => sha256_hex(sid) }), NO_WAIT, None).await?.is_some() {}
		Ok(())
	}

	/// Renews a guest account's lease, at most every quarter of the lifetime; looked at at most once a minute per account.
	pub async fn touch_guest(&self, account_id: &str) -> WebResult<()> {
		let now = time_now();
		{
			let mut looked = self.looked.borrow_mut();
			if looked.get(account_id).is_some_and(|t| now - t < 60_000.0) { return Ok(()); }
			if looked.len() >= 10_000 { looked.retain(|_, t| now - *t < 60_000.0); }
			looked.insert(account_id.to_owned(), now);
		}
		let t = tmpl("Account", obj! { "accountId" => account_id, "guest" => true });
		let Some((_, world)) = self.regions.find(&t, 0.0).await? else { return Ok(()) };
		let Some(e) = world.peek(&t, None).await? else { return Ok(()) };
		if time_now() - j::n(fields(&e), "touchedAt") < self.guest_ttl_ms / 4.0 { return Ok(()); }
		let txn = world.create_transaction(10_000.0).await?;
		let r: WebResult<()> = async {
			if let Some(a) = world.take_if_exists(&obj! { "type" => "Account", "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(&txn)).await? {
				let mut f = fields(&a).clone();
				j::set(&mut f, "touchedAt", time_now());
				world.write(&tmpl("Account", f), Some(&txn), self.guest_ttl_ms).await?;
			}
			world.commit(&txn).await?;
			Ok(())
		}.await;
		if r.is_err() { let _ = world.abort(&txn).await; }
		Ok(())
	}

	async fn activate(&self, key: &str, account_id: &str) -> WebResult<()> {
		let txn = self.store.create_transaction(10_000.0).await?;
		let r: WebResult<()> = async {
			if let Some(p) = self.store.take(&tmpl("Credential", obj! { "key" => key, "accountId" => account_id, "state" => "pending" }), 5_000.0, Some(&txn)).await? {
				let mut f = fields(&p).clone();
				j::set(&mut f, "state", "active");
				self.store.write(&tmpl("Credential", f), Some(&txn), FOREVER).await?;
			}
			self.store.commit(&txn).await?;
			Ok(())
		}.await;
		if r.is_err() { let _ = self.store.abort(&txn).await; }
		r
	}

	async fn space_of(&self, account_id: &str) -> WebResult<Space> {
		let wait = if self.regions.size() > 1 { 3_000.0 } else { 0.0 };
		Ok(self.regions.find(&tmpl("Account", obj! { "accountId" => account_id }), wait).await?.map_or_else(|| self.regions.home_space().clone(), |(_, s)| s))
	}

	async fn account(&self, account_id: &str) -> WebResult<Option<Json>> {
		let s = self.space_of(account_id).await?;
		Ok(s.read_existing(&tmpl("Account", obj! { "accountId" => account_id }), None, HELD_WAIT_MS).await?.map(|e| fields(&e).clone()))
	}

	async fn me(&self, account: &Json) -> WebResult<Me> {
		let aid = j::s(account, "accountId");
		let t = tmpl("Character", obj! { "accountId" => aid });
		let mut c = self.space_of(aid).await?.read_existing(&t, None, HELD_WAIT_MS).await?;
		if c.is_none() {
			if let Some((_, s)) = self.regions.find(&t, if self.regions.size() > 1 { 3_000.0 } else { 0.0 }).await? { c = s.read_existing(&t, None, HELD_WAIT_MS).await?; }
		}
		let Some(c) = c else { return auth(409, "Zu diesem Konto gibt es keine Figur") };
		let ch = fields(&c);
		let (account_id, name, guest, admin) = pick(account);
		let alias = (j::s(ch, "name") != name).then(|| j::s(ch, "name").to_owned());
		Ok(Me { account_id, name, guest, admin, char_id: j::s(ch, "charId").to_owned(), alias })
	}

	/// A new character at the start, on a cell near the spawn that no one online stands on.
	async fn new_character(&self, account: &Json, start: &str, world: &Space) -> WebResult<Json> {
		let live = spatial_world(world, &self.w).await?;
		let Some(room) = j::by(j::a(&live, "rooms"), "roomId", start).cloned() else { return Err(WebError::Other(format!("no room {start}"))) };
		let rid = j::s(&room, "roomId");
		let mut avoid: Vec<String> = occupied_in(world, rid, None).await?.into_iter().map(|(k, _)| k).collect();
		avoid.extend(j::a(&live, "exits").iter().filter(|e| j::s(e, "room") == rid).map(|e| cell_key(j::n(e, "x"), j::n(e, "y"))));
		avoid.extend(j::a(&live, "beacons").iter().filter(|b| j::s(b, "room") == rid).map(|b| cell_key(j::n(b, "x"), j::n(b, "y"))));
		let ground: Vec<String> = j::a(&room, "ground").iter().filter_map(Json::as_str).map(str::to_owned).collect();
		let spawn = j::at(&room, "spawn");
		let s = (j::n(spawn, "x"), j::n(spawn, "y"));
		let near = (s.0 + random_int(-3.0, 4.0), s.1 + random_int(-2.0, 3.0));
		let from = if walkable(&self.w, &ground, near.0, near.1) { near } else { s };
		let at = free_cell_near(&self.w, &ground, from, &|k| avoid.iter().any(|a| a == k), 8).unwrap_or(s);
		Ok(obj! { "charId" => id("c"), "accountId" => j::at(account, "accountId").clone(), "name" => j::at(account, "name").clone(), "room" => rid, "x" => at.0, "y" => at.1, "skin" => random_int(0.0, j::a(&self.w, "skins").len() as f64), "guest" => j::at(account, "guest").clone() })
	}

	fn token_ok(&self, got: &str) -> bool {
		let Some(t) = &self.setup_token else { return false };
		equal_time(&Sha256::digest(t.as_bytes()), &Sha256::digest(got.as_bytes()))
	}
}

/// `String(x ?? "")` for what a body gave.
pub fn text_of(v: &Json) -> String {
	match v { Json::Null => String::new(), Json::String(s) => s.clone(), Json::Bool(b) => b.to_string(), Json::Number(n) => phi_json::number_text(*n), Json::Array(_) | Json::Object(_) => mmo_engine::fire::key_text(v) }
}

#[cfg(test)]
mod tests {
	#[tokio::test]
	async fn scrypt_as_node() {
		let salt: Vec<u8> = (0..16).map(|i| (i * 17) as u8).collect();
		let got = super::scrypt("pässwort-1".into(), salt).await;
		assert_eq!(mmo_engine::source::hex(&got), "22632b457a008a4532a0fde2659ed71286d98ca16e0aab5316b73f54efeab2b050bf7bad67da4385aaeae7f54756ade1df16b9630c80feb3b1cf4c33f8c0ed4d");
		assert_eq!(super::sha256_hex("ab"), "fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603");
	}
}
