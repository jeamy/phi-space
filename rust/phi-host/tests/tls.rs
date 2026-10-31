// The Rust side of TLS against the other side: the register client against src/tls-register.ts, and the management API over https.
use phi_host::gate::Netbird;
use phi_host::register::{serve_register, validate_read_keys, PeerPolicy, RegisterClient, RegisterError, SqliteRegister};
use phi_host::tls::{private_file, server_name, TlsIdentity};
use phi_json::{obj, Json};
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::{crypto, version, ClientConfig, RootCertStore, ServerConfig};

fn root() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../..") }
fn openssl(dir: &Path, args: &[&str]) {
	let out = Command::new("openssl").args(args).current_dir(dir).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}
/// A CA and certificates signed by it, in files of mode 0600.
fn pki(dir: &Path, ca: &str, names: &[(&str, &str)]) {
	openssl(dir, &["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", &format!("{ca}.key"), "-out", &format!("{ca}.crt"), "-subj", &format!("/CN={ca}"), "-days", "2"]);
	for (name, ext) in names {
		openssl(dir, &["req", "-newkey", "rsa:2048", "-nodes", "-keyout", &format!("{name}.key"), "-out", &format!("{name}.csr"), "-subj", &format!("/CN={name}")]);
		std::fs::write(dir.join(format!("{name}.ext")), ext).unwrap();
		openssl(dir, &["x509", "-req", "-in", &format!("{name}.csr"), "-CA", &format!("{ca}.crt"), "-CAkey", &format!("{ca}.key"), "-CAcreateserial", "-out", &format!("{name}.crt"), "-days", "2", "-extfile", &format!("{name}.ext")]);
	}
	for e in std::fs::read_dir(dir).unwrap() {
		std::fs::set_permissions(e.unwrap().path(), std::fs::Permissions::from_mode(0o600)).unwrap();
	}
}
fn scratch(name: &str) -> PathBuf {
	let d = std::env::temp_dir().join(format!("phi-tls-{name}-{}", std::process::id()));
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn runtime() -> tokio::runtime::Runtime { tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap() }
const SERVER_EXT: &str = "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n";
const CLIENT_EXT: &str = "extendedKeyUsage=clientAuth\n";

#[test]
fn the_rust_client_talks_to_the_typescript_register() {
	let dir = scratch("register");
	pki(&dir, "ca", &[("server", SERVER_EXT), ("reader", CLIENT_EXT), ("operator", CLIENT_EXT)]);
	let id = |n: &str| TlsIdentity { ca_file: dir.join("ca.crt").to_str().unwrap().into(), cert_file: dir.join(format!("{n}.crt")).to_str().unwrap().into(), key_file: dir.join(format!("{n}.key")).to_str().unwrap().into() };
	let script = format!(
		r#"import {{ X509Certificate, createHash }} from "node:crypto"; import {{ readFileSync }} from "node:fs"; import {{ serveTlsRegister }} from "./src/tls-register.ts"; import {{ SqliteRecoveryRegister }} from "./src/recovery-register.ts";
const dir = {d:?}, print = (n) => createHash("sha256").update(new X509Certificate(readFileSync(dir + "/" + n + ".crt")).raw).digest("hex");
const f = (n) => ({{ caFile: dir + "/ca.crt", certFile: dir + "/" + n + ".crt", keyFile: dir + "/" + n + ".key" }});
const s = await serveTlsRegister(new SqliteRecoveryRegister(dir + "/r.sqlite"), {{ ...f("server"), host: "127.0.0.1", port: 0, peers: {{ [print("reader")]: {{}}, [print("operator")]: {{ operator: true }} }} }});
console.log(s.address().port);"#,
		d = dir.to_str().unwrap()
	);
	let mut node = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &script]).current_dir(root()).stdout(Stdio::piped()).spawn().unwrap();
	let mut line = String::new();
	BufReader::new(node.stdout.as_mut().unwrap()).read_line(&mut line).unwrap();
	let port: u16 = line.trim().parse().unwrap();
	let client = |n: &str, name: Option<&str>| RegisterClient::new(RegisterClient { identity: id(n), host: "127.0.0.1".into(), port, server_name: name.map(str::to_owned), timeout_ms: 5000, batch_reads: true, unix_path: None }).unwrap();
	runtime().block_on(async {
		let first = client("operator", None).compare_and_set("authority:control", None, &obj! { "authorityId" => "a" }).await.unwrap();
		assert_eq!(first.get("version").and_then(Json::as_f64), Some(1.0));
		let read = client("reader", None).get("authority:control").await.unwrap();
		assert_eq!(read.get("value").and_then(|v| v.get("authorityId")).and_then(Json::as_str), Some("a"));
		assert!(matches!(client("operator", None).compare_and_set("authority:control", None, &obj! {}).await, Err(RegisterError::Conflict(_))));
		let refused = client("reader", None).compare_and_set("authority:control", Some(1.0), &obj! {}).await;
		assert!(matches!(&refused, Err(RegisterError::Failed(m)) if m.contains("no CAS permission")), "{refused:?}");
		let batch = client("reader", None).get_many(&["authority:control".into(), "missing".into()]).await.unwrap();
		assert_eq!(batch.get("missing"), Some(&Json::Null));
		assert!(client("reader", Some("untrusted.example")).get("authority:control").await.is_err(), "the server's name is pinned");
	});
	node.kill().unwrap();
	let _ = node.wait();
	std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_management_api_is_read_over_https_and_a_foreign_certificate_is_refused() {
	let dir = scratch("https");
	pki(&dir, "ca", &[("server", SERVER_EXT)]);
	let other = dir.join("other");
	std::fs::create_dir(&other).unwrap();
	pki(&other, "other", &[]);
	let chain = CertificateDer::pem_file_iter(dir.join("server.crt")).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
	let key = PrivateKeyDer::from_pem_file(dir.join("server.key")).unwrap();
	let config = ServerConfig::builder_with_provider(Arc::new(crypto::ring::default_provider())).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(chain, key).unwrap();
	let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
	let local = tokio::task::LocalSet::new();
	local.block_on(&runtime(), async {
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let port = listener.local_addr().unwrap().port();
		tokio::task::spawn_local(async move {
			loop {
				let (socket, _) = listener.accept().await.unwrap();
				let Ok(mut tls) = acceptor.accept(socket).await else { continue };
				let mut head = [0u8; 4096];
				let n = tls.read(&mut head).await.unwrap();
				assert!(String::from_utf8_lossy(&head[..n]).contains("Authorization: Token secret\r\n"));
				let body = r#"[{"id":"p-1","ip":"100.64.0.2","groups":[{"name":"space-hosts"}]}]"#;
				tls.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
				tls.shutdown().await.unwrap();
			}
		});
		let directory = |ca: &Path| {
			let d = Netbird::new(&format!("https://127.0.0.1:{port}"), "secret", None, Rc::new(|| 1.0)).unwrap();
			*d.ca.borrow_mut() = Some(std::fs::read_to_string(ca).unwrap());
			d
		};
		let found = directory(&dir.join("ca.crt")).lookup("100.64.0.2").await.unwrap().unwrap();
		assert_eq!((found.id.as_str(), found.groups.as_slice()), ("p-1", ["space-hosts".to_owned()].as_slice()));
		assert!(directory(&other.join("other.crt")).lookup("100.64.0.2").await.is_err(), "a certificate of another CA");
		let public = Netbird::new(&format!("https://127.0.0.1:{port}"), "secret", None, Rc::new(|| 1.0)).unwrap();
		assert!(public.lookup("100.64.0.2").await.is_err(), "the public roots do not know a private CA");
	});
	std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn the_register_asks_tls_1_3_and_a_batch_stays_bounded() {
	let dir = scratch("strict");
	pki(&dir, "ca", &[("server", SERVER_EXT), ("reader", CLIENT_EXT)]);
	let id = |n: &str| TlsIdentity { ca_file: dir.join("ca.crt").to_str().unwrap().into(), cert_file: dir.join(format!("{n}.crt")).to_str().unwrap().into(), key_file: dir.join(format!("{n}.key")).to_str().unwrap().into() };
	let identity = id("server");
	let print = {
		let der = CertificateDer::pem_file_iter(dir.join("reader.crt")).unwrap().next().unwrap().unwrap();
		phi_json::hex(&<sha2::Sha256 as sha2::Digest>::digest(der.as_ref()))
	};
	let register = SqliteRegister::open(&dir.join("r.sqlite")).unwrap();
	let local = tokio::task::LocalSet::new();
	local.block_on(&runtime(), async {
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let port = listener.local_addr().unwrap().port();
		let peers = Rc::new(move || [(print.clone(), PeerPolicy::default())].into());
		tokio::task::spawn_local(async move { serve_register(register, &identity, listener, peers).await.unwrap() });
		let client = RegisterClient { identity: id("reader"), host: "127.0.0.1".into(), port, server_name: None, timeout_ms: 5000, batch_reads: true, unix_path: None };
		assert_eq!(client.get("nothing").await, Ok(Json::Null), "the same client gets through");
		let mut store = RootCertStore::empty();
		store.add(CertificateDer::pem_file_iter(dir.join("ca.crt")).unwrap().next().unwrap().unwrap()).unwrap();
		let chain = CertificateDer::pem_file_iter(dir.join("reader.crt")).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
		let key = PrivateKeyDer::from_pem_file(dir.join("reader.key")).unwrap();
		let old = ClientConfig::builder_with_provider(Arc::new(crypto::ring::default_provider())).with_protocol_versions(&[&version::TLS12]).unwrap().with_root_certificates(store).with_client_auth_cert(chain, key).unwrap();
		let socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
		assert!(tokio_rustls::TlsConnector::from(Arc::new(old)).connect(server_name("127.0.0.1").unwrap(), socket).await.is_err(), "TLS 1.2 is refused");
		let keys: Vec<String> = (0..33).map(|i| format!("key:{i}")).collect();
		assert!(matches!(validate_read_keys(&keys), Err(RegisterError::Conflict(_))));
		assert!(matches!(client.get_many(&keys).await, Err(RegisterError::Conflict(_))));
		assert!(validate_read_keys(&keys[..32]).is_ok());
	});
	std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_key_file_is_private_or_it_is_not_read() {
	let dir = scratch("private");
	let file = dir.join("k");
	std::fs::write(&file, "secret").unwrap();
	std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
	assert_eq!(private_file(&file).unwrap(), b"secret");
	let link = dir.join("l");
	std::os::unix::fs::symlink(&file, &link).unwrap();
	assert!(private_file(&link).is_err(), "no symlink");
	let hard = dir.join("h");
	std::fs::hard_link(&file, &hard).unwrap();
	assert!(private_file(&file).is_err(), "no second name");
	std::fs::remove_file(&hard).unwrap();
	std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
	assert!(private_file(&file).is_err(), "not for the group");
	std::fs::remove_dir_all(&dir).unwrap();
}
