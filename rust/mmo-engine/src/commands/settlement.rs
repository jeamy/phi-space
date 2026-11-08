//! Settlements (`server/engine/commands/settlement.ts`), so far what other commands read of them.
use phi_json::{obj, Json};

use crate::space::{fields, tmpl, Result, Space};

/// `settlementIn`.
pub async fn settlement_in(space: &Space, room: &str, txn: Option<&str>) -> Result<Option<Json>> {
	Ok(space.peek(&tmpl("Settlement", obj! { "room" => room }), txn).await?.map(|e| fields(&e).clone()))
}
