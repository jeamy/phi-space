//! TLS of the host, on rustls: the management API over the public roots, and pinned mutual TLS 1.3 for the register
//! (src/tls-register.ts). Both name their crypto provider, so nothing depends on a process-wide default.
use std::fs::Metadata;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::io::Read as _;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::rustls::crypto::{ring, CryptoProvider};
use tokio_rustls::rustls::pki_types::pem::PemObject;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio_rustls::rustls::server::WebPkiClientVerifier;
use tokio_rustls::rustls::{version, ClientConfig, RootCertStore, ServerConfig};
use tokio_rustls::{client::TlsStream, TlsConnector};

fn provider() -> Arc<CryptoProvider> { Arc::new(ring::default_provider()) }

/// `privateFile` (src/keys.ts): a regular file of this user, no link, mode 0600 at most.
pub fn private_file(path: &Path) -> Result<Vec<u8>, String> {
	const O_NOFOLLOW: i32 = 0o400_000;
	let wrong = || format!("{}: provisioned file must be a regular private file (0600)", path.display());
	let mut f = std::fs::OpenOptions::new().read(true).custom_flags(O_NOFOLLOW).open(path).map_err(|e| format!("{}: {e}", path.display()))?;
	let m: Metadata = f.metadata().map_err(|e| e.to_string())?;
	let here = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
	let own = std::fs::metadata("/proc/self").map_or(m.uid(), |p| p.uid());
	if !m.is_file() || here.file_type().is_symlink() || m.ino() != here.ino() || m.dev() != here.dev() || m.nlink() != 1 || m.uid() != own || m.mode() & 0o077 != 0 {
		return Err(wrong());
	}
	let mut out = vec![];
	f.read_to_end(&mut out).map_err(|e| e.to_string())?;
	Ok(out)
}

fn certificates(pem: &[u8]) -> Result<Vec<CertificateDer<'static>>, String> {
	let list = CertificateDer::pem_slice_iter(pem).collect::<Result<Vec<_>, _>>().map_err(|e| format!("a certificate file: {e}"))?;
	if list.is_empty() { Err("a certificate file without certificates".to_owned()) } else { Ok(list) }
}
fn roots(pem: &[u8]) -> Result<RootCertStore, String> {
	let mut store = RootCertStore::empty();
	for c in certificates(pem)? {
		store.add(c).map_err(|e| format!("a CA certificate: {e}"))?;
	}
	Ok(store)
}

/// A client's or server's files; each is checked as a private file.
#[derive(Clone, Debug)]
pub struct TlsIdentity {
	pub ca_file: String,
	pub cert_file: String,
	pub key_file: String,
}
impl TlsIdentity {
	fn parts(&self) -> Result<(RootCertStore, Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), String> {
		let key = private_file(Path::new(&self.key_file))?;
		Ok((roots(&private_file(Path::new(&self.ca_file))?)?, certificates(&private_file(Path::new(&self.cert_file))?)?, PrivateKeyDer::from_pem_slice(&key).map_err(|e| format!("a key file: {e}"))?))
	}
	pub fn client(&self) -> Result<TlsConnector, String> {
		let (store, chain, key) = self.parts()?;
		let config = ClientConfig::builder_with_provider(provider()).with_protocol_versions(&[&version::TLS13]).map_err(|e| e.to_string())?.with_root_certificates(store).with_client_auth_cert(chain, key).map_err(|e| e.to_string())?;
		Ok(TlsConnector::from(Arc::new(config)))
	}
	pub fn server(&self) -> Result<tokio_rustls::TlsAcceptor, String> {
		let (store, chain, key) = self.parts()?;
		let verifier = WebPkiClientVerifier::builder_with_provider(Arc::new(store), provider()).build().map_err(|e| e.to_string())?;
		let config = ServerConfig::builder_with_provider(provider()).with_protocol_versions(&[&version::TLS13]).map_err(|e| e.to_string())?.with_client_cert_verifier(verifier).with_single_cert(chain, key).map_err(|e| e.to_string())?;
		Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
	}
}

pub fn server_name(name: &str) -> Result<ServerName<'static>, String> { ServerName::try_from(name.to_owned()).map_err(|e| format!("{name}: {e}")) }

/// A server of the public web, or of a private CA given as PEM.
pub async fn connect_web<S: AsyncRead + AsyncWrite + Unpin>(host: &str, socket: S, ca: Option<&str>) -> Result<TlsStream<S>, String> {
	let store = match ca {
		Some(pem) => roots(pem.as_bytes())?,
		None => RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() },
	};
	let config = ClientConfig::builder_with_provider(provider()).with_safe_default_protocol_versions().map_err(|e| e.to_string())?.with_root_certificates(store).with_no_client_auth();
	TlsConnector::from(Arc::new(config)).connect(server_name(host)?, socket).await.map_err(|e| e.to_string())
}
