// The Space process of spaces-files in Rust: what spaces-files/server/space-host.ts is, with the same command line, the
// same ready line and the same requests (docs/zanzibar-agent-filesystem-plan.en.md, section 8, separate Space process).
// It serves the store with the tenant Spaces on a private unix socket to the filesystem service, its only client, and on
// the store's own thread answers the two requests only the service makes (`FilesHostRequest` in the default Space,
// spaces-files/server/store.ts): the creation of a tenant's Space and the compaction of the store.
//
//   files-space --store FILE|memory --listen unix:/path.sock [--exit-with-parent]
use phi_core::space::Template;
use phi_json::{obj, Json};
use phi_service::Service;
use phi_space_host::{fail, make_parent, HostTask, Instance, Periodic};
use phi_store::{system_random, Compaction};
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, TryRecvError};

const PEER: &str = "files";
const REQUEST: &str = "FilesHostRequest";
const REPLY: &str = "FilesHostReply";
/// How long an unclaimed reply stays.
const REPLY_LEASE_MS: f64 = 60_000.0;
/// How often the requests are looked for.
const EVERY_MS: u64 = 10;

/// A tenant's Space alias (`tenantAlias` of the service): `t-` and 1 to 62 of a-z 0-9 _ -, starting with a letter or digit.
fn tenant_alias(a: &str) -> bool {
	let Some(t) = a.strip_prefix("t-") else { return false };
	!t.is_empty()
		&& t.len() <= 62
		&& t.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
		&& t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// The requests, one at a time; a compaction runs on the writer and is answered when it has finished.
#[derive(Default)]
struct Requests {
	compacting: Option<(Json, Receiver<Compaction>)>,
}

impl Requests {
	fn reply(service: &mut Service, id: &Json, answer: Result<Json, String>) {
		let now = service.now();
		let mut fields = match answer {
			Ok(result) => obj! { "ok" => true, "result" => result },
			Err(error) => obj! { "ok" => false, "error" => error },
		};
		if let Json::Object(o) = &mut fields {
			o.insert("id", id.clone());
		}
		let entry = obj! { "type" => REPLY, "fields" => fields };
		match service
			.store
			.commit(None, now, |s| s.write(now, &entry, None, Some(&REPLY_LEASE_MS.into()), None))
		{
			Ok(Ok(_)) => {}
			Ok(Err(e)) => eprintln!("[files-space] reply lost: {}", e.message),
			Err(e) => eprintln!("[files-space] reply lost: {e}"),
		}
	}

	fn tick(&mut self, service: &mut Service) {
		if let Some((id, rx)) = &self.compacting {
			match rx.try_recv() {
				Err(TryRecvError::Empty) => return,
				Ok(r) => {
					let mut out = obj! { "freedPages" => r.freed_pages as f64, "converted" => r.converted };
					if let (Json::Object(o), Some(e)) = (&mut out, r.error) {
						o.insert("error", e.into());
					}
					let id = id.clone();
					self.compacting = None;
					Self::reply(service, &id, Ok(out));
				}
				Err(TryRecvError::Disconnected) => {
					let id = id.clone();
					self.compacting = None;
					Self::reply(service, &id, Err("the compaction ended without a result".into()));
				}
			}
		}
		let tmpl = Template::from_json(Some(&obj! { "type" => REQUEST })).unwrap_or_else(|e| fail(e.message));
		loop {
			let now = service.now();
			let taken = match service.store.commit(None, now, |s| s.probe(now, &tmpl, None, true, None)) {
				Ok(Ok(c)) => c.value,
				Ok(Err(e)) => return eprintln!("[files-space] requests: {}", e.message),
				Err(e) => return eprintln!("[files-space] requests: {e}"),
			};
			let Some(fields) = taken.get("entry").and_then(|e| e.get("fields")).cloned() else {
				return;
			};
			let id = fields.get("id").cloned().unwrap_or(Json::Null);
			match fields.get("op").and_then(Json::as_str) {
				Some("createSpace") => {
					let alias = fields.get("alias").and_then(Json::as_str).unwrap_or("");
					let answer = if !tenant_alias(alias) {
						Err("a tenant Space alias is t-<tenant>".to_owned())
					} else {
						match service.store.create_space(alias, now, system_random()) {
							Ok(Ok(info)) => Ok(obj! { "spaceId" => info.get("spaceId").cloned().unwrap_or(Json::Null), "alias" => alias }),
							Ok(Err(e)) => Err(e.message),
							Err(e) => Err(e.to_string()),
						}
					};
					Self::reply(service, &id, answer);
				}
				Some("compact") => match service.store.compact_begin() {
					Some(rx) => {
						self.compacting = Some((id, rx));
						return;
					}
					None => Self::reply(service, &id, Ok(Json::Null)),
				},
				other => Self::reply(service, &id, Err(format!("unknown request {}", other.unwrap_or("")))),
			}
		}
	}
}

impl HostTask for Requests {
	fn prepare(&mut self, _service: &mut Service) {}
	fn periodic(self: Box<Self>) -> Vec<Periodic> {
		let mut me = *self;
		vec![Periodic {
			every_ms: EVERY_MS,
			run: Box::new(move |s| me.tick(s)),
		}]
	}
}

fn main() {
	phi_space_host::abort_on_panic();
	let args: Vec<String> = std::env::args().collect();
	let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
	let (Some(store), Some(listen)) = (arg("--store"), arg("--listen")) else {
		eprintln!("usage: files-space --store FILE|memory --listen unix:/path.sock [--exit-with-parent]");
		std::process::exit(2)
	};
	if !listen.starts_with("unix:") {
		fail("--listen must be unix:/path.sock: the tenant Spaces are never served beyond a private socket");
	}
	let file = (store != "memory").then(|| PathBuf::from(&store));
	if let Some(f) = &file {
		make_parent(f);
	}
	if args.iter().any(|a| a == "--exit-with-parent") {
		// the service's end closes this pipe: the process ends with it, as a crash would (the store is safe on the disk)
		std::thread::spawn(|| {
			let mut sink = [0u8; 256];
			let mut stdin = std::io::stdin();
			while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
			std::process::exit(0);
		});
	}
	let line = format!("[files-space] ready on {listen} (store {store})");
	let instance = Instance {
		listen,
		file,
		peer: PEER,
		wake_on_commit: true,
		max_inflight: 1024,
		limits: obj! {},
		locks: vec![],
		presence: None,
		compact_ms: 0,
		task: Some(Box::new(Requests::default())),
	};
	phi_space_host::run(vec![instance], line)
}
