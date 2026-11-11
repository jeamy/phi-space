//! The web process of spaces-mmo in Rust (`server/index.ts`, R8.5): HTTP and the game WebSocket around the page (the
//! export in out/), accounts and logins, the gateway for playing browsers, chat, statistics, the operator's window and
//! the world's graphics. It holds no game state: the world lives in the world spaces, logins in the accounts space.
//! Every POST must carry the header `x-mmo: 1`; the cookie is SameSite=Strict.
pub mod accounts;
pub mod admin;
pub mod chat;
pub mod gateway;
pub mod omap;
pub mod pages;
pub mod regions;
pub mod stats;
pub mod views;
pub mod ws;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use mmo_engine::j;
use mmo_engine::source::time_now;
use mmo_engine::space::Space;
use phi_json::{obj, Json};
use tokio::sync::watch;

use crate::accounts::{Accounts, Me};
use crate::gateway::Gateway;
use crate::regions::RegionSpaces;
use crate::stats::StatsCache;

pub fn env_ms(name: &str, fallback: f64) -> f64 { mmo_engine::world_host::env_ms(name, fallback) }

/// An error a request ends with: `Auth` is answered with its status and text (`AuthError`), `Other` with 500.
#[derive(Debug)]
pub enum WebError { Auth(u16, String), Other(String) }
impl std::fmt::Display for WebError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { match self { WebError::Auth(_, m) | WebError::Other(m) => f.write_str(m) } }
}
impl From<mmo_engine::space::Error> for WebError { fn from(e: mmo_engine::space::Error) -> Self { WebError::Other(e.to_string()) } }
impl From<phi_spaces_client::Error> for WebError { fn from(e: phi_spaces_client::Error) -> Self { WebError::Other(e.to_string()) } }
pub type WebResult<T> = Result<T, WebError>;

const COOKIE: &str = "mmo_sid";
const DEFAULT_SPACE: &str = "unix:/tmp/spaces-mmo-world.sock";
const DEFAULT_ACCOUNTS: &str = "unix:/tmp/spaces-mmo-accounts.sock";

/// At most `limit` hits per key in a sliding window (at most 4096 tracked keys).
struct Quota { limit: f64, window_ms: f64, seen: RefCell<HashMap<String, (f64, f64)>> }
impl Quota {
	fn new(limit: f64, window_ms: f64) -> Self { Self { limit, window_ms, seen: RefCell::default() } }
	fn hit(&self, key: &str) -> bool {
		let now = time_now();
		let mut seen = self.seen.borrow_mut();
		if seen.len() >= 4096 { seen.retain(|_, v| now - v.0 < self.window_ms); }
		let fresh = seen.get(key).is_none_or(|v| now - v.0 >= self.window_ms);
		if fresh {
			if !seen.contains_key(key) && seen.len() >= 4096 { return false; }
			seen.insert(key.to_owned(), (now, 0.0));
		}
		let v = seen.get_mut(key).expect("the key");
		v.1 += 1.0;
		v.1 <= self.limit
	}
}

fn env_number(name: &str, def: f64) -> f64 { std::env::var(name).map_or(def, |v| mmo_engine::js::to_number(&v)) }

struct Web {
	root: PathBuf,
	w: Rc<Json>,
	regions: Rc<RegionSpaces>,
	store: Space,
	accounts: Rc<Accounts>,
	gateway: Rc<Gateway>,
	stats: StatsCache,
	build: Option<String>,
	pages: Option<PathBuf>,
	allowed: Quota, login_by_ip: Quota, login_by_name: Quota, guests_by_ip: Quota, registrations_by_ip: Quota,
	sockets: Cell<usize>,
	system: RefCell<Option<(f64, Json)>>,
}

type Resp = Response<Full<Bytes>>;

fn json(status: u16, body: &Json, extra: &[(&str, String)]) -> Resp {
	let mut r = Response::builder().status(status).header("content-type", "application/json; charset=utf-8").header("cache-control", "no-store");
	for (k, v) in extra { r = r.header(*k, v.as_str()); }
	r.body(Full::new(Bytes::from(body.to_json_text()))).expect("a response")
}
fn error(status: u16, text: &str) -> Resp { json(status, &obj! { "error" => text }, &[]) }
fn plain(status: u16, ty: &str, text: &'static str) -> Resp { Response::builder().status(status).header("content-type", ty).body(Full::new(Bytes::from_static(text.as_bytes()))).expect("a response") }

fn header<'a>(req: &'a Request<Incoming>, k: &str) -> Option<&'a str> { req.headers().get(k).and_then(|v| v.to_str().ok()) }
fn cookie_of(req: &Request<Incoming>, name: &str) -> Option<String> {
	let all: Vec<&str> = req.headers().get_all("cookie").iter().filter_map(|v| v.to_str().ok()).collect();
	for part in all.join("; ").split(';') {
		if let Some(i) = part.find('=') { if i > 0 && part[..i].trim() == name { return Some(part[i + 1..].trim().to_owned()); } }
	}
	None
}
/// The client address: behind the local reverse proxy (loopback peer) the last x-forwarded-for hop, else the peer.
fn client_ip(req: &Request<Incoming>, peer: &SocketAddr) -> String {
	let p = match peer.ip() { std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or_else(|| v6.to_string(), |v4| format!("::ffff:{v4}")), ip => ip.to_string() };
	let loopback = p.starts_with("127.") || p == "::1" || p.starts_with("::ffff:127.");
	let Some(xff) = header(req, "x-forwarded-for").filter(|x| !mmo_engine::js::trim(x).is_empty()) else { return p };
	if !loopback { return p; }
	let last = mmo_engine::js::trim(xff.rsplit(',').next().unwrap_or(""));
	if last.is_empty() { p } else { last.to_owned() }
}
/// `URL.parse(origin)?.host`.
fn origin_host(origin: &str) -> Option<String> {
	let (scheme, rest) = origin.split_once("://")?;
	let scheme = scheme.to_lowercase();
	if !scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) { return None; }
	let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
	let auth = auth.rsplit('@').next().unwrap_or("");
	if auth.is_empty() { return None; }
	let (host, port) = match auth.rfind(':') { Some(i) if !auth[i..].contains(']') => (&auth[..i], Some(&auth[i + 1..])), _ => (auth, None) };
	let host = host.to_lowercase();
	let default = match scheme.as_str() { "http" | "ws" => Some("80"), "https" | "wss" => Some("443"), _ => None };
	Some(match port.filter(|p| !p.is_empty()) {
		Some(p) => { let p = p.trim_start_matches('0'); let p = if p.is_empty() { "0" } else { p }; if Some(p) == default { host } else { format!("{host}:{p}") } }
		None => host,
	})
}

/// The world's graphics: `/assets/<world>/<path>`.
fn world_asset(root: &Path, id: &str, path: &str) -> Option<(Vec<u8>, &'static str)> {
	let id_ok = !id.is_empty() && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
	let (stem, ext) = path.rsplit_once('.')?;
	let part_ok = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
	if !id_ok || !["png", "md"].contains(&ext) || !stem.split('/').all(part_ok) { return None; }
	let body = std::fs::read(root.join("worlds").join(id).join("assets").join(path)).ok()?;
	Some((body, if ext == "png" { "image/png" } else { "text/markdown; charset=utf-8" }))
}

impl Web {
	fn me_view(&self, me: Option<&Me>) -> Json {
		let account = me.map_or(Json::Null, |m| {
			let mut o = phi_json::Object::new();
			o.insert("name", Json::from(m.name.as_str()));
			o.insert("guest", Json::Bool(m.guest));
			o.insert("admin", Json::Bool(m.admin));
			if let Some(a) = m.alias.as_ref().filter(|a| !a.is_empty()) { o.insert("alias", Json::from(a.as_str())); }
			Json::Object(o)
		});
		obj! { "account" => account, "world" => obj! { "id" => j::at(&self.w, "id").clone(), "title" => j::at(&self.w, "title").clone() }, "build" => self.build.clone().map_or(Json::Null, Json::from) }
	}
	/// The system bar's hosts, read at most once in five seconds.
	async fn system(&self) -> WebResult<Json> {
		if let Some((at, v)) = self.system.borrow().as_ref() { if time_now() - at <= 5_000.0 { return Ok(v.clone()); } }
		let at = time_now();
		let mut spaces: Vec<Space> = self.regions.entries().iter().map(|(_, s)| s.clone()).collect();
		spaces.push(self.store.clone());
		let mut procs: Vec<Json> = Vec::new();
		let mut entries = 0.0;
		for s in &spaces { for e in s.remote().read_all(&obj! { "type" => "Process" }, Some(200.0), None).await? { procs.push(mmo_engine::space::fields(&e).clone()); } }
		for s in &spaces { entries += s.remote().count(&Json::Null, None).await?; }
		procs.sort_by(|a, b| j::n(a, "startedAt").total_cmp(&j::n(b, "startedAt")));
		let mut hosts: omap::OMap<(Json, Vec<String>)> = omap::OMap::default();
		for p in procs {
			let name = j::s(&p, "name").to_owned();
			let role = j::s(&p, "role").to_owned();
			match hosts.get_mut(&name) { Some(h) => { if !h.1.contains(&role) { h.1.push(role); } } None => hosts.set(&name, (p, vec![role])) }
		}
		let order = ["space", "world", "npc", "model", "web"];
		let v = obj! {
			"hosts" => Json::Array(hosts.iter().map(|(_, (host, roles))| obj! { "name" => j::at(host, "name").clone(), "roles" => Json::Array(order.iter().filter(|r| roles.iter().any(|x| x == *r)).map(|r| Json::from(*r)).collect()), "host" => host.clone() }).collect()),
			"entries" => entries
		};
		*self.system.borrow_mut() = Some((at, v.clone()));
		Ok(v)
	}

	async fn handle(self: Rc<Self>, req: Request<Incoming>, peer: SocketAddr) -> Result<Resp, std::io::Error> {
		let upgrade = req.headers().contains_key("upgrade") && header(&req, "connection").is_some_and(|c| c.to_lowercase().split(',').any(|x| x.trim() == "upgrade"));
		if upgrade { return self.upgrade(req, peer).await; }
		Ok(match self.route(req, peer).await {
			Ok(r) => r,
			Err(WebError::Auth(status, m)) => error(status, &m),
			Err(WebError::Other(m)) => { eprintln!("[web] {m}"); error(500, "Das ging gerade nicht; bitte noch einmal") }
		})
	}

	async fn route(&self, req: Request<Incoming>, peer: SocketAddr) -> WebResult<Resp> {
		let p = req.uri().path().to_owned();
		let method = req.method().clone();
		if p == "/healthz" { return Ok(json(200, &obj! { "ok" => true }, &[])); }
		if method == Method::GET {
			if let Some(rest) = p.strip_prefix("/assets/") {
				if let Some((id, path)) = rest.split_once('/').filter(|(id, path)| !id.is_empty() && !path.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')) {
					return Ok(match world_asset(&self.root, id, path) {
						Some((body, ty)) => Response::builder().status(200).header("content-type", ty).header("cache-control", "public, max-age=3600").body(Full::new(Bytes::from(body))).expect("a response"),
						None => plain(404, "text/plain", "Not found"),
					});
				}
			}
		}
		if p.starts_with("/api/") { return self.api(req, peer, &p).await; }
		if let Some(dir) = &self.pages {
			if method == Method::GET || method == Method::HEAD {
				let head = method == Method::HEAD;
				let send = |status: u16, f: &Path| -> Resp {
					let body = std::fs::read(f).unwrap_or_default();
					let immutable = status == 200 && p.starts_with("/_next/static/");
					let r = Response::builder().status(status).header("content-type", pages::type_of(f)).header("content-length", body.len().to_string())
						.header("cache-control", if immutable { "public, max-age=31536000, immutable" } else { "no-cache" });
					r.body(Full::new(if head { Bytes::new() } else { Bytes::from(body) })).expect("a response")
				};
				if let Some(f) = pages::page_file(dir, &p) { return Ok(send(200, &f)); }
				let missing = dir.join("404.html");
				if missing.is_file() { return Ok(send(404, &missing)); }
				return Ok(plain(404, "text/plain; charset=utf-8", "Not found"));
			}
		}
		Ok(plain(404, "text/plain", "Not found"))
	}

	async fn api(&self, req: Request<Incoming>, peer: SocketAddr, p: &str) -> WebResult<Resp> {
		let ip = client_ip(&req, &peer);
		if !self.allowed.hit(&ip) { return Ok(error(429, "Zu viele Anfragen; bitte in einer Minute noch einmal")); }
		let sid = cookie_of(&req, COOKIE);
		let get = req.method() == Method::GET;
		if get {
			match p {
				"/api/me" => { let me = self.accounts.resolve(sid.as_deref()).await?; return Ok(json(200, &self.me_view(me.as_ref()), &[])); }
				"/api/system" => return Ok(json(200, &self.system().await?, &[])),
				"/api/stats" => {
					if self.accounts.resolve(sid.as_deref()).await?.is_none() { return Err(WebError::Auth(401, "Bitte erst anmelden".into())); }
					return Ok(json(200, &self.stats.get().await, &[]));
				}
				"/api/admin/settings" => {
					if !self.accounts.resolve(sid.as_deref()).await?.is_some_and(|m| m.admin) { return Err(WebError::Auth(403, "Nur für Admins".into())); }
					return Ok(json(200, &admin::admin_settings(&self.regions, None).await?, &[]));
				}
				"/api/admin/reports" => {
					if !self.accounts.resolve(sid.as_deref()).await?.is_some_and(|m| m.admin) { return Ok(error(403, "Nur für Admins")); }
					return Ok(json(200, &obj! { "reports" => self.gateway.chat_reports().await }, &[]));
				}
				_ => {}
			}
		}
		if req.method() != Method::POST { return Ok(error(405, "POST erwartet")); }
		if header(&req, "x-mmo") != Some("1") { return Ok(error(403, "Header x-mmo fehlt")); }
		let (parts, mut body) = req.into_parts();
		let req = Request::from_parts(parts, ());
		let mut bytes: Vec<u8> = Vec::new();
		while let Some(f) = body.frame().await {
			let f = f.map_err(|e| WebError::Other(e.to_string()))?;
			if let Some(d) = f.data_ref() {
				if bytes.len() + d.len() > 16_000 { return Err(WebError::Auth(413, "Anfrage zu groß".into())); }
				bytes.extend_from_slice(d);
			}
		}
		let b = if bytes.is_empty() { Json::Object(phi_json::Object::new()) } else {
			std::str::from_utf8(&bytes).ok().and_then(|s| phi_json::parse(s).ok()).ok_or_else(|| WebError::Auth(400, "Ungültiges JSON".into()))?
		};
		let hdr = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
		let secure = hdr("x-forwarded-proto").as_deref() == Some("https");
		let cookie = |sid: Option<&str>| -> String {
			let s = if secure { "; Secure" } else { "" };
			match sid { Some(x) => format!("{COOKIE}={x}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{s}", (self.accounts.web_session_ms / 1000.0).floor()), None => format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{s}") }
		};
		let sign_in = |me: Me| async move {
			self.accounts.close_session(sid.as_deref()).await?;
			let new = self.accounts.open_session(&me.account_id).await?;
			Ok::<Resp, WebError>(json(200, &self.me_view(Some(&me)), &[("set-cookie", cookie(Some(&new)))]))
		};
		let token = j::so(&b, "setupToken").map(str::to_owned);
		match p {
			"/api/guest" => {
				if !self.guests_by_ip.hit(&ip) { return Ok(error(429, "Zu viele neue Gäste von dieser Adresse; bitte später noch einmal")); }
				let me = self.accounts.create_guest().await?;
				sign_in(me).await
			}
			"/api/register" => {
				if !self.registrations_by_ip.hit(&ip) { return Ok(error(429, "Zu viele Registrierungen von dieser Adresse heute")); }
				let current = self.accounts.resolve(cookie_of_parts(&req).as_deref()).await?;
				let guest = current.filter(|c| c.guest).map(|c| c.account_id);
				let me = self.accounts.register(j::at(&b, "name"), j::at(&b, "password"), guest.as_deref(), token.as_deref()).await?;
				sign_in(me).await
			}
			"/api/login" => {
				let name = mmo_engine::js::lower(mmo_engine::js::trim(&crate::accounts::text_of(b.get("name").filter(|v| !v.is_null()).unwrap_or(&Json::from("")))));
				if !self.login_by_ip.hit(&ip) || !self.login_by_name.hit(&name) { return Ok(error(429, "Zu viele Anmeldeversuche; bitte in einer Minute noch einmal")); }
				let me = self.accounts.login(j::at(&b, "name"), j::at(&b, "password"), token.as_deref().filter(|t| !t.is_empty())).await?;
				sign_in(me).await
			}
			"/api/alias" => {
				let Some(me) = self.accounts.resolve(cookie_of_parts(&req).as_deref()).await? else { return Ok(error(401, "Nicht angemeldet")) };
				if !self.login_by_ip.hit(&ip) { return Ok(error(429, "Zu viele Versuche; bitte in einer Minute noch einmal")); }
				let alias = Json::from(crate::accounts::text_of(b.get("alias").filter(|v| !v.is_null()).unwrap_or(&Json::from(""))));
				let me = self.accounts.set_alias(&me.account_id, &alias).await?;
				Ok(json(200, &self.me_view(Some(&me)), &[]))
			}
			"/api/admin/settings" => {
				if !self.accounts.resolve(cookie_of_parts(&req).as_deref()).await?.is_some_and(|m| m.admin) { return Err(WebError::Auth(403, "Nur für Admins".into())); }
				Ok(json(200, &admin::admin_settings(&self.regions, Some(&b)).await?, &[]))
			}
			"/api/logout" => {
				self.accounts.close_session(cookie_of_parts(&req).as_deref()).await?;
				Ok(json(200, &self.me_view(None), &[("set-cookie", cookie(None))]))
			}
			_ => Ok(error(404, "Unbekannter Aufruf")),
		}
	}

	/// A WebSocket upgrade: only `/ws`, from this site's own pages, with a session.
	async fn upgrade(self: Rc<Self>, mut req: Request<Incoming>, peer: SocketAddr) -> Result<Resp, std::io::Error> {
		let destroy = || Err(std::io::Error::other("destroyed"));
		if req.uri().path() != "/ws" { return destroy(); }
		if let Some(origin) = header(&req, "origin") { if origin_host(origin).as_deref() != header(&req, "host") { return destroy(); } }
		if self.sockets.get() >= 1024 || !self.allowed.hit(&client_ip(&req, &peer)) { return destroy(); }
		let Ok(Some(me)) = self.accounts.resolve(cookie_of(&req, COOKIE).as_deref()).await else { return destroy() };
		let Some(accept) = ws::accept_of(req.method(), req.headers()) else { return destroy() };
		let on = hyper::upgrade::on(&mut req);
		let web = self.clone();
		tokio::task::spawn_local(async move {
			let Ok(io) = on.await else { return };
			let (conn, messages, waiting) = ws::start(io, 600);
			web.sockets.set(web.sockets.get() + 1);
			{ let w = Rc::downgrade(&web); conn.on_close(Box::new(move || { if let Some(w) = w.upgrade() { w.sockets.set(w.sockets.get().saturating_sub(1)); } })); }
			web.gateway.attach(conn, me, messages, waiting).await;
		});
		Ok(Response::builder().status(StatusCode::SWITCHING_PROTOCOLS).header("upgrade", "websocket").header("connection", "Upgrade").header("sec-websocket-accept", accept).body(Full::new(Bytes::new())).expect("a response"))
	}
}

fn cookie_of_parts(req: &Request<()>) -> Option<String> {
	let all: Vec<&str> = req.headers().get_all("cookie").iter().filter_map(|v| v.to_str().ok()).collect();
	for part in all.join("; ").split(';') {
		if let Some(i) = part.find('=') { if i > 0 && part[..i].trim() == COOKIE { return Some(part[i + 1..].trim().to_owned()); } }
	}
	None
}

/// Starts the web process from its environment and serves until `halt` turns true; `ready` gets the address it
/// listens on.
pub async fn run_web(root: PathBuf, ready: impl FnOnce(&str), mut halt: watch::Receiver<bool>) -> Result<(), String> {
	let id = std::env::var("SPACES_MMO_WORLD").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "leuchtfeuer".into());
	let w = Rc::new(mmo_engine::world::load_world(&root, &id).map_err(|e| e.to_string())?);
	let whole = std::env::var("SPACES_MMO_SPACE").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_SPACE.into());
	let regions = Rc::new(RegionSpaces::connect(&w, &whole).map_err(|e| e.to_string())?);
	let accounts_addr = std::env::var("SPACES_MMO_ACCOUNTS").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_ACCOUNTS.into());
	let store = mmo_engine::world_host::connect(&accounts_addr).map_err(|e| e.to_string())?;
	let accounts = Rc::new(Accounts::new(regions.clone(), store.clone(), (*w).clone()));
	let pages = if std::env::var("SPACES_MMO_NO_NEXT").as_deref() == Ok("1") { None } else {
		let p = std::env::var("SPACES_MMO_PAGES").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "out".into());
		let dir = root.join(p);
		if pages::exported_build(&dir).is_none() { eprintln!("[web] no exported page in {} (npm run build writes it)", dir.display()); }
		Some(dir)
	};
	let build = match std::env::var("SPACES_MMO_BUILD_ID") {
		Ok(b) => Some(b).filter(|b| !b.is_empty()),
		Err(_) => pages.as_deref().and_then(pages::exported_build).or_else(|| std::fs::read_to_string(root.join(".next").join("BUILD_ID")).ok().map(|s| mmo_engine::js::trim(&s).to_owned())),
	};
	let on_activity: Box<dyn Fn(&str)> = { let a = Rc::downgrade(&accounts); Box::new(move |account_id: &str| {
		let (Some(a), id) = (a.upgrade(), account_id.to_owned()) else { return };
		tokio::task::spawn_local(async move { let _ = a.touch_guest(&id).await; });
	}) };
	let gateway = Gateway::new(regions.clone(), w.clone(), on_activity, build.clone(), Some(store.clone()));
	let proc = mmo_engine::world_host::announce(regions.home_space().clone(), "web", halt.clone());
	let web = Rc::new(Web {
		root: root.clone(), w: w.clone(), stats: StatsCache::new(regions.clone(), w.clone()), regions, store, accounts, gateway, build, pages,
		allowed: Quota::new(env_number("SPACES_MMO_REQ_PER_MIN", 120.0), 60_000.0), login_by_ip: Quota::new(10.0, 60_000.0), login_by_name: Quota::new(10.0, 60_000.0),
		guests_by_ip: Quota::new(env_number("SPACES_MMO_GUESTS_PER_HOUR", 5.0), 3_600_000.0), registrations_by_ip: Quota::new(env_number("SPACES_MMO_REGISTRATIONS_PER_DAY", 20.0), 24.0 * 3_600_000.0),
		sockets: Cell::new(0), system: RefCell::new(None),
	});
	let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3900);
	let bind = std::env::var("SPACES_MMO_BIND").ok().unwrap_or_else(|| "127.0.0.1".into());
	let listener = tokio::net::TcpListener::bind((bind.as_str(), port)).await.map_err(|e| format!("listen on {bind}:{port}: {e}"))?;
	let actual = listener.local_addr().map_err(|e| e.to_string())?.port();
	ready(&format!("http://127.0.0.1:{actual}"));
	loop {
		tokio::select! {
			a = listener.accept() => {
				let Ok((stream, peer)) = a else { continue };
				let web = web.clone();
				tokio::task::spawn_local(async move {
					let svc = hyper::service::service_fn(move |req| web.clone().handle(req, peer));
					let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).with_upgrades().await;
				});
			}
			_ = halt.wait_for(|h| *h) => break,
		}
	}
	web.gateway.close();
	let _ = tokio::time::timeout(std::time::Duration::from_secs(2), proc).await;
	Ok(())
}
