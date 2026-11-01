//! The heartbeat of a Member (src/configured-runtime.ts, src/capability-directory.ts): what this host offers, at the control host
//! and in its own data Spaces. A directory entry adds no routing Member, and a failed heartbeat is reported and tried again.
use crate::remote::ControlClient;
use phi_core::space::{error, CoreError, Template};
use phi_json::{obj, Json};
use phi_service::Service;
use phi_wire::Owner;
use std::rc::Rc;
use std::time::Duration;

const LEASE_MS: f64 = 120_000.0;
const HEARTBEAT_MS: u64 = 60_000;
const MAX_RECORDS: usize = 4;

pub struct Capabilities {
	pub host_id: String,
	pub tools: Vec<String>,
	pub models: Vec<String>,
	pub data_spaces: Vec<String>,
	/// The control host; `None` on the control host itself, whose directory is among its `data_spaces`.
	pub client: Option<Rc<ControlClient>>,
}

fn memory() -> (f64, f64) {
	let text = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
	let of = |name: &str| text.lines().find(|l| l.starts_with(name)).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()).unwrap_or(0.0) * 1024.0;
	(of("MemTotal:"), of("MemAvailable:"))
}

/// `replace`: a bounded record, not one more for each heartbeat.
pub fn publish(service: &mut Service, space: &str, fields: &Json) -> Result<Json, CoreError> {
	let host = fields.get("hostId").cloned().unwrap_or(Json::Null);
	service.commit_on(Some(space), |s, now| {
		let old = s.list(now, &Template::from_json(Some(&obj! { "type" => "Capability", "fields" => obj! { "hostId" => host } }))?, None, None, None)?;
		let old = old.as_array().map_or(&[][..], Vec::as_slice);
		if old.len() > MAX_RECORDS {
			return Err(error("ResourceExhausted", "duplicate directory records"));
		}
		for e in old {
			s.probe(now, &Template::from_json(Some(&obj! { "type" => "Capability", "id" => e.get("id").cloned().unwrap_or(Json::Null) }))?, None, true, None)?;
		}
		let mut stamped = fields.as_object().cloned().unwrap_or_default();
		stamped.insert("at", now.into());
		s.write(now, &obj! { "type" => "Capability", "fields" => Json::Object(stamped) }, None, Some(&Json::Number(LEASE_MS)), None)
	})
}

impl Capabilities {
	fn report(&self) -> Json {
		let names = |v: &[String]| Json::Array(v.iter().map(|n| n.as_str().into()).collect());
		let (total, free) = memory();
		let cpus = std::thread::available_parallelism().map_or(1.0, |n| n.get() as f64);
		obj! { "hostId" => self.host_id.as_str(), "resources" => obj! { "memoryBytes" => total, "cpus" => cpus }, "tools" => names(&self.tools), "models" => names(&self.models), "metrics" => obj! { "freeMemoryBytes" => free } }
	}

	async fn beat(&self, owner: &Owner) -> Result<(), String> {
		let report = self.report();
		for space in &self.data_spaces {
			owner.with(|service| publish(service, space, &report)).map_err(|e| e.message)?;
		}
		let Some(client) = &self.client else { return Ok(()) };
		let grant = client.grant().await?;
		client.call(&obj! { "method" => "capabilityHeartbeat", "space" => "control", "args" => obj! { "report" => report }, "frame" => obj! { "grant" => grant } }).await?;
		Ok(())
	}

	pub async fn run(self: Rc<Self>, owner: Owner) {
		loop {
			if let Err(e) = self.beat(&owner).await {
				eprintln!("Capability heartbeat: {e}");
			}
			tokio::time::sleep(Duration::from_millis(HEARTBEAT_MS)).await;
		}
	}
}
