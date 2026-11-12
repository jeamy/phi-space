//! Trade and economy (`server/engine/commands/trade.ts`): offers between two, the market board with its listings and
//! wanted notices, crafting, the order board, and the ticks that post orders, restock traders and give back what lapsed
//! on the board. Every exchange moves its items in the command's transaction.
use phi_json::{obj, Json, Object};

use super::build::{bau, chest_for_sale, plan_of};
use super::siteorder::board_lines;
use super::interior::{furnishing_for, near_buildings};
use crate::clock::{decay_now_of, patience_of, world_now_of};
use crate::context::{inventory, items_named, msg, stem, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::source::{hex, random_bytes, random_int, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, HELD_WAIT_MS, NO_WAIT};

/// How long a trade offer waits for an answer (real time).
const OFFER_MS: f64 = 120_000.0;

fn txt(v: &Json) -> String { key_text(v) }
/// Bold on the page (client/RichText.tsx): a value marked so keeps its template for the translation.
fn strong(s: &str) -> String { format!("**{s}**") }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn f(e: &Json) -> &Json { fields(e) }
fn info() -> MsgOpts { MsgOpts::default() }
fn templ() -> MsgOpts { MsgOpts { templ: true, ..Default::default() } }
fn names(f: &Json) -> Vec<String> { std::iter::once(j::s(f, "name")).chain(j::strs(j::a(f, "aliases"))).map(str::to_lowercase).collect() }
fn item_id(e: &Json) -> String { txt(j::at(f(e), "itemId")) }

/// A part of a spec: a name and how many.
#[derive(Debug, Clone)]
pub struct Want { pub name: String, pub count: f64 }
impl Want {
	fn of(v: &Json) -> Self { Self { name: txt(j::at(v, "name")), count: j::n(v, "count") } }
	fn json(&self) -> Json { obj! { "name" => self.name.as_str(), "count" => self.count } }
}

/// `parseSpec`: "2 muschel, treibholz".
pub fn parse_spec(s: &str) -> Vec<Want> {
	js::re(r",|\sund\s|\sand\s", "i").split(s).into_iter().map(|p| js::trim(p.unwrap_or("")).to_owned()).filter(|p| !p.is_empty()).map(|p| match js::caps(&js::re(r"^(\d+)\s*x?\s+(.+)$", "i"), &p) {
		Some(m) => Want { name: js::trim(m[2].as_deref().unwrap_or("")).to_lowercase(), count: 50f64.min(1f64.max(js::to_number(m[1].as_deref().unwrap_or("")))) },
		None => Want { name: p.to_lowercase(), count: 1.0 },
	}).collect()
}

enum Picked { Items(Vec<Json>), Missing(String, bool) }

/// `pick`: items of `inv` that satisfy `spec` (each used once), or what is missing (and whether nothing goes by that name).
fn pick(inv: &[Json], spec: &[Want], world: &Json) -> Picked {
	let mut used: Vec<String> = Vec::new();
	let mut items: Vec<Json> = Vec::new();
	for want in spec {
		let free: Vec<Json> = inv.iter().filter(|i| !used.contains(&item_id(i))).cloned().collect();
		let mut hits: Vec<&Json> = free.iter().filter(|i| names(f(i)).contains(&want.name) || j::s(f(i), "proto") == want.name).collect();
		if hits.is_empty() {
			if let Some(near) = items_named(world, &free, &want.name, None).into_iter().next() {
				let proto = j::at(f(&near), "proto").clone();
				hits = free.iter().filter(|i| j::at(f(i), "proto") == &proto).collect();
			}
		}
		if (hits.len() as f64) < want.count { return Picked::Missing(format!("{}× {}", nt(want.count), hits.first().map_or_else(|| want.name.clone(), |h| txt(j::at(f(h), "name")))), hits.is_empty()); }
		for h in hits.into_iter().take(want.count as usize) { used.push(item_id(h)); items.push(h.clone()); }
	}
	Picked::Items(items)
}
fn by_proto(inv: &[Json], proto: &Json, count: f64) -> Option<Vec<Json>> {
	let hits: Vec<Json> = inv.iter().filter(|i| j::at(f(i), "proto") == proto).cloned().collect();
	(hits.len() as f64 >= count).then(|| hits.into_iter().take(count.max(0.0) as usize).collect())
}
fn missing_error(unknown: bool, text: String) -> Error { if unknown { Error::NotUnderstood(text) } else { Error::Command(text) } }

/// `move`: takes an item where it is and writes it at `to` (a pack, or the market's escrow), without its listing.
pub async fn move_item(c: &Ctx, item: &Json, from: &str, to: &str, extra: &[(&str, Json)]) -> Result<()> {
	let Some(e) = c.space.take(&tmpl("Item", obj! { "itemId" => j::at(item, "itemId").clone(), "location" => from }), NO_WAIT, c.txn()).await? else { return refuse(format!("{} ist nicht mehr da.", txt(j::at(item, "name")))) };
	let mut o = j::object(f(&e));
	o.remove("listing");
	o.remove("seller");
	o.insert("location", Json::from(to));
	o.insert("x", Json::from(-1.0));
	o.insert("y", Json::from(-1.0));
	for (k, v) in extra { o.insert(*k, v.clone()); }
	let types: Vec<Json> = j::a(&e, "types").iter().skip(1).cloned().collect();
	c.space.write(&obj! { "type" => j::at(&e, "type").clone(), "types" => Json::Array(types), "fields" => Json::Object(o) }, c.txn(), FOREVER).await?;
	Ok(())
}
/// `consume`: takes an item for good (a boat with cargo or a bill with coins are not used up).
pub async fn consume(c: &Ctx, item: &Json, from: &str) -> Result<()> {
	let proto = j::s(item, "proto");
	let inside_t = tmpl("Item", obj! { "location" => j::at(item, "itemId").clone() });
	let inside = || c.space.count(&inside_t, c.txn());
	let name = txt(j::at(item, "name"));
	if j::opt(j::at(j::at(c.w(), "boat"), "hatch"), proto).is_some_and(j::truthy) && inside().await? > 0.0 { return refuse(format!("In der Luke von {name} liegt noch etwas; entlade sie erst („luke entlade alle“).")); }
	if j::so(j::at(j::at(c.w(), "bank"), "note"), "proto") == Some(proto) && inside().await? > 0.0 { return refuse(format!("{name} wird am Kontor eingelöst („wechsel einlösen“).")); }
	if c.space.take(&tmpl("Item", obj! { "itemId" => j::at(item, "itemId").clone(), "location" => from }), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{name} ist nicht mehr da.")); }
	Ok(())
}

fn no_guest(c: &Ctx) -> Result<()> {
	if c.account.as_ref().is_none_or(|a| j::b(a, "guest")) { return refuse("Gäste können nicht tauschen oder handeln; registriere dich dafür."); }
	Ok(())
}
fn capital(s: &str) -> String { let mut ch = s.chars(); ch.next().map_or_else(String::new, |c| c.to_uppercase().chain(ch).collect()) }
/// `counted`: things by kind with their count ("2× Münze, Perle").
pub fn counted(xs: &[(String, f64)]) -> String {
	let mut m: Vec<(String, f64)> = Vec::new();
	for (n, k) in xs { match m.iter_mut().find(|(x, _)| x == n) { Some(s) => s.1 += k, None => m.push((n.clone(), *k)) } }
	m.iter().map(|(n, k)| if *k > 1.0 { format!("{}× {n}", nt(*k)) } else { n.clone() }).collect::<Vec<_>>().join(", ")
}
fn counted_names(xs: &[String]) -> String { counted(&xs.iter().map(|x| (x.clone(), 1.0)).collect::<Vec<_>>()) }
fn counted_wants(xs: &[Want]) -> String { counted(&xs.iter().map(|w| (capital(&w.name), w.count)).collect::<Vec<_>>()) }

/// The commands of this module by key.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"offer" => offer(c, arg).await,
		"accept" => accept(c, arg).await,
		"decline" => decline(c, arg).await,
		"market" => market(c, arg).await,
		"craft" => craft(c, arg).await,
		"order" => order(c, arg).await,
		k => Err(Error::Other(format!("unported: trade/{k}"))),
	}
}

async fn offer(c: &mut Ctx, arg: &str) -> Result<()> {
	no_guest(c)?;
	let me = c.char_id().to_owned();
	if js::re(r"^(zurück|zurueck|withdraw)$", "i").test(js::trim(arg)) {
		let mut n = 0;
		for e in c.space.read_all(&tmpl("Offer", obj! { "from" => me.as_str() }), None).await? { if c.space.take(&obj! { "type" => "Offer", "id" => j::at(&e, "id").clone() }, NO_WAIT, c.txn()).await?.is_some() { n += 1; } }
		return msg(c, &me, "info", &if n > 0 { format!("{n} Angebot{} zurückgenommen.", if n == 1 { "" } else { "e" }) } else { "Du hast kein offenes Angebot.".into() }, info()).await;
	}
	let Some(m) = js::caps(&js::re(r"^(.+?)\s+(?:an|to)\s+(\S+)(?:\s+(?:für|fuer|for)\s+(.+))?$", "i"), js::trim(arg)) else { return not_understood("So geht es: offer <dinge> an <person> [für <dinge>], z. B. offer treibholz an Bert für münze") };
	let inv = inventory(c).await?;
	let items = match pick(&inv, &parse_spec(m[1].as_deref().unwrap_or("")), c.w()) { Picked::Items(i) => i, Picked::Missing(t, u) => return Err(missing_error(u, format!("Du hast nicht: {t}."))) };
	let to = m[2].clone().unwrap_or_default();
	let who = c.space.read_all(&tmpl("Character", obj! { "room" => c.room() }), None).await?.into_iter().map(|e| f(&e).clone()).find(|ch| j::s(ch, "charId") != me && !j::b(ch, "aboard") && j::s(ch, "name").to_lowercase() == to.to_lowercase());
	let Some(who) = who else { return not_understood(format!("Hier ist niemand namens „{}“.", js::slice16(&to, 0, Some(30)))) };
	let want = m[3].as_deref().map(parse_spec).unwrap_or_default();
	let give_names: Vec<String> = items.iter().map(|i| txt(j::at(f(i), "name"))).collect();
	let o = obj! {
		"offerId" => format!("o-{}", hex(&random_bytes(5))), "from" => me.as_str(), "fromName" => j::at(&c.actor, "name").clone(), "to" => j::at(&who, "charId").clone(), "toName" => j::at(&who, "name").clone(),
		"give" => Json::Array(items.iter().map(|i| j::at(f(i), "itemId").clone()).collect()), "giveNames" => Json::Array(give_names.iter().map(|n| Json::from(n.as_str())).collect()),
		"want" => Json::Array(want.iter().map(Want::json).collect()), "room" => c.room(), "at" => time_now()
	};
	c.space.write(&tmpl("Offer", o), c.txn(), OFFER_MS).await?;
	let wants = if want.is_empty() { " als Geschenk".to_owned() } else { format!(" für {}", strong(&counted_wants(&want))) };
	let name = txt(j::at(&c.actor, "name"));
	msg(c, j::s(&who, "charId"), "info", &format!("{name} bietet dir {}{wants} an. „accept {name}“ nimmt an, „decline {name}“ lehnt ab.", strong(&counted_names(&give_names))), info()).await?;
	msg(c, &me, "info", &format!("Du bietest {} {}{wants} an.", txt(j::at(&who, "name")), strong(&counted_names(&give_names))), info()).await
}

/// `offerFor`: the offer to the actor from `name` (or the newest one).
async fn offer_for(c: &Ctx, name: &str) -> Result<Option<Json>> {
	let all = c.space.read_all(&tmpl("Offer", obj! { "to" => c.char_id() }), None).await?;
	let n = js::trim(name).to_lowercase();
	let mut mine: Vec<Json> = all.into_iter().filter(|o| name.is_empty() || j::s(f(o), "fromName").to_lowercase() == n).collect();
	mine.sort_by(|a, b| (j::n(f(b), "at") - j::n(f(a), "at")).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
	Ok(mine.into_iter().next())
}

async fn accept(c: &mut Ctx, arg: &str) -> Result<()> {
	no_guest(c)?;
	let Some(o) = offer_for(c, arg).await? else { return refuse("Dir liegt kein Angebot vor.") };
	if c.space.take(&obj! { "type" => "Offer", "id" => j::at(&o, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Das Angebot ist nicht mehr da."); }
	let of = f(&o).clone();
	let (from_id, from_name) = (txt(j::at(&of, "from")), txt(j::at(&of, "fromName")));
	let from = c.space.read_if_exists(&tmpl("Character", obj! { "charId" => from_id.as_str() }), 2_000.0, None).await?;
	let Some(from) = from.filter(|e| j::s(f(e), "room") == c.room()) else { return refuse(format!("{from_name} ist nicht mehr hier.")) };
	let theirs = c.space.read_if_exists(&tmpl("Account", obj! { "accountId" => j::at(f(&from), "accountId").clone() }), 2_000.0, None).await?;
	if theirs.as_ref().is_none_or(|a| j::b(f(a), "guest")) { return refuse("Mit Gästen kann man nicht tauschen."); }
	let me = c.char_id().to_owned();
	for id in j::a(&of, "give") {
		let Some(e) = c.space.peek(&tmpl("Item", obj! { "itemId" => id.clone(), "location" => from_id.as_str() }), None).await? else { return refuse(format!("Das Angebot gilt nicht mehr: {from_name} hat nicht mehr alles.")) };
		move_item(c, f(&e), &from_id, &me, &[]).await?;
	}
	let want: Vec<Want> = j::a(&of, "want").iter().map(Want::of).collect();
	let inv = inventory(c).await?;
	let items = match pick(&inv, &want, c.w()) { Picked::Items(i) => i, Picked::Missing(t, _) => return refuse(format!("Dir fehlt für diesen Tausch: {t}.")) };
	for i in &items { move_item(c, f(i), &me, &from_id, &[]).await?; }
	let gave: Vec<String> = j::strs(j::a(&of, "giveNames")).into_iter().map(str::to_owned).collect();
	let back = if items.is_empty() { String::new() } else { format!(" gegen {}", counted_names(&items.iter().map(|i| txt(j::at(f(i), "name"))).collect::<Vec<_>>())) };
	msg(c, &from_id, "info", &format!("{} nimmt dein Angebot an: {}{back}.", txt(j::at(&c.actor, "name")), counted_names(&gave)), info()).await?;
	msg(c, &me, "info", &format!("Tausch mit {from_name}: du bekommst {}{back}.", counted_names(&gave)), info()).await
}

async fn decline(c: &mut Ctx, arg: &str) -> Result<()> {
	let o = offer_for(c, arg).await?;
	let taken = match &o { Some(o) => c.space.take(&obj! { "type" => "Offer", "id" => j::at(o, "id").clone() }, NO_WAIT, c.txn()).await?.is_some(), None => false };
	let Some(o) = o.filter(|_| taken) else { return refuse("Dir liegt kein Angebot vor.") };
	let of = f(&o);
	msg(c, j::s(of, "from"), "info", &format!("{} lehnt dein Angebot ab.", txt(j::at(&c.actor, "name"))), info()).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("Du lehnst das Angebot von {} ab.", txt(j::at(of, "fromName"))), info()).await
}

async fn board(space: &Space, ty: &str, id_key: &str, room: &str) -> Result<Vec<Json>> {
	let mut all = space.read_all(&tmpl(ty, obj! { "room" => room }), None).await?;
	all.sort_by(|a, b| { let d = j::n(f(a), "at") - j::n(f(b), "at"); if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal) } else { js::locale_compare(j::s(f(a), id_key), j::s(f(b), id_key)) } });
	Ok(all)
}
/// How many wanted notices one may have open on a board.
const WANTED_MAX: usize = 5;
/// `protoNamed`: a thing of the world by its name, key or alias, also in another form.
fn proto_named<'a>(w: &'a Json, name: &str) -> Option<&'a Json> {
	let n = js::re(r"^(?:eine?n?|eine[rs]?|a|an)\s+", "").replace(&js::trim(name).to_lowercase(), "");
	let all = |p: &'a Json| std::iter::once(j::s(p, "name")).chain(j::strs(j::a(p, "aliases")));
	let protos = j::a(w, "prototypes");
	protos.iter().find(|p| j::s(p, "key") == n || all(p).any(|a| a.to_lowercase() == n)).or_else(|| { let sn = stem(&n); protos.iter().find(|p| all(p).any(|a| stem(a) == sn)) })
}
fn coins(n: f64) -> String { format!("{} Münze{}", nt(n), if n == 1.0 { "" } else { "n" }) }
/// `replyText`: "Gesa: ab 8", or "Gesa: gerade keins".
pub fn reply_text(r: &Json) -> String { let ask = j::n(r, "ask"); format!("{}: {}", txt(j::at(r, "name")), if ask != 0.0 && !ask.is_nan() { format!("ab {}", nt(ask)) } else { "gerade keins".into() }) }
fn room_name(w: &Json, room: &str) -> String { j::by(j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")), "roomId", room).map_or_else(|| room.to_owned(), |r| txt(j::at(r, "name"))) }
fn board_room(w: &Json, room: &str) -> String { j::by(j::a(w, "rooms"), "roomId", room).map_or_else(|| room.to_owned(), |r| txt(j::at(r, "name"))) }
fn room_names(w: &Json, rooms: &[Json]) -> String { rooms.iter().map(|r| board_room(w, &txt(r))).collect::<Vec<_>>().join(", ") }

/// A trader that sells a thing: its name, where, its board, for how much.
pub struct Seller { pub name: String, pub place: String, pub market: Option<String>, pub each: f64 }
fn sell_price(n: &Json, proto: &str) -> f64 { j::at(j::at(n, "prices"), proto).as_array().and_then(|a| a.get(1)).and_then(Json::as_f64).unwrap_or(0.0) }
/// `sellersOf`.
pub fn sellers_of(w: &Json, proto: &str) -> Vec<Seller> {
	j::a(w, "npcs").iter().filter_map(|n| {
		let each = sell_price(n, proto);
		let market = j::so(n, "market").map(str::to_owned);
		(each > 0.0).then(|| Seller { name: txt(j::at(n, "name")), place: room_name(w, market.as_deref().unwrap_or(j::s(n, "room"))), market, each })
	}).collect()
}
/// `sellerHint`: what one who seeks `proto` at `room` hears when no trader at this board sells it.
pub fn seller_hint(w: &Json, proto: &str, proto_name: &str, room: &str) -> String {
	let all = sellers_of(w, proto);
	if all.iter().any(|s| s.market.as_deref() == Some(room)) { return String::new(); }
	if all.is_empty() { return format!("{proto_name} verkauft kein Händler; liefern kann nur, wer es selbst hat oder macht."); }
	format!("An diesem Brett verkauft kein Händler {proto_name}; {}. Hier kann nur liefern, wer es selbst hat.", all.iter().map(|s| format!("{} ({}) verkauft es um {}, je nach Vorrat", s.name, s.place, coins(s.each))).collect::<Vec<_>>().join(", "))
}
/// `lotOf`: "Muschel", "10× Muschel".
pub fn lot_of(l: &Json) -> String { let n = j::no(l, "count").unwrap_or(1.0); if n > 1.0 { format!("{}× {}", nt(n), txt(j::at(l, "itemName"))) } else { txt(j::at(l, "itemName")) } }
fn is_int(n: f64) -> bool { n.is_finite() && n.fract() == 0.0 }
fn number_of(s: Option<&str>) -> f64 { s.map_or(f64::NAN, js::to_number) }
const PRICE: &str = r"^(.+?)\s+(?:für|fuer|for|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?$";

async fn market(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = c.world.clone();
	let mk = j::at(&w, "market");
	if !j::a(mk, "rooms").iter().any(|r| r.as_str() == Some(c.room())) { return refuse(format!("Hier steht kein Marktbrett. Marktbretter stehen in: {}.", room_names(&w, j::a(mk, "rooms")))); }
	let words: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let verb = words.first().cloned().unwrap_or_default();
	let rest: Vec<String> = words.iter().skip(1).cloned().collect();
	let r0 = rest.first().map(String::as_str);
	let me = c.char_id().to_owned();
	let room = c.room().to_owned();
	let all = board(&c.space, "Listing", "listingId", &room).await?;
	let nr = |s: Option<&str>| -> Result<Json> { let n = number_of(s); if !is_int(n) || n < 1.0 || n > all.len() as f64 { return refuse("Diese Nummer steht nicht auf dem Brett. „markt“ zeigt es."); } Ok(all[n as usize - 1].clone()) };
	let coin = j::at(&w, "currency").clone();
	let sought = board(&c.space, "Wanted", "wantedId", &room).await?;
	let wnr = |s: Option<&str>| -> Result<Json> { let n = number_of(s); if !is_int(n) || n < 1.0 || n > sought.len() as f64 { return refuse("Dieses Gesuch steht nicht am Brett. „markt“ zeigt es."); } Ok(sought[n as usize - 1].clone()) };
	if verb.is_empty() {
		let mut lines: Vec<String> = if all.is_empty() { vec!["Das Marktbrett ist leer. „markt biete <ding> für <n>“ stellt etwas ein.".into()] } else {
			std::iter::once("Marktbrett:".to_owned()).chain(all.iter().enumerate().map(|(i, l)| { let l = f(l); format!("  {}. {} für {} (von {})", i + 1, lot_of(l), coins(j::n(l, "price")), txt(j::at(l, "sellerName"))) })).collect()
		};
		if !sought.is_empty() {
			lines.push("Gesuche („markt liefere <nr>“):".into());
			for (i, x) in sought.iter().enumerate() {
				let x = f(x);
				let n = j::no(x, "count").unwrap_or(1.0);
				let replies = j::a(x, "replies");
				lines.push(format!("  {}. {} sucht {}{}, zahlt {}{}", i + 1, txt(j::at(x, "buyerName")), if n > 1.0 { format!("{}× ", nt(n)) } else { String::new() }, txt(j::at(x, "protoName")), coins(j::n(x, "price")), if replies.is_empty() { String::new() } else { format!(" ({})", replies.iter().map(reply_text).collect::<Vec<_>>().join(", ")) }));
			}
		}
		return msg(c, &me, "info", &lines.join("\n"), info()).await;
	}
	no_guest(c)?;
	let actor = txt(j::at(&c.actor, "name"));
	let escrow_of = |id: &Json| tmpl("Item", obj! { "location" => "market", "listing" => id.clone() });
	if js::re(r"^(suche|gesuch|want)$", "i").test(&verb) {
		if js::re(r"^(zurück|zurueck|withdraw)$", "i").test(r0.unwrap_or("")) {
			let wd = wnr(rest.get(1).map(String::as_str))?;
			let wf = f(&wd).clone();
			if j::s(&wf, "buyer") != me { return refuse("Das ist nicht dein Gesuch."); }
			if c.space.take(&obj! { "type" => "Wanted", "id" => j::at(&wd, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Zu spät – jemand liefert gerade."); }
			for e in c.space.read_all(&escrow_of(j::at(&wf, "wantedId")), c.txn()).await? { move_item(c, f(&e), "market", &me, &[]).await?; }
			return msg(c, &me, "info", &format!("Du nimmst dein Gesuch nach {} zurück; deine {} hast du wieder.", txt(j::at(&wf, "protoName")), coins(j::n(&wf, "price"))), info()).await;
		}
		let Some(m) = js::caps(&js::re(PRICE, "i"), &rest.join(" ")) else { return not_understood("So geht es: markt suche <ding> für <n>, z. B. markt suche ziege für 5 oder markt suche 3 ziegen für 12") };
		let price = number_of(m[2].as_deref());
		if !(1.0..=1000.0).contains(&price) { return refuse("Ein Preis liegt zwischen 1 und 1000 Münzen."); }
		let Some(spec) = parse_spec(m[1].as_deref().unwrap_or("")).into_iter().next() else { return Err(Error::Other("Cannot read properties of undefined (reading 'count')".into())) };
		let count = 50f64.min(1f64.max(spec.count));
		let Some(p) = proto_named(&w, &spec.name) else { return refuse(format!("Ein Ding namens „{}“ gibt es nicht.", js::slice16(&spec.name, 0, Some(30)))) };
		if j::at(p, "key") == &coin { return refuse("Münzen gegen Münzen zu tauschen ergibt nichts; suche etwas anderes."); }
		if sought.iter().filter(|x| j::s(f(x), "buyer") == me).count() >= WANTED_MAX { return refuse(format!("Du hast schon {WANTED_MAX} Gesuche an diesem Brett; nimm erst eines zurück („markt suche zurück <nr>“).")); }
		let inv = inventory(c).await?;
		let Some(pay) = by_proto(&inv, &coin, price) else { return refuse(format!("Dafür brauchst du {}; sie liegen am Brett, bis jemand liefert.", coins(price))) };
		let wanted_id = format!("w-{}", hex(&random_bytes(5)));
		for i in &pay { move_item(c, f(i), &me, "market", &[("listing", Json::from(wanted_id.as_str())), ("seller", Json::from(me.as_str()))]).await?; }
		let mut wf = Object::new();
		wf.insert("wantedId", Json::from(wanted_id.as_str()));
		wf.insert("buyer", Json::from(me.as_str()));
		wf.insert("buyerName", j::at(&c.actor, "name").clone());
		wf.insert("proto", j::at(p, "key").clone());
		wf.insert("protoName", j::at(p, "name").clone());
		if count > 1.0 { wf.insert("count", Json::from(count)); }
		wf.insert("price", Json::from(price));
		wf.insert("room", Json::from(room.as_str()));
		wf.insert("at", Json::from(time_now()));
		wf.insert("expiresWorldMs", Json::from(decay_now_of(&c.space, c.txn()).await? + j::n(mk, "listMs")));
		c.space.write(&tmpl("Wanted", Json::Object(wf)), c.txn(), FOREVER).await?;
		let pname = txt(j::at(p, "name"));
		msg(c, "*", "info", &format!("$you() $conj(suchst|sucht) am Marktbrett {} und $conj(zahlst|zahlt) {}.", if count > 1.0 { format!("{}× {pname}", nt(count)) } else { pname.clone() }, coins(price)), templ()).await?;
		let hint = seller_hint(&w, j::s(p, "key"), &pname, &room);
		if !hint.is_empty() { msg(c, &me, "info", &hint, info()).await?; }
		return Ok(());
	}
	if js::re(r"^(liefere|deliver)$", "i").test(&verb) {
		let wd = wnr(r0)?;
		let wf = f(&wd).clone();
		let ask_m = if js::re(r"^(?:für|fuer|for|um)$", "i").test(rest.get(1).map_or("", String::as_str)) { number_of(rest.get(2).map(String::as_str)) } else { f64::NAN };
		if rest.get(1).is_some() && !(is_int(ask_m) && ask_m >= 1.0) { return not_understood("So geht es: markt liefere <nr>, oder markt liefere <nr> für <n> (weniger als geboten; der Rest geht zurück)."); }
		let buyer = txt(j::at(&wf, "buyer"));
		if buyer == me { return refuse("Das ist dein eigenes Gesuch; „markt suche zurück“ nimmt es zurück."); }
		let inv = inventory(c).await?;
		let want = j::no(&wf, "count").unwrap_or(1.0);
		let pname = txt(j::at(&wf, "protoName"));
		let lot = if want > 1.0 { format!("{}× {pname}", nt(want)) } else { pname.clone() };
		let proto = j::at(&wf, "proto").clone();
		let mut things: Vec<Json> = Vec::new();
		for i in inv.iter().filter(|i| j::at(f(i), "proto") == &proto) {
			if c.space.count(&tmpl("Item", obj! { "location" => j::at(f(i), "itemId").clone() }), c.txn()).await? > 0.0 { continue; }
			things.push(i.clone());
		}
		things.truncate(want.max(0.0) as usize);
		let have = inv.iter().filter(|i| j::at(f(i), "proto") == &proto).count() as f64;
		if (things.len() as f64) < want { return refuse(if have >= want { format!("Leere erst, was in {pname} liegt.") } else if have > 0.0 { format!("Gesucht sind {lot}; du trägst nur {}.", nt(have)) } else { format!("{pname} trägst du nicht bei dir.") }); }
		if c.space.take(&obj! { "type" => "Wanted", "id" => j::at(&wd, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Zu spät – jemand anderes liefert gerade."); }
		let escrow = c.space.read_all(&escrow_of(j::at(&wf, "wantedId")), c.txn()).await?;
		let ask = if ask_m.is_nan() { escrow.len() } else { (ask_m as usize).min(escrow.len()) };
		let (paid, back) = escrow.split_at(ask);
		for e in paid { move_item(c, f(e), "market", &me, &[]).await?; }
		for e in back { move_item(c, f(e), "market", &buyer, &[]).await?; }
		for t in &things { move_item(c, f(t), &me, &buyer, &[]).await?; }
		let board_name = board_room(&w, &room);
		msg(c, &buyer, "info", &format!("{actor} liefert dir {lot} für dein Gesuch am Marktbrett ({board_name}); die {} hat {actor}.{}", coins(paid.len() as f64), if back.is_empty() { String::new() } else { format!(" {} bekommst du zurück.", coins(back.len() as f64)) }), info()).await?;
		return msg(c, "*", "info", &format!("$you() $conj(lieferst|liefert) {} {lot} und $conj(bekommst|bekommt) {}.", txt(j::at(&wf, "buyerName")), coins(paid.len() as f64)), templ()).await;
	}
	if js::re(r"^(antworte|answer)$", "i").test(&verb) {
		let wd = wnr(r0)?;
		let wf = f(&wd).clone();
		let tail = rest.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
		let none = js::re(r"^(?:keine?s?|keins|nichts|none)$", "i").test(&tail);
		let m = js::caps(&js::re(r"^(?:ab|für|fuer|for|from|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?$", "i"), &tail);
		if m.is_none() && !none { return not_understood("So geht es: markt antworte <nr> ab <n> (für wie viel du liefern würdest), oder markt antworte <nr> keins."); }
		let buyer = txt(j::at(&wf, "buyer"));
		if buyer == me { return refuse("Das ist dein eigenes Gesuch."); }
		let price = j::n(&wf, "price");
		let ask = if none { 0.0 } else { number_of(m.as_ref().and_then(|m| m[1].as_deref())) };
		if !none && ask <= price { return refuse(format!("Für {} kannst du gleich liefern: „markt liefere {}“.", coins(price), r0.unwrap_or(""))); }
		if ask > 1000.0 { return refuse("Ein Preis liegt zwischen 1 und 1000 Münzen."); }
		if c.space.take(&obj! { "type" => "Wanted", "id" => j::at(&wd, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Zu spät – jemand liefert gerade."); }
		let mut replies: Vec<Json> = j::a(&wf, "replies").iter().filter(|r| j::s(r, "charId") != me).cloned().collect();
		replies.push(obj! { "charId" => me.as_str(), "name" => j::at(&c.actor, "name").clone(), "ask" => ask });
		let replies: Vec<Json> = replies.split_off(replies.len().saturating_sub(5));
		let mut nw = j::object(&wf);
		nw.insert("replies", Json::Array(replies));
		c.space.write(&tmpl("Wanted", Json::Object(nw)), c.txn(), FOREVER).await?;
		let n = j::no(&wf, "count").unwrap_or(1.0);
		let pname = txt(j::at(&wf, "protoName"));
		let lot = if n > 1.0 { format!("{}× {pname}", nt(n)) } else { pname.clone() };
		let board_name = board_room(&w, &room);
		let bname = txt(j::at(&wf, "buyerName"));
		if none {
			msg(c, &buyer, "info", &format!("{actor} antwortet auf dein Gesuch nach {lot} am Marktbrett ({board_name}): {pname} hat {actor} gerade nicht. Kommt wieder etwas herein, liefert {actor}, solange dein Gesuch hängt."), info()).await?;
			return msg(c, &me, "info", &format!("Du antwortest {bname}: {lot} hast du gerade nicht."), info()).await;
		}
		msg(c, &buyer, "info", &format!("{actor} antwortet auf dein Gesuch nach {lot} am Marktbrett ({board_name}): Für {} nicht, ab {} liefert {actor}.", coins(price), coins(ask)), info()).await?;
		return msg(c, &me, "info", &format!("Du antwortest {bname}: {lot} ab {}.", coins(ask)), info()).await;
	}
	if js::re(r"^(biete|sell|verkaufe)$", "i").test(&verb) {
		let Some(m) = js::caps(&js::re(PRICE, "i"), &rest.join(" ")) else { return not_understood("So geht es: markt biete <ding> für <n>, auch markt biete 10 muscheln für 15") };
		let price = number_of(m[2].as_deref());
		if !(1.0..=1000.0).contains(&price) { return refuse("Ein Preis liegt zwischen 1 und 1000 Münzen."); }
		let what = m[1].clone().unwrap_or_default();
		let from_chest = js::caps(&js::re(r"^(.+?)\s+(?:aus|from)\s+(.+)$", "i"), &what);
		let chest = match &from_chest { Some(fc) => Some(chest_for_sale(c, fc[2].as_deref().unwrap_or("")).await?), None => None };
		let source = match &chest { Some((_, items)) => items.clone(), None => inventory(c).await? };
		let spec: Vec<Want> = parse_spec(from_chest.as_ref().map_or(what.as_str(), |fc| fc[1].as_deref().unwrap_or(""))).into_iter().take(1).collect();
		let items = match pick(&source, &spec, &w) { Picked::Items(i) => i, Picked::Missing(t, u) => return Err(missing_error(u, if chest.is_some() { format!("In der Truhe ist nicht: {t}.") } else { format!("Du hast nicht: {t}.") })) };
		let Some(item) = items.first().map(|i| f(i).clone()) else { return Err(Error::Other("Cannot read properties of undefined (reading 'f')".into())) };
		let listing_id = format!("l-{}", hex(&random_bytes(5)));
		if j::s(&item, "proto") == "muenze" { return refuse("Münzen gegen Münzen zu tauschen ergibt nichts; stelle etwas anderes ans Marktbrett."); }
		let from = chest.as_ref().map_or_else(|| me.clone(), |(b, _)| txt(j::at(b, "buildId")));
		for i in &items { move_item(c, f(i), &from, "market", &[("listing", Json::from(listing_id.as_str())), ("seller", Json::from(me.as_str()))]).await?; }
		let mut lot = Object::new();
		lot.insert("listingId", Json::from(listing_id.as_str()));
		lot.insert("seller", Json::from(me.as_str()));
		lot.insert("sellerName", j::at(&c.actor, "name").clone());
		lot.insert("itemId", j::at(&item, "itemId").clone());
		lot.insert("itemName", j::at(&item, "name").clone());
		if items.len() > 1 { lot.insert("count", Json::from(items.len() as f64)); }
		lot.insert("price", Json::from(price));
		lot.insert("room", Json::from(room.as_str()));
		lot.insert("at", Json::from(time_now()));
		lot.insert("expiresWorldMs", Json::from(decay_now_of(&c.space, c.txn()).await? + j::n(mk, "listMs")));
		let lot = Json::Object(lot);
		c.space.write(&tmpl("Listing", lot.clone()), c.txn(), FOREVER).await?;
		return msg(c, "*", "info", &format!("$you() $conj(hängst|hängt) {} für {} ans Marktbrett{}.", lot_of(&lot), coins(price), if chest.is_some() { " (aus der Truhe)" } else { "" }), templ()).await;
	}
	if js::re(r"^(kaufe|buy)$", "i").test(&verb) {
		let said = rest.join(" ");
		let l = if js::re(r"^\d+$", "").test(js::trim(&said)) { nr(r0)? } else { by_lot(&w, &all, &said, &me)? };
		let lf = f(&l).clone();
		let seller = txt(j::at(&lf, "seller"));
		if seller == me { return refuse("Das ist dein eigenes Angebot; „markt zurück“ holt es zurück."); }
		if c.space.take(&obj! { "type" => "Listing", "id" => j::at(&l, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Zu spät – jemand anderes kauft gerade."); }
		let price = j::n(&lf, "price");
		let inv = inventory(c).await?;
		let Some(pay) = by_proto(&inv, &coin, price) else { return refuse(format!("Dafür brauchst du {}.", coins(price))) };
		for m in &pay { move_item(c, f(m), &me, &seller, &[]).await?; }
		let goods = c.space.read_all(&escrow_of(j::at(&lf, "listingId")), c.txn()).await?;
		if goods.is_empty() { return refuse("Die Ware ist nicht mehr am Brett."); }
		for g in &goods { move_item(c, f(g), "market", &me, &[]).await?; }
		msg(c, &seller, "info", &format!("{actor} kauft dein {} am Marktbrett ({}) für {}.", lot_of(&lf), board_room(&w, &room), coins(price)), info()).await?;
		return msg(c, "*", "info", &format!("$you() $conj(kaufst|kauft) {} vom Marktbrett.", lot_of(&lf)), templ()).await;
	}
	if js::re(r"^(zurück|zurueck|withdraw)$", "i").test(&verb) {
		let l = nr(r0)?;
		let lf = f(&l).clone();
		if j::s(&lf, "seller") != me { return refuse("Das ist nicht dein Angebot."); }
		if c.space.take(&obj! { "type" => "Listing", "id" => j::at(&l, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Zu spät – jemand kauft es gerade."); }
		for g in c.space.read_all(&escrow_of(j::at(&lf, "listingId")), c.txn()).await? { move_item(c, f(&g), "market", &me, &[]).await?; }
		return msg(c, &me, "info", &format!("Du holst {} vom Marktbrett zurück.", lot_of(&lf)), info()).await;
	}
	not_understood("Am Marktbrett: markt, markt biete <ding> für <n>, markt kaufe <nr>, markt zurück <nr>, markt suche <ding> für <n>, markt liefere <nr> [für <n>], markt antworte <nr> ab <n>, markt suche zurück <nr>.")
}

/// `byLot`: a lot on the board by what it is ("markt kaufe gans": the cheapest; "markt kaufe 10 muscheln für 15").
fn by_lot(w: &Json, all: &[Json], s: &str, me: &str) -> Result<Json> {
	let Some(m) = js::caps(&js::re(r"^(?:(\d+)\s*[x×]?\s+)?(.+?)(?:\s+(?:für|fuer|for|um)\s+(\d+)(?:\s+(?:münzen?|muenzen?|coins?))?)?$", "i"), js::trim(s)) else {
		return not_understood("So geht es: markt kaufe <ding>, auch markt kaufe 10 muscheln für 15 oder markt kaufe <nr>.");
	};
	let name = js::trim(m[2].as_deref().unwrap_or("")).to_owned();
	let p = proto_named(w, &name);
	let (count, price) = (m[1].as_deref().map(js::to_number), m[3].as_deref().map(js::to_number));
	let sn = stem(&name);
	let named = |l: &Json| { let s = stem(j::s(l, "itemName")); s == sn || p.is_some_and(|p| s == stem(j::s(p, "name"))) };
	let fits: Vec<&Json> = all.iter().filter(|l| { let l = f(l); named(l) && j::s(l, "seller") != me && count.is_none_or(|n| j::no(l, "count").unwrap_or(1.0) == n) && price.is_none_or(|p| j::n(l, "price") == p) }).collect();
	if fits.is_empty() {
		let any = all.iter().any(|l| named(f(l)));
		return refuse(if !any { format!("Am Brett hängt nichts, was „{}“ heißt. „markt“ zeigt, was da ist.", js::slice16(&name, 0, Some(30))) } else if all.iter().any(|l| named(f(l)) && j::s(f(l), "seller") != me) { "So hängt es nicht mehr am Brett (jemand war schneller, oder Menge und Preis sind andere). „markt“ zeigt, was da ist.".into() } else { "Das ist dein eigenes Angebot; „markt zurück“ holt es zurück.".into() });
	}
	let mut best = fits[0];
	for b in &fits[1..] { if j::n(f(b), "price") < j::n(f(best), "price") { best = b; } }
	Ok(best.clone())
}

/// How many rounds one `craft` may make.
const MAX_CRAFT: f64 = 20.0;
const COUNT_WORDS: [(&str, f64); 14] = [("ein", 1.0), ("eine", 1.0), ("einen", 1.0), ("eins", 1.0), ("zwei", 2.0), ("drei", 3.0), ("vier", 4.0), ("fünf", 5.0), ("fuenf", 5.0), ("sechs", 6.0), ("sieben", 7.0), ("acht", 8.0), ("neun", 9.0), ("zehn", 10.0)];
/// `countOf`: "3 tangseile", "3x seil", "drei stück tangseil".
fn count_of(arg: &str) -> (f64, String) {
	let Some(m) = js::caps(&js::re(r"^(\d+|\p{L}+)\s*(?:x|×|mal|stück|stueck)?\s+(.+)$", "iu"), arg) else { return (1.0, arg.to_owned()) };
	let w = m[1].clone().unwrap_or_default();
	let count = if w.starts_with(|c: char| c.is_ascii_digit()) { Some(js::to_number(&w)) } else { COUNT_WORDS.iter().find(|(k, _)| *k == w).map(|(_, n)| *n) };
	match count { Some(n) => (n, m[2].clone().unwrap_or_default()), None => (1.0, arg.to_owned()) }
}
/// `recipeNamed`: by key or name, in any form, or by what it makes is also called.
/// A thing a recipe asks for by `key`: of that prototype, or one of its own that stands for it (a log for driftwood).
fn is_of(f: &Json, key: &Json) -> bool { j::at(f, "proto") == key || j::at(f, "of") == key }

fn recipe_named<'a>(w: &'a Json, what: &str) -> Option<&'a Json> {
	let rs = j::a(w, "recipes");
	let own = |r: &Json| vec![j::s(r, "key").to_owned(), j::s(r, "name").to_owned()];
	let also = |r: &Json| j::a(w, "prototypes").iter().find(|p| j::at(p, "key") == j::at(r, "makes")).map(|p| j::strs(j::a(p, "aliases")).into_iter().map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
	let is = |n: &String| n.to_lowercase() == what;
	let sw = stem(what);
	let form = |n: &String| stem(n) == sw;
	rs.iter().find(|r| own(r).iter().any(is)).or_else(|| rs.iter().find(|r| own(r).iter().any(form))).or_else(|| rs.iter().find(|r| also(r).iter().any(is))).or_else(|| rs.iter().find(|r| also(r).iter().any(form)))
}

/// `craft hier`.
async fn craft_here(c: &mut Ctx, w: &Json) -> Result<()> {
	let beside = near_buildings(c, Some("cook")).await?;
	let rs = j::a(w, "recipes");
	let mut plans: Vec<String> = Vec::new();
	for b in &beside { let p = txt(j::at(b, "plan")); if !plans.contains(&p) && rs.iter().any(|r| j::so(r, "at") == Some(p.as_str())) { plans.push(p); } }
	if plans.is_empty() {
		return refuse(match beside.first() { Some(b) => format!("Neben {} stellt man nichts her; was überall geht, zeigt „craft“.", txt(j::at(b, "name"))), None => "Neben dir steht kein Bau. Was überall geht, zeigt „craft“.".to_owned() });
	}
	let mut carried: Vec<(String, f64)> = Vec::new();
	for i in inventory(c).await? {
		let mut ks = vec![txt(j::at(f(&i), "proto"))];
		if j::truthy(j::at(f(&i), "of")) { ks.push(txt(j::at(f(&i), "of"))); }
		for p in ks { match carried.iter_mut().find(|(k, _)| *k == p) { Some((_, n)) => *n += 1.0, None => carried.push((p, 1.0)) } }
	}
	let has = |k: &str| carried.iter().find(|(p, _)| p == k).map_or(0.0, |(_, n)| *n);
	let pn = |k: &str| j::a(w, "prototypes").iter().find(|p| j::s(p, "key") == k).map_or_else(|| k.to_owned(), |p| txt(j::at(p, "name")));
	let mut lines: Vec<String> = Vec::new();
	for p in &plans {
		lines.push(format!("{}:", plan_of(w, p).map_or_else(|| p.clone(), |x| txt(j::at(x, "name")))));
		for r in rs.iter().filter(|r| j::so(r, "at") == Some(p.as_str())) {
			let tool = j::so(r, "tool").filter(|t| !t.is_empty());
			let ok = j::a(r, "needs").iter().all(|x| has(j::s(x, "proto")) >= j::n(x, "count")) && tool.is_none_or(|t| has(t) > 0.0);
			let n = j::no(r, "count").unwrap_or(1.0);
			let name = format!("{}{}", if n > 1.0 { format!("{}× ", nt(n)) } else { String::new() }, txt(j::at(r, "name")));
			let needs = j::a(r, "needs").iter().map(|x| format!("{} {}", txt(j::at(x, "count")), pn(j::s(x, "proto")))).collect::<Vec<_>>().join(", ");
			lines.push(format!("  {} („craft {}“): {needs}{}{}", strong(&name), txt(j::at(r, "key")), tool.map_or_else(String::new, |t| format!(", mit {}", pn(t))), if ok { " – das hast du dabei" } else { "" }));
		}
	}
	if beside.iter().any(|b| plan_of(w, j::s(b, "plan")).is_some_and(|p| j::b(p, "sparesTools"))) { lines.push("Neben der Werkstatt nutzt sich Werkzeug nur halb so schnell ab.".to_owned()); }
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &lines.join("\n"), info()).await
}

/// `craft`.
pub async fn craft(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = c.world.clone();
	let me = c.char_id().to_owned();
	if arg.is_empty() {
		let show = |r: &Json| {
			let needs = j::a(r, "needs").iter().map(|n| format!("{}× {}", txt(j::at(n, "count")), txt(j::at(n, "proto")))).collect::<Vec<_>>().join(", ");
			let tool = j::so(r, "tool").filter(|t| !t.is_empty()).map_or_else(String::new, |t| format!(", Werkzeug: {t}"));
			let at = j::so(r, "at").filter(|t| !t.is_empty()).map_or_else(String::new, |a| format!(", nur am Bau: {}", plan_of(&w, a).map_or_else(|| a.to_owned(), |p| txt(j::at(p, "name")))));
			let n = j::no(r, "count").unwrap_or(1.0);
			format!("  {}: {needs}{tool}{at}{}", strong(&txt(j::at(r, "key"))), if n > 1.0 { format!(" (gibt {})", nt(n)) } else { String::new() })
		};
		let lines: Vec<String> = std::iter::once("Rezepte:".to_owned()).chain(j::a(&w, "recipes").iter().map(show)).collect();
		return msg(c, &me, "info", &lines.join("\n"), info()).await;
	}
	// "craft hier": what the buildings beside one make, in names, and whether one carries enough for it
	if js::re(r"^(?:hier|here)$", "i").test(js::trim(arg)) { return craft_here(c, &w).await; }
	let (want, a) = count_of(&js::trim(arg).to_lowercase());
	let Some(r) = recipe_named(&w, &a) else {
		if plan_of(&w, &js::re(r"(?:\s+\d+){2}$", "").replace(&js::trim(arg).to_lowercase(), "")).is_some() { return bau(c, arg).await; }
		return not_understood(format!("Ein Rezept „{}“ gibt es nicht. „craft“ zeigt die Rezepte.", js::slice16(arg, 0, Some(30))));
	};
	let rname = txt(j::at(r, "name"));
	if let Some(at) = j::so(r, "at").filter(|t| !t.is_empty()) {
		if !near_buildings(c, Some("cook")).await?.iter().any(|b| j::s(b, "plan") == at) {
			// inside the building of the recipe, away from its hearth: go to it
			let hearth = if near_buildings(c, None).await?.iter().any(|b| j::s(b, "plan") == at) { furnishing_for(c, "cook").await? } else { None };
			if let Some(h) = hearth { return refuse(format!("{rname} macht man am {}; geh zu ihm.", txt(j::at(&h, "name")))); }
			let p = plan_of(&w, at);
			let dative = p.and_then(|p| j::so(p, "dative")).map_or_else(|| format!("einem {}", p.map_or_else(|| at.to_owned(), |p| txt(j::at(p, "name")))), str::to_owned);
			return refuse(format!("{rname} macht man nur direkt neben {dative}."));
		}
	}
	if want < 1.0 { return not_understood(format!("Wie viele? Zum Beispiel: craft 3 {}", txt(j::at(r, "key")))); }
	if want > MAX_CRAFT { return refuse(format!("Höchstens {} auf einmal.", nt(MAX_CRAFT))); }
	let inv = inventory(c).await?;
	let tool_proto = j::so(r, "tool").filter(|t| !t.is_empty()).map(str::to_owned);
	let tools: Vec<&Json> = tool_proto.as_ref().map(|t| inv.iter().filter(|i| j::s(f(i), "proto") == t).collect()).unwrap_or_default();
	let wearing = if tool_proto.is_some() {
		let near = near_buildings(c, None).await?;
		if near.iter().any(|b| plan_of(&w, j::s(b, "plan")).is_some_and(|p| j::b(p, "sparesTools"))) { 0.5 } else { 1.0 }
	} else { 1.0 };
	let (mut used, mut inputs, mut wear): (Vec<String>, Vec<Json>, Vec<(String, f64)>) = (Vec::new(), Vec::new(), Vec::new());
	let wear_of = |wear: &[(String, f64)], t: &Json| wear.iter().find(|(k, _)| *k == item_id(t)).map(|(_, v)| *v).unwrap_or_else(|| j::no(f(t), "wear").unwrap_or(1.0));
	let (mut made, mut lack) = (0.0, String::new());
	'rounds: while made < want {
		let mut round: Vec<String> = Vec::new();
		for n in j::a(r, "needs") {
			let count = j::n(n, "count");
			// a log is driftwood and a log (ItemFields.of): asked for driftwood, real driftwood goes first
			let want_p = j::at(n, "proto");
			let rank = |i: &Json| { let of = j::at(f(i), "of"); u8::from(j::truthy(of) && of != want_p) };
			let mut hits: Vec<&Json> = inv.iter().filter(|i| is_of(f(i), want_p) && !used.contains(&item_id(i)) && !round.contains(&item_id(i))).collect();
			hits.sort_by_key(|i| rank(i));
			let hits: Vec<String> = hits.into_iter().take(count.max(0.0) as usize).map(item_id).collect();
			if (hits.len() as f64) < count { lack = format!("Dir fehlt: {}× {}.", nt(count), txt(j::at(n, "proto"))); break 'rounds; }
			round.extend(hits);
		}
		let tool = tools.iter().find(|i| !round.contains(&item_id(i)) && !used.contains(&item_id(i)) && wear_of(&wear, i) > 0.0);
		if let (Some(t), None) = (&tool_proto, tool) { lack = format!("Dafür brauchst du ein Werkzeug: {t}."); break; }
		if let Some(t) = tool {
			let left = wear_of(&wear, t) - wearing;
			match wear.iter_mut().find(|(k, _)| *k == item_id(t)) { Some(s) => s.1 = left, None => wear.push((item_id(t), left)) }
		}
		for id in round { inputs.extend(inv.iter().find(|i| item_id(i) == id).cloned()); used.push(id); }
		made += 1.0;
	}
	if made == 0.0 { return refuse(lack); }
	for i in &inputs { consume(c, f(i), &me).await?; }
	let mut broken: Vec<String> = Vec::new();
	for t in &tools {
		let Some((_, left)) = wear.iter().find(|(k, _)| *k == item_id(t)).cloned() else { continue };
		if left <= 0.0 { consume(c, f(t), &me).await?; broken.push(txt(j::at(f(t), "name"))); }
		else { move_item(c, f(t), &me, &me, &[("wear", Json::from(left))]).await?; }
	}
	let Some(p) = resolve_prototype(&c.space, j::s(r, "makes")).await? else { return refuse("Das Rezept ist kaputt.") };
	let n = j::no(r, "count").unwrap_or(1.0) * made;
	for _ in 0..n as usize { spawn(&c.space, c.txn(), c.w(), &p, At { location: me.clone(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; }
	let pname = txt(j::at(&p, "name"));
	msg(c, "*", "info", &format!("$you() $conj(stellst|stellt) {} her.{}", if n > 1.0 { format!("{} {pname}", nt(n)) } else { pname.clone() }, broken.iter().map(|b| format!(" Das {b} zerbricht dabei.")).collect::<String>()), templ()).await?;
	if made < want { msg(c, &me, "info", &format!("Für {} reicht es nicht, es wurden {}. {lack}", nt(want), nt(made)), info()).await?; }
	Ok(())
}

async fn orders_of(space: &Space) -> Result<Vec<Json>> {
	let mut all = space.read_all(&obj! { "type" => "Order" }, None).await?;
	all.sort_by(|a, b| js::locale_compare(j::s(f(a), "orderId"), j::s(f(b), "orderId")));
	Ok(all)
}
fn reward(o: &Json) -> String { coins(j::n(j::at(o, "reward"), "count")) }

async fn order(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = c.world.clone();
	let od = j::at(&w, "orders");
	if !j::a(od, "rooms").iter().any(|r| r.as_str() == Some(c.room())) { return refuse(format!("Hier hängt keine Auftragstafel. Tafeln hängen in: {}.", room_names(&w, j::a(od, "rooms")))); }
	let words: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let verb = words.first().cloned().unwrap_or_default();
	let me = c.char_id().to_owned();
	let all = orders_of(&c.space).await?;
	let open: Vec<&Json> = all.iter().filter(|o| !j::b(f(o), "takenBy") && j::s(f(o), "room") == c.room()).collect();
	let mine = all.iter().find(|o| j::s(f(o), "takenBy") == me).cloned();
	if verb.is_empty() {
		let mut lines: Vec<String> = vec![if open.is_empty() { "Die Auftragstafel ist leer; bald kommen neue Aufträge.".into() } else { "Auftragstafel:".into() }];
		lines.extend(open.iter().enumerate().map(|(i, o)| format!("  {}. {} Lohn: {}", i + 1, txt(j::at(f(o), "text")), reward(f(o)))));
		let sites = board_lines(&c.space, &w).await?;
		let plan = j::so(j::at(&w, "shop"), "plan").unwrap_or("");
		let standing: Vec<String> = c.space.read_all(&tmpl("Building", obj! { "plan" => plan }), None).await?.iter().map(|e| txt(j::at(f(e), "buildId"))).collect();
		let stores: Vec<String> = c.space.read_all(&obj! { "type" => "ShopOrder" }, None).await?.iter().map(|e| f(e).clone()).filter(|o| standing.contains(&txt(j::at(o, "buildId")))).map(|o| format!("  {} von {} ({}): {}× {} zu {}", txt(j::at(&o, "storeName")), txt(j::at(&o, "ownerName")), room_names(&w, &[j::at(&o, "room").clone()]), txt(j::at(&o, "count")), txt(j::at(&o, "protoName")), coins(j::n(&o, "reward")))).collect();
		if !sites.is_empty() { lines.push("Baustellen zahlen vor Ort beim Liefern und Mitarbeiten:".into()); lines.extend(sites); }
		if !stores.is_empty() { lines.push("Kaufhäuser bestellen („laden liefere <ding>“ dort):".into()); lines.extend(stores); }
		if let Some(m) = &mine { lines.push(format!("Dein Auftrag: {} („order liefere“, sobald du alles hast)", txt(j::at(f(m), "text")))); }
		return msg(c, &me, "info", &lines.join("\n"), info()).await;
	}
	no_guest(c)?;
	let until = |c: &Ctx| { let (s, t) = (c.space.clone(), c.txn.clone()); let lease = j::n(od, "leaseMs"); async move { Ok::<f64, Error>(world_now_of(&s, Some(&t)).await? + lease * patience_of(&s, Some(&t)).await?) } };
	if js::re(r"^(nimm|take)$", "i").test(&verb) {
		if mine.is_some() { return refuse("Du hast schon einen Auftrag; liefere ihn erst oder gib ihn auf."); }
		let n = number_of(words.get(1).map(String::as_str));
		let o = if is_int(n) && n >= 1.0 { open.get(n as usize - 1) } else { None };
		let Some(o) = o else { return refuse("Diese Nummer hängt nicht an der Tafel. „order“ zeigt sie.") };
		if c.space.take(&obj! { "type" => "Order", "id" => j::at(o, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Zu spät – den hat gerade jemand genommen."); }
		let mut nf = j::object(f(o));
		nf.insert("takenBy", Json::from(me.as_str()));
		nf.insert("expiresWorldMs", Json::from(until(c).await?));
		c.space.write(&tmpl("Order", Json::Object(nf)), c.txn(), FOREVER).await?;
		return msg(c, &me, "info", &format!("Du übernimmst: {}", txt(j::at(f(o), "text"))), info()).await;
	}
	let Some(mine) = mine else { return refuse("Du hast keinen Auftrag. „order nimm <nr>“ übernimmt einen.") };
	if js::re(r"^(aufgeben|abandon)$", "i").test(&verb) {
		if c.space.take(&obj! { "type" => "Order", "id" => j::at(&mine, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Der Auftrag ist gerade nicht greifbar."); }
		let mut nf = j::object(f(&mine));
		nf.insert("takenBy", Json::from(""));
		nf.insert("expiresWorldMs", Json::from(until(c).await?));
		c.space.write(&tmpl("Order", Json::Object(nf)), c.txn(), FOREVER).await?;
		return msg(c, &me, "info", "Du gibst den Auftrag zurück an die Tafel.", info()).await;
	}
	if js::re(r"^(liefere|deliver)$", "i").test(&verb) {
		let inv = inventory(c).await?;
		let mut give: Vec<Json> = Vec::new();
		for need in j::a(f(&mine), "needs") {
			let free: Vec<Json> = inv.iter().filter(|i| !give.iter().any(|g| item_id(g) == item_id(i))).cloned().collect();
			let Some(hits) = by_proto(&free, j::at(need, "proto"), j::n(need, "count")) else { return refuse(format!("Dir fehlt noch: {}× {}.", txt(j::at(need, "count")), txt(j::at(need, "proto")))) };
			give.extend(hits);
		}
		if c.space.take(&obj! { "type" => "Order", "id" => j::at(&mine, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { return refuse("Der Auftrag ist gerade nicht greifbar."); }
		for i in &give { consume(c, f(i), &me).await?; }
		let rw = j::at(f(&mine), "reward");
		let Some(p) = resolve_prototype(&c.space, j::s(rw, "proto")).await? else { return refuse("Der Lohn ist verschwunden.") };
		for _ in 0..j::n(rw, "count").max(0.0) as usize { spawn(&c.space, c.txn(), c.w(), &p, At { location: me.clone(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; }
		return msg(c, "*", "info", &format!("$you() $conj(lieferst|liefert) einen Auftrag ab und $conj(bekommst|bekommt) {}.", reward(f(&mine))), templ()).await;
	}
	not_understood("An der Tafel: order, order nimm <nr>, order liefere, order aufgeben.")
}

/// `Number.prototype.toString(36)` of a whole number.
fn base36(n: f64) -> String {
	if !n.is_finite() || n.fract() != 0.0 { return nt(n); }
	let (mut v, neg) = (n.abs() as u128, n < 0.0);
	if v == 0 { return "0".into(); }
	let mut out = Vec::new();
	while v > 0 { out.push(char::from_digit((v % 36) as u32, 36).unwrap_or('0')); v /= 36; }
	if neg { out.push('-'); }
	out.iter().rev().collect()
}

/// `ordersTick`: each board gets a new job while fewer than `max` are posted there.
pub async fn orders_tick(space: &Space, w: &Json) -> Result<()> {
	let od = j::at(w, "orders");
	for room in j::strs(j::a(od, "rooms")) {
		let kinds: Vec<&Json> = j::a(od, "kinds").iter().filter(|k| j::ao(k, "rooms").is_none_or(|r| r.iter().any(|x| x.as_str() == Some(room)))).collect();
		if kinds.is_empty() || space.count(&tmpl("Order", obj! { "room" => room }), None).await? >= j::n(od, "max") { continue; }
		let k = kinds[random_int(0.0, kinds.len() as f64) as usize];
		let order_id = format!("j-{}-{}", base36(time_now()), hex(&random_bytes(3)));
		let until = world_now_of(space, None).await? + j::n(od, "leaseMs") * patience_of(space, None).await?;
		let o = obj! { "orderId" => order_id, "kind" => j::at(k, "key").clone(), "text" => j::at(k, "text").clone(), "needs" => j::at(k, "needs").clone(), "reward" => j::at(k, "reward").clone(), "takenBy" => "", "room" => room, "expiresWorldMs" => until };
		space.write(&tmpl("Order", o), None, FOREVER).await?;
	}
	Ok(())
}

/// Every this much world time a trader gets back one thing it sells.
pub const RESTOCK_WORLD_MS: f64 = 24.0 * 3_600_000.0;
async fn restock(space: &Space, w: &Json) -> Result<()> {
	let now = world_now_of(space, None).await?;
	let currency = j::at(w, "currency");
	for n in j::a(w, "npcs") {
		let sells: Vec<&Json> = j::a(n, "carry").iter().filter(|c| j::at(c, "proto") != currency && sell_price(n, j::s(c, "proto")) > 0.0).collect();
		if sells.is_empty() { continue; }
		let char_id = format!("npc-{}", txt(j::at(n, "npcId")));
		if space.peek(&tmpl("Character", obj! { "charId" => char_id.as_str() }), None).await?.is_none() { continue; }
		for c in sells {
			let proto = j::at(c, "proto").clone();
			let have = space.count(&tmpl("Item", obj! { "location" => char_id.as_str(), "proto" => proto.clone() }), None).await?;
			let e = space.peek(&tmpl("Restock", obj! { "charId" => char_id.as_str(), "proto" => proto.clone() }), None).await?;
			let next = e.as_ref().map(|e| j::n(f(e), "nextWorldMs"));
			if have >= j::n(c, "count") { if let Some(e) = &e { space.take_if_exists(&obj! { "type" => "Restock", "id" => j::at(e, "id").clone() }, NO_WAIT, None).await?; } continue; }
			if next.is_some_and(|x| x > now) { continue; }
			let txn = space.create_transaction(10_000.0).await?;
			let r: Result<bool> = async {
				if let Some(e) = &e { if space.take_if_exists(&obj! { "type" => "Restock", "id" => j::at(e, "id").clone() }, NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); } }
				if e.is_some() { if let Some(p) = resolve_prototype(space, j::s(c, "proto")).await? { spawn(space, Some(&txn), w, &p, At { location: char_id.clone(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; } }
				if e.is_none() || have + 1.0 < j::n(c, "count") { space.write(&tmpl("Restock", obj! { "charId" => char_id.as_str(), "proto" => proto.clone(), "nextWorldMs" => now + RESTOCK_WORLD_MS }), Some(&txn), FOREVER).await?; }
				Ok(true)
			}.await;
			match r { Ok(true) => space.commit(&txn).await?, Ok(false) => space.abort(&txn).await?, Err(err) => { let _ = space.abort(&txn).await; return Err(err); } }
		}
	}
	Ok(())
}

/// `shipOff`: what a trader only buys (no selling price) it ships off, one a RESTOCK_WORLD_MS while it holds any, so a
/// glut it paid little for wears off and its buying price comes back up.
async fn ship_off(space: &Space, w: &Json) -> Result<()> {
	let now = world_now_of(space, None).await?;
	let currency = j::s(w, "currency");
	for n in j::a(w, "npcs") {
		let only: Vec<String> = j::entries(j::at(n, "prices")).filter(|(p, v)| { let pr = v.as_array().map(Vec::as_slice).unwrap_or(&[]); let (b, s) = (pr.first().map_or(f64::NAN, j::number), pr.get(1).map_or(f64::NAN, j::number)); b > 0.0 && s <= 0.0 && *p != currency }).map(|(p, _)| p.to_owned()).collect();
		if only.is_empty() { continue; }
		let char_id = format!("npc-{}", txt(j::at(n, "npcId")));
		if space.read_limit(&tmpl("Character", obj! { "charId" => char_id.as_str() }), 1, None).await?.is_empty() { continue; } // in another region
		for proto in &only {
			let key = format!("-{proto}");
			let e = space.peek(&tmpl("Restock", obj! { "charId" => char_id.as_str(), "proto" => key.as_str() }), None).await?;
			let next = e.as_ref().map(|e| j::n(f(e), "nextWorldMs"));
			let have = space.count(&tmpl("Item", obj! { "location" => char_id.as_str(), "proto" => proto.as_str() }), None).await?;
			if have == 0.0 { if let Some(e) = &e { space.take_if_exists(&obj! { "type" => "Restock", "id" => j::at(e, "id").clone() }, NO_WAIT, None).await?; } continue; }
			if next.is_some_and(|x| x > now) { continue; }
			let txn = space.create_transaction(10_000.0).await?;
			let r: Result<bool> = async {
				if let Some(e) = &e { if space.take_if_exists(&obj! { "type" => "Restock", "id" => j::at(e, "id").clone() }, NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); } }
				// the first time it holds some, the clock starts; one goes when it is up
				if e.is_some() { space.take_if_exists(&tmpl("Item", obj! { "location" => char_id.as_str(), "proto" => proto.as_str() }), NO_WAIT, Some(&txn)).await?; }
				if e.is_none() || have > 1.0 { space.write(&tmpl("Restock", obj! { "charId" => char_id.as_str(), "proto" => key.as_str(), "nextWorldMs" => now + RESTOCK_WORLD_MS }), Some(&txn), FOREVER).await?; }
				Ok(true)
			}.await;
			match r { Ok(true) => space.commit(&txn).await?, Ok(false) => space.abort(&txn).await?, Err(err) => { let _ = space.abort(&txn).await; return Err(err); } }
		}
	}
	Ok(())
}

/// `marketTick`: restocking, shipping off, and what lies in escrow for a listing or notice that lapsed goes back.
pub async fn market_tick(space: &Space, w: &Json) -> Result<()> {
	restock(space, w).await?;
	ship_off(space, w).await?;
	for e in space.read_all(&tmpl("Item", obj! { "location" => "market" }), None).await? {
		let it = f(&e);
		if let Some(l) = j::so(it, "listing").filter(|l| !l.is_empty()) {
			let t = if l.starts_with("w-") { tmpl("Wanted", obj! { "wantedId" => l }) } else { tmpl("Listing", obj! { "listingId" => l }) };
			match space.read_existing(&t, None, HELD_WAIT_MS).await { Ok(Some(_)) | Err(Error::StillHeld(_)) => continue, Ok(None) => {} Err(err) => return Err(err) }
		}
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<()> = async {
			if let Some(t) = space.take_if_exists(&obj! { "type" => "Item", "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(&txn)).await? {
				let mut o = j::object(f(&t));
				o.remove("listing");
				let seller = o.remove("seller");
				let to = seller.filter(|s| !s.is_null()).unwrap_or_else(|| o.get("location").cloned().unwrap_or(Json::Null));
				o.insert("location", to);
				o.insert("x", Json::from(-1.0));
				o.insert("y", Json::from(-1.0));
				let types: Vec<Json> = j::a(&t, "types").iter().skip(1).cloned().collect();
				space.write(&obj! { "type" => j::at(&t, "type").clone(), "types" => Json::Array(types), "fields" => Json::Object(o) }, Some(&txn), FOREVER).await?;
			}
			Ok(())
		}.await;
		match r { Ok(()) => space.commit(&txn).await?, Err(err) => { let _ = space.abort(&txn).await; return Err(err); } }
	}
	Ok(())
}
