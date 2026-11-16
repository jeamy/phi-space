//! Chat between players (`server/chat.ts`): talks between two, groups by invitation, blocks, reports, kept in the
//! accounts space. The pages seal every copy (end to end); this module checks who may read a talk, keeps each copy as a
//! ChatMsg entry and tells the pages of new messages and state by the accounts space's change stream.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::time::Duration;

use mmo_engine::j;
use mmo_engine::js;
use mmo_engine::source::{hex, random_bytes, time_now};
use mmo_engine::space::{fields, tmpl, Space, NO_WAIT};
use phi_json::{obj, Json, Object};
use phi_spaces_client::cut_text;

use crate::gateway::Gateway;

#[derive(Clone, Debug)]
pub struct ChatUser { pub account_id: String, pub name: String, pub guest: bool }

enum ChatErr { Chat(String), Other(String) }
impl From<mmo_engine::space::Error> for ChatErr { fn from(e: mmo_engine::space::Error) -> Self { ChatErr::Other(e.to_string()) } }
type R<T> = Result<T, ChatErr>;
fn refuse<T>(t: impl Into<String>) -> R<T> { Err(ChatErr::Chat(t.into())) }

const VERBS: [&str; 13] = ["chat", "tell", "whisper", "flüstere", "fluestere", "flüster", "gruppe", "group", "ignoriere", "ignore", "erlaube", "unignore", "melde"];
const SUB: [&str; 12] = ["neu", "new", "lade", "invite", "annehmen", "accept", "ablehnen", "decline", "verlasse", "leave", "entferne", "remove"];
const MAX_BOX: usize = 4000;
const KEEP: usize = 50;
const GROUP_MAX: usize = 20;
const OWN_MAX: f64 = 10.0;
const REPORT_MS: f64 = 30.0 * 24.0 * 3_600_000.0;
const FOREVER: f64 = -1.0;
const NOT_PLAIN: &str = "Chat-Nachrichten gehen nur verschlüsselt, aus dem Chat der Seite (Reiter „Chats“); dort richtest du ihn mit einem Chat-Passwort ein.";
const UNREACHABLE: &str = "Der Chat ist gerade nicht erreichbar; bitte gleich noch einmal.";
const BAD_MSG: &str = "Ungültige Nachricht.";
fn msg_ms() -> f64 { crate::env_ms("SPACES_MMO_CHAT_MSG_MS", 7.0 * 24.0 * 3_600_000.0) }
fn invite_ms() -> f64 { crate::env_ms("SPACES_MMO_CHAT_INVITE_MS", 24.0 * 3_600_000.0) }
fn new_id() -> String { hex(&random_bytes(8)) }

/// The first word of a line and the rest after it, when the line is a chat line (`LINE`, case-insensitive, followed by
/// a space or the end).
fn line_verb(line: &str) -> Option<(String, &str)> {
	let end = line.find(js::is_js_space).unwrap_or(line.len());
	let word = js::lower(&line[..end]);
	let verb = if word == "report" { "report".to_owned() } else { word };
	(VERBS.contains(&verb.as_str()) || verb == "report").then_some((verb, &line[end..]))
}
pub fn is_chat_line(line: &str) -> bool { line_verb(line).is_some() }
pub fn is_chat_frame(f: &Json) -> bool { ["chatkey", "chatkeys", "chatsend", "chatreport", "chatwaiting", "chatdeliver"].contains(&j::s(f, "t")) }

fn note(kind: &str, text: &str) -> Json { obj! { "t" => "msg", "m" => obj! { "kind" => kind, "text" => text, "from" => "", "at" => time_now() } } }
fn wait_note(from: &[String]) -> String { format!("{} möchte dir im Chat schreiben. Richte im Reiter „Chats“ den Chat mit einem Chat-Passwort ein, dann kommen die Nachrichten an.", from.join(", ")) }
fn split_ws(s: &str) -> Vec<&str> { js::re(r"\s+", "").split(s).into_iter().flatten().collect() }
fn cut20(s: &str) -> String { js::slice16(s, 0, Some(20)).to_owned() }
fn b64(s: &str) -> bool { !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') }
fn box_ok(b: &Json, pub_key: &str) -> bool {
	let (iv, ct, p) = (j::at(b, "iv"), j::at(b, "ct"), j::at(b, "pub"));
	b.as_object().is_some() && p.as_str() == Some(pub_key) && [iv, ct, p].iter().all(|x| x.as_str().is_some_and(b64)) && js::len16(ct.as_str().unwrap_or("")) <= MAX_BOX && js::len16(iv.as_str().unwrap_or("")) <= 40
}
fn box_text(b: &Json) -> String { obj! { "iv" => j::at(b, "iv").clone(), "ct" => j::at(b, "ct").clone(), "pub" => j::at(b, "pub").clone() }.to_json_text() }
/// JavaScript's `Number(x) || 0`.
fn number_or_zero(v: &Json) -> f64 {
	let n = match v { Json::Number(n) => *n, Json::String(s) => js::to_number(s), Json::Bool(b) => f64::from(u8::from(*b)), Json::Null => 0.0, Json::Array(a) if a.is_empty() => 0.0, _ => f64::NAN };
	if n.is_nan() { 0.0 } else { n }
}
fn by_at(list: &mut [Json]) { list.sort_by(|a, b| j::number(j::at(fields(a), "at")).total_cmp(&j::number(j::at(fields(b), "at")))); }

/// The accounts a known chat entry concerns, and its group.
type Concern = (Vec<String>, Option<String>);

pub struct Chat {
	space: Space,
	hooks: Weak<Gateway>,
	closed: Cell<bool>,
	concerns: RefCell<HashMap<String, Concern>>,
}

struct Readers { conv: Json, group_id: String, readers: Vec<(String, String, Option<String>)> }

impl Chat {
	pub fn new(space: Space, hooks: Weak<Gateway>) -> Rc<Chat> {
		let c = Rc::new(Chat { space, hooks, closed: Cell::new(false), concerns: RefCell::default() });
		let c2 = c.clone();
		tokio::task::spawn_local(async move { c2.run().await });
		c
	}
	pub fn close(&self) { self.closed.set(true); }
	fn g(&self) -> Option<Rc<Gateway>> { self.hooks.upgrade() }
	fn name_of(&self, account_id: &str) -> String { self.g().map_or_else(String::new, |g| g.name_of(account_id)) }
	fn send(&self, account_id: &str, f: &Json) { if let Some(g) = self.g() { g.send_to(account_id, f); } }
	fn online(&self, account_id: &str) -> bool { self.g().is_some_and(|g| g.is_online(account_id)) }

	async fn all(&self, ty: &str, f: Json) -> R<Vec<Json>> { Ok(self.space.read_all(&tmpl(ty, f), None).await?) }
	async fn count(&self, ty: &str, f: Json) -> R<f64> { Ok(self.space.count(&tmpl(ty, f), None).await?) }
	async fn take(&self, t: &Json) -> R<Option<Json>> { Ok(self.space.take_if_exists(t, NO_WAIT, None).await?) }

	/// A new page of `me`: the talks so far and the state.
	pub async fn attach(&self, me: &ChatUser, send: &dyn Fn(&Json)) -> Result<(), String> {
		let r: R<()> = async {
			let mut msgs: Vec<Json> = self.all("ChatMsg", obj! { "to" => me.account_id.as_str() }).await?.iter().map(|e| fields(e).clone()).collect();
			msgs.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")));
			send(&obj! { "t" => "chatme", "accountId" => me.account_id.as_str(), "key" => self.key(&me.account_id).await?.unwrap_or(Json::Null) });
			let skip = msgs.len().saturating_sub(300);
			send(&obj! { "t" => "chatlog", "msgs" => Json::Array(msgs[skip..].iter().map(|m| self.view(m)).collect()) });
			let state = self.state(&me.account_id).await?;
			let waiting: Vec<String> = j::a(&state, "waiting").iter().map(|w| j::s(w, "from").to_owned()).collect();
			send(&obj! { "t" => "chats", "state" => state });
			if !waiting.is_empty() && self.key(&me.account_id).await?.is_none() { send(&note("info", &wait_note(&waiting))); }
			Ok(())
		}.await;
		r.map_err(|e| match e { ChatErr::Chat(m) | ChatErr::Other(m) => m })
	}

	fn answer(&self, r: R<()>, reply: &dyn Fn(&Json)) {
		match r {
			Ok(()) => {}
			Err(ChatErr::Chat(m)) => reply(&note("error", &m)),
			Err(ChatErr::Other(m)) => { eprintln!("[chat] {m}"); reply(&note("error", UNREACHABLE)); }
		}
	}

	/// Runs a chat line of `me`; false when the line is not one.
	pub async fn handle(&self, me: &ChatUser, line: &str, reply: &dyn Fn(&Json)) -> bool {
		let Some((verb, rest)) = line_verb(line) else { return false };
		let rest = js::trim(rest);
		let r = match verb.as_str() {
			"chat" | "tell" | "whisper" | "flüstere" | "fluestere" | "flüster" => self.direct(me, rest, reply),
			"gruppe" | "group" => self.group(me, rest, reply).await,
			"ignoriere" | "ignore" => self.ignore(me, rest, reply).await,
			"erlaube" | "unignore" => self.allow(me, rest, reply).await,
			_ => refuse("Gemeldet wird über „Melden“ an einer Nachricht im Chat der Seite."),
		};
		self.answer(r, reply);
		true
	}

	/// A chat frame of the page.
	pub async fn frame(&self, me: &ChatUser, f: &Json, reply: &dyn Fn(&Json)) {
		let r: R<()> = async {
			match j::s(f, "t") {
				"chatkey" => self.set_key(me, f, reply).await,
				"chatkeys" => {
					let r = self.readers(me, j::at(f, "conv")).await?;
					let readers: Vec<Json> = r.readers.iter().filter_map(|(a, n, p)| p.as_ref().map(|p| obj! { "accountId" => a.as_str(), "name" => n.as_str(), "pub" => p.as_str() })).collect();
					let missing: Vec<Json> = r.readers.iter().filter(|x| x.2.is_none()).map(|x| Json::from(x.1.as_str())).collect();
					reply(&obj! { "t" => "chatkeys", "conv" => r.conv, "readers" => Json::Array(readers), "missing" => Json::Array(missing), "req" => number_or_zero(j::at(f, "req")) });
					Ok(())
				}
				"chatsend" => self.send_msg(me, f).await,
				"chatwaiting" => { let items = self.hand_on(&me.account_id).await?; if !items.is_empty() { reply(&obj! { "t" => "chatreseal", "items" => Json::Array(items) }); } Ok(()) }
				"chatdeliver" => self.deliver(me, f).await,
				_ => self.report(me, f, reply).await,
			}
		}.await;
		self.answer(r, reply);
	}

	/// The groups, invitations, blocks and waiting messages of an account.
	pub async fn state_of(&self, account_id: &str) -> Result<Json, String> { self.state(account_id).await.map_err(|e| match e { ChatErr::Chat(m) | ChatErr::Other(m) => m }) }
	async fn state(&self, account_id: &str) -> R<Json> {
		let mut groups: Vec<Json> = Vec::new();
		for mem in self.all("ChatMember", obj! { "accountId" => account_id }).await? {
			let Some(g) = self.group_by_id(j::s(fields(&mem), "groupId")).await? else { continue };
			let mut members: Vec<String> = self.members(j::s(&g, "groupId")).await?.iter().map(|x| self.name_of(j::s(x, "accountId"))).collect();
			members.sort_by(|a, b| js::locale_compare(a, b));
			groups.push(obj! { "groupId" => j::at(&g, "groupId").clone(), "name" => j::at(&g, "name").clone(), "members" => Json::Array(members.into_iter().map(Json::from).collect()), "owner" => j::s(&g, "owner") == account_id });
		}
		let mut invites: Vec<Json> = Vec::new();
		for inv in self.all("ChatInvite", obj! { "to" => account_id }).await? {
			let f = fields(&inv);
			if let Some(g) = self.group_by_id(j::s(f, "groupId")).await? { invites.push(obj! { "groupId" => j::at(&g, "groupId").clone(), "name" => j::at(&g, "name").clone(), "from" => self.name_of(j::s(f, "fromId")) }); }
		}
		let mut blocked: Vec<String> = self.all("ChatBlock", obj! { "who" => account_id }).await?.iter().map(|e| self.name_of(j::s(fields(e), "whom"))).collect();
		js::utf16_sort(&mut blocked);
		let mut waits: Vec<(String, f64)> = Vec::new();
		for e in self.all("ChatWait", obj! { "to" => account_id }).await? {
			let w = fields(&e);
			let n = { let n = self.name_of(j::s(w, "fromId")); if n.is_empty() { j::s(w, "fromName").to_owned() } else { n } };
			match waits.iter_mut().find(|x| x.0 == n) { Some(x) => x.1 += 1.0, None => waits.push((n, 1.0)) }
		}
		groups.sort_by(|a, b| js::locale_compare(j::s(a, "name"), j::s(b, "name")));
		Ok(obj! { "groups" => Json::Array(groups), "invites" => Json::Array(invites), "blocked" => Json::Array(blocked.into_iter().map(Json::from).collect()),
			"waiting" => Json::Array(waits.into_iter().map(|(from, count)| obj! { "from" => from, "count" => count }).collect()) })
	}

	/// The reports for the admins, newest first.
	pub async fn reports(&self) -> Result<Json, String> {
		let mut r: Vec<Json> = self.space.read_all(&obj! { "type" => "ChatReport" }, None).await.map_err(|e| e.to_string())?.iter().map(|e| fields(e).clone()).collect();
		r.sort_by(|a, b| j::n(b, "at").total_cmp(&j::n(a, "at")));
		Ok(Json::Array(r))
	}

	// ---- talks between two

	fn direct(&self, me: &ChatUser, rest: &str, reply: &dyn Fn(&Json)) -> R<()> {
		let Some(m) = js::caps(&js::re(r"^(\S+)\s*([\s\S]*)$", ""), rest) else { return refuse("So geht es: chat <name> <text>, z. B. chat Ines hallo. „chat <name>“ allein öffnet das Gespräch.") };
		let p = self.player(m[1].as_deref().unwrap_or(""))?;
		if p.account_id == me.account_id { return refuse("Mit dir selbst kannst du nicht chatten."); }
		if !js::trim(m[2].as_deref().unwrap_or("")).is_empty() { return refuse(NOT_PLAIN); }
		reply(&obj! { "t" => "chatopen", "conv" => obj! { "kind" => "dm", "id" => p.account_id.as_str(), "title" => p.name.as_str() } });
		Ok(())
	}

	// ---- groups

	async fn group(&self, me: &ChatUser, rest: &str, reply: &dyn Fn(&Json)) -> R<()> {
		if rest.is_empty() { let s = self.state(&me.account_id).await?; reply(&note("info", &describe(&s))); return Ok(()); }
		let words = split_ws(rest);
		let first = words.first().copied().unwrap_or("");
		let sub = js::lower(first);
		let args = words[1..].join(" ");
		let args = js::trim(&args);
		if !SUB.contains(&sub.as_str()) {
			let g = self.mine(me, first).await?;
			if !args.is_empty() { return refuse(NOT_PLAIN); }
			reply(&obj! { "t" => "chatopen", "conv" => obj! { "kind" => "group", "id" => j::at(&g, "groupId").clone(), "title" => j::at(&g, "name").clone() } });
			return Ok(());
		}
		match sub.as_str() {
			"neu" | "new" => {
				if me.guest { return refuse("Gäste können keine Gruppe gründen; registriere dich dafür."); }
				let name = args;
				if !js::re(r"^[\p{L}\p{N}_-]{2,20}$", "u").test(name) || SUB.contains(&js::lower(name).as_str()) { return refuse("Ein Gruppenname hat 2 bis 20 Buchstaben, Ziffern, - oder _, z. B. gruppe neu Bautrupp."); }
				if self.group_by_name(name).await?.is_some() { return refuse(format!("Eine Gruppe „{name}“ gibt es schon.")); }
				if self.count("ChatGroup", obj! { "owner" => me.account_id.as_str() }).await? >= OWN_MAX { return refuse(format!("Du verwaltest schon {} Gruppen.", OWN_MAX)); }
				let gid = new_id();
				let g = obj! { "groupId" => gid.as_str(), "name" => name, "key" => js::lower(name), "owner" => me.account_id.as_str(), "at" => time_now() };
				if let Err(e) = self.space.write_unique(&tmpl("ChatGroup", g), None, FOREVER, &["key"]).await {
					if e.to_string().contains("unique entry already exists") { return refuse(format!("Eine Gruppe „{name}“ gibt es schon.")); }
					return Err(e.into());
				}
				self.space.write(&tmpl("ChatMember", obj! { "groupId" => gid.as_str(), "accountId" => me.account_id.as_str(), "at" => time_now() }), None, FOREVER).await?;
				reply(&note("info", &format!("Gruppe „{name}“ gegründet. Lade ein mit: gruppe lade <name> in {name}")));
				Ok(())
			}
			"lade" | "invite" => {
				if me.guest { return refuse("Gäste können niemanden in eine Gruppe einladen; registriere dich dafür."); }
				let Some(m) = js::caps(&js::re(r"^(\S+)\s+(?:(?:in|zu|to|into)\s+)?(\S+)(?:\s+ein)?$", "i"), args) else { return refuse("So geht es: gruppe lade <name> in <gruppe>") };
				let g = self.mine(me, m[2].as_deref().unwrap_or("")).await?;
				let p = self.player(m[1].as_deref().unwrap_or(""))?;
				let (gid, gname) = (j::s(&g, "groupId"), j::s(&g, "name"));
				if self.members(gid).await?.iter().any(|x| j::s(x, "accountId") == p.account_id) { return refuse(format!("{} ist schon in „{gname}“.", p.name)); }
				if !self.all("ChatInvite", obj! { "groupId" => gid, "to" => p.account_id.as_str() }).await?.is_empty() { return refuse(format!("{} ist schon eingeladen.", p.name)); }
				if self.members(gid).await?.len() >= GROUP_MAX { return refuse(format!("„{gname}“ ist voll ({GROUP_MAX}).")); }
				if self.blocks(&p.account_id, &me.account_id).await? { return refuse(format!("{} nimmt keine Einladungen von dir an.", p.name)); }
				self.space.write(&tmpl("ChatInvite", obj! { "inviteId" => new_id(), "groupId" => gid, "to" => p.account_id.as_str(), "fromId" => me.account_id.as_str(), "at" => time_now() }), None, invite_ms()).await?;
				reply(&note("info", &format!("{} ist in „{gname}“ eingeladen.", p.name)));
				Ok(())
			}
			"annehmen" | "accept" | "ablehnen" | "decline" => {
				let g = self.group_by_name(args).await?;
				let inv = match &g { Some(g) => self.take(&tmpl("ChatInvite", obj! { "groupId" => j::at(g, "groupId").clone(), "to" => me.account_id.as_str() })).await?, None => None };
				let (Some(g), Some(_)) = (g, inv) else { return refuse(format!("Du hast keine Einladung in „{}“.", cut20(args))) };
				let gname = j::s(&g, "name");
				if sub == "ablehnen" || sub == "decline" { reply(&note("info", &format!("Einladung in „{gname}“ abgelehnt."))); return Ok(()); }
				if self.members(j::s(&g, "groupId")).await?.len() >= GROUP_MAX { return refuse(format!("„{gname}“ ist inzwischen voll.")); }
				self.space.write(&tmpl("ChatMember", obj! { "groupId" => j::at(&g, "groupId").clone(), "accountId" => me.account_id.as_str(), "at" => time_now() }), None, FOREVER).await?;
				self.note(&g, &format!("{} ist der Gruppe beigetreten.", me.name)).await
			}
			"verlasse" | "leave" => {
				let g = self.mine(me, args).await?;
				let (gid, gname) = (j::s(&g, "groupId").to_owned(), j::s(&g, "name").to_owned());
				self.take(&tmpl("ChatMember", obj! { "groupId" => gid.as_str(), "accountId" => me.account_id.as_str() })).await?;
				let mut left = self.members(&gid).await?;
				if left.is_empty() {
					self.take(&tmpl("ChatGroup", obj! { "groupId" => gid.as_str() })).await?;
					for e in self.all("ChatInvite", obj! { "groupId" => gid.as_str() }).await? { self.take(&obj! { "id" => j::at(&e, "id").clone() }).await?; }
					reply(&note("info", &format!("Du hast „{gname}“ verlassen; die Gruppe ist aufgelöst.")));
					return Ok(());
				}
				if j::s(&g, "owner") == me.account_id {
					left.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")));
					let next = j::s(&left[0], "accountId").to_owned();
					if let Some(e) = self.take(&tmpl("ChatGroup", obj! { "groupId" => gid.as_str() })).await? {
						let mut f = fields(&e).clone();
						j::set(&mut f, "owner", next);
						self.space.write(&tmpl("ChatGroup", f), None, FOREVER).await?;
					}
				}
				reply(&note("info", &format!("Du hast „{gname}“ verlassen.")));
				self.note(&g, &format!("{} hat die Gruppe verlassen.", me.name)).await
			}
			_ => {
				let Some(m) = js::caps(&js::re(r"^(\S+)\s+(?:(?:aus|from)\s+)?(\S+)$", "i"), args) else { return refuse("So geht es: gruppe entferne <name> aus <gruppe>") };
				let g = self.mine(me, m[2].as_deref().unwrap_or("")).await?;
				let p = self.player(m[1].as_deref().unwrap_or(""))?;
				let gname = j::s(&g, "name");
				if j::s(&g, "owner") != me.account_id { return refuse(format!("Nur wer „{gname}“ verwaltet, kann jemanden entfernen.")); }
				if p.account_id == me.account_id { return refuse("Dich selbst nimmst du mit „gruppe verlasse“ heraus."); }
				if self.take(&tmpl("ChatMember", obj! { "groupId" => j::at(&g, "groupId").clone(), "accountId" => p.account_id.as_str() })).await?.is_none() { return refuse(format!("{} ist nicht in „{gname}“.", p.name)); }
				reply(&note("info", &format!("{} ist nicht mehr in „{gname}“.", p.name)));
				self.note(&g, &format!("{} wurde aus der Gruppe entfernt.", p.name)).await
			}
		}
	}

	// ---- blocks and reports

	async fn ignore(&self, me: &ChatUser, rest: &str, reply: &dyn Fn(&Json)) -> R<()> {
		if rest.is_empty() {
			let s = self.state(&me.account_id).await?;
			let b: Vec<&str> = j::a(&s, "blocked").iter().filter_map(Json::as_str).collect();
			reply(&note("info", &if b.is_empty() { "Du ignorierst niemanden.".to_owned() } else { format!("Du ignorierst: {}. „erlaube <name>“ hebt es auf.", b.join(", ")) }));
			return Ok(());
		}
		let p = self.player(split_ws(rest)[0])?;
		if p.account_id == me.account_id { return refuse("Dich selbst kannst du nicht ignorieren."); }
		if !self.blocks(&me.account_id, &p.account_id).await? { self.space.write(&tmpl("ChatBlock", obj! { "who" => me.account_id.as_str(), "whom" => p.account_id.as_str(), "at" => time_now() }), None, FOREVER).await?; }
		for e in self.all("ChatInvite", obj! { "to" => me.account_id.as_str(), "fromId" => p.account_id.as_str() }).await? { self.take(&obj! { "id" => j::at(&e, "id").clone() }).await?; }
		reply(&note("info", &format!("Du ignorierst {0}: keine Nachrichten und Einladungen mehr. „erlaube {0}“ hebt es auf.", p.name)));
		Ok(())
	}

	async fn allow(&self, me: &ChatUser, rest: &str, reply: &dyn Fn(&Json)) -> R<()> {
		if rest.is_empty() { return refuse("So geht es: erlaube <name>"); }
		let p = self.player(split_ws(rest)[0])?;
		if self.take(&tmpl("ChatBlock", obj! { "who" => me.account_id.as_str(), "whom" => p.account_id.as_str() })).await?.is_none() { return refuse(format!("Du ignorierst {} nicht.", p.name)); }
		reply(&note("info", &format!("{} kann dir wieder schreiben.", p.name)));
		Ok(())
	}

	async fn report(&self, me: &ChatUser, r: &Json, reply: &dyn Fn(&Json)) -> R<()> {
		let msg_id = j::so(r, "msgId").unwrap_or("");
		let m = if msg_id.is_empty() { None } else { self.all("ChatMsg", obj! { "msgId" => msg_id, "to" => me.account_id.as_str() }).await?.into_iter().next() };
		let Some(m) = m else { return refuse("Diese Nachricht gibt es nicht (mehr).") };
		let f = fields(&m);
		if j::s(f, "fromId") == me.account_id || j::s(f, "fromId").is_empty() { return refuse("Melden kannst du nur Nachrichten anderer."); }
		let text = j::so(r, "text").map_or("", |t| cut_text(t, 1000));
		self.space.write(&tmpl("ChatReport", obj! { "reportId" => new_id(), "by" => me.account_id.as_str(), "byName" => me.name.as_str(), "fromId" => j::at(f, "fromId").clone(), "fromName" => j::at(f, "fromName").clone(), "text" => text, "at" => time_now() }), None, REPORT_MS).await?;
		reply(&note("info", &format!("Gemeldet. Die Admins sehen sich die Nachricht von {} an.", j::s(f, "fromName"))));
		Ok(())
	}

	// ---- helpers

	fn player(&self, name: &str) -> R<ChatUser> {
		match self.g().and_then(|g| g.person(name)) {
			Some(Ok(p)) => Ok(p),
			Some(Err(())) => refuse(format!("{name} ist keine Spielerin und kein Spieler; mit NPCs sprichst du mit „say“.")),
			None => refuse(format!("Niemand heißt „{}“.", cut20(name))),
		}
	}
	async fn group_by_id(&self, group_id: &str) -> R<Option<Json>> { Ok(self.all("ChatGroup", obj! { "groupId" => group_id }).await?.first().map(|e| fields(e).clone())) }
	async fn group_by_name(&self, name: &str) -> R<Option<Json>> { Ok(self.all("ChatGroup", obj! { "key" => js::lower(name) }).await?.first().map(|e| fields(e).clone())) }
	async fn mine(&self, me: &ChatUser, name: &str) -> R<Json> {
		let g = self.group_by_name(name).await?;
		if let Some(g) = &g { if self.count("ChatMember", obj! { "groupId" => j::at(g, "groupId").clone(), "accountId" => me.account_id.as_str() }).await? > 0.0 { return Ok(g.clone()); } }
		refuse(format!("Du bist in keiner Gruppe „{}“. „gruppe“ zeigt deine Gruppen.", cut20(name)))
	}
	async fn members(&self, group_id: &str) -> R<Vec<Json>> { Ok(self.all("ChatMember", obj! { "groupId" => group_id }).await?.iter().map(|e| fields(e).clone()).collect()) }
	async fn blocks(&self, who: &str, whom: &str) -> R<bool> { Ok(self.count("ChatBlock", obj! { "who" => who, "whom" => whom }).await? > 0.0) }
	async fn store(&self, f: Json) -> R<()> {
		let (to, conv) = (j::at(&f, "to").clone(), j::at(&f, "conv").clone());
		self.space.write(&tmpl("ChatMsg", f), None, msg_ms()).await?;
		let mut all = self.all("ChatMsg", obj! { "to" => to, "conv" => conv }).await?;
		if all.len() > KEEP {
			by_at(&mut all);
			let n = all.len() - KEEP;
			for e in &all[..n] { self.take(&obj! { "id" => j::at(e, "id").clone() }).await?; }
		}
		Ok(())
	}
	async fn note(&self, g: &Json, text: &str) -> R<()> {
		let (msg_id, at) = (new_id(), time_now());
		for x in self.members(j::s(g, "groupId")).await? {
			self.store(obj! { "msgId" => msg_id.as_str(), "to" => j::at(&x, "accountId").clone(), "conv" => format!("g:{}", j::s(g, "groupId")), "title" => j::at(g, "name").clone(), "fromId" => "", "fromName" => "", "note" => text, "at" => at }).await?;
		}
		Ok(())
	}
	async fn key(&self, account_id: &str) -> R<Option<Json>> {
		let e = self.all("ChatKey", obj! { "accountId" => account_id }).await?;
		Ok(e.first().map(|e| { let k = fields(e); obj! { "pub" => j::at(k, "pub").clone(), "wrapped" => j::at(k, "wrapped").clone(), "salt" => j::at(k, "salt").clone(), "iter" => j::at(k, "iter").clone() } }))
	}
	async fn set_key(&self, me: &ChatUser, f: &Json, reply: &dyn Fn(&Json)) -> R<()> {
		let k = j::at(f, "key");
		let bad = || refuse::<()>("Ungültiger Schlüssel.");
		let (Some(p), Some(wrapped), Some(salt), Some(iter)) = (j::so(k, "pub"), j::so(k, "wrapped"), j::so(k, "salt"), j::no(k, "iter")) else { return bad() };
		if iter.fract() != 0.0 || !iter.is_finite() { return bad(); }
		let wrapped_ok = !wrapped.is_empty() && wrapped.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=.".contains(&b));
		if !b64(p) || js::len16(p) > 200 || js::len16(wrapped) > 2000 || !wrapped_ok || !b64(salt) || js::len16(salt) > 100 || iter < 100_000.0 || iter > 10_000_000.0 { return bad(); }
		let old = self.key(&me.account_id).await?;
		let old_pub = old.as_ref().map(|o| j::s(o, "pub").to_owned());
		if old_pub.as_deref().is_some_and(|o| o != p) && !j::truthy(j::at(f, "replace")) { return refuse("Es gibt schon einen Chat-Schlüssel; entsperre ihn mit deinem Chat-Passwort."); }
		self.take(&tmpl("ChatKey", obj! { "accountId" => me.account_id.as_str() })).await?;
		self.space.write(&tmpl("ChatKey", obj! { "accountId" => me.account_id.as_str(), "pub" => p, "wrapped" => wrapped, "salt" => salt, "iter" => iter, "at" => time_now() }), None, FOREVER).await?;
		self.send(&me.account_id, &obj! { "t" => "chatme", "accountId" => me.account_id.as_str(), "key" => obj! { "pub" => p, "wrapped" => wrapped, "salt" => salt, "iter" => iter } });
		if old_pub.as_deref() != Some(p) {
			let mut senders: Vec<String> = Vec::new();
			for e in self.all("ChatWait", obj! { "to" => me.account_id.as_str() }).await? { let s = j::s(fields(&e), "fromId").to_owned(); if !senders.contains(&s) { senders.push(s); } }
			for s in senders {
				let items: Vec<Json> = self.hand_on(&s).await?.into_iter().filter(|i| j::s(i, "to") == me.account_id).collect();
				if !items.is_empty() { self.send(&s, &obj! { "t" => "chatreseal", "items" => Json::Array(items) }); }
			}
		}
		reply(&note("info", match old_pub.as_deref() { None => "Chat eingerichtet. Deine Nachrichten sind Ende-zu-Ende verschlüsselt.", Some(o) if o == p => "Chat-Passwort geändert.", _ => "Neuer Chat-Schlüssel: was für den alten geschrieben wurde, ist nicht mehr lesbar." }));
		Ok(())
	}
	async fn pub_of(&self, account_id: &str) -> R<Option<String>> { Ok(self.key(account_id).await?.map(|k| j::s(&k, "pub").to_owned())) }
	async fn readers(&self, me: &ChatUser, conv: &Json) -> R<Readers> {
		if j::s(conv, "kind") == "dm" {
			let other = js_string(j::at(conv, "id"));
			let name = self.name_of(&other);
			if name.is_empty() || other == me.account_id { return refuse("Dieses Gespräch gibt es nicht."); }
			if self.blocks(&other, &me.account_id).await? { return refuse(format!("{name} nimmt keine Nachrichten von dir an.")); }
			let readers = vec![(other.clone(), name.clone(), self.pub_of(&other).await?), (me.account_id.clone(), me.name.clone(), self.pub_of(&me.account_id).await?)];
			return Ok(Readers { conv: obj! { "kind" => "dm", "id" => other, "title" => name }, group_id: String::new(), readers });
		}
		let g = if j::s(conv, "kind") == "group" { self.group_by_id(&js_string(j::at(conv, "id"))).await? } else { None };
		let g = match g { Some(g) if self.count("ChatMember", obj! { "groupId" => j::at(&g, "groupId").clone(), "accountId" => me.account_id.as_str() }).await? > 0.0 => g, _ => return refuse("Du bist nicht in dieser Gruppe.") };
		let gid = j::s(&g, "groupId").to_owned();
		let mut readers = Vec::new();
		for x in self.members(&gid).await? {
			let a = j::s(&x, "accountId").to_owned();
			if a == me.account_id || !self.blocks(&a, &me.account_id).await? {
				let name = if a == me.account_id { me.name.clone() } else { self.name_of(&a) };
				let p = self.pub_of(&a).await?;
				readers.push((a, name, p));
			}
		}
		Ok(Readers { conv: obj! { "kind" => "group", "id" => gid.as_str(), "title" => j::at(&g, "name").clone() }, group_id: gid, readers })
	}
	async fn send_msg(&self, me: &ChatUser, f: &Json) -> R<()> {
		let msg_id = j::so(f, "msgId").unwrap_or("");
		let Some(copies) = j::ao(f, "copies") else { return refuse(BAD_MSG) };
		if msg_id.len() != 16 || !msg_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return refuse(BAD_MSG); }
		let Some(mine) = self.pub_of(&me.account_id).await? else { return refuse(NOT_PLAIN) };
		let r = self.readers(me, j::at(f, "conv")).await?;
		let allowed: HashSet<&str> = r.readers.iter().filter(|x| x.2.is_some()).map(|x| x.0.as_str()).collect();
		if copies.is_empty() || copies.len() > allowed.len() { return refuse(BAD_MSG); }
		let mut seen: HashSet<String> = HashSet::new();
		for c in copies {
			let to = j::so(c, "to").unwrap_or("");
			if !allowed.contains(to) || seen.contains(to) || !box_ok(j::at(c, "box"), &mine) { return refuse(BAD_MSG); }
			seen.insert(to.to_owned());
		}
		if !seen.contains(&me.account_id) { return refuse(BAD_MSG); }
		if self.count("ChatMsg", obj! { "msgId" => msg_id }).await? > 0.0 { return refuse("Diese Nachricht ist schon angekommen."); }
		let at = time_now();
		let title_of_conv = j::s(&r.conv, "title").to_owned();
		for c in copies {
			let to = j::s(c, "to");
			let (conv, title) = if !r.group_id.is_empty() { (format!("g:{}", r.group_id), title_of_conv.clone()) } else if to == me.account_id { (format!("dm:{}", j::s(&r.conv, "id")), title_of_conv.clone()) } else { (format!("dm:{}", me.account_id), me.name.clone()) };
			self.store(obj! { "msgId" => msg_id, "to" => to, "conv" => conv, "title" => title, "fromId" => me.account_id.as_str(), "fromName" => me.name.as_str(), "box" => box_text(j::at(c, "box")), "at" => at }).await?;
		}
		self.wait(me, msg_id, &r, at).await
	}
	async fn wait(&self, me: &ChatUser, msg_id: &str, r: &Readers, at: f64) -> R<()> {
		for (a, _, p) in &r.readers {
			if p.is_some() { continue; }
			let mut had = self.all("ChatWait", obj! { "to" => a.as_str(), "fromId" => me.account_id.as_str() }).await?;
			let (conv, title) = if !r.group_id.is_empty() { (format!("g:{}", r.group_id), j::s(&r.conv, "title").to_owned()) } else { (format!("dm:{}", me.account_id), me.name.clone()) };
			self.space.write(&tmpl("ChatWait", obj! { "msgId" => msg_id, "to" => a.as_str(), "fromId" => me.account_id.as_str(), "fromName" => me.name.as_str(), "conv" => conv, "title" => title, "first" => had.is_empty(), "at" => at }), None, msg_ms()).await?;
			if had.len() >= KEEP {
				by_at(&mut had);
				let n = had.len() - KEEP + 1;
				for e in &had[..n] { self.take(&obj! { "id" => j::at(e, "id").clone() }).await?; }
			}
		}
		Ok(())
	}
	async fn hand_on(&self, sender: &str) -> R<Vec<Json>> {
		let mut items = Vec::new();
		let mut keys: HashMap<String, Option<String>> = HashMap::new();
		for e in self.all("ChatWait", obj! { "fromId" => sender }).await? {
			let w = fields(&e);
			let to = j::s(w, "to").to_owned();
			if !keys.contains_key(&to) { let p = self.pub_of(&to).await?; keys.insert(to.clone(), p); }
			if let Some(Some(p)) = keys.get(&to) {
				let conv = j::s(w, "conv");
				items.push(obj! { "msgId" => j::at(w, "msgId").clone(), "to" => to.as_str(), "pub" => p.as_str(), "groupId" => conv.strip_prefix("g:").unwrap_or("") });
			}
		}
		Ok(items)
	}
	async fn deliver(&self, me: &ChatUser, f: &Json) -> R<()> {
		let b = j::at(f, "box");
		let mine = self.pub_of(&me.account_id).await?;
		let theirs = match j::so(f, "to") { Some(t) => self.pub_of(t).await?, None => None };
		let (Some(mine), Some(_), Some(msg_id)) = (mine, theirs, j::so(f, "msgId")) else { return refuse(BAD_MSG) };
		if !box_ok(b, &mine) { return refuse(BAD_MSG); }
		let Some(e) = self.take(&tmpl("ChatWait", obj! { "msgId" => msg_id, "to" => j::at(f, "to").clone(), "fromId" => me.account_id.as_str() })).await? else { return Ok(()) };
		let w = fields(&e);
		if self.blocks(j::s(w, "to"), &me.account_id).await? { return Ok(()); }
		let conv = j::s(w, "conv");
		if let Some(gid) = conv.strip_prefix("g:") { if self.count("ChatMember", obj! { "groupId" => gid, "accountId" => j::at(w, "to").clone() }).await? == 0.0 { return Ok(()); } }
		self.store(obj! { "msgId" => j::at(w, "msgId").clone(), "to" => j::at(w, "to").clone(), "conv" => conv, "title" => j::at(w, "title").clone(), "fromId" => me.account_id.as_str(), "fromName" => me.name.as_str(), "box" => box_text(b), "at" => j::at(w, "at").clone() }).await
	}
	fn view(&self, m: &Json) -> Json {
		let conv = j::s(m, "conv");
		let (kind, conv_id) = match conv.strip_prefix("g:") { Some(g) => ("group", g), None => ("dm", conv.get(3..).unwrap_or("")) };
		let title = if kind == "dm" { let n = self.name_of(conv_id); if n.is_empty() { txt_of(j::at(m, "title")) } else { Json::from(n) } } else { txt_of(j::at(m, "title")) };
		let from_id = j::s(m, "fromId");
		let from = if from_id.is_empty() { Json::from("") } else { let n = self.name_of(from_id); if n.is_empty() { j::at(m, "fromName").clone() } else { Json::from(n) } };
		let mut o = Object::new();
		o.insert("id", j::at(m, "msgId").clone());
		o.insert("conv", obj! { "kind" => kind, "id" => conv_id, "title" => title });
		o.insert("from", from);
		o.insert("fromId", j::at(m, "fromId").clone());
		o.insert("at", j::at(m, "at").clone());
		if !from_id.is_empty() && from_id == j::s(m, "to") { o.insert("mine", Json::Bool(true)); }
		if let Some(b) = j::so(m, "box").filter(|b| !b.is_empty()).and_then(|b| phi_json::parse(b).ok()) { if j::truthy(&b) { o.insert("box", b); } }
		if let Some(n) = j::so(m, "note").filter(|n| !n.is_empty()) { o.insert("note", Json::from(n)); }
		Json::Object(o)
	}

	// ---- the change stream

	async fn run(self: Rc<Self>) {
		let mut rev = -1.0;
		let types = ["ChatGroup", "ChatMember", "ChatInvite", "ChatBlock", "ChatWait"];
		while !self.closed.get() {
			let r: Result<(), (bool, String)> = async {
				let err = |e: phi_spaces_client::Error| (matches!(e.code(), Some("SnapshotExpired" | "RevisionAhead")), e.to_string());
				let eng = |e: mmo_engine::space::Error| match e { mmo_engine::space::Error::Space(s) => err(s), o => (false, o.to_string()) };
				if rev < 0.0 {
					rev = j::n(&self.space.remote().read_page(&obj! { "type" => "-" }, None, None, None, None, None).await.map_err(err)?, "rev");
					self.concerns.borrow_mut().clear();
					for ty in types { for e in self.space.read_all(&obj! { "type" => ty }, None).await.map_err(eng)? { self.remember(j::s(&e, "id"), ty, fields(&e)); } }
				}
				let ch = self.space.remote().changes(rev, None, Some(20_000.0), None).await.map_err(err)?;
				for b in j::a(&ch, "batches") {
					let (mut touched, mut groups): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
					let add = |v: &mut Vec<String>, x: String| if !v.contains(&x) { v.push(x); };
					for op in j::a(b, "ops") {
						let (id, ty, f) = (j::s(op, "id"), j::s(op, "type"), j::at(op, "fields"));
						if j::s(op, "op") == "put" {
							if ty == "ChatMsg" { self.send(j::s(f, "to"), &obj! { "t" => "chat", "m" => self.view(f) }); continue; }
							if !types.contains(&ty) { continue; }
							let (accounts, group) = self.remember(id, ty, f);
							for a in accounts { add(&mut touched, a); }
							if let Some(g) = group { add(&mut groups, g); }
							if ty == "ChatWait" && j::truthy(j::at(f, "first")) { self.send(j::s(f, "to"), &note("info", &wait_note(&[j::s(f, "fromName").to_owned()]))); }
							if ty == "ChatInvite" {
								if let Some(g) = self.group_by_id(j::s(f, "groupId")).await.map_err(|e| (false, match e { ChatErr::Chat(m) | ChatErr::Other(m) => m }))? {
									let (gname, from) = (j::s(&g, "name"), self.name_of(j::s(f, "fromId")));
									self.send(j::s(f, "to"), &note("info", &format!("{from} lädt dich in die Gruppe „{gname}“ ein: „gruppe annehmen {gname}“ oder „gruppe ablehnen {gname}“.")));
								}
							}
						} else {
							let Some((accounts, group)) = self.concerns.borrow_mut().remove(id) else { continue };
							for a in accounts { add(&mut touched, a); }
							if let Some(g) = group { add(&mut groups, g); }
						}
					}
					let unwrap = |e: ChatErr| (false, match e { ChatErr::Chat(m) | ChatErr::Other(m) => m });
					for g in &groups { for x in self.members(g).await.map_err(unwrap)? { add(&mut touched, j::s(&x, "accountId").to_owned()); } }
					for a in &touched { if self.online(a) { let s = self.state(a).await.map_err(unwrap)?; self.send(a, &obj! { "t" => "chats", "state" => s }); } }
				}
				rev = j::n(&ch, "next");
				Ok(())
			}.await;
			if let Err((resync, m)) = r {
				if self.closed.get() { break; }
				if resync { rev = -1.0; continue; }
				eprintln!("[chat] change stream: {m}");
				tokio::time::sleep(Duration::from_secs(1)).await;
			}
		}
	}
	fn remember(&self, entry_id: &str, ty: &str, f: &Json) -> Concern {
		let s = |k: &str| js_string(j::at(f, k));
		let c = match ty {
			"ChatGroup" => (vec![s("owner")], Some(s("groupId"))),
			"ChatMember" => (vec![s("accountId")], Some(s("groupId"))),
			"ChatInvite" | "ChatWait" => (vec![s("to")], None),
			_ => (vec![s("who")], None),
		};
		self.concerns.borrow_mut().insert(entry_id.to_owned(), c.clone());
		c
	}
}

/// JavaScript's `String(x)` for the values entries hold.
fn js_string(v: &Json) -> String {
	match v { Json::String(s) => s.clone(), Json::Null => "null".into(), Json::Number(n) => js::number_text(*n), Json::Bool(b) => b.to_string(), o => o.to_json_text() }
}
fn txt_of(v: &Json) -> Json { v.clone() }

fn describe(s: &Json) -> String {
	let groups = j::a(s, "groups");
	let mut parts = vec![if groups.is_empty() { "Du bist in keiner Gruppe. „gruppe neu <name>“ gründet eine.".to_owned() } else {
		format!("Deine Gruppen: {}.", groups.iter().map(|g| format!("{} ({})", j::s(g, "name"), j::strs(j::a(g, "members")).join(", "))).collect::<Vec<_>>().join("; "))
	}];
	let inv = j::a(s, "invites");
	if !inv.is_empty() { parts.push(format!("Einladungen: {}.", inv.iter().map(|i| format!("{0} von {1} („gruppe annehmen {0}“)", j::s(i, "name"), j::s(i, "from"))).collect::<Vec<_>>().join(", "))); }
	parts.join(" ")
}
