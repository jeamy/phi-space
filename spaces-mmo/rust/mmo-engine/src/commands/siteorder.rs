//! Orders of a site (`server/engine/commands/siteorder.ts`): the owner hangs out what the site lacks with a wage per
//! piece or per work point; whoever delivers or works there is paid from the coins that lie in the order.
use phi_json::{obj, Json, Object};

use super::build::{missing, settle, site_here};
use crate::clock::{decay_now_of, world_now_of};
use crate::context::{inventory, msg, stem, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::source::{hex, random_bytes};
use crate::space::{fields, not_understood, refuse, tmpl, Result, Space, FOREVER, NO_WAIT};

/// `orderLine`: "5 Treibholz, je 2 Münzen".
pub fn order_line(o: &Json) -> String {
	let pay = j::at(o, "pay");
	format!("{} {}, je {} Münze{}", key_text(j::at(o, "left")), key_text(j::at(o, "name")), key_text(pay), if pay.as_f64() == Some(1.0) { "" } else { "n" })
}

/// `ordersOfSite`.
pub async fn orders_of_site(space: &Space, build_id: &Json, txn: Option<&str>) -> Result<Vec<Json>> {
	Ok(space.read_all(&tmpl("SiteOrder", obj! { "buildId" => build_id.clone() }), txn).await?.iter().map(|e| fields(e).clone()).collect())
}

/// `moveCoin`: a thing (taken in the transaction) from `from` to `to`.
pub async fn move_coin(space: &Space, txn: &str, item_id: &Json, from: &str, to: &str) -> Result<bool> {
	let Some(e) = space.take_if_exists(&tmpl("Item", obj! { "itemId" => item_id.clone(), "location" => from }), NO_WAIT, Some(txn)).await? else { return Ok(false) };
	let mut f = j::object(fields(&e));
	f.insert("location", Json::from(to));
	f.insert("x", Json::from(-1.0));
	f.insert("y", Json::from(-1.0));
	let types: Vec<Json> = j::a(&e, "types").iter().skip(1).cloned().collect();
	space.write(&obj! { "type" => j::at(&e, "type").clone(), "types" => Json::Array(types), "fields" => Json::Object(f) }, Some(txn), FOREVER).await?;
	Ok(true)
}

/// `payFor`: pays the actor for `n` pieces of `proto` ("": work) of the site; the order shrinks and goes when nothing
/// is left. How many coins.
pub async fn pay_for(c: &Ctx, build_id: &Json, proto: &Json, n: f64) -> Result<f64> {
	let Some(e) = c.space.take_if_exists(&tmpl("SiteOrder", obj! { "buildId" => build_id.clone(), "proto" => proto.clone() }), NO_WAIT, c.txn()).await? else { return Ok(0.0) };
	let o = fields(&e).clone();
	let left = j::n(&o, "left");
	let paid = n.min(left);
	let order_id = key_text(j::at(&o, "orderId"));
	let coins = c.space.read_all(&tmpl("Item", obj! { "location" => order_id.as_str() }), c.txn()).await?;
	let mut got = 0.0;
	let k = (paid * j::n(&o, "pay")).max(0.0);
	for coin in coins.iter().take(if k.is_finite() { k as usize } else { 0 }) {
		if move_coin(&c.space, &c.txn, j::at(fields(coin), "itemId"), &order_id, c.char_id()).await? { got += 1.0; }
	}
	if left > paid {
		let mut f = j::object(&o);
		f.insert("left", Json::from(left - paid));
		c.space.write(&obj! { "type" => "SiteOrder", "fields" => Json::Object(f) }, c.txn(), FOREVER).await?;
	}
	Ok(got)
}

/// `closeOrders`: the site's orders end, their wages go back to the owner (into its pack, or as an estate at the site's
/// room while it is elsewhere). How many coins.
pub async fn close_orders(space: &Space, txn: &str, s: &Json, estate_until: f64) -> Result<f64> {
	let mut back = 0.0;
	let here = space.count(&tmpl("Character", obj! { "charId" => j::at(s, "owner").clone() }), Some(txn)).await? > 0.0;
	for e in space.read_all(&tmpl("SiteOrder", obj! { "buildId" => j::at(s, "buildId").clone() }), Some(txn)).await? {
		let o = fields(&e);
		if space.take_if_exists(&tmpl("SiteOrder", obj! { "orderId" => j::at(o, "orderId").clone() }), NO_WAIT, Some(txn)).await?.is_none() { continue; }
		let order_id = key_text(j::at(o, "orderId"));
		let to = if here { key_text(j::at(s, "owner")) } else { format!("est-{order_id}") };
		let mut moved = 0.0;
		for coin in space.read_all(&tmpl("Item", obj! { "location" => order_id.as_str() }), Some(txn)).await? {
			if move_coin(space, txn, j::at(fields(&coin), "itemId"), &order_id, &to).await? { moved += 1.0; }
		}
		if moved > 0.0 && !here {
			let est = obj! { "estateId" => to.as_str(), "accountId" => j::at(s, "accountId").clone(), "ownerName" => j::at(s, "ownerName").clone(), "room" => j::at(s, "room").clone(), "name" => j::at(s, "name").clone(), "untilWorldMs" => estate_until };
			space.write(&obj! { "type" => "Estate", "fields" => est }, Some(txn), FOREVER).await?;
		}
		back += moved;
	}
	Ok(back)
}

/// `keptUntil`: until when wages wait as an estate for an owner in another region.
pub async fn kept_until(c: &Ctx) -> Result<f64> {
	Ok(decay_now_of(&c.space, c.txn()).await? + j::no(j::at(c.w(), "building"), "estateWorldMs").unwrap_or(30.0 * 24.0 * 3_600_000.0))
}

/// `aushang`.
pub async fn aushang(c: &mut Ctx, arg: &str) -> Result<()> {
	let s = site_here(c, "").await?;
	let build_id = j::at(&s, "buildId").clone();
	let orders = orders_of_site(&c.space, &build_id, c.txn()).await?;
	let a = js::trim(arg).to_owned();
	let me = c.char_id().to_owned();
	let name = key_text(j::at(&s, "name"));
	if a.is_empty() {
		settle(c, &s).await?;
		let text = if orders.is_empty() { format!("An der {name} hängt nichts aus. „aushang 5 treibholz je 1“ bietet Lohn für jedes Stück, „aushang 4 arbeit je 2“ für die Arbeit.") } else { format!("Ausgehängt an der {name}: {}.", orders.iter().map(order_line).collect::<Vec<_>>().join("; ")) };
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	}
	if c.account.as_ref().is_none_or(|acc| j::at(acc, "accountId") != j::at(&s, "accountId")) { return refuse("Aushängen darf nur, wem die Baustelle gehört."); }
	if js::re(r"^(?:ab|weg|zurück|zurueck)$", "i").test(&a) {
		let until = kept_until(c).await?;
		let back = close_orders(&c.space, &c.txn, &s, until).await?;
		settle(c, &s).await?;
		let text = if orders.is_empty() { "Hier hängt nichts von dir aus.".to_owned() } else { format!("Du nimmst den Aushang ab und bekommst {} Münzen zurück.", phi_json::number_text(back)) };
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	}
	let Some(m) = js::caps(&js::re(r"^(\d+)\s+(.+?)\s+(?:je|für je|fuer je|pro stück|pro stueck|each)\s+(\d+)(?:\s+münzen?|\s+muenzen?)?$", "i"), &a) else {
		return not_understood("So: aushang 5 treibholz je 1, oder aushang 4 arbeit je 2.");
	};
	let g = |i: usize| m[i].clone().unwrap_or_default();
	let pay = js::to_number(&g(3));
	if pay < 1.0 { return refuse("Ein Aushang braucht Lohn, mindestens eine Münze."); }
	let what = g(2);
	let work = js::re(r"^(?:arbeit|arbeitspunkte?|arbeitsstunden?|work)$", "i").test(&what);
	let said = stem(&what.to_lowercase());
	let needs = j::a(&s, "needs").to_vec();
	let need = if work { None } else {
		needs.iter().position(|x| {
			let proto = key_text(j::at(x, "proto"));
			let aliases: Vec<String> = j::a(c.w(), "prototypes").iter().find(|p| key_text(j::at(p, "key")) == proto).map(|p| j::strs(j::a(p, "aliases")).into_iter().map(str::to_owned).collect()).unwrap_or_default();
			std::iter::once(proto).chain(std::iter::once(key_text(j::at(x, "name")))).chain(aliases).any(|w| stem(&w.to_lowercase()) == said)
		})
	};
	if !work && need.is_none() { return refuse(format!("Das braucht die {name} nicht. Es fehlen {}.", missing(&s).join(", "))); }
	let nd = need.map(|i| &needs[i]);
	let proto = nd.map_or(Json::from(""), |x| j::at(x, "proto").clone());
	let open = if work { j::n(&s, "workNeed") - j::n(&s, "work") } else { nd.map_or(f64::NAN, |x| j::n(x, "count") - j::n(x, "have")) };
	let oname = if work { Json::from("Arbeit") } else { nd.map_or(Json::Null, |x| j::at(x, "name").clone()) };
	let n = js::to_number(&g(1)).min(open);
	if n.is_nan() || n <= 0.0 { return refuse(format!("{} hat die Baustelle genug.", key_text(&oname))); }
	if orders.iter().any(|o| j::at(o, "proto") == &proto) { return refuse(format!("Für {} hängt schon ein Aushang; „aushang ab“ nimmt ihn ab.", key_text(&oname))); }
	let currency = j::at(c.w(), "currency").clone();
	let coins: Vec<Json> = inventory(c).await?.into_iter().filter(|i| j::at(fields(i), "proto") == &currency).collect();
	let cost = n * pay;
	if (coins.len() as f64) < cost { return refuse(format!("Das kostet {} Münzen, du hast {}.", phi_json::number_text(cost), coins.len())); }
	let order_id = format!("so-{}", hex(&random_bytes(6)));
	let mut o = Object::new();
	o.insert("orderId", Json::from(order_id.as_str()));
	o.insert("buildId", build_id.clone());
	o.insert("siteName", j::at(&s, "name").clone());
	for k in ["room", "x", "y", "w", "h", "ownerName"] { o.insert(k, j::at(&s, k).clone()); }
	o.insert("proto", proto);
	o.insert("name", oname);
	o.insert("left", Json::from(n));
	o.insert("pay", Json::from(pay));
	o.insert("at", Json::from(world_now_of(&c.space, c.txn()).await?));
	let o = Json::Object(o);
	for coin in coins.iter().take(cost as usize) {
		if !move_coin(&c.space, &c.txn, j::at(fields(coin), "itemId"), &me, &order_id).await? { return refuse("Die Münzen sind gerade nicht greifbar; bitte noch einmal."); }
	}
	c.space.write(&obj! { "type" => "SiteOrder", "fields" => o.clone() }, c.txn(), FOREVER).await?;
	settle(c, &s).await?;
	let text = format!("{} hängt an der {name} aus: {}. Bezahlt wird beim Liefern und Mitarbeiten.", key_text(j::at(&c.actor, "name")), order_line(&o));
	msg(c, "*", "info", &text, MsgOpts::default()).await
}

/// `boardLines`: the board's lines for the sites of a region.
pub async fn board_lines(space: &Space, w: &Json) -> Result<Vec<String>> {
	let room = |id: &str| j::by(j::a(w, "rooms"), "roomId", id).map_or_else(|| id.to_owned(), |r| key_text(j::at(r, "name")));
	Ok(space.read_all(&obj! { "type" => "SiteOrder" }, None).await?.iter().map(|e| {
		let o = fields(e);
		format!("  {} von {} in {}: {}", key_text(j::at(o, "siteName")), key_text(j::at(o, "ownerName")), room(&key_text(j::at(o, "room"))), order_line(o))
	}).collect())
}
