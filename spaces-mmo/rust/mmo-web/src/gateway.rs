//! The gateway for playing browsers (`server/gateway.ts`): it reads the world once and follows each region's change
//! stream, keeps what a page shows (characters, things, fires, fog, trade, notices), greets a page with its room, tells it
//! what changes there, and writes what the player types as an Intent for a world worker.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::time::Duration;

use mmo_engine::commands::interior::interior_of;
use mmo_engine::commands::wild::wild_kinds;
use mmo_engine::context::NOTICE_MS;
use mmo_engine::fire::key_text as txt;
use mmo_engine::j;
use mmo_engine::js;
use mmo_engine::liner::{bays_of, liner_of};
use mmo_engine::regions::region_of_room;
use mmo_engine::settings::setting;
use mmo_engine::source::{hex, random_bytes, time_now};
use mmo_engine::space::{fields, tmpl, Space};
use mmo_engine::world::scenery_text;
use mmo_engine::world_host::ms_until_world;
use mmo_engine::worldtime::{decay_at, world_at};
use phi_json::{obj, Json, Object};
use phi_spaces_client::{cut_text, Error as SpaceError, Opts};
use tokio::sync::{mpsc, oneshot, watch};

use crate::accounts::Me;
use crate::chat::{is_chat_frame, is_chat_line, Chat, ChatUser};
use crate::omap::OMap;
use crate::regions::RegionSpaces;
use crate::views::*;
use crate::ws::WsConn;

const NOTICES_SHOWN: usize = 200;
const MAX_LINE: usize = 300;
const RECENT: usize = 40;
const INTENT_LEASE_MS: f64 = 30_000.0;
const STEP_BURST: f64 = 8.0;
const STEP_REFILL_MS: f64 = 100.0;
const MAX_PAGES: usize = 4;
const ATLAS_MS: u64 = 1_000;

#[derive(Clone, Copy)]
struct Bucket { left: f64, at: f64 }
/// Takes one from the bucket (refilled by the time passed); false when it is empty.
fn spend(b: &mut Bucket, burst: f64, refill_ms: f64) -> bool {
	let now = time_now();
	b.left = burst.min(b.left + (now - b.at) / refill_ms);
	b.at = now;
	if b.left < 1.0 { return false; }
	b.left -= 1.0;
	true
}
struct Limits { steps: Bucket, cmds: Bucket }

pub struct Client {
	ws: Rc<WsConn>,
	me: Me,
	lang: RefCell<Option<String>>,
	room: RefCell<Option<String>>,
	lease: RefCell<Option<String>>,
	lease_region: RefCell<Option<String>>,
	awaits_hello: Cell<bool>,
	atlas: Cell<bool>,
	limits: Rc<RefCell<Limits>>,
	warned: Cell<f64>,
	timer: RefCell<Option<tokio::task::JoinHandle<()>>>,
}
impl Client { fn room(&self) -> Option<String> { self.room.borrow().clone() } }

#[derive(Default)]
struct State {
	chars: OMap<Json>, char_of: HashMap<String, String>, char_entry: HashMap<String, String>, sessions: HashMap<String, String>, online: HashMap<String, f64>,
	rooms: OMap<Json>, winds: HashMap<String, f64>,
	objs: OMap<Json>, obj_of: HashMap<String, String>, obj_entry: HashMap<String, String>,
	objs_by_loc: HashMap<String, OMap<()>>, atlas_objs: OMap<()>,
	recent: HashMap<String, Vec<Json>>, flames: HashMap<String, f64>, flame_of: OMap<String>, fog: OMap<f64>,
	clock: Option<Json>,
	offers: OMap<Json>, orders: OMap<Json>, listings: OMap<Json>, wanted: OMap<Json>, notices: OMap<Json>, notices_by_char: HashMap<String, OMap<()>>, seed_rests: OMap<Json>, epochs: OMap<Json>, site_orders: OMap<Json>, mill_loads: OMap<Json>, herds: HashMap<String, Json>,
	applied: HashMap<String, f64>, char_region: HashMap<String, String>,
}

/// What every client's atlas state shares (Gateway::atlas_shared).
struct AtlasShared {
	owned: HashMap<String, Vec<Json>>, tasks: HashMap<String, Vec<Json>>,
	people: Json, world_now: Option<f64>, lit: Json, patient: f64, decay_now: Option<f64>, fog: Json, epochs: Json, pack_max: Json, stops: Json,
}

/// A hello waiting for a region's stream to reach a revision.
type Waiter = (String, f64, Option<oneshot::Sender<()>>);

pub struct Gateway {
	pub session_lease_ms: f64,
	closed: Cell<bool>,
	regions: Rc<RegionSpaces>,
	space: Space,
	w: Rc<Json>,
	build: Option<String>,
	on_activity: Box<dyn Fn(&str)>,
	st: RefCell<State>,
	clients: RefCell<Vec<Rc<Client>>>,
	waiting: RefCell<Vec<Waiter>>,
	ready: watch::Sender<bool>,
	atlas_due: Cell<bool>,
	atlas_geometry: Cell<bool>,
	year_days: Cell<f64>, beam_cost: Cell<f64>, pack_max: Cell<Option<f64>>, epoch_force: Cell<f64>,
	cmd_burst: Cell<f64>, cmd_per_sec: Cell<f64>,
	model_chars: HashSet<String>, model_names: HashSet<String>, proto_icons: Vec<(String, String)>, world_base: Object,
	pub chat: RefCell<Option<Rc<Chat>>>,
	deferred: RefCell<Vec<Rc<Client>>>,
	me: RefCell<Weak<Gateway>>,
}

fn now() -> f64 { time_now() }
fn error_msg(text: &str) -> Json { obj! { "t" => "msg", "m" => obj! { "kind" => "error", "text" => text, "from" => "", "at" => now() } } }
fn is_safe_int(v: &Json) -> bool { v.as_f64().is_some_and(phi_json::safe_integer) }
fn unit(v: &Json) -> Option<f64> { v.as_f64().filter(|d| *d == -1.0 || *d == 0.0 || *d == 1.0) }
fn strip_controls(s: &str) -> String { s.chars().map(|c| if (c as u32) < 0x20 || c as u32 == 0x7f { ' ' } else { c }).collect() }

fn is_atlas_kind(kind: &str) -> bool { matches!(kind, "site" | "building" | "bed" | "field" | "ruin" | "road" | "beacon") }

fn build_world_base(w: &Json, proto_icons: &[(String, String)]) -> Object {
	let mut world = obj_of(obj! { "id" => j::at(w, "id").clone(), "title" => j::at(w, "title").clone(), "tileSize" => j::at(w, "tileSize").clone(), "tiles" => j::at(w, "tiles").clone(), "skins" => j::at(w, "skins").clone() });
	if j::truthy(j::at(w, "decor")) { world.insert("decor", j::at(w, "decor").clone()); }
	world.insert("fuels", Json::Array(j::entries(j::at(j::at(w, "fire"), "fuel")).map(|(k, _)| Json::from(proto_name(w, k))).collect()));
	let mut icons: Vec<String> = Vec::new();
	for (_, i) in proto_icons { if !icons.contains(i) { icons.push(i.clone()); } }
	if j::truthy(j::at(w, "wild")) { let i = format!("/assets/{}/{}", j::s(w, "id"), txt(j::at(j::at(j::at(w, "wild"), "hare"), "icon"))); if !icons.contains(&i) { icons.push(i); } }
	world.insert("icons", Json::Array(icons.into_iter().map(Json::from).collect()));
	world.insert("plans", plans_of(w));
	world.insert("uses", uses_of(w));
	if j::truthy(j::at(w, "liner")) {
		if let Some(t) = liner_of(w) {
			let all_rooms = j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms"));
			world.insert("liner", obj! {
				"stops" => Json::Array(t.stops.iter().map(|s| obj! { "island" => s.island.as_str(), "room" => s.room.as_str(), "x" => s.x, "y" => s.y }).collect()),
				"stayMs" => t.stay_ms, "legMs" => Json::Array(t.leg_ms.iter().map(|x| Json::Number(*x)).collect()), "cycleMs" => t.cycle_ms,
				"island" => "", "fare" => j::at(j::at(w, "liner"), "fare").clone(),
				"routes" => Json::Array(bays_of(all_rooms).into_iter().map(|(i, r)| obj! { "island" => i, "room" => j::at(r, "roomId").clone() }).collect())
			});
		}
	}
	if j::truthy(j::at(w, "rail")) {
		let rail = j::at(w, "rail");
		let mut r = obj_of(obj! { "plan" => j::at(rail, "plan").clone() });
		if j::truthy(j::at(rail, "everyWorldMs")) { r.insert("everyWorldMs", j::at(rail, "everyWorldMs").clone()); }
		world.insert("rail", Json::Object(r));
	}
	world
}

impl Gateway {
	pub fn new(regions: Rc<RegionSpaces>, w: Rc<Json>, on_activity: Box<dyn Fn(&str)>, build: Option<String>, chat_space: Option<Space>) -> Rc<Gateway> {
		let model_chars = j::a(&w, "npcs").iter().filter(|n| j::truthy(j::at(n, "model"))).map(|n| format!("npc-{}", j::s(n, "npcId"))).collect();
		let model_names = j::a(&w, "npcs").iter().filter(|n| j::truthy(j::at(n, "model"))).map(|n| j::s(n, "name").to_owned()).collect();
		let id = j::s(&w, "id").to_owned();
		let proto_icons: Vec<(String, String)> = j::a(&w, "prototypes").iter().filter(|p| j::truthy(j::at(p, "icon"))).map(|p| (j::s(p, "key").to_owned(), format!("/assets/{id}/{}", txt(j::at(p, "icon"))))).collect();
		let world_base = build_world_base(&w, &proto_icons);
		let (ready, _) = watch::channel(false);
		let g = Rc::new(Gateway {
			session_lease_ms: crate::env_ms("SPACES_MMO_SESSION_LEASE_MS", 30_000.0),
			closed: Cell::new(false), space: regions.home_space().clone(), regions, w, build, on_activity,
			st: RefCell::default(), clients: RefCell::default(), waiting: RefCell::default(), ready,
			atlas_due: Cell::new(false), atlas_geometry: Cell::new(false),
			year_days: Cell::new(0.0), beam_cost: Cell::new(1.0), pack_max: Cell::new(None), epoch_force: Cell::new(0.0),
			cmd_burst: Cell::new(20.0), cmd_per_sec: Cell::new(5.0),
			model_chars, model_names, proto_icons, world_base, chat: RefCell::new(None), deferred: RefCell::default(), me: RefCell::new(Weak::new()),
		});
		*g.me.borrow_mut() = Rc::downgrade(&g);
		g.refresh_settings();
		if let Some(s) = chat_space { *g.chat.borrow_mut() = Some(Chat::new(s, Rc::downgrade(&g))); }
		let n = g.regions.entries().len();
		let left = Rc::new(Cell::new(n));
		for (region, space) in g.regions.entries().to_vec() {
			let (g2, left) = (g.clone(), left.clone());
			tokio::task::spawn_local(async move { g2.follow(region, space, left).await });
		}
		// a regular reminder of the hour; the time moves the tasks on without any entry changing
		{
			let g2 = Rc::downgrade(&g);
			tokio::task::spawn_local(async move {
				loop {
					tokio::time::sleep(Duration::from_secs(30)).await;
					let Some(g) = g2.upgrade() else { return };
					if g.closed.get() { return; }
					g.broadcast_time();
					g.atlas_changed(false);
				}
			});
		}
		g
	}
	pub fn close(&self) { self.closed.set(true); if let Some(c) = self.chat.borrow().as_ref() { c.close(); } let cs: Vec<Rc<Client>> = self.clients.borrow().clone(); for c in cs { c.ws.close(); } }
	fn rc(&self) -> Rc<Gateway> { self.me.borrow().upgrade().expect("the gateway") }
	fn refresh_settings(&self) {
		let (g, s, pack) = (Rc::downgrade(&self.rc()), self.space.clone(), j::truthy(j::at(&self.w, "pack")));
		tokio::task::spawn_local(async move {
			let (b, e, cb, cp, p) = (
				setting(&s, "beam.cost").await, setting(&s, "epoch.force").await,
				setting(&s, "cmd.burst").await, setting(&s, "cmd.perSec").await,
				if pack { setting(&s, "pack.max").await.ok() } else { None },
			);
			let Some(g) = g.upgrade() else { return };
			if let Ok(b) = b { g.beam_cost.set(b); }
			if let Ok(e) = e { g.epoch_force.set(e); }
			if let Ok(cb) = cb { g.cmd_burst.set(cb); }
			if let Ok(cp) = cp { g.cmd_per_sec.set(cp); }
			if let Some(p) = p { g.pack_max.set(Some(p)); }
		});
	}
	fn icon_of(&self, proto: &str) -> Option<String> { self.proto_icons.iter().find(|(k, _)| k == proto).map(|(_, v)| v.clone()) }

	// ---- what chat asks of the gateway

	pub fn person(&self, name: &str) -> Option<Result<ChatUser, ()>> {
		let n = name.to_lowercase();
		let st = self.st.borrow();
		let c = st.chars.values().find(|x| j::s(x, "name").to_lowercase() == n)?;
		if j::s(c, "charId").starts_with("npc-") { return Some(Err(())); }
		Some(Ok(ChatUser { account_id: j::s(c, "accountId").to_owned(), name: j::s(c, "name").to_owned(), guest: j::truthy(j::at(c, "guest")) }))
	}
	pub fn name_of(&self, account_id: &str) -> String { self.st.borrow().chars.values().find(|x| j::s(x, "accountId") == account_id).map_or_else(String::new, |c| j::s(c, "name").to_owned()) }
	pub fn send_to(&self, account_id: &str, f: &Json) { for c in self.clients.borrow().iter() { if c.me.account_id == account_id { c.ws.send(f); } } }
	pub fn is_online(&self, account_id: &str) -> bool { self.clients.borrow().iter().any(|c| c.me.account_id == account_id) }
	pub async fn chat_reports(&self) -> Json { let chat = self.chat.borrow().clone(); match chat { Some(c) => c.reports().await.unwrap_or(Json::Array(vec![])), None => Json::Array(vec![]) } }

	fn player_names(&self) -> HashSet<String> { self.st.borrow().chars.values().filter(|c| !j::s(c, "charId").starts_with("npc-")).map(|c| j::s(c, "name").to_owned()).collect() }
	fn chat_user(&self, c: &Client) -> ChatUser {
		let name = self.st.borrow().chars.get(&c.me.char_id).map_or_else(|| c.me.name.clone(), |ch| j::s(ch, "name").to_owned());
		ChatUser { account_id: c.me.account_id.clone(), name, guest: c.me.guest }
	}
	fn wind_in(&self, room: &str) -> Json {
		let st = self.st.borrow();
		let island = st.rooms.get(room).map_or("", |r| j::s(r, "island")).to_owned();
		let level = st.winds.get(&island).copied().unwrap_or(1.0);
		j::a(j::at(&self.w, "wind"), "names").get(level as usize).cloned().filter(|x| !x.is_null()).unwrap_or_else(|| Json::from(""))
	}

	/// A browser of `me` plays now.
	pub async fn attach(&self, ws: Rc<WsConn>, me: Me, mut messages: mpsc::UnboundedReceiver<String>, waiting: Rc<Cell<(usize, usize)>>) {
		let mine: Vec<Rc<Client>> = self.clients.borrow().iter().filter(|x| x.me.account_id == me.account_id).cloned().collect();
		for old in mine.iter().take((mine.len() + 1).saturating_sub(MAX_PAGES)) { old.ws.close(); }
		let limits = match mine.last() { Some(m) => m.limits.clone(), None => Rc::new(RefCell::new(Limits { steps: Bucket { left: STEP_BURST, at: now() }, cmds: Bucket { left: self.cmd_burst.get(), at: now() } })) };
		let c = Rc::new(Client { ws: ws.clone(), me: me.clone(), lang: RefCell::new(None), room: RefCell::new(None), lease: RefCell::new(None), lease_region: RefCell::new(None), awaits_hello: Cell::new(false), atlas: Cell::new(false), limits, warned: Cell::new(0.0), timer: RefCell::new(None) });
		self.clients.borrow_mut().push(c.clone());
		{
			let (g, c2) = (Rc::downgrade(&self.rc()), Rc::downgrade(&c));
			ws.on_close(Box::new(move || {
				let (Some(g), Some(c)) = (g.upgrade(), c2.upgrade()) else { return };
				g.clients.borrow_mut().retain(|x| !Rc::ptr_eq(x, &c));
				if let Some(t) = c.timer.borrow_mut().take() { t.abort(); }
				let lease = c.lease.borrow_mut().take();
				if let Some(l) = lease {
					let region = c.lease_region.borrow().clone().unwrap_or_else(|| g.regions.home().to_owned());
					if let Some(s) = g.regions.get(&region).cloned() { tokio::task::spawn_local(async move { let _ = s.remote().cancel(&l, &Opts::default()).await; }); }
				}
			}));
		}
		// the page's messages, one after another
		{
			let (g, c) = (self.rc(), c.clone());
			tokio::task::spawn_local(async move {
				while let Some(text) = messages.recv().await {
					let (q, b) = waiting.get();
					waiting.set((q.saturating_sub(1), b.saturating_sub(text.len())));
					if c.ws.is_closed() { break; }
					g.inbound(&c, &text).await;
				}
			});
		}
		let mut ready = self.ready.subscribe();
		let _ = ready.wait_for(|r| *r).await;
		self.keep(&c).await;
		self.intent(&c, "arrive", None).await;
		{
			let (g, c2) = (Rc::downgrade(&self.rc()), Rc::downgrade(&c));
			let every = 1000f64.max((self.session_lease_ms / 3.0).floor());
			*c.timer.borrow_mut() = Some(tokio::task::spawn_local(async move {
				loop {
					tokio::time::sleep(Duration::from_millis(every as u64)).await;
					let (Some(g), Some(c)) = (g.upgrade(), c2.upgrade()) else { return };
					g.keep(&c).await;
				}
			}));
		}
		// read your writes: the hello waits until the stream has caught up with the space as it is now
		for (region, s) in self.regions.entries().to_vec() {
			let Ok(p) = s.remote().read_page(&obj! { "type" => "-" }, None, None, None, None, None).await else { break };
			if self.reach(&region, j::n(&p, "rev"), 5_000).await.is_err() { break; }
		}
		self.hello(&c);
		self.flush();
		let chat = self.chat.borrow().clone();
		if let Some(chat) = chat {
			let ws = c.ws.clone();
			if let Err(e) = chat.attach(&self.chat_user(&c), &move |f: &Json| ws.send(f)).await { eprintln!("[chat] attach: {e}"); }
		}
	}

	/// The session lives in the character's region.
	async fn keep(&self, c: &Rc<Client>) {
		let r: Result<(), SpaceError> = async {
			let region = self.region_of(&c.me.char_id).await;
			let old = c.lease.borrow().clone();
			let old_region = c.lease_region.borrow().clone();
			if let Some(l) = &old {
				if old_region.as_deref() != Some(region.as_str()) {
					let s = self.regions.get(old_region.as_deref().unwrap_or(self.regions.home())).cloned();
					if let Some(s) = s { let l = l.clone(); tokio::task::spawn_local(async move { let _ = s.remote().cancel(&l, &Opts::default()).await; }); }
					*c.lease.borrow_mut() = None;
				}
			}
			let space = self.regions.get(&region).cloned().expect("the region's space");
			let lease = c.lease.borrow().clone();
			if let Some(l) = lease {
				if space.remote().renew(&l, self.session_lease_ms, &Opts::default()).await.is_ok() { return Ok(()); }
				*c.lease.borrow_mut() = None;
			}
			if !self.has_client(c) { return Ok(()); }
			let e = space.remote().write(&tmpl("Session", obj! { "sessionId" => c.ws.id.as_str(), "charId" => c.me.char_id.as_str(), "accountId" => c.me.account_id.as_str() }), None, self.session_lease_ms, &Opts::default()).await?;
			let id = j::s(&e, "id").to_owned();
			*c.lease.borrow_mut() = Some(id.clone());
			*c.lease_region.borrow_mut() = Some(region);
			if !self.has_client(c) { let _ = space.remote().cancel(&id, &Opts::default()).await; }
			Ok(())
		}.await;
		if let Err(e) = r { eprintln!("[gateway] session: {e}"); }
	}
	fn has_client(&self, c: &Rc<Client>) -> bool { self.clients.borrow().iter().any(|x| Rc::ptr_eq(x, c)) }

	/// The region a character stands in; on a ferry the one it lands in is waited for.
	async fn region_of(&self, char_id: &str) -> String {
		if self.regions.size() == 1 { return self.regions.home().to_owned(); }
		for _ in 0..30 {
			if self.closed.get() { break; }
			{ let st = self.st.borrow(); if let (Some(r), true) = (st.char_region.get(char_id), st.chars.has(char_id)) { return r.clone(); } }
			tokio::time::sleep(Duration::from_millis(100)).await;
		}
		self.st.borrow().char_region.get(char_id).cloned().unwrap_or_else(|| self.regions.home().to_owned())
	}

	async fn reach(&self, region: &str, rev: f64, ms: u64) -> Result<(), ()> {
		if self.st.borrow().applied.get(region).copied().unwrap_or(-1.0) >= rev { return Ok(()); }
		let (tx, rx) = oneshot::channel();
		self.waiting.borrow_mut().push((region.to_owned(), rev, Some(tx)));
		match tokio::time::timeout(Duration::from_millis(ms), rx).await { Ok(Ok(())) => Ok(()), _ => Err(()) }
	}
	fn advance(&self, region: &str, rev: f64) {
		self.st.borrow_mut().applied.insert(region.to_owned(), rev);
		for w in self.waiting.borrow_mut().iter_mut() { if w.0 == region && w.1 <= rev { if let Some(t) = w.2.take() { let _ = t.send(()); } } }
		self.waiting.borrow_mut().retain(|w| w.2.as_ref().is_some_and(|t| !t.is_closed()));
	}

	fn world_time(&self) -> Json {
		let st = self.st.borrow();
		let Some(c) = &st.clock else { return Json::Null };
		let n = now();
		obj! { "epoch" => j::at(c, "epoch").clone(), "worldMs" => world_at(c, n), "rate" => j::at(c, "rate").clone(), "paused" => j::at(c, "paused").clone(), "serverNowMs" => n, "yearDays" => self.year_days.get(), "patience" => { let rate = j::n(c, "rate"); rate / j::no(c, "decayRate").unwrap_or(rate) } }
	}
	fn broadcast_time(&self) {
		{ let (g, s) = (Rc::downgrade(&self.rc()), self.space.clone()); tokio::task::spawn_local(async move { if let (Ok(d), Some(g)) = (setting(&s, "year.days").await, g.upgrade()) { g.year_days.set(d); } }); }
		let time = self.world_time();
		if time.is_null() { return; }
		let text = obj! { "t" => "time", "time" => time }.to_json_text();
		for c in self.clients.borrow().iter() { if c.room.borrow().is_some() { c.ws.send_text(&text); } }
	}

	async fn inbound(&self, c: &Rc<Client>, text: &str) {
		let Ok(f) = phi_json::parse(text) else { return };
		let t = j::s(&f, "t");
		if t == "step" {
			let (seq, dx, dy) = (j::at(&f, "seq"), unit(j::at(&f, "dx")), unit(j::at(&f, "dy")));
			let (Some(dx), Some(dy)) = (dx, dy) else { return };
			if !is_safe_int(seq) || dx.abs() + dy.abs() != 1.0 { return; }
			if !spend(&mut c.limits.borrow_mut().steps, STEP_BURST, STEP_REFILL_MS) { return; }
			self.intent(c, &format!("step {} {}", js::number_text(dx), js::number_text(dy)), Some(obj! { "conn" => c.ws.id.as_str(), "seq" => seq.clone() })).await;
			(self.on_activity)(&c.me.account_id);
			return;
		}
		let chat = self.chat.borrow().clone();
		if let (true, Some(chat)) = (is_chat_frame(&f), &chat) {
			let burst = self.cmd_burst.get();
			let per = self.cmd_per_sec.get();
			if !spend(&mut c.limits.borrow_mut().cmds, burst, 1000.0 / per.max(1.0)) { c.ws.send(&error_msg("Zu viele Nachrichten auf einmal; einen Moment bitte.")); return; }
			let ws = c.ws.clone();
			chat.frame(&self.chat_user(c), &f, &move |x: &Json| ws.send(x)).await;
			(self.on_activity)(&c.me.account_id);
			return;
		}
		if t != "cmd" { return; }
		let Some(line) = j::so(&f, "line") else { return };
		*c.lang.borrow_mut() = (j::s(&f, "lang") == "en").then(|| "en".to_owned());
		let line = cut_text(js::trim(&strip_controls(line)), MAX_LINE).to_owned();
		if line.is_empty() { return; }
		let burst = self.cmd_burst.get();
		let refill = 1000.0 / self.cmd_per_sec.get().max(1.0);
		let is_step = js::re(r"^step\s", "").test(&line);
		let ok = { let mut l = c.limits.borrow_mut(); if is_step { spend(&mut l.steps, STEP_BURST, STEP_REFILL_MS) } else { spend(&mut l.cmds, burst, refill) } };
		if !ok {
			if now() - c.warned.get() > 2_000.0 { c.warned.set(now()); c.ws.send(&error_msg("Zu viele Befehle auf einmal; einen Moment bitte.")); }
			return;
		}
		if let (Some(chat), true) = (&chat, is_chat_line(&line)) {
			let ws = c.ws.clone();
			chat.handle(&self.chat_user(c), &line, &move |x: &Json| ws.send(x)).await;
			(self.on_activity)(&c.me.account_id);
			return;
		}
		self.intent(c, &line, None).await;
		(self.on_activity)(&c.me.account_id);
	}

	async fn intent(&self, c: &Rc<Client>, line: &str, step: Option<Json>) {
		let mut f = Object::new();
		f.insert("intentId", Json::from(hex(&random_bytes(8))));
		f.insert("charId", Json::from(c.me.char_id.as_str()));
		f.insert("line", Json::from(line));
		f.insert("at", Json::Number(now()));
		if let Some(l) = c.lang.borrow().clone() { f.insert("lang", Json::from(l)); }
		if let Some(s) = step { f.insert("step", s); }
		let region = self.region_of(&c.me.char_id).await;
		let space = self.regions.get(&region).cloned().expect("the region's space");
		if space.remote().write(&tmpl("Intent", Json::Object(f)), None, INTENT_LEASE_MS, &Opts::default()).await.is_err() { c.ws.send(&error_msg("Die Welt ist gerade nicht erreichbar; bitte gleich noch einmal.")); }
	}

	fn hello(&self, c: &Rc<Client>) {
		let (self_c, room) = { let st = self.st.borrow(); let s = st.chars.get(&c.me.char_id).cloned(); let r = s.as_ref().and_then(|s| st.rooms.get(j::s(s, "room")).cloned()); (s, r) };
		let (Some(me), Some(room)) = (self_c, room) else {
			if c.awaits_hello.get() { return; }
			c.awaits_hello.set(true);
			let (g, c2) = (Rc::downgrade(&self.rc()), Rc::downgrade(c));
			tokio::task::spawn_local(async move {
				tokio::time::sleep(Duration::from_millis(2000)).await;
				let (Some(g), Some(c)) = (g.upgrade(), c2.upgrade()) else { return };
				if c.awaits_hello.get() && g.has_client(&c) { c.ws.send(&error_msg("Deine Figur ist noch nicht in der Welt angekommen.")); }
			});
			return;
		};
		c.awaits_hello.set(false);
		let my_room = j::s(&me, "room").to_owned();
		let my_id = j::s(&me, "charId").to_owned();
		*c.room.borrow_mut() = Some(my_room.clone());
		let players = self.player_names();
		let (chars, objs, log) = {
			let st = self.st.borrow();
			let chars: Vec<Json> = st.chars.values().filter(|ch| j::s(ch, "room") == my_room && (j::s(ch, "charId") == my_id || (st.online.get(j::s(ch, "charId")).copied().unwrap_or(0.0) > 0.0 && !j::truthy(j::at(ch, "aboard"))))).map(|ch| char_view(ch, &self.model_chars)).collect();
			let mut seen_oids: HashSet<&str> = HashSet::new();
			let mut oids: Vec<&str> = Vec::new();
			let mut push_loc = |loc: &str| {
				if let Some(m) = st.objs_by_loc.get(loc) {
					for k in m.keys() { if seen_oids.insert(k) { oids.push(k); } }
				}
			};
			push_loc(&my_room);
			push_loc(&my_id);
			for cid in st.atlas_objs.keys() {
				if self.in_own_chest(&st, Some(cid), &my_id, Some(&my_room)) { push_loc(cid); }
			}
			oids.sort_by_key(|id| st.objs.index_of(id).unwrap_or(usize::MAX));
			let objs: Vec<Json> = oids.into_iter().filter_map(|id| st.objs.get(id)).map(|o| self.view(&st, o)).collect();
			let mut kept: Vec<Json> = st.notices_by_char.get(&my_id).into_iter().flat_map(|m| m.keys()).filter_map(|id| st.notices.get(id)).filter(|n| j::truthy(j::at(n, "told"))).map(|n| { let mut o = j::object(n); o.remove("noticeId"); o.remove("charId"); o.remove("told"); Json::Object(o) }).collect();
			let recent = st.recent.get(&my_room).cloned().unwrap_or_default();
			let lines = if kept.is_empty() { recent } else {
				kept.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")));
				let skip = kept.len().saturating_sub(NOTICES_SHOWN);
				let mut all: Vec<Json> = recent.into_iter().chain(kept.into_iter().skip(skip)).collect();
				all.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")));
				all
			};
			let log: Vec<Json> = lines.iter().map(|m| msg_view(m, &my_id, &self.model_names, j::s(&me, "name"), Some(&players))).collect();
			(chars, objs, log)
		};
		let mut world = self.world_base.clone();
		if let Some(Json::Object(liner)) = world.get_mut("liner") {
			let island = self.st.borrow().rooms.get(&my_room).map_or("", |r| j::s(r, "island")).to_owned();
			liner.insert("island", Json::from(island));
		}
		let fog = self.st.borrow().fog.get(&my_room).copied().unwrap_or(0.0);
		let hello = obj! {
			"t" => "hello", "wind" => self.wind_in(&my_room), "build" => self.build.clone().map_or(Json::Null, Json::from), "world" => Json::Object(world),
			"me" => obj! { "charId" => my_id.as_str(), "name" => j::at(&me, "name").clone(), "guest" => c.me.guest, "admin" => c.me.admin },
			"room" => room, "chars" => Json::Array(chars), "objs" => Json::Array(objs), "log" => Json::Array(log), "fog" => fog, "now" => now(), "worldTime" => self.world_time()
		};
		c.ws.send(&hello);
		// the rest after what the running batch sends (queueMicrotask in the TypeScript gateway): see `flush`
		self.deferred.borrow_mut().push(c.clone());
	}

	/** What a hello sends after the frames of the batch (or call) that brought it. */
	fn flush(&self) {
		if self.deferred.borrow().is_empty() { return; }
		let shared = self.atlas_shared();
		let mut atlas: Option<String> = None;
		loop {
			let next = { let mut d = self.deferred.borrow_mut(); if d.is_empty() { break; } d.remove(0) };
			let c = &next;
			c.ws.send(&obj! { "t" => "trade", "trade" => self.trade(c) });
			self.tell(&c.me.char_id);
			if !c.atlas.get() {
				c.atlas.set(true);
				let a = atlas.get_or_insert_with(|| obj! { "t" => "atlas", "atlas" => self.atlas() }.to_json_text());
				c.ws.send_text(a);
			}
			c.ws.send(&obj! { "t" => "atlasState", "state" => self.atlas_state(c, &shared) });
		}
	}

	/// Tells a player the word waiting for it and marks it told.
	fn tell(&self, char_id: &str) {
		let pages: Vec<Rc<Client>> = self.clients.borrow().iter().filter(|c| c.me.char_id == char_id && c.room.borrow().is_some()).cloned().collect();
		if pages.is_empty() { return; }
		let (new, name): (Vec<(String, Json)>, String) = {
			let st = self.st.borrow();
			let new = st.notices_by_char.get(char_id).into_iter().flat_map(|m| m.keys()).filter_map(|id| st.notices.get(id).map(|v| (id.to_owned(), v.clone()))).filter(|(_, n)| !j::truthy(j::at(n, "told"))).collect();
			let name = st.chars.get(char_id).map_or_else(String::new, |c| j::s(c, "name").to_owned());
			(new, name)
		};
		for (id, n) in new {
			let mut told = n.clone();
			j::set(&mut told, "told", true);
			self.st.borrow_mut().notices.set(&id, told);
			let mut m = j::object(&n);
			m.remove("noticeId"); m.remove("charId"); m.remove("told");
			let view = msg_view(&Json::Object(m), char_id, &self.model_names, &name, None);
			for c in &pages { c.ws.send(&obj! { "t" => "msg", "m" => view.clone() }); }
			let (region, rest) = id.split_once(':').map_or((id.as_str(), ""), |(a, b)| (a, b));
			let left = j::n(&n, "at") + NOTICE_MS - now();
			if let Some(space) = self.regions.get(region).cloned() {
				let rest = rest.to_owned();
				tokio::task::spawn_local(async move {
					if let Ok(Some(e)) = space.take_if_exists(&obj! { "type" => "Notice", "id" => rest }, 0.0, None).await {
						if left > 0.0 { let mut f = fields(&e).clone(); j::set(&mut f, "told", true); let _ = space.write(&tmpl("Notice", f), None, left).await; }
					}
				});
			}
		}
	}

	async fn read_paged(&self, region: &str, space: &Space, t: &Json, msgs: &mut Vec<Json>) -> Result<(), SpaceError> {
		let (mut after, mut token): (Option<String>, Option<String>) = (None, None);
		loop {
			let page = space.remote().read_page(t, Some(256.0 * 1024.0), after.as_deref(), token.as_deref(), None, None).await?;
			for e in j::a(&page, "items") { if self.foreign(region, j::s(e, "type"), j::a(e, "types"), j::at(e, "fields")) { continue; } self.put(&format!("{region}:{}", txt(j::at(e, "id"))), j::s(e, "type"), j::a(e, "types"), j::at(e, "fields"), msgs); }
			after = j::so(&page, "next").map(str::to_owned);
			token = j::so(&page, "token").map(str::to_owned);
			if after.is_none() { return Ok(()); }
		}
	}

	/// Reads the world once and then follows the change stream.
	async fn follow(self: Rc<Self>, region: String, space: Space, left: Rc<Cell<usize>>) {
		let mut rev = -1.0;
		let mut signalled = false;
		while !self.closed.get() {
			let r: Result<(), SpaceError> = async {
				if rev < 0.0 {
					rev = j::n(&space.remote().read_page(&obj! { "type" => "-" }, None, None, None, None, None).await?, "rev");
					let mut msgs: Vec<Json> = Vec::new();
					for ty in ["Room", "Character", "Session", "Item", "Exit", "Beacon", "Flame", "Fog", "WorldClock", "Offer", "Order", "Listing", "Wanted", "Notice", "SeedRest", "Epoch", "SiteOrder", "Scenery", "Site", "Building", "Ruin", "Bed", "Field", "Tree", "Animal", "Zone", "Road", "Wind", "Cart", "MillLoad"] { self.read_paged(&region, &space, &obj! { "type" => ty }, &mut msgs).await?; }
					self.read_paged(&region, &space, &tmpl("Msg", obj! { "to" => "*" }), &mut msgs).await?;
					self.advance(&region, rev);
					if !signalled { signalled = true; left.set(left.get() - 1); if left.get() == 0 { self.ready.send_replace(true); } }
					let cs: Vec<Rc<Client>> = self.clients.borrow().clone();
					for c in cs { self.hello(&c); }
					self.flush();
				}
				let ch = space.remote().changes(rev, None, Some(20_000.0), None).await?;
				for b in j::a(&ch, "batches") { self.batch(&region, j::a(b, "ops")); }
				self.flush();
				rev = j::n(&ch, "next");
				self.advance(&region, rev);
				Ok(())
			}.await;
			if let Err(e) = r {
				if self.closed.get() { break; }
				if matches!(e.code(), Some("SnapshotExpired" | "RevisionAhead")) { eprintln!("[gateway] change stream of {region}: {e}; reading it again"); self.reset(&region); rev = -1.0; continue; }
				eprintln!("[gateway] change stream: {e}");
				tokio::time::sleep(Duration::from_secs(1)).await;
			}
		}
	}

	fn batch(&self, region: &str, ops: &[Json]) {
		let key = |id: &str| format!("{region}:{id}");
		let mut chars: Vec<(String, Option<String>)> = Vec::new();
		let mut objs: Vec<(String, Option<String>)> = Vec::new();
		let mut msgs: Vec<Json> = Vec::new();
		let mut fogs: Vec<String> = Vec::new();
		let mut trade = false;
		let mut seeking: HashSet<String> = HashSet::new();
		let mut clock = false;
		let touch = |entry: &str, f: Option<&Json>, types: &[Json], chars: &mut Vec<(String, Option<String>)>, objs: &mut Vec<(String, Option<String>)>, fogs: &mut Vec<String>| {
			let st = self.st.borrow();
			let has = |t: &str| types.iter().any(|x| x.as_str() == Some(t));
			let field = |k: &str| f.map(|f| txt(j::at(f, k)).replace("null", "undefined"));
			let char_id = st.char_of.get(entry).cloned().or_else(|| st.sessions.get(entry).cloned()).or_else(|| if f.is_some() && (has("Character") || has("Session")) { field("charId") } else { None });
			if let Some(cid) = char_id { if !chars.iter().any(|(c, _)| *c == cid) { let before = st.chars.get(&cid).map(|c| j::s(c, "room").to_owned()); chars.push((cid, before)); } }
			let obj_id = st.obj_of.get(entry).cloned().or_else(|| st.flame_of.get(entry).cloned()).or_else(|| {
				f?;
				let by = [("Item", "itemId"), ("Exit", "exitId"), ("Beacon", "beaconId"), ("Flame", "beaconId"), ("Scenery", "sceneryId"), ("Site", "buildId"), ("Building", "buildId"), ("Ruin", "buildId"), ("Bed", "bedId"), ("Field", "fieldId"), ("Tree", "treeId"), ("Animal", "animalId"), ("Zone", "zoneId"), ("Road", "roadId"), ("Cart", "cartId")];
				by.iter().find(|(t, _)| has(t)).and_then(|(_, k)| field(k))
			});
			if let (Some(f), true) = (f, has("Fog")) { let r = txt(j::at(f, "room")); if !fogs.contains(&r) { fogs.push(r); } }
			if let Some(oid) = obj_id { if !objs.iter().any(|(o, _)| *o == oid) { let before = st.objs.get(&oid).map(|o| j::s(o, "location").to_owned()); objs.push((oid, before)); } }
		};
		for op in ops {
			let id = key(&txt(j::at(op, "id")));
			let ty = j::s(op, "type");
			if j::s(op, "op") == "put" && self.foreign(region, ty, j::a(op, "types"), j::at(op, "fields")) { continue; }
			if j::s(op, "op") == "put" {
				clock |= ty == "WorldClock";
				let renewed = ty == "Session" && self.st.borrow().sessions.contains_key(&id);
				if !renewed { touch(&id, Some(j::at(op, "fields")), j::a(op, "types"), &mut chars, &mut objs, &mut fogs); }
				trade |= ["Offer", "Order", "Listing", "Wanted"].contains(&ty);
				if ty == "SeedRest" { seeking.insert(txt(j::at(j::at(op, "fields"), "charId"))); }
				self.put(&id, ty, j::a(op, "types"), j::at(op, "fields"), &mut msgs);
			} else {
				touch(&id, None, &[], &mut chars, &mut objs, &mut fogs);
				{ let st = self.st.borrow(); trade |= st.offers.has(&id) || st.orders.has(&id) || st.listings.has(&id) || st.wanted.has(&id); if let Some(s) = st.seed_rests.get(&id) { seeking.insert(j::s(s, "charId").to_owned()); } }
				self.del(&id);
			}
		}
		for (cid, before) in &chars { self.announce(cid, before.as_deref()); }
		if !trade { let st = self.st.borrow(); trade = chars.iter().any(|(id, _)| st.offers.values().any(|o| j::s(o, "from") == id || j::s(o, "to") == id)); }
		for (oid, before) in &objs { self.announce_obj(oid, before.as_deref()); }
		if clock {
			self.broadcast_time();
			let beacons: Vec<(String, String)> = self.st.borrow().objs.iter().filter(|(_, o)| j::s(o, "kind") == "beacon").map(|(k, o)| (k.to_owned(), j::s(o, "location").to_owned())).collect();
			for (id, loc) in beacons { self.announce_obj(&id, Some(&loc)); }
		}
		let clients: Vec<Rc<Client>> = self.clients.borrow().clone();
		for c in &clients { if c.room.borrow().is_some() && (trade || seeking.contains(&c.me.char_id)) { c.ws.send(&obj! { "t" => "trade", "trade" => self.trade(c) }); } }
		if !chars.is_empty() || !fogs.is_empty() || !objs.is_empty() { self.atlas_changed(false); }
		for room in &fogs { let level = self.st.borrow().fog.get(room).copied().unwrap_or(0.0); for c in &clients { if c.room.borrow().as_deref() == Some(room.as_str()) { c.ws.send(&obj! { "t" => "fog", "level" => level }); } } }
		for m in &msgs {
			let to = j::s(m, "to");
			let who = (j::s(m, "kind") == "who").then(|| self.player_names());
			for c in &clients {
				if to.starts_with('#') || (if to == "*" { c.room.borrow().as_deref() == Some(j::s(m, "room")) && !j::at(m, "room").is_null() } else { c.me.char_id == to }) {
					let name = self.st.borrow().chars.get(&c.me.char_id).map_or_else(String::new, |x| j::s(x, "name").to_owned());
					c.ws.send(&obj! { "t" => "msg", "m" => msg_view(m, &c.me.char_id, &self.model_names, &name, who.as_ref()) });
				}
			}
		}
	}

	/// Forgets what the region's stream showed (it is read again).
	fn reset(&self, region: &str) {
		if self.regions.size() == 1 {
			let mut st = self.st.borrow_mut();
			st.clock = None;
			st.chars.clear(); st.char_of.clear(); st.char_entry.clear(); st.sessions.clear(); st.online.clear(); st.rooms.clear(); st.objs.clear(); st.obj_of.clear(); st.obj_entry.clear(); st.objs_by_loc.clear(); st.atlas_objs.clear(); st.recent.clear(); st.flames.clear(); st.flame_of.clear(); st.fog.clear();
			st.offers.clear(); st.orders.clear(); st.listings.clear(); st.wanted.clear(); st.notices.clear(); st.notices_by_char.clear(); st.seed_rests.clear(); st.epochs.clear(); st.mill_loads.clear(); st.herds.clear();
			return;
		}
		let pre = format!("{region}:");
		let ids: Vec<String> = {
			let st = self.st.borrow();
			let mut v: Vec<String> = st.char_of.keys().chain(st.obj_of.keys()).chain(st.sessions.keys()).cloned().collect();
			v.extend(st.flame_of.keys().chain(st.offers.keys()).chain(st.orders.keys()).chain(st.listings.keys()).chain(st.wanted.keys()).chain(st.notices.keys()).chain(st.seed_rests.keys()).chain(st.epochs.keys()).chain(st.site_orders.keys()).chain(st.mill_loads.keys()).map(str::to_owned));
			v.into_iter().filter(|id| id.starts_with(&pre)).collect()
		};
		for id in ids { self.del(&id); }
	}

	fn shown_name(&self, char_id: &str, stored: &Json) -> Json { self.st.borrow().chars.get(char_id).map_or_else(|| stored.clone(), |c| j::at(c, "name").clone()) }

	/// `#roomOf`: the room a thing of the world's rooms stands in (a room, its fog, fire, exits, what lies or is built
	/// there), or None for what is not bound to a room (a character, what one carries, messages, the market).
	fn room_of(&self, ty: &str, types: &[Json], f: &Json) -> Option<String> {
		f.as_object()?;
		let is = |t: &str| ty == t || types.iter().any(|x| x.as_str() == Some(t));
		let text = |k: &str| j::at(f, k).as_str().map(str::to_owned);
		if is("Room") { return text("roomId"); }
		if is("Flame") || is("Contribution") { let b = txt(j::at(f, "beaconId")); return j::a(&self.w, "beacons").iter().find(|x| j::s(x, "beaconId") == b).map(|x| j::s(x, "room").to_owned()); }
		if is("Item") || is("Exit") { return text("location"); }
		if ["Fog", "Beacon", "Scenery", "Site", "Building", "Ruin", "Bed", "Field", "Tree", "Animal", "Zone", "Road"].iter().any(|t| is(t)) { return text("room"); }
		None
	}

	/// `#foreign`: with regions a thing of the world's rooms counts only from the stream of the region its room lies in
	/// (2026-11-11, docs/rust-portierung.en.md R8.6); a room no region knows counts from wherever.
	fn foreign(&self, region: &str, ty: &str, types: &[Json], f: &Json) -> bool {
		if self.regions.size() == 1 { return false; }
		let Some(room) = self.room_of(ty, types, f) else { return false };
		region_of_room(&self.w, &room).is_some_and(|owner| owner != region)
	}

	/// Applies a put; a message is collected in `msgs` to be sent after the batch.
	fn put(&self, id: &str, ty: &str, types: &[Json], f: &Json, msgs: &mut Vec<Json>) {
		let w = self.w.clone();
		let has = |t: &str| types.iter().any(|x| x.as_str() == Some(t));
		if ty == "WorldClock" { self.st.borrow_mut().clock = Some(f.clone()); }
		match ty {
			"MillLoad" => { self.st.borrow_mut().mill_loads.set(id, f.clone()); self.atlas_changed(false); }
			"Room" => {
				let rid = j::s(f, "roomId").to_owned();
				let was = self.st.borrow().rooms.get(&rid).cloned();
				self.st.borrow_mut().rooms.set(&rid, f.clone());
				if let Some(was) = was {
					let (a, b) = (j::a(&was, "ground"), j::a(f, "ground"));
					let width = |g: &[Json]| g.first().and_then(Json::as_str).map_or(0, js::len16);
					if a.len() != b.len() || width(a) != width(b) {
						self.atlas_changed(true);
						let cs: Vec<Rc<Client>> = self.clients.borrow().iter().filter(|c| c.room.borrow().as_deref() == Some(rid.as_str())).cloned().collect();
						for c in cs { self.hello(&c); }
					}
				}
			}
			"Character" => {
				let cid = j::s(f, "charId").to_owned();
				let (prev, before) = { let st = self.st.borrow(); (st.char_entry.get(&cid).cloned(), st.chars.get(&cid).map(|c| j::at(c, "name").clone())) };
				{
					let mut st = self.st.borrow_mut();
					if let Some(p) = prev.filter(|p| p != id) { st.char_of.remove(&p); }
					st.chars.set(&cid, f.clone()); st.char_of.insert(id.to_owned(), cid.clone()); st.char_entry.insert(cid.clone(), id.to_owned());
				}
				if before.as_ref() != Some(j::at(f, "name")) {
					let name = j::at(f, "name").clone();
					let mut touched: Vec<(String, String)> = Vec::new();
					{
						let mut st = self.st.borrow_mut();
						for o in st.objs.values_mut() {
							let i = j::a(o, "sponsorIds").iter().position(|x| x.as_str() == Some(cid.as_str()));
							let owner = j::s(o, "ownerId") == cid;
							if !owner && i.is_none() { continue; }
							if owner { j::set(o, "owner", name.clone()); }
							if let (Some(i), Some(Json::Array(s))) = (i, o.as_object_mut().and_then(|m| m.get_mut("sponsors"))) { if i < s.len() { s[i] = name.clone(); } }
							touched.push((j::s(o, "id").to_owned(), j::s(o, "location").to_owned()));
						}
					}
					for (oid, loc) in touched { self.announce_obj(&oid, Some(&loc)); }
				}
				let region = id.split(':').next().unwrap_or("").to_owned();
				if self.st.borrow().char_region.get(&cid) != Some(&region) {
					self.st.borrow_mut().char_region.insert(cid.clone(), region.clone());
					let cs: Vec<Rc<Client>> = self.clients.borrow().iter().filter(|cl| cl.me.char_id == cid && cl.lease_region.borrow().as_ref().is_some_and(|r| *r != region)).cloned().collect();
					for cl in cs { let g = self.rc(); tokio::task::spawn_local(async move { g.keep(&cl).await; }); }
				}
			}
			"Session" => {
				let mut st = self.st.borrow_mut();
				if st.sessions.contains_key(id) { return; }
				let cid = txt(j::at(f, "charId"));
				st.sessions.insert(id.to_owned(), cid.clone());
				*st.online.entry(cid).or_insert(0.0) += 1.0;
			}
			"Beacon" => self.set_obj(id, obj! { "id" => j::at(f, "beaconId").clone(), "kind" => "beacon", "name" => j::at(f, "name").clone(), "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone() }),
			"Cart" => {
				let name = format!("Karren von {}", txt(&self.shown_name(j::s(f, "charId"), j::at(f, "ownerName"))));
				self.set_obj(id, obj! { "id" => j::at(f, "cartId").clone(), "kind" => "cart", "name" => name, "ownerId" => j::at(f, "charId").clone(), "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "glyph" => obj! { "shape" => "square", "color" => "#8a6a44" }, "icon" => "items/karren.png" });
			}
			"Zone" => {
				let weg = j::s(f, "kind") == "weg";
				self.set_obj(id, obj! { "id" => j::at(f, "zoneId").clone(), "kind" => "zone", "name" => if weg { "Wegerecht" } else { "Grünzone" }, "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "w" => j::at(f, "w").clone(), "h" => j::at(f, "h").clone(), "color" => if weg { "#e0c060" } else { "#5fbf6a" } });
			}
			"Road" => {
				let cells = j::at(f, "cells").clone();
				let first = cells.as_array().and_then(|c| c.first()).cloned().unwrap_or_else(|| obj! { "x" => 0.0, "y" => 0.0 });
				let state = j::s(f, "state");
				let mut o = obj_of(obj! { "id" => j::at(f, "roadId").clone(), "kind" => "road", "name" => j::at(f, "name").clone(), "location" => j::at(f, "room").clone(), "x" => j::at(&first, "x").clone(), "y" => j::at(&first, "y").clone(), "through" => true, "runs" => Json::Array(vec![cells]) });
				put_some(&mut o, "paved", f.get("paved")); put_some(&mut o, "roadState", f.get("state")); put_some(&mut o, "roadTo", f.get("to"));
				if state == "build" && j::truthy(j::at(f, "missing")) { o.insert("missing", j::at(f, "missing").clone()); }
				if state == "vote" && !j::a(f, "votedBy").is_empty() { o.insert("votedIds", j::at(f, "votedBy").clone()); }
				if state == "vote" { put_some(&mut o, "votes", f.get("votes")); }
				self.set_obj(id, Json::Object(o));
				self.atlas_changed(false);
			}
			"Ruin" => {
				let owner = self.shown_name(j::s(f, "owner"), j::at(f, "ownerName"));
				self.set_obj(id, obj! { "id" => j::at(f, "buildId").clone(), "kind" => "ruin", "name" => j::at(f, "name").clone(), "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "w" => j::at(f, "w").clone(), "h" => j::at(f, "h").clone(), "owner" => owner, "ownerId" => j::at(f, "owner").clone(), "plan" => j::at(f, "plan").clone() });
			}
			"Bed" => {
				let kind = j::s(f, "kind");
				let mut o = obj_of(obj! { "id" => j::at(f, "bedId").clone(), "kind" => "bed", "name" => match kind { "gemein" => "Gemeinschaftsbeet", "zier" => "Zierbeet", _ => "Beet" } });
				if j::truthy(j::at(f, "kind")) { o.insert("bedKind", j::at(f, "kind").clone()); }
				if j::truthy(j::at(f, "fenced")) { o.insert("fenced", Json::Bool(true)); }
				for k in ["x", "y", "w", "h"] { if k == "x" { o.insert("location", j::at(f, "room").clone()); } put_some(&mut o, k, f.get(k)); }
				o.insert("owner", self.shown_name(j::s(f, "owner"), j::at(f, "ownerName")));
				put_some(&mut o, "ownerId", f.get("owner"));
				o.insert("plants", bed_plants_view(&w, f));
				put_some(&mut o, "wateredWorldMs", f.get("wateredWorldMs"));
				o.insert("thirstMs", j::at(j::at(&w, "garden"), "thirstWorldMs").as_f64().map_or(Json::Number(0.0), Json::Number));
				put_some(&mut o, "weedy", f.get("weedy"));
				let sponsors = j::a(f, "sponsors");
				o.insert("sponsors", Json::Array(sponsors.iter().map(|x| self.shown_name(j::s(x, "charId"), j::at(x, "name"))).collect()));
				o.insert("sponsorIds", Json::Array(sponsors.iter().map(|x| j::at(x, "charId").clone()).collect()));
				self.set_obj(id, Json::Object(o));
			}
			"Tree" => {
				let s = j::by(j::a(j::at(&w, "trees"), "sorts"), "key", j::s(f, "sort"));
				let pick = |k: &str, or: &str| s.map(|s| j::at(s, k)).filter(|v| j::truthy(v)).cloned().unwrap_or_else(|| if or.is_empty() { j::at(f, "sort").clone() } else { Json::from(or) });
				let mut o = obj_of(obj! { "id" => j::at(f, "treeId").clone(), "kind" => "tree", "name" => pick("name", ""), "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "w" => 1.0, "h" => 1.0 });
				o.insert("owner", self.shown_name(j::s(f, "owner"), j::at(f, "ownerName")));
				o.insert("ownerId", j::at(f, "owner").clone());
				o.insert("model", pick("model", "tree"));
				o.insert("color", pick("color", "#6a8a3a"));
				o.insert("treeStage", j::at(f, "stage").clone());
				if j::truthy(j::at(f, "ripe")) { o.insert("ripe", Json::Bool(true)); }
				if s.is_some_and(|s| j::truthy(j::at(j::at(s, "crop"), "cut"))) { o.insert("cut", Json::Bool(true)); }
				self.set_obj(id, Json::Object(o));
			}
			"Field" => {
				let (crop, color, model, stage, progress) = field_view(&w, f);
				let name = match crop.as_ref().filter(|c| j::truthy(c)) { Some(c) => format!("Acker ({})", txt(c)), None => "Acker".into() };
				let mut o = obj_of(obj! { "id" => j::at(f, "fieldId").clone(), "kind" => "field", "name" => name, "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "w" => j::at(f, "w").clone(), "h" => j::at(f, "h").clone() });
				o.insert("owner", self.shown_name(j::s(f, "owner"), j::at(f, "ownerName")));
				put_some(&mut o, "ownerId", f.get("owner"));
				o.insert("fieldStage", stage);
				o.insert("progress", Json::Number(progress));
				if let Some(c) = color.filter(j::truthy) { o.insert("color", c); }
				if let Some(m) = model.filter(j::truthy) { o.insert("cropModel", m); }
				if j::truthy(j::at(f, "open")) { o.insert("open", Json::Bool(true)); }
				if j::truthy(j::at(f, "fenced")) { o.insert("fenced", Json::Bool(true)); }
				self.set_obj(id, Json::Object(o));
			}
			"Animal" => {
				let kind = j::so(f, "kind").unwrap_or("hase").to_owned();
				let k = if j::truthy(j::at(&w, "wild")) { wild_kinds(j::at(&w, "wild")).into_iter().find(|x| j::s(x, "key") == kind) } else { None };
				let mut o = obj_of(obj! { "id" => j::at(f, "animalId").clone(), "kind" => "animal", "animal" => kind.as_str(), "name" => j::at(f, "name").clone(), "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone() });
				put_some(&mut o, "target", j::opt(f, "bedId").or(f.get("target")));
				o.insert("glyph", obj! { "shape" => "circle", "color" => "#a08a6a" });
				if let Some(k) = k { o.insert("icon", Json::from(format!("/assets/{}/{}", j::s(&w, "id"), txt(j::at(&k, "icon"))))); }
				self.set_obj(id, Json::Object(o));
			}
			"Site" | "Building" => {
				let site = ty == "Site";
				let needs = j::a(f, "needs");
				let (total, have) = if site { (needs.iter().map(|n| j::n(n, "count")).sum::<f64>() + j::n(f, "workNeed"), needs.iter().map(|n| j::n(n, "have").min(j::n(n, "count"))).sum::<f64>() + j::n(f, "work")) } else { (0.0, 0.0) };
				let plan = j::a(j::at(&w, "building"), "plans").iter().find(|p| j::at(p, "key") == j::at(f, "plan")).cloned();
				let bid = j::s(f, "buildId").to_owned();
				if !site && j::truthy(j::at(f, "herd")) { self.st.borrow_mut().herds.insert(bid.clone(), j::at(f, "herd").clone()); } else { self.st.borrow_mut().herds.remove(&bid); }
				let mut o = obj_of(obj! { "id" => bid.as_str(), "kind" => if site { "site" } else { "building" }, "name" => j::at(f, "name").clone(), "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "w" => j::at(f, "w").clone(), "h" => j::at(f, "h").clone() });
				o.insert("owner", self.shown_name(j::s(f, "owner"), j::at(f, "ownerName")));
				put_some(&mut o, "ownerId", f.get("owner"));
				put_some(&mut o, "plan", f.get("plan"));
				if site {
					o.insert("orders", self.orders_of(&bid));
					o.insert("progress", Json::Number(if total != 0.0 && !total.is_nan() { have / total } else { 0.0 }));
					let mut miss: Vec<String> = needs.iter().filter(|n| j::n(n, "have") < j::n(n, "count")).map(|n| format!("{} {}", js::number_text(j::n(n, "count") - j::n(n, "have")), txt(j::at(n, "name")))).collect();
					if j::n(f, "work") < j::n(f, "workNeed") { miss.push(format!("{} Arbeit", js::number_text(j::n(f, "workNeed") - j::n(f, "work")))); }
					o.insert("missing", Json::from(miss.join(", ")));
				}
				if let Some(c) = plan.as_ref().and_then(|p| j::opt(p, "color")).filter(|c| j::truthy(c)) { o.insert("color", c.clone()); }
				if !site && j::truthy(j::at(f, "herd")) { o.insert("herd", j::at(j::at(f, "herd"), "kind").clone()); o.insert("fedUntil", j::at(j::at(f, "herd"), "fedUntilWorldMs").clone()); }
				if !site && j::truthy(j::at(f, "keeper")) { o.insert("keeper", j::at(j::at(f, "keeper"), "kind").clone()); o.insert("keeperFedUntil", j::at(j::at(f, "keeper"), "fedUntilWorldMs").clone()); }
				if !site && j::truthy(j::at(f, "fenced")) { o.insert("fenced", Json::Bool(true)); }
				// its term on the second clock (todos: told before it falls)
				if !site { put_some(&mut o, "term", f.get("untilWorldMs")); }
				if !site && plan.as_ref().is_some_and(|p| j::truthy(j::at(p, "interior"))) {
					o.insert("interior", Json::Bool(true));
					let g = j::a(f, "guests");
					if !g.is_empty() { o.insert("guestIds", Json::Array(g.iter().map(|x| j::at(x, "charId").clone()).collect())); }
				}
				self.set_obj(id, Json::Object(o));
			}
			"Flame" => { let mut st = self.st.borrow_mut(); let b = txt(j::at(f, "beaconId")); st.flames.insert(b.clone(), j::n(f, "until")); st.flame_of.set(id, b); }
			"Wind" => {
				let island = txt(j::at(f, "island"));
				self.st.borrow_mut().winds.insert(island.clone(), j::n(f, "level"));
				let cs: Vec<Rc<Client>> = self.clients.borrow().clone();
				for c in cs { let Some(room) = c.room() else { continue }; let here = self.st.borrow().rooms.get(&room).is_some_and(|r| j::s(r, "island") == island); if here { c.ws.send(&obj! { "t" => "wind", "wind" => self.wind_in(&room) }); } }
			}
			"Fog" => { self.st.borrow_mut().fog.set(&txt(j::at(f, "room")), j::n(f, "level")); }
			"Offer" => self.st.borrow_mut().offers.set(id, f.clone()),
			"Order" => self.st.borrow_mut().orders.set(id, f.clone()),
			"Listing" => self.st.borrow_mut().listings.set(id, f.clone()),
			"Wanted" => self.st.borrow_mut().wanted.set(id, f.clone()),
			"Notice" => {
				{
					let mut st = self.st.borrow_mut();
					st.notices.set(id, f.clone());
					st.notices_by_char.entry(j::s(f, "charId").to_owned()).or_default().set(id, ());
				}
				self.tell(j::s(f, "charId"));
			}
			"SeedRest" => self.st.borrow_mut().seed_rests.set(id, f.clone()),
			"Epoch" => { self.st.borrow_mut().epochs.set(id, f.clone()); self.atlas_changed(false); }
			"Scenery" => {
				let mut o = obj_of(obj! { "id" => j::at(f, "sceneryId").clone(), "kind" => "scenery", "name" => j::at(f, "name").clone(), "desc" => scenery_text(&w, f), "location" => j::at(f, "room").clone(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "w" => j::at(f, "w").clone(), "h" => j::at(f, "h").clone() });
				put_some(&mut o, "model", f.get("model")); put_some(&mut o, "left", f.get("left"));
				if j::truthy(j::at(f, "fixed")) { o.insert("fixed", Json::Bool(true)); }
				if j::truthy(j::at(f, "through")) { o.insert("through", Json::Bool(true)); }
				if j::truthy(j::at(f, "use")) { o.insert("use", j::at(f, "use").clone()); }
				if j::truthy(j::at(f, "plan")) { o.insert("plan", j::at(f, "plan").clone()); }
				if j::truthy(j::at(f, "owner")) { o.insert("ownerId", j::at(f, "owner").clone()); }
				self.set_obj(id, Json::Object(o));
			}
			"SiteOrder" => { self.st.borrow_mut().site_orders.set(id, f.clone()); self.show_orders(j::s(f, "buildId")); }
			"Msg" => {
				if j::s(f, "to") == "*" {
					let room = txt(j::at(f, "room"));
					let mut st = self.st.borrow_mut();
					let list = st.recent.entry(room).or_default();
					list.push(f.clone());
					if list.len() > RECENT { list.remove(0); }
				}
				msgs.push(f.clone());
			}
			_ if has("Item") || has("Exit") => {
				let o = if has("Item") { item_view(f, &|p| self.icon_of(p), &w) } else { exit_view(f, &w) };
				self.set_obj(id, o);
			}
			_ => {}
		}
	}

	fn set_obj(&self, id: &str, o: Json) {
		let oid = j::s(&o, "id").to_owned();
		let new_loc = j::s(&o, "location").to_owned();
		let atlas_kind = is_atlas_kind(j::s(&o, "kind"));
		let mut st = self.st.borrow_mut();
		if let Some(prev) = st.obj_entry.get(&oid).cloned() { if prev != id { st.obj_of.remove(&prev); } }
		let old_loc = st.objs.get(&oid).map(|old| j::s(old, "location").to_owned());
		if old_loc.as_deref() != Some(new_loc.as_str()) {
			if let Some(ol) = old_loc {
				if let Some(m) = st.objs_by_loc.get_mut(&ol) { m.delete(&oid); if m.is_empty() { st.objs_by_loc.remove(&ol); } }
			}
			st.objs_by_loc.entry(new_loc).or_default().set(&oid, ());
		}
		if atlas_kind { st.atlas_objs.set(&oid, ()); } else { st.atlas_objs.delete(&oid); }
		st.objs.set(&oid, o); st.obj_of.insert(id.to_owned(), oid.clone()); st.obj_entry.insert(oid, id.to_owned());
	}
	fn orders_of(&self, build_id: &str) -> Json {
		Json::Array(self.st.borrow().site_orders.values().filter(|o| j::s(o, "buildId") == build_id).map(|o| obj! { "proto" => j::at(o, "proto").clone(), "name" => j::at(o, "name").clone(), "left" => j::at(o, "left").clone(), "pay" => j::at(o, "pay").clone() }).collect())
	}
	fn show_orders(&self, build_id: &str) {
		let orders = self.orders_of(build_id);
		let loc = { let mut st = self.st.borrow_mut(); st.objs.get_mut(build_id).map(|o| { j::set(o, "orders", orders); j::s(o, "location").to_owned() }) };
		if let Some(loc) = loc { self.announce_obj(build_id, Some(&loc)); }
	}

	fn del(&self, id: &str) {
		if self.st.borrow_mut().mill_loads.delete(id).is_some() { self.atlas_changed(false); return; }
		let order = self.st.borrow_mut().site_orders.delete(id);
		if let Some(o) = order { self.show_orders(j::s(&o, "buildId")); return; }
		let mut st = self.st.borrow_mut();
		if st.offers.delete(id).is_some() || st.orders.delete(id).is_some() || st.listings.delete(id).is_some() || st.wanted.delete(id).is_some() || st.seed_rests.delete(id).is_some() { return; }
		if let Some(n) = st.notices.delete(id) {
			let cid = j::s(&n, "charId");
			if let Some(m) = st.notices_by_char.get_mut(cid) { m.delete(id); if m.is_empty() { st.notices_by_char.remove(cid); } }
			return;
		}
		if st.epochs.delete(id).is_some() { drop(st); self.atlas_changed(false); return; }
		if let Some(b) = st.flame_of.delete(id) { if !st.flame_of.values().any(|x| *x == b) { st.flames.remove(&b); } return; }
		if let Some(cid) = st.char_of.remove(id) { if st.char_entry.get(&cid).map(String::as_str) == Some(id) { st.char_entry.remove(&cid); st.chars.delete(&cid); } return; }
		if let Some(oid) = st.obj_of.remove(id) {
			if st.obj_entry.get(&oid).map(String::as_str) == Some(id) {
				st.obj_entry.remove(&oid);
				st.atlas_objs.delete(&oid);
				if let Some(old) = st.objs.delete(&oid) {
					let loc = j::s(&old, "location");
					if let Some(m) = st.objs_by_loc.get_mut(loc) { m.delete(&oid); if m.is_empty() { st.objs_by_loc.remove(loc); } }
				}
			}
			return;
		}
		if let Some(s) = st.sessions.remove(id) { let n = st.online.get(&s).copied().unwrap_or(1.0) - 1.0; if n > 0.0 { st.online.insert(s, n); } else { st.online.remove(&s); } }
	}

	/// After a batch: tells the clients of the character's room (and of the room it left) where it is now.
	fn announce(&self, char_id: &str, room_before: Option<&str>) {
		let (c, visible) = { let st = self.st.borrow(); let c = st.chars.get(char_id).cloned(); let v = c.is_some() && st.online.get(char_id).copied().unwrap_or(0.0) > 0.0; (c, v) };
		let view = c.as_ref().filter(|_| visible).map(|c| char_view(c, &self.model_chars));
		let view_text = view.as_ref().map(|v| obj! { "t" => "char", "c" => v.clone() }.to_json_text());
		let gone_text = obj! { "t" => "gone", "charId" => char_id }.to_json_text();
		let clients: Vec<Rc<Client>> = self.clients.borrow().clone();
		for cl in clients {
			let room = cl.room();
			if let Some(c) = &c { if cl.me.char_id == char_id && (cl.awaits_hello.get() || room.as_ref().is_some_and(|r| r != j::s(c, "room"))) { self.hello(&cl); continue; } }
			if let (true, Some(c), Some(v), Some(vt)) = (visible, &c, &view, &view_text) {
				if room.as_deref() == Some(j::s(c, "room")) && (!j::truthy(j::at(c, "aboard")) || cl.me.char_id == char_id) {
					let ack = j::at(c, "ack");
					if cl.me.char_id == char_id && j::s(ack, "conn") == cl.ws.id && !ack.is_null() {
						cl.ws.send(&obj! { "t" => "char", "c" => v.clone(), "ack" => j::at(ack, "seq").clone() });
					} else {
						cl.ws.send_text(vt);
					}
					continue;
				}
			}
			if let Some(r) = &room { if Some(r.as_str()) == room_before || c.as_ref().is_some_and(|c| j::s(c, "room") == r) { cl.ws.send_text(&gone_text); } }
		}
	}

	fn here(&self, st: &State, char_id: &str, room: Option<&str>) -> bool { st.chars.get(char_id).is_some_and(|c| Some(j::s(c, "room")) == room) && st.online.get(char_id).copied().unwrap_or(0.0) > 0.0 }

	/// The client's view of trade, numbered like the text commands number them.
	fn trade(&self, c: &Client) -> Json {
		let st = self.st.borrow();
		let w = &self.w;
		let me = c.me.char_id.as_str();
		let room = c.room();
		let mut orders: Vec<&Json> = st.orders.values().collect();
		orders.sort_by(|a, b| js::locale_compare(j::s(a, "orderId"), j::s(b, "orderId")));
		let open: Vec<&Json> = orders.iter().copied().filter(|o| !j::truthy(j::at(o, "takenBy"))).collect();
		let mine = orders.iter().find(|o| j::s(o, "takenBy") == me);
		let mut listings: Vec<&Json> = st.listings.values().collect();
		listings.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")).then_with(|| js::locale_compare(j::s(a, "listingId"), j::s(b, "listingId"))));
		let in_list = |list: &Json, r: &Option<String>| r.as_ref().is_some_and(|r| j::a(list, "rooms").iter().any(|x| x.as_str() == Some(r.as_str())));
		let order_rooms = j::at(w, "orders");
		let market = j::at(w, "market");
		let pick = |o: &Json, keys: &[&str]| { let mut x = Object::new(); for k in keys { put_some(&mut x, k, o.get(k)); } Json::Object(x) };
		let offers_in: Vec<Json> = st.offers.values().filter(|o| j::s(o, "to") == me && self.here(&st, j::s(o, "from"), room.as_deref())).map(|o| pick(o, &["offerId", "fromName", "giveNames", "want"])).collect();
		let offers_out: Vec<Json> = st.offers.values().filter(|o| j::s(o, "from") == me && self.here(&st, j::s(o, "to"), room.as_deref())).map(|o| pick(o, &["offerId", "toName", "giveNames", "want"])).collect();
		let orders_v = if in_list(order_rooms, &room) { Json::Array(open.iter().filter(|o| Some(j::s(o, "room")) == room.as_deref()).enumerate().map(|(i, o)| obj! { "nr" => (i + 1) as f64, "text" => j::at(o, "text").clone(), "reward" => j::at(j::at(o, "reward"), "count").clone() }).collect()) } else { Json::Null };
		let my_order = match mine {
			Some(m) => {
				let mut x = obj_of(obj! { "text" => j::at(m, "text").clone() });
				put_some(&mut x, "needs", m.get("needs"));
				x.insert("here", Json::Bool(in_list(order_rooms, &room)));
				x.insert("boards", Json::Array(j::a(order_rooms, "rooms").iter().map(|r| { let r = r.as_str().unwrap_or(""); st.rooms.get(r).map_or_else(|| Json::from(r), |x| j::at(x, "name").clone()) }).collect()));
				Json::Object(x)
			}
			None => Json::Null,
		};
		let seed = match &room { Some(r) => { let m = st.seed_rests.values().filter(|x| j::s(x, "charId") == me && j::s(x, "room") == r).map(|x| j::n(x, "untilWorldMs")).fold(0f64, f64::max); if m != 0.0 && !m.is_nan() { Json::Number(m) } else { Json::Null } } None => Json::Null };
		let in_market = in_list(market, &room);
		let listings_v = if in_market { Json::Array(listings.iter().filter(|l| Some(j::s(l, "room")) == room.as_deref()).enumerate().map(|(i, l)| obj! { "nr" => (i + 1) as f64, "itemName" => j::at(l, "itemName").clone(), "count" => j::no(l, "count").unwrap_or(1.0), "price" => j::at(l, "price").clone(), "sellerName" => j::at(l, "sellerName").clone(), "mine" => j::s(l, "seller") == me }).collect()) } else { Json::Null };
		let wanted_v = if in_market {
			let mut ws: Vec<&Json> = st.wanted.values().filter(|x| Some(j::s(x, "room")) == room.as_deref()).collect();
			ws.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")).then_with(|| js::locale_compare(j::s(a, "wantedId"), j::s(b, "wantedId"))));
			Json::Array(ws.iter().enumerate().map(|(i, x)| {
				let proto = j::s(x, "proto");
				let until = self.lapse_in(&st, j::no(x, "expiresWorldMs"));
				let traded = j::a(w, "npcs").iter().any(|n| j::at(j::at(n, "prices"), proto).as_array().and_then(|a| a.get(1)).and_then(Json::as_f64).unwrap_or(0.0) > 0.0);
				obj! { "nr" => (i + 1) as f64, "protoName" => j::at(x, "protoName").clone(), "count" => j::no(x, "count").unwrap_or(1.0), "price" => j::at(x, "price").clone(), "buyerName" => j::at(x, "buyerName").clone(), "mine" => j::s(x, "buyer") == me,
					"replies" => Json::Array(j::a(x, "replies").iter().map(|r| obj! { "name" => j::at(r, "name").clone(), "ask" => j::at(r, "ask").clone() }).collect()), "traded" => traded, "until" => until }
			}).collect())
		} else { Json::Null };
		obj! { "offersIn" => Json::Array(offers_in), "offersOut" => Json::Array(offers_out), "orders" => orders_v, "myOrder" => my_order, "seedRestUntilWorldMs" => seed, "listings" => listings_v, "wanted" => wanted_v }
	}
	fn lapse_in(&self, st: &State, at: Option<f64>) -> Json {
		let (Some(clock), Some(at)) = (&st.clock, at) else { return Json::Null };
		let rate = j::no(clock, "decayRate").unwrap_or_else(|| j::n(clock, "rate"));
		if j::truthy(j::at(clock, "paused")) || rate.is_nan() || rate <= 0.0 { return Json::Null; }
		Json::Number(now() + 0f64.max(at - decay_at(clock, now())) / rate)
	}

	/// The overview: the rooms with a place on it and the ways between them.
	fn atlas(&self) -> Json {
		let st = self.st.borrow();
		let w = &self.w;
		let market = j::a(j::at(w, "market"), "rooms");
		let rooms: Vec<Json> = st.rooms.values().filter(|r| j::truthy(j::at(r, "map"))).map(|r| {
			let rid = j::s(r, "roomId");
			let mut o = obj_of(obj! { "roomId" => rid, "name" => j::at(r, "name").clone(), "island" => j::so(r, "island").unwrap_or(""), "x" => j::at(j::at(r, "map"), "x").clone(), "y" => j::at(j::at(r, "map"), "y").clone(), "ground" => j::at(r, "ground").clone(),
				"fires" => Json::Array(st.atlas_objs.keys().filter_map(|id| st.objs.get(id)).filter(|o| j::s(o, "kind") == "beacon" && j::s(o, "location") == rid).map(|o| obj! { "x" => j::at(o, "x").clone(), "y" => j::at(o, "y").clone() }).collect()) });
			if market.iter().any(|m| m.as_str() == Some(rid)) { o.insert("market", Json::Bool(true)); }
			Json::Object(o)
		}).collect();
		let placed: HashSet<String> = rooms.iter().map(|r| j::s(r, "roomId").to_owned()).collect();
		let mut links: OMap<Json> = OMap::default();
		for e in j::a(w, "exits") {
			let (a, b) = (j::s(e, "room"), j::s(e, "destination"));
			if placed.contains(a) && placed.contains(b) {
				let mut p = [a, b];
				p.sort_by(|x, y| phi_json::utf16_cmp(x, y));
				links.set(&p.join(" "), Json::Array(vec![Json::from(p[0]), Json::from(p[1])]));
			}
		}
		obj! { "rooms" => Json::Array(rooms), "links" => Json::Array(links.values().cloned().collect()) }
	}

	/// What an atlas state needs that is the same for every client, read once per broadcast (not once per client: with
	/// many players the per-client passes over every object of the world were the web process's whole time): what each
	/// character owns, the objects each one has tasks of, and the parts every state shares. The settings the next state
	/// carries are read here too, once.
	fn atlas_shared(&self) -> AtlasShared {
		self.refresh_settings();
		let w = &self.w;
		let st = self.st.borrow();
		let mut owned: HashMap<String, Vec<Json>> = HashMap::new();
		let mut tasks: HashMap<String, Vec<Json>> = HashMap::new();
		for oid in st.atlas_objs.keys() {
			let Some(o) = st.objs.get(oid) else { continue };
			let owner = j::s(o, "ownerId");
			let kind = j::s(o, "kind");
			if !owner.is_empty() && ["site", "building", "bed", "field", "ruin"].contains(&kind) {
				let mut x = obj_of(obj! { "id" => j::at(o, "id").clone(), "kind" => j::at(o, "kind").clone(), "name" => j::at(o, "name").clone(), "room" => j::at(o, "location").clone(), "x" => j::at(o, "x").clone(), "y" => j::at(o, "y").clone() });
				if j::truthy(j::at(o, "plan")) { x.insert("plan", j::at(o, "plan").clone()); }
				owned.entry(owner.to_owned()).or_default().push(Json::Object(x));
			}
			// whose tasks this object may give (todos_for: its owner, a bed's sponsors), each once, in the objects' order
			let mut whose: Vec<&str> = Vec::new();
			if j::truthy(j::at(o, "ownerId")) { whose.push(owner); }
			if kind == "bed" { for sp in j::a(o, "sponsorIds") { if let Some(sp) = sp.as_str() { if !whose.contains(&sp) { whose.push(sp); } } } }
			for who in whose { tasks.entry(who.to_owned()).or_default().push(o.clone()); }
		}
		let mut people = Object::new();
		for ch in st.chars.values() {
			let cid = j::s(ch, "charId");
			if st.online.get(cid).copied().unwrap_or(0.0) <= 0.0 { continue; }
			let room = j::s(ch, "room");
			let mut n = people.get(room).cloned().unwrap_or_else(|| Json::Array(vec![Json::Number(0.0), Json::Number(0.0)]));
			if let Json::Array(a) = &mut n { let i = usize::from(cid.starts_with("npc-")); a[i] = Json::Number(j::number(&a[i]) + 1.0); }
			people.insert(room, n);
		}
		let world_now = st.clock.as_ref().map(|c| world_at(c, now()));
		let lit: Vec<Json> = j::a(w, "beacons").iter().filter(|b| self.burns(&st, st.flames.get(j::s(b, "beaconId")).copied().unwrap_or(0.0))).map(|b| j::at(b, "room").clone()).collect();
		let patient = st.clock.as_ref().map_or(1.0, |c| { let rate = j::n(c, "rate"); rate / j::no(c, "decayRate").unwrap_or(rate) });
		let decay_now = st.clock.as_ref().map(|c| decay_at(c, now()));
		let mut fog = Object::new();
		for (k, v) in st.fog.iter() { fog.insert(k, Json::Number(*v)); }
		let epochs = if !j::truthy(j::at(w, "epochs")) { Json::Null } else if self.epoch_force.get() > 0.0 {
			let mut o = Object::new();
			for r in j::a(w, "rooms") { o.insert(j::so(r, "island").unwrap_or(""), Json::Number(self.epoch_force.get())); }
			Json::Object(o)
		} else {
			let mut o = Object::new();
			for e in st.epochs.values() { o.insert(txt(j::at(e, "island")), j::at(e, "epoch").clone()); }
			Json::Object(o)
		};
		let pack_max = if j::truthy(j::at(w, "pack")) { self.pack_max.get().map_or_else(|| j::at(j::at(w, "pack"), "max").clone(), Json::Number) } else { Json::Null };
		AtlasShared { owned, tasks, people: Json::Object(people), world_now, lit: Json::Array(lit), patient, decay_now, fog: Json::Object(fog), epochs, pack_max, stops: self.stops(&st) }
	}

	fn stops(&self, st: &State) -> Json {
		let w = &self.w;
		let built = |plan: Option<&str>| -> Vec<Json> {
			let mut seen: Vec<String> = Vec::new();
			if let Some(plan) = plan {
				for oid in st.atlas_objs.keys() {
					let Some(o) = st.objs.get(oid) else { continue };
					if j::s(o, "kind") == "building" && j::s(o, "plan") == plan { let l = j::s(o, "location").to_owned(); if !seen.contains(&l) { seen.push(l); } }
				}
			}
			seen.into_iter().map(Json::from).collect()
		};
		let roads: Vec<Json> = st.atlas_objs.keys().filter_map(|oid| st.objs.get(oid)).filter(|o| j::s(o, "kind") == "road" && j::s(o, "roadState") == "built" && j::truthy(j::at(o, "roadTo"))).map(|o| Json::Array(vec![j::at(o, "location").clone(), j::at(o, "roadTo").clone()])).collect();
		obj! { "jetties" => Json::Array(built(j::so(j::at(w, "fishing"), "plan"))), "stations" => Json::Array(built(j::so(j::at(w, "rail"), "plan"))), "trainFare" => j::no(j::at(w, "rail"), "fare").unwrap_or(1.0), "roads" => Json::Array(roads) }
	}

	fn atlas_state(&self, c: &Client, sh: &AtlasShared) -> Json {
		let st = self.st.borrow();
		let mine = sh.tasks.get(&c.me.char_id).map_or(&[][..], Vec::as_slice);
		let todos = todos_for(&c.me.char_id, mine.iter(), &|id| st.herds.get(id).cloned(), st.mill_loads.values(), &self.w, sh.world_now, sh.patient, sh.decay_now);
		obj! { "todos" => todos, "here" => c.room().unwrap_or_default(), "fog" => sh.fog.clone(), "lit" => sh.lit.clone(), "people" => sh.people.clone(), "mine" => Json::Array(sh.owned.get(&c.me.char_id).cloned().unwrap_or_default()), "epochs" => sh.epochs.clone(), "beamCost" => self.beam_cost.get(), "packMax" => sh.pack_max.clone(), "stops" => sh.stops.clone() }
	}

	/// Something on the overview changed: its state goes out to every client once the short pause is over.
	fn atlas_changed(&self, geometry: bool) {
		if geometry { self.atlas_geometry.set(true); }
		if self.atlas_due.replace(true) { return; }
		let g = Rc::downgrade(&self.rc());
		tokio::task::spawn_local(async move {
			tokio::time::sleep(Duration::from_millis(ATLAS_MS)).await;
			let Some(g) = g.upgrade() else { return };
			g.atlas_due.set(false);
			let shared = g.atlas_shared();
			let atlas = if g.atlas_geometry.replace(false) { Some(obj! { "t" => "atlas", "atlas" => g.atlas() }.to_json_text()) } else { None };
			let cs: Vec<Rc<Client>> = g.clients.borrow().clone();
			for c in cs { if c.atlas.get() {
				if let Some(a) = &atlas { c.ws.send_text(a); }
				c.ws.send(&obj! { "t" => "atlasState", "state" => g.atlas_state(&c, &shared) });
			} }
		});
	}

	fn burns(&self, st: &State, until: f64) -> bool { st.clock.as_ref().is_some_and(|c| until > world_at(c, now())) }
	fn real_until(&self, st: &State, until: f64) -> f64 {
		let n = now();
		let Some(clock) = &st.clock else { return 0.0 };
		if !self.burns(st, until) { return 0.0; }
		let wait = ms_until_world(clock, until, n);
		n + if wait.is_finite() { wait } else { 10.0 * 365.0 * 24.0 * 3_600_000.0 }
	}
	fn view(&self, st: &State, o: &Json) -> Json {
		if j::s(o, "kind") != "beacon" { return o.clone(); }
		let mut v = o.clone();
		j::set(&mut v, "until", self.real_until(st, st.flames.get(j::s(o, "id")).copied().unwrap_or(0.0)));
		v
	}
	/// Whether `loc` is the chest of one of `char_id`'s own buildings in `room` (or inside it).
	fn in_own_chest(&self, st: &State, loc: Option<&str>, char_id: &str, room: Option<&str>) -> bool {
		let (Some(loc), Some(room)) = (loc.filter(|l| !l.is_empty()), room) else { return false };
		let Some(b) = st.objs.get(loc) else { return false };
		if j::s(b, "kind") != "building" || j::s(b, "ownerId") != char_id || (j::s(b, "location") != room && room != interior_of(j::s(b, "id"))) { return false; }
		j::a(j::at(&self.w, "building"), "plans").iter().find(|p| j::at(p, "key") == j::at(b, "plan")).is_some_and(|p| j::truthy(j::at(p, "chest")) && !j::truthy(j::at(p, "store")))
	}
	fn announce_obj(&self, obj_id: &str, before: Option<&str>) {
		let o = { let st = self.st.borrow(); st.objs.get(obj_id).map(|b| self.view(&st, b)) };
		let obj_loc = o.as_ref().and_then(|o| j::so(o, "location").map(str::to_owned));
		let obj_text = o.as_ref().map(|o| obj! { "t" => "obj", "o" => o.clone() }.to_json_text());
		let gone_text = obj! { "t" => "objgone", "id" => obj_id }.to_json_text();
		let clients: Vec<Rc<Client>> = self.clients.borrow().clone();
		for cl in clients {
			let room = cl.room();
			let sees = |loc: Option<&str>| { let st = self.st.borrow(); loc.is_some_and(|l| !l.is_empty() && (room.as_deref() == Some(l) || cl.me.char_id == l || self.in_own_chest(&st, Some(l), &cl.me.char_id, room.as_deref()))) };
			if let (Some(loc), Some(text)) = (obj_loc.as_deref(), &obj_text) {
				if sees(Some(loc)) { cl.ws.send_text(text); continue; }
			}
			if sees(before) { cl.ws.send_text(&gone_text); }
		}
	}
}
