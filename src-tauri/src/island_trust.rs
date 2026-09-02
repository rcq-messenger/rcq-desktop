// An island trusted by its fingerprint, not by a certificate authority: the
// desktop half of docs/island-fingerprint-design.md (§1, §2, §3, §4, §7.3).
//
// A browser cannot be told to trust a private certificate, and neither can the
// webview Tauri wraps: wry hands the TLS decision to WebKit, WebView2 or
// WebKitGTK and takes no verifier. So for an island the platform does not
// trust, TLS is terminated HERE. Per island a listener sits on loopback; the
// page talks plain HTTP to it (lib/island-trust.ts rewrites the origin, the
// way front.ts rewrites the flagship's), and every accepted connection is
// bridged to the island over rustls with OUR rule in the verifier. The webview
// still owns TLS for everything it can verify itself; only the connections it
// would refuse come through here.
//
// The rule (§1) runs on EVERY handshake through here, whichever way the WebPKI
// check went. A fingerprint the person typed with the address wins over
// everything that arrives over the network, an authority's signature included.
// Otherwise a chain the roots accept for THIS name is accepted and remembered
// as `ca`, and the pin store governs only what the roots do not accept: a
// first sighting pins, a match connects, a mismatch is REFUSED - not warned
// about and connected anyway. A connection carrying a session token cannot be
// judged by the person the way a page can, so a changed certificate is not
// connected to at all until they decide (§5). The flagship and the front are
// never trusted on first use: an attacker who can present a private
// certificate for api.rcq.app must not be able to pin themselves in.
//
// ⚠ The `ca` write on the SUCCESS branch is the point of running the rule on
// both outcomes. A client that consults the store only when the platform
// refuses has no `ca` records, and for it every island used for months over
// Let's Encrypt is still an unknown island that an attacker's self-signed
// certificate takes on first use. The page probes every island origin through
// this verifier once, BEFORE its first request, so that write happens.
//
// ⚠ The pin is the identity. Validity dates and subject names of a PINNED
// certificate are ignored on purpose (the installer issues for ten years and
// an operator may move the island to a bare IP); what is checked, always, is
// that the handshake signature verifies under the pinned certificate's key -
// that is what binds the pin to THIS connection rather than to a copied
// certificate.
//
// ⚠ A refusal is not a blocked route (§5.5). The island answered; it is the
// certificate that was wrong. `reachability` below is what the bypass probes
// ask about an island that is not the flagship, so a refused island does not
// raise the tunnel and the banner and the shield never fight over it.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

const FILE: &str = "island-pins.json";
/// Matches the TURN tunnel's budget: through a relay a throttled link needs
/// more than a few seconds, and a probe that gives up early reads as an
/// island that is down.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// A request head or a chunk-size line longer than this is not a browser's;
/// the connection is dropped rather than buffered without bound.
const MAX_HEAD: usize = 64 * 1024;
/// A webview keeps six connections per origin plus sockets and media; a
/// runaway page must still not fan out into the tunnel without limit.
const MAX_BRIDGES: usize = 64;

// ── The store (§4) ─────────────────────────────────────────────────────────

/// One line of the pin store. `mode` is "ca" or "pinned"; a pinned record
/// carries the fingerprint and where it came from ("tofu", "typed",
/// "accepted"); `noticed` is whether the first-use notice has been shown.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Record {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub since: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noticed: Option<bool>,
}

impl Record {
    fn ca(now: u64) -> Record {
        Record { mode: "ca".into(), fp: None, source: None, since: now, noticed: None }
    }

    fn pinned(fp: String, source: &str, now: u64) -> Record {
        // A fingerprint the person typed or accepted has been looked at; only
        // a first-use pin owes the notice.
        let noticed = Some(source != "tofu");
        Record { mode: "pinned".into(), fp: Some(fp), source: Some(source.into()), since: now, noticed }
    }

    fn is_typed(&self) -> bool {
        self.source.as_deref() == Some("typed")
    }
}

#[derive(Serialize, Deserialize, Default)]
struct PinFile {
    #[serde(default)]
    pins: HashMap<String, Record>,
}

#[derive(Default)]
struct Store {
    /// None until the first command hands us an AppHandle. Plain JSON in the
    /// app data dir, next to the vault: a pin is not a secret, losing it costs
    /// a re-trust, and the panic wipe takes the directory with everything.
    path: Option<PathBuf>,
    pins: HashMap<String, Record>,
}

fn store() -> &'static Mutex<Store> {
    static S: OnceLock<Mutex<Store>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Store::default()))
}

/// Refusals the UI has to draw, keyed like the store. In memory only: a probe
/// re-derives them, and a page that reloads re-probes.
fn changed() -> &'static Mutex<HashMap<String, Changed>> {
    static C: OnceLock<Mutex<HashMap<String, Changed>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load_into(s: &mut Store, dir: PathBuf) {
    let path = dir.join(FILE);
    s.pins = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<PinFile>(&t).ok())
        .map(|f| f.pins)
        .unwrap_or_default();
    s.path = Some(path);
}

fn ensure_loaded(app: &AppHandle) {
    let mut s = store().lock().unwrap();
    if s.path.is_some() {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else {
        log::error!("no app data dir; island pins will not persist");
        return;
    };
    load_into(&mut s, dir);
}

/// The store without an AppHandle, for the tests against a live island and
/// nothing else. Idempotent the way `ensure_loaded` is.
#[cfg(test)]
fn init_store_at(dir: PathBuf) {
    let mut s = store().lock().unwrap();
    if s.path.is_none() {
        load_into(&mut s, dir);
    }
}

fn persist(s: &Store) {
    let Some(path) = &s.path else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = match serde_json::to_string(&PinFile { pins: s.pins.clone() }) {
        Ok(b) => b,
        Err(e) => {
            log::error!("island pins: cannot encode: {e}");
            return;
        }
    };
    // Beside it and rename, like the vault: a half-written store is a set of
    // pins that vanished, and every one of them comes back as a first use.
    let tmp = path.with_extension("json.part");
    if let Err(e) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, path)) {
        log::error!("island pins: cannot write {}: {e}", path.display());
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── The pure parts (§1, §2, §3) ─────────────────────────────────────────────

/// The store key: `host:port`, host lowercased, IPv6 brackets kept.
pub fn key(host: &str, port: u16) -> String {
    format!("{}:{}", host.to_ascii_lowercase(), port)
}

/// SHA-256 over the DER of the leaf exactly as presented - what
/// `openssl x509 -noout -fingerprint -sha256` prints - as 64 lowercase hex.
pub fn fingerprint(leaf_der: &[u8]) -> String {
    hex::encode(Sha256::digest(leaf_der))
}

/// Accept what a person pastes (openssl's `AB:CD:…`, any case, spaces) and
/// hand back the canonical form, or None for anything that is not 32 bytes.
pub fn parse_fingerprint(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| *c != ':' && !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if cleaned.len() == 64 && cleaned.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(cleaned)
    } else {
        None
    }
}

/// `host[:port]` as the page and the bypass write it, split the way the store
/// keys it: brackets kept on an IPv6 literal, 443 when no port is given. A
/// bare IPv6 literal without brackets is not an authority and answers None.
pub fn split_authority(authority: &str) -> Option<(String, u16)> {
    let a = authority.trim();
    if a.is_empty() {
        return None;
    }
    if a.starts_with('[') {
        let end = a.find(']')?;
        let host = &a[..=end];
        return match &a[end + 1..] {
            "" => Some((host.to_string(), 443)),
            rest => rest.strip_prefix(':').and_then(|p| p.parse().ok()).map(|p| (host.to_string(), p)),
        };
    }
    match a.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => Some((host.to_string(), port.parse().ok()?)),
        Some(_) => None,
        None => Some((a.to_string(), 443)),
    }
}

/// Hosts that are never trusted on first use: the flagship, anything under
/// its apex, and the CDN front the signed relay list names.
pub fn is_ca_only(host: &str, front: Option<&str>) -> bool {
    let h = host.to_ascii_lowercase();
    h == "rcq.app"
        || h.ends_with(".rcq.app")
        || front.is_some_and(|f| f.eq_ignore_ascii_case(&h))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Accept,
    AcceptFirstUse(String),
    RefuseCaOnly,
    /// `old` is a fingerprint or the literal "ca". `ca` is whether the refused
    /// chain was one the roots accept, which decides what an accept writes
    /// (§5.2); `typed` is whether the record on file was entered by the person.
    RefuseChanged { old: String, new: String, ca: bool, typed: bool },
}

/// The rule of §1 over an in-memory map, so it can be tested without a disk
/// or a socket. Mutates the map exactly where the rule says a record is
/// written; the caller persists. `ca_valid` means chain AND name: the roots
/// accept the chain for the host that was dialled.
pub fn decide(
    pins: &mut HashMap<String, Record>,
    host: &str,
    port: u16,
    leaf_der: &[u8],
    ca_valid: bool,
    ca_only: bool,
    now: u64,
) -> Verdict {
    if ca_only {
        // Never pinned, typed or not, and never recorded either.
        return if ca_valid { Verdict::Accept } else { Verdict::RefuseCaOnly };
    }
    let key = key(host, port);
    let fp = fingerprint(leaf_der);
    if let Some(rec) = pins.get(&key).filter(|r| r.is_typed()) {
        // The identity the person was handed out of band. Nothing that arrives
        // over the network overrides it, an authority's signature included:
        // whoever can obtain a certificate the roots trust for this address
        // (Let's Encrypt issues for IP literals, and a route hijacker passes
        // its challenge) would otherwise replace the typed pin silently and
        // take the session token, and the real island would be the one
        // refused. The verdict carries `ca` so that accepting a genuine move
        // to an authority records `ca` rather than a leaf that rotates.
        return if rec.fp.as_deref() == Some(fp.as_str()) {
            Verdict::Accept
        } else {
            Verdict::RefuseChanged { old: rec.fp.clone().unwrap_or_default(), new: fp, ca: ca_valid, typed: true }
        };
    }
    if ca_valid {
        // Overwrites a tofu or accepted pin too: the island moved to a CA, and
        // a private certificate for it from now on is a change, not a first
        // use. Written on every success, which is what makes an island used
        // for months over Let's Encrypt a KNOWN island.
        if pins.get(&key).map(|r| r.mode.as_str()) != Some("ca") {
            pins.insert(key, Record::ca(now));
        }
        return Verdict::Accept;
    }
    match pins.get(&key) {
        None => {
            pins.insert(key, Record::pinned(fp.clone(), "tofu", now));
            Verdict::AcceptFirstUse(fp)
        }
        Some(rec) if rec.mode == "ca" => {
            Verdict::RefuseChanged { old: "ca".into(), new: fp, ca: false, typed: false }
        }
        Some(rec) if rec.fp.as_deref() == Some(fp.as_str()) => Verdict::Accept,
        Some(rec) => {
            Verdict::RefuseChanged { old: rec.fp.clone().unwrap_or_default(), new: fp, ca: false, typed: false }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PrePin {
    /// Nothing was on file; the typed value is now, before any connection.
    Pinned,
    /// The same value was already on file: a no-op.
    Same,
    /// A record that disagrees is on file. Not written (§3): the banner
    /// decides, with `old` what is on file (a fingerprint or "ca").
    Conflict { old: String, typed: bool },
}

/// §3: the fingerprint typed with the address, BEFORE the first connection.
/// Only a null record is written silently. A pasted URL or an address that
/// arrived in a chat must not be able to replace what this device already
/// trusts because somebody opened it.
pub fn prepin(pins: &mut HashMap<String, Record>, host: &str, port: u16, fp: &str, now: u64) -> PrePin {
    let key = key(host, port);
    match pins.get(&key) {
        None => {
            pins.insert(key, Record::pinned(fp.to_string(), "typed", now));
            PrePin::Pinned
        }
        Some(rec) if rec.mode == "pinned" && rec.fp.as_deref() == Some(fp) => PrePin::Same,
        Some(rec) if rec.mode == "ca" => PrePin::Conflict { old: "ca".into(), typed: false },
        Some(rec) => PrePin::Conflict { old: rec.fp.clone().unwrap_or_default(), typed: rec.is_typed() },
    }
}

/// What the banner's "trust the new fingerprint" writes (§5.2). When the
/// refused chain was CA-valid - a typed pin against an island that moved to
/// an authority - it records `ca`, because pinning a leaf an authority rotates
/// would bring the banner back at the next renewal. A value the person entered
/// with the address (§3's conflict) stays `typed`; anything else is `accepted`.
pub fn accept_record(changed: Option<&Changed>, fp: &str, source: &str, now: u64) -> Record {
    let about_this = changed.filter(|c| c.new == fp);
    if about_this.is_some_and(|c| c.ca) {
        return Record::ca(now);
    }
    let source = if source == "typed" || about_this.is_some_and(|c| c.entered) { "typed" } else { "accepted" };
    Record::pinned(fp.to_string(), source, now)
}

/// `decide` over the live store, persisted when it wrote, with the refusal
/// map kept in step. Every handshake - probe or bridge - comes through here.
fn judge(host: &str, port: u16, leaf_der: &[u8], ca_valid: bool, ca_only: bool) -> Verdict {
    let k = key(host, port);
    let verdict = {
        let mut s = store().lock().unwrap();
        let before = s.pins.get(&k).cloned();
        let verdict = decide(&mut s.pins, host, port, leaf_der, ca_valid, ca_only, now());
        if s.pins.get(&k) != before.as_ref() {
            persist(&s);
        }
        verdict
    };
    let mut c = changed().lock().unwrap();
    match &verdict {
        Verdict::RefuseChanged { old, new, ca, typed } => {
            c.insert(k, Changed { old: old.clone(), new: new.clone(), ca: *ca, typed: *typed, entered: false });
        }
        Verdict::Accept | Verdict::AcceptFirstUse(_) => {
            c.remove(&k);
        }
        Verdict::RefuseCaOnly => {}
    }
    verdict
}

// ── The verifier ───────────────────────────────────────────────────────────

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    static P: OnceLock<Arc<rustls::crypto::CryptoProvider>> = OnceLock::new();
    P.get_or_init(|| Arc::new(rustls::crypto::ring::default_provider())).clone()
}

/// The WebPKI verifier over the bundled Mozilla roots, built once: parsing
/// the anchors is the expensive part, and it is the same for every island.
fn webpki_verifier() -> Result<Arc<WebPkiServerVerifier>, String> {
    static V: OnceLock<Result<Arc<WebPkiServerVerifier>, String>> = OnceLock::new();
    V.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
            .build()
            .map_err(|e| e.to_string())
    })
    .clone()
}

/// rustls asks this once per handshake, with the leaf as presented. The
/// answer is `judge`'s; the WebPKI verdict is only the `caValid` input to it.
#[derive(Debug)]
struct IslandVerifier {
    host: String,
    port: u16,
    ca_only: bool,
    webpki: Arc<WebPkiServerVerifier>,
    /// What the rule said, for the probe to read back after the handshake.
    /// None when the handshake failed before a certificate arrived.
    outcome: Arc<Mutex<Option<Verdict>>>,
}

impl ServerCertVerifier for IslandVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // ⚠ `ca_valid` has to mean chain AND name, or a captive portal's
        // perfectly valid certificate for some other name would write a `ca`
        // record over an island's pin. The WebPKI verifier does both here: it
        // walks the chain to a root and then matches `server_name`, the name
        // we dialled, against the leaf's SANs (rustls hands it in for that).
        let ca_valid = self
            .webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
            .is_ok();
        let verdict = judge(&self.host, self.port, end_entity.as_ref(), ca_valid, self.ca_only);
        *self.outcome.lock().unwrap() = Some(verdict.clone());
        match verdict {
            Verdict::Accept | Verdict::AcceptFirstUse(_) => Ok(ServerCertVerified::assertion()),
            Verdict::RefuseCaOnly => Err(rustls::Error::General("island_trust: ca_only".into())),
            Verdict::RefuseChanged { .. } => Err(rustls::Error::General("island_trust: changed".into())),
        }
    }

    // The handshake signature is verified under the presented certificate's
    // key whichever way the certificate was accepted. That check is the pin.
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.webpki.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

fn client_config(
    host: &str,
    port: u16,
    ca_only: bool,
    outcome: Arc<Mutex<Option<Verdict>>>,
) -> Result<Arc<rustls::ClientConfig>, String> {
    let verifier = IslandVerifier { host: host.to_string(), port, ca_only, webpki: webpki_verifier()?, outcome };
    let mut cfg = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    // http/1.1 only: the forwarder frames requests to rewrite Host, and h2 on
    // the island side would leave the loopback side speaking a protocol the
    // framer does not.
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(cfg))
}

// ── Dialling ───────────────────────────────────────────────────────────────

fn check_host(host: &str, port: u16) -> Result<(), String> {
    if host.is_empty() || host.len() > 255 {
        return Err("bad host".into());
    }
    if host.chars().any(|c| c.is_whitespace() || matches!(c, '/' | '#' | '?' | '@' | '\\')) {
        return Err("bad host".into());
    }
    if port == 0 {
        return Err("bad port".into());
    }
    Ok(())
}

/// The host without IPv6 brackets: what the socket and the TLS layer want.
fn bare(host: &str) -> &str {
    host.trim_start_matches('[').trim_end_matches(']')
}

/// `host:port` as a browser would write it in `Host:` - no port for 443.
fn authority(host: &str, port: u16) -> String {
    if port == 443 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    }
}

/// Through sing-box when a SOCKS port is given - the same road the webview
/// takes while the bypass is up - and straight out otherwise. The port is
/// read by the caller per connection, not cached: the core can stop or
/// rebuild underneath a listener that outlives it.
async fn dial(host: &str, port: u16, socks: Option<u16>) -> std::io::Result<TcpStream> {
    let connect = async {
        match socks {
            Some(socks) => crate::turn_tunnel::socks_connect(socks, host, port).await,
            None => TcpStream::connect((bare(host), port)).await,
        }
    };
    tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| std::io::Error::other("connect timed out"))?
}

async fn handshake(
    host: &str,
    port: u16,
    ca_only: bool,
    socks: Option<u16>,
) -> (std::io::Result<tokio_rustls::client::TlsStream<TcpStream>>, Option<Verdict>) {
    let outcome = Arc::new(Mutex::new(None));
    let attempt = async {
        let cfg = client_config(host, port, ca_only, outcome.clone()).map_err(std::io::Error::other)?;
        let name = ServerName::try_from(bare(host).to_string())
            .map_err(|e| std::io::Error::other(format!("bad server name: {e}")))?;
        let tcp = dial(host, port, socks).await?;
        tcp.set_nodelay(true)?;
        TlsConnector::from(cfg).connect(name, tcp).await
    };
    let result = match tokio::time::timeout(HANDSHAKE_TIMEOUT, attempt).await {
        Ok(r) => r,
        Err(_) => Err(std::io::Error::other("handshake timed out")),
    };
    let verdict = outcome.lock().unwrap().clone();
    (result, verdict)
}

fn front(app: &AppHandle) -> Option<String> {
    crate::bypass::current_config(app).and_then(|c| c.front)
}

// ── The commands' side ─────────────────────────────────────────────────────

/// A refusal the banner draws (§5.2). `old` is a fingerprint or "ca"; `ca`
/// says the refused chain was CA-valid (accepting records `ca`); `typed` says
/// the record on file was entered by the person (the banner says so);
/// `entered` says the NEW value is one the person typed with the address and
/// the store disagreed (§3), so accepting keeps it `typed`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Changed {
    pub old: String,
    pub new: String,
    pub ca: bool,
    pub typed: bool,
    pub entered: bool,
}

#[derive(Serialize, Debug)]
pub struct Probe {
    /// ca | pinned | first_use | changed | ca_only | offline
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// For a pinned island: whether the first-use notice has been shown.
    /// A notice that never got drawn (the app closed on it) is drawn later.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noticed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<Changed>,
    /// For `offline`: what the store holds for this island ("ca" or
    /// "pinned"), so the page knows whether a request may go out on the
    /// webview's own TLS in the meantime or has to wait for the forwarder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_file: Option<String>,
}

/// One TLS handshake, the rule applied, nothing sent. What the page asks
/// BEFORE the first request to an island origin, and again (throttled) when
/// a request to it fails - which is how a certificate swapped mid-session
/// reaches the banner.
pub async fn probe(app: &AppHandle, host: &str, port: u16) -> Result<Probe, String> {
    check_host(host, port)?;
    ensure_loaded(app);
    let ca_only = is_ca_only(host, front(app).as_deref());
    Ok(probe_at(host, port, ca_only, crate::bypass::socks_port()).await)
}

async fn probe_at(host: &str, port: u16, ca_only: bool, socks: Option<u16>) -> Probe {
    let (result, verdict) = handshake(host, port, ca_only, socks).await;
    drop(result);
    let none = Probe { state: "offline", fingerprint: None, noticed: None, changed: None, on_file: None };
    let rec = store().lock().unwrap().pins.get(&key(host, port)).cloned();
    match verdict {
        None => Probe { on_file: rec.map(|r| r.mode), ..none },
        Some(Verdict::Accept) => match rec {
            Some(r) if r.mode == "pinned" => {
                Probe { state: "pinned", fingerprint: r.fp, noticed: Some(r.noticed.unwrap_or(true)), ..none }
            }
            _ => Probe { state: "ca", ..none },
        },
        Some(Verdict::AcceptFirstUse(fp)) => Probe { state: "first_use", fingerprint: Some(fp), ..none },
        Some(Verdict::RefuseCaOnly) => Probe { state: "ca_only", ..none },
        Some(Verdict::RefuseChanged { .. }) => {
            let changed = changed().lock().unwrap().get(&key(host, port)).cloned();
            Probe { state: "changed", changed, ..none }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Reachability {
    /// The island answered a REQUEST on this road, not just a handshake.
    Reachable,
    /// The island answered and the rule refused its certificate. NOT a
    /// blocked route: no tunnel, no relay, no retry helps.
    Refused,
    Unreachable,
}

/// `GET /health` on a connection the rule has already accepted, and whether
/// the island answered it.
///
/// ⚠ A completed handshake is not an answer. A middlebox can finish the TLS -
/// a TLS 1.3 client does not wait on the server to consider it done - and
/// reset the stream on the first byte of the request, which is the shape of
/// blocking the bypass probes exist to catch; and a TLS terminator can be up
/// with nothing behind it. Judging reachability on the handshake alone would
/// also let the shield report a route "verified" over which nothing was ever
/// sent. Only the status line is read: the answer is whether the island
/// spoke, not what it said.
async fn health(tls: &mut tokio_rustls::client::TlsStream<TcpStream>, host: &str, port: u16) -> bool {
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: {}\r\nUser-Agent: rcq-desktop\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        authority(host, port)
    );
    if tls.write_all(req.as_bytes()).await.is_err() || tls.flush().await.is_err() {
        return false;
    }
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    // The status line is the first thing on the wire and is short; anything
    // longer than this is not one.
    while line.len() < 128 {
        match tls.read(&mut byte).await {
            Ok(0) | Err(_) => return false,
            Ok(_) => {}
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&line);
    // "HTTP/1.1 200 OK" - the same bar the reqwest probe set with
    // `status().is_success()`.
    status.starts_with("HTTP/1.") && status.split(' ').nth(1).is_some_and(|c| c.starts_with('2'))
}

/// The bypass probes' question about an island that is not the flagship,
/// answered under the rule rather than by a plain HTTP client that knows
/// nothing of pins - but answered with a request, exactly as that client
/// asked it. Blocking on the caller's budget, which covers the handshake and
/// the request together. None for a CA-only host: the caller's own probe
/// covers the flagship.
pub fn reachability(app: &AppHandle, authority: &str, socks: Option<u16>, budget: Duration) -> Option<Reachability> {
    let (host, port) = split_authority(authority)?;
    if check_host(&host, port).is_err() || is_ca_only(&host, front(app).as_deref()) {
        return None;
    }
    ensure_loaded(app);
    let outcome = tauri::async_runtime::block_on(async {
        tokio::time::timeout(budget, async {
            let (result, verdict) = handshake(&host, port, false, socks).await;
            // A refusal IS the answer, and the island is the one thing it is
            // not a question about: it answered, and no road changes that.
            if matches!(verdict, Some(Verdict::RefuseChanged { .. }) | Some(Verdict::RefuseCaOnly)) {
                return Reachability::Refused;
            }
            match result {
                Ok(mut tls) => {
                    if health(&mut tls, &host, port).await {
                        Reachability::Reachable
                    } else {
                        Reachability::Unreachable
                    }
                }
                Err(_) => Reachability::Unreachable,
            }
        })
        .await
    });
    Some(outcome.unwrap_or(Reachability::Unreachable))
}

#[derive(Serialize, Debug)]
pub struct PrePinResult {
    /// pinned | same | conflict
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<Changed>,
}

/// §3, from the address form: the typed fingerprint goes on file before the
/// first connection, or, against a record that disagrees, onto the banner
/// with nothing written and nothing dialled.
pub fn prepin_island(app: &AppHandle, host: &str, port: u16, fingerprint: &str) -> Result<PrePinResult, String> {
    check_host(host, port)?;
    let fp = parse_fingerprint(fingerprint).ok_or("bad fingerprint")?;
    ensure_loaded(app);
    if is_ca_only(host, front(app).as_deref()) {
        return Err("ca_only".into());
    }
    let k = key(host, port);
    let outcome = {
        let mut s = store().lock().unwrap();
        let outcome = prepin(&mut s.pins, host, port, &fp, now());
        if outcome == PrePin::Pinned {
            persist(&s);
        }
        outcome
    };
    let mut c = changed().lock().unwrap();
    Ok(match outcome {
        PrePin::Pinned => {
            c.remove(&k);
            PrePinResult { state: "pinned", changed: None }
        }
        PrePin::Same => PrePinResult { state: "same", changed: None },
        PrePin::Conflict { old, typed } => {
            let entry = Changed { old, new: fp, ca: false, typed, entered: true };
            c.insert(k, entry.clone());
            PrePinResult { state: "conflict", changed: Some(entry) }
        }
    })
}

#[derive(Serialize, Debug)]
pub struct Status {
    /// "ca", "pinned", or null when this island has never been met.
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noticed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed: Option<Changed>,
}

pub fn status(app: &AppHandle, host: &str, port: u16) -> Result<Status, String> {
    check_host(host, port)?;
    ensure_loaded(app);
    let k = key(host, port);
    let rec = store().lock().unwrap().pins.get(&k).cloned();
    let changed = changed().lock().unwrap().get(&k).cloned();
    Ok(match rec {
        None => Status { mode: None, fingerprint: None, source: None, since: None, noticed: None, changed },
        Some(r) => Status {
            mode: Some(r.mode),
            fingerprint: r.fp,
            source: r.source,
            since: Some(r.since),
            noticed: r.noticed,
            changed,
        },
    })
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub host: String,
    pub port: u16,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub since: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noticed: Option<bool>,
}

pub fn list(app: &AppHandle) -> Vec<Entry> {
    ensure_loaded(app);
    let s = store().lock().unwrap();
    let mut out: Vec<Entry> = s
        .pins
        .iter()
        .filter_map(|(k, r)| {
            // rsplit: an IPv6 key is `[::1]:8443`, and the port is after the
            // LAST colon.
            let (host, port) = k.rsplit_once(':')?;
            Some(Entry {
                host: host.to_string(),
                port: port.parse().ok()?,
                mode: r.mode.clone(),
                fingerprint: r.fp.clone(),
                source: r.source.clone(),
                since: r.since,
                noticed: r.noticed,
            })
        })
        .collect();
    out.sort_by(|a, b| a.host.cmp(&b.host).then(a.port.cmp(&b.port)));
    out
}

/// The banner's accept (§5.2), or the form's typed value handed over after a
/// conflict. What gets written is `accept_record`'s business; either way the
/// person has looked at the value, so the first-use notice is owed nothing.
pub fn accept(app: &AppHandle, host: &str, port: u16, fingerprint: &str, source: &str) -> Result<(), String> {
    check_host(host, port)?;
    let fp = parse_fingerprint(fingerprint).ok_or("bad fingerprint")?;
    ensure_loaded(app);
    if is_ca_only(host, front(app).as_deref()) {
        return Err("ca_only".into());
    }
    let k = key(host, port);
    let mut c = changed().lock().unwrap();
    {
        let mut s = store().lock().unwrap();
        let rec = accept_record(c.get(&k), &fp, source, now());
        s.pins.insert(k.clone(), rec);
        persist(&s);
    }
    c.remove(&k);
    Ok(())
}

/// The destroy-everything path (§4): every pin, and the file itself.
///
/// ⚠ The desktop has no panic wipe, so this is the whole of what §4 means by
/// "the panic wipe clears it with everything else": sign-out, "remove this
/// account" and "forgot PIN -> reset the vault" all end in
/// `wipeLocalAccountData`, and that is what calls this. What the file holds is
/// exactly the residue that function deletes `rcq.island.*` for - host:port
/// and a date for the account's own island, its backup homes, correspondents'
/// islands and every visited group's island - and a laptop about to be handed
/// over must not carry it.
pub fn clear(app: &AppHandle) -> Result<(), String> {
    ensure_loaded(app);
    {
        let mut s = store().lock().unwrap();
        s.pins.clear();
        if let Some(path) = s.path.clone() {
            // Removed, not written empty: an empty file is still a file that
            // says this device runs RCQ, and persist() would recreate it.
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("cannot remove {}: {e}", path.display())),
            }
            let _ = std::fs::remove_file(path.with_extension("json.part"));
        }
    }
    changed().lock().unwrap().clear();
    Ok(())
}

pub fn forget(app: &AppHandle, host: &str, port: u16) -> Result<(), String> {
    check_host(host, port)?;
    ensure_loaded(app);
    let k = key(host, port);
    {
        let mut s = store().lock().unwrap();
        if s.pins.remove(&k).is_some() {
            persist(&s);
        }
    }
    changed().lock().unwrap().remove(&k);
    Ok(())
}

/// The first-use notice was shown; never again for this island.
pub fn noticed(app: &AppHandle, host: &str, port: u16) -> Result<(), String> {
    check_host(host, port)?;
    ensure_loaded(app);
    let mut s = store().lock().unwrap();
    if let Some(r) = s.pins.get_mut(&key(host, port)) {
        if r.noticed != Some(true) {
            r.noticed = Some(true);
            persist(&s);
        }
    }
    Ok(())
}

// ── The loopback forwarder ─────────────────────────────────────────────────

fn forwarders() -> &'static Mutex<HashMap<String, u16>> {
    static F: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}

static LIVE: AtomicUsize = AtomicUsize::new(0);

/// A listener bridging to `host:port`, armed once per island for the life of
/// the process, and its loopback port. Idempotent: the second call for the
/// same island is a lock and a lookup.
pub async fn open(app: &AppHandle, host: &str, port: u16) -> Result<u16, String> {
    check_host(host, port)?;
    ensure_loaded(app);
    if is_ca_only(host, front(app).as_deref()) {
        // Nothing to forward: the webview verifies these itself, and a
        // forwarder that only ever refuses is a slower way to fail.
        return Err("ca_only".into());
    }
    open_at(host, port).await
}

/// Loopback only, and the OS picks the port, for the reasons the TURN tunnel
/// gives: nothing outside this machine may use us as a door into the tunnel,
/// and a desktop runs whatever else its owner installed.
async fn open_at(host: &str, port: u16) -> Result<u16, String> {
    let k = key(host, port);
    if let Some(p) = forwarders().lock().unwrap().get(&k) {
        return Ok(*p);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let loopback = listener.local_addr().map_err(|e| e.to_string())?.port();
    {
        let mut f = forwarders().lock().unwrap();
        if let Some(p) = f.get(&k) {
            return Ok(*p); // lost a race; this listener drops with the socket
        }
        f.insert(k, loopback);
    }
    log::info!("island forwarder: 127.0.0.1:{loopback} -> {host}:{port}");
    let host = host.to_string();
    tauri::async_runtime::spawn(accept_loop(listener, host, port));
    Ok(loopback)
}

async fn accept_loop(listener: TcpListener, host: String, port: u16) {
    loop {
        let client = match listener.accept().await {
            Ok((c, _)) => c,
            Err(_) => return,
        };
        if LIVE.load(Ordering::Relaxed) >= MAX_BRIDGES {
            continue; // dropped: the page sees a reset, not a hang
        }
        LIVE.fetch_add(1, Ordering::Relaxed);
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = bridge(client, &host, port).await {
                log::warn!("island forwarder {host}:{port}: {e}");
            }
            LIVE.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

/// One accepted loopback connection, bridged to the island over TLS. The rule
/// runs on THIS handshake too, not only on the probe's: a certificate swapped
/// mid-session is refused here, the client side is dropped, and the page's
/// request fails. The page then re-probes to put the refusal on the banner;
/// it never re-sends the request.
async fn bridge(client: TcpStream, host: &str, port: u16) -> std::io::Result<()> {
    let (upstream, _verdict) = handshake(host, port, false, crate::bypass::socks_port()).await;
    let upstream = upstream?;
    let _ = client.set_nodelay(true);
    let (mut cr, mut cw) = client.into_split();
    let (mut sr, mut sw) = tokio::io::split(upstream);
    let mut framer = RequestFramer::new(&authority(host, port));

    let c2s = async {
        let mut buf = [0u8; 16 * 1024];
        loop {
            let n = cr.read(&mut buf).await?;
            if n == 0 {
                let _ = sw.shutdown().await;
                return Ok::<(), std::io::Error>(());
            }
            let out = framer.push(&buf[..n]).map_err(std::io::Error::other)?;
            if !out.is_empty() {
                sw.write_all(&out).await?;
            }
        }
    };
    let s2c = async {
        tokio::io::copy(&mut sr, &mut cw).await?;
        let _ = cw.shutdown().await;
        Ok::<(), std::io::Error>(())
    };
    tokio::pin!(c2s);
    tokio::pin!(s2c);
    // A clean end on one side (EOF, its peer's write half shut) waits for the
    // other, which is how a keep-alive connection winds down. An ERROR on
    // either side takes both down at once: leaving the client half open on a
    // dead upstream would hand the webview a connection that swallows its
    // next request.
    tokio::select! {
        r = &mut c2s => match r {
            Ok(()) => { let _ = s2c.await; }
            Err(e) => return Err(e),
        },
        r = &mut s2c => match r {
            Ok(()) => { let _ = c2s.await; }
            Err(e) => return Err(e),
        },
    }
    Ok(())
}

// ── The request framer ─────────────────────────────────────────────────────

/// Walks HTTP/1.1 requests on the client→island direction so that ONE line
/// can be rewritten: `Host:`, which the webview writes as the loopback
/// address and the island has to see as its own. Bodies pass through untouched
/// and unbuffered (Content-Length or chunked); after a request that asks for
/// `Upgrade: websocket` the rest of the stream is copied raw, frames and all.
/// Nothing else is inspected: the response direction is a plain copy.
pub struct RequestFramer {
    authority: String,
    buf: Vec<u8>,
    state: State,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    Head,
    Body(u64),
    ChunkSize,
    ChunkData(u64),
    Trailer,
    Raw,
}

#[derive(Debug, PartialEq)]
pub enum FrameError {
    HeadTooLong,
    BadHead,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::HeadTooLong => f.write_str("request head too long"),
            FrameError::BadHead => f.write_str("malformed request head"),
        }
    }
}

impl std::error::Error for FrameError {}

enum Framing {
    None,
    Length(u64),
    Chunked,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn header_value_has(value: &str, token: &str) -> bool {
    value.split(',').any(|v| v.trim().eq_ignore_ascii_case(token))
}

/// The head with `Host:` replaced, and what the rule for its body is.
fn rewrite_head(head: &[u8], authority: &str) -> Result<(Vec<u8>, Framing, bool), FrameError> {
    let text = std::str::from_utf8(head).map_err(|_| FrameError::BadHead)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(FrameError::BadHead)?;
    if request_line.is_empty() {
        return Err(FrameError::BadHead);
    }
    let mut out = String::with_capacity(head.len() + authority.len());
    out.push_str(request_line);
    out.push_str("\r\n");
    let mut framing = Framing::None;
    let mut chunked = false;
    let mut upgrade = false;
    let mut saw_host = false;
    for line in lines {
        if line.is_empty() {
            continue; // the blank line that ends the head
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(FrameError::BadHead);
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            if saw_host {
                continue; // a second Host line is a smuggling attempt; drop it
            }
            saw_host = true;
            out.push_str("Host: ");
            out.push_str(authority);
            out.push_str("\r\n");
            continue;
        }
        if name.eq_ignore_ascii_case("transfer-encoding") && header_value_has(value, "chunked") {
            chunked = true;
        } else if name.eq_ignore_ascii_case("content-length") {
            framing = Framing::Length(value.parse().map_err(|_| FrameError::BadHead)?);
        } else if name.eq_ignore_ascii_case("upgrade") && header_value_has(value, "websocket") {
            upgrade = true;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    if !saw_host {
        // Inserted right after the request line, where every client puts it.
        let at = request_line.len() + 2;
        out.insert_str(at, &format!("Host: {authority}\r\n"));
    }
    out.push_str("\r\n");
    // Chunked wins over a Content-Length beside it (RFC 7230 §3.3.3).
    if chunked {
        framing = Framing::Chunked;
    }
    Ok((out.into_bytes(), framing, upgrade))
}

impl RequestFramer {
    pub fn new(authority: &str) -> Self {
        RequestFramer { authority: authority.to_string(), buf: Vec::new(), state: State::Head }
    }

    /// Feed bytes read from the client; get back what to send the island.
    /// Bodies come out as they come in; only a head is held until complete.
    pub fn push(&mut self, input: &[u8]) -> Result<Vec<u8>, FrameError> {
        if self.state == State::Raw {
            return Ok(input.to_vec());
        }
        self.buf.extend_from_slice(input);
        let mut out = Vec::with_capacity(input.len() + 64);
        loop {
            match self.state {
                State::Head => {
                    let Some(end) = find(&self.buf, b"\r\n\r\n") else {
                        if self.buf.len() > MAX_HEAD {
                            return Err(FrameError::HeadTooLong);
                        }
                        break;
                    };
                    let head: Vec<u8> = self.buf.drain(..end + 4).collect();
                    let (rewritten, framing, upgrade) = rewrite_head(&head, &self.authority)?;
                    out.extend_from_slice(&rewritten);
                    self.state = match framing {
                        Framing::None | Framing::Length(0) => State::Head,
                        Framing::Length(n) => State::Body(n),
                        Framing::Chunked => State::ChunkSize,
                    };
                    if upgrade {
                        // From here the bytes are WebSocket frames, whatever
                        // the head said about a body.
                        self.state = State::Raw;
                        out.extend(self.buf.drain(..));
                        break;
                    }
                }
                State::Body(n) | State::ChunkData(n) => {
                    if self.buf.is_empty() {
                        break;
                    }
                    let take = (n.min(self.buf.len() as u64)) as usize;
                    out.extend(self.buf.drain(..take));
                    let left = n - take as u64;
                    self.state = match (self.state, left) {
                        (State::Body(_), 0) => State::Head,
                        (State::Body(_), l) => State::Body(l),
                        (_, 0) => State::ChunkSize,
                        (_, l) => State::ChunkData(l),
                    };
                }
                State::ChunkSize => {
                    let Some(end) = find(&self.buf, b"\r\n") else {
                        if self.buf.len() > MAX_HEAD {
                            return Err(FrameError::HeadTooLong);
                        }
                        break;
                    };
                    let line: Vec<u8> = self.buf.drain(..end + 2).collect();
                    let text = std::str::from_utf8(&line[..end]).map_err(|_| FrameError::BadHead)?;
                    let size_hex = text.split(';').next().unwrap_or("").trim();
                    let size = u64::from_str_radix(size_hex, 16).map_err(|_| FrameError::BadHead)?;
                    out.extend_from_slice(&line);
                    // Data plus the CRLF that ends the chunk.
                    self.state = if size == 0 { State::Trailer } else { State::ChunkData(size + 2) };
                }
                State::Trailer => {
                    if self.buf.starts_with(b"\r\n") {
                        out.extend(self.buf.drain(..2));
                        self.state = State::Head;
                    } else if let Some(end) = find(&self.buf, b"\r\n") {
                        out.extend(self.buf.drain(..end + 2)); // one trailer line
                    } else {
                        if self.buf.len() > MAX_HEAD {
                            return Err(FrameError::HeadTooLong);
                        }
                        break;
                    }
                }
                State::Raw => {
                    out.extend(self.buf.drain(..));
                    break;
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(b: &[u8]) -> String {
        String::from_utf8_lossy(b).into_owned()
    }

    fn typed(fp: &str) -> Record {
        Record::pinned(fp.to_string(), "typed", 1)
    }

    // ── decide (§1), every branch ──

    #[test]
    fn a_ca_only_host_is_accepted_through_the_roots_and_never_recorded() {
        let mut pins = HashMap::new();
        assert_eq!(decide(&mut pins, "api.rcq.app", 443, b"le", true, true, 1), Verdict::Accept);
        assert_eq!(decide(&mut pins, "api.rcq.app", 443, b"x", false, true, 1), Verdict::RefuseCaOnly);
        assert!(pins.is_empty(), "the flagship is never pinned, typed or not");
        // Even a typed record for it changes nothing: the branch comes first.
        pins.insert("api.rcq.app:443".into(), typed(&fingerprint(b"x")));
        assert_eq!(decide(&mut pins, "api.rcq.app", 443, b"x", false, true, 1), Verdict::RefuseCaOnly);
        assert!(is_ca_only("API.RCQ.APP", None));
        assert!(is_ca_only("rcq.app", None));
        assert!(is_ca_only("cdn.rcq.app", None));
        assert!(is_ca_only("edge.northfieldlabs.fyi", Some("edge.northfieldlabs.fyi")));
        assert!(!is_ca_only("notrcq.app", None));
        assert!(!is_ca_only("island.example", Some("edge.northfieldlabs.fyi")));
    }

    #[test]
    fn a_typed_fingerprint_wins_over_an_authority() {
        let mut pins = HashMap::new();
        pins.insert("203.0.113.5:443".into(), typed(&fingerprint(b"mine")));
        // The chain the roots accept is not the identity the person typed.
        let verdict = decide(&mut pins, "203.0.113.5", 443, b"le-for-the-ip", true, false, 2);
        assert_eq!(
            verdict,
            Verdict::RefuseChanged { old: fingerprint(b"mine"), new: fingerprint(b"le-for-the-ip"), ca: true, typed: true }
        );
        assert_eq!(pins["203.0.113.5:443"], typed(&fingerprint(b"mine")), "no ca write over a typed pin");
        // The typed value itself connects, and caValid changes nothing.
        assert_eq!(decide(&mut pins, "203.0.113.5", 443, b"mine", false, false, 3), Verdict::Accept);
        assert_eq!(decide(&mut pins, "203.0.113.5", 443, b"mine", true, false, 3), Verdict::Accept);
        assert_eq!(pins["203.0.113.5:443"], typed(&fingerprint(b"mine")));
        // A private certificate that is not the typed one: changed, not CA.
        let verdict = decide(&mut pins, "203.0.113.5", 443, b"other", false, false, 4);
        assert_eq!(
            verdict,
            Verdict::RefuseChanged { old: fingerprint(b"mine"), new: fingerprint(b"other"), ca: false, typed: true }
        );
    }

    #[test]
    fn a_chain_the_roots_accept_is_recorded_as_ca_and_overwrites_a_tofu_pin() {
        let mut pins = HashMap::new();
        pins.insert("island.test:443".to_string(), Record::pinned("00".repeat(32), "tofu", 1));
        assert_eq!(decide(&mut pins, "Island.TEST", 443, b"leaf", true, false, 5), Verdict::Accept);
        let rec = &pins["island.test:443"];
        assert_eq!(rec.mode, "ca");
        assert_eq!(rec.since, 5);
        assert!(rec.fp.is_none());
        // Written on a null record too - the success branch is where a CA
        // island becomes a known island.
        let mut fresh = HashMap::new();
        assert_eq!(decide(&mut fresh, "island.test", 443, b"leaf", true, false, 6), Verdict::Accept);
        assert_eq!(fresh["island.test:443"].mode, "ca");
        // And not rewritten on every success: the since is the first one.
        assert_eq!(decide(&mut fresh, "island.test", 443, b"leaf2", true, false, 7), Verdict::Accept);
        assert_eq!(fresh["island.test:443"].since, 6);
    }

    #[test]
    fn an_accepted_pin_moves_to_ca_silently_too() {
        let mut pins = HashMap::new();
        pins.insert("island.test:443".to_string(), Record::pinned(fingerprint(b"old"), "accepted", 1));
        assert_eq!(decide(&mut pins, "island.test", 443, b"le", true, false, 2), Verdict::Accept);
        assert_eq!(pins["island.test:443"].mode, "ca");
    }

    #[test]
    fn first_sight_pins_and_says_so_then_matches_quietly() {
        let mut pins = HashMap::new();
        let fp = fingerprint(b"leaf");
        assert_eq!(decide(&mut pins, "203.0.113.5", 443, b"leaf", false, false, 7), Verdict::AcceptFirstUse(fp.clone()));
        let rec = &pins["203.0.113.5:443"];
        assert_eq!(rec.source.as_deref(), Some("tofu"));
        assert_eq!(rec.noticed, Some(false));
        assert_eq!(decide(&mut pins, "203.0.113.5", 443, b"leaf", false, false, 8), Verdict::Accept);
        assert_eq!(pins["203.0.113.5:443"].since, 7, "a match must not rewrite the record");
    }

    #[test]
    fn a_different_leaf_is_refused_with_both_fingerprints_and_writes_nothing() {
        let mut pins = HashMap::new();
        decide(&mut pins, "island.test", 8443, b"one", false, false, 1);
        let verdict = decide(&mut pins, "island.test", 8443, b"two", false, false, 2);
        assert_eq!(
            verdict,
            Verdict::RefuseChanged { old: fingerprint(b"one"), new: fingerprint(b"two"), ca: false, typed: false }
        );
        assert_eq!(pins["island.test:8443"].fp.as_deref(), Some(fingerprint(b"one").as_str()));
    }

    #[test]
    fn a_ca_island_showing_a_private_certificate_is_a_change_not_a_first_use() {
        let mut pins = HashMap::new();
        decide(&mut pins, "island.test", 443, b"le", true, false, 1);
        let verdict = decide(&mut pins, "island.test", 443, b"private", false, false, 2);
        assert_eq!(
            verdict,
            Verdict::RefuseChanged { old: "ca".into(), new: fingerprint(b"private"), ca: false, typed: false }
        );
        assert_eq!(pins["island.test:443"].mode, "ca", "a refusal writes nothing");
    }

    // ── prepin (§3) and accept (§5.2) ──

    #[test]
    fn a_typed_fragment_pins_a_null_record_and_only_a_null_record() {
        let mut pins = HashMap::new();
        let fp = fingerprint(b"mine");
        assert_eq!(prepin(&mut pins, "Island.Test", 8443, &fp, 1), PrePin::Pinned);
        assert_eq!(pins["island.test:8443"], typed(&fp));
        assert_eq!(prepin(&mut pins, "island.test", 8443, &fp, 2), PrePin::Same);
        assert_eq!(pins["island.test:8443"].since, 1, "a no-op does not touch the record");
        let other = fingerprint(b"other");
        assert_eq!(prepin(&mut pins, "island.test", 8443, &other, 3), PrePin::Conflict { old: fp.clone(), typed: true });
        assert_eq!(pins["island.test:8443"], typed(&fp), "a conflict writes nothing");
        // Against a CA record the banner says "a certificate authority".
        pins.insert("ca.test:443".into(), Record::ca(1));
        assert_eq!(prepin(&mut pins, "ca.test", 443, &fp, 4), PrePin::Conflict { old: "ca".into(), typed: false });
        assert_eq!(pins["ca.test:443"].mode, "ca");
        // Against a tofu pin the same, and the banner does not call it typed.
        pins.insert("tofu.test:443".into(), Record::pinned(other.clone(), "tofu", 1));
        assert_eq!(prepin(&mut pins, "tofu.test", 443, &fp, 5), PrePin::Conflict { old: other, typed: false });
    }

    #[test]
    fn accepting_records_the_authority_when_the_refused_chain_was_ca_valid() {
        let fp = fingerprint(b"le");
        let moved = Changed { old: fingerprint(b"mine"), new: fp.clone(), ca: true, typed: true, entered: false };
        assert_eq!(accept_record(Some(&moved), &fp, "accepted", 9), Record::ca(9));
        // A private certificate accepted from the banner is pinned as accepted.
        let swapped = Changed { old: fingerprint(b"one"), new: fp.clone(), ca: false, typed: false, entered: false };
        assert_eq!(accept_record(Some(&swapped), &fp, "accepted", 9), Record::pinned(fp.clone(), "accepted", 9));
        // A value the person typed and the store disagreed with stays typed.
        let entered = Changed { old: "ca".into(), new: fp.clone(), ca: false, typed: false, entered: true };
        assert_eq!(accept_record(Some(&entered), &fp, "accepted", 9), Record::pinned(fp.clone(), "typed", 9));
        // A refusal about some OTHER value says nothing about this one.
        let stale = Changed { old: "ca".into(), new: fingerprint(b"x"), ca: true, typed: false, entered: false };
        assert_eq!(accept_record(Some(&stale), &fp, "typed", 9), Record::pinned(fp.clone(), "typed", 9));
        assert_eq!(accept_record(None, &fp, "accepted", 9).noticed, Some(true), "looked at, so no notice owed");
    }

    // ── the small helpers ──

    #[test]
    fn the_key_is_lowercase_host_and_port_with_ipv6_brackets_kept() {
        assert_eq!(key("Island.Example", 443), "island.example:443");
        assert_eq!(key("[::1]", 8443), "[::1]:8443");
    }

    #[test]
    fn an_authority_splits_the_way_the_store_keys_it() {
        assert_eq!(split_authority("island.example"), Some(("island.example".into(), 443)));
        assert_eq!(split_authority("127.0.0.1:8443"), Some(("127.0.0.1".into(), 8443)));
        assert_eq!(split_authority("[::1]:8443"), Some(("[::1]".into(), 8443)));
        assert_eq!(split_authority("[::1]"), Some(("[::1]".into(), 443)));
        assert_eq!(split_authority("::1"), None);
        assert_eq!(split_authority("host:notaport"), None);
        assert_eq!(split_authority(""), None);
    }

    #[test]
    fn openssl_form_parses_to_canonical() {
        let canon = "ab".repeat(32);
        let openssl = canon
            .as_bytes()
            .chunks(2)
            .map(|c| String::from_utf8_lossy(c).to_uppercase())
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(parse_fingerprint(&openssl).as_deref(), Some(canon.as_str()));
        assert_eq!(parse_fingerprint(&format!(" {} ", canon)).as_deref(), Some(canon.as_str()));
        assert_eq!(parse_fingerprint("abcd"), None);
        assert_eq!(parse_fingerprint(&"zz".repeat(32)), None);
    }

    #[test]
    fn the_fingerprint_is_sha256_of_the_der() {
        // sha256("") is a known constant; the DER here is just bytes.
        assert_eq!(fingerprint(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    // ── framer ──

    #[test]
    fn pipelined_requests_each_get_their_host_rewritten() {
        let mut f = RequestFramer::new("island.example:8443");
        let input = b"GET /a HTTP/1.1\r\nHost: 127.0.0.1:5555\r\nAccept: */*\r\n\r\nGET /b HTTP/1.1\r\nhost: 127.0.0.1:5555\r\n\r\n";
        let out = f.push(input).unwrap();
        assert_eq!(
            s(&out),
            "GET /a HTTP/1.1\r\nHost: island.example:8443\r\nAccept: */*\r\n\r\nGET /b HTTP/1.1\r\nHost: island.example:8443\r\n\r\n"
        );
        assert!(f.buf.is_empty());
    }

    #[test]
    fn a_head_arriving_byte_by_byte_is_held_until_complete() {
        let mut f = RequestFramer::new("island.example");
        let input = b"GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n";
        let mut out = Vec::new();
        for b in input.iter() {
            out.extend(f.push(std::slice::from_ref(b)).unwrap());
        }
        assert_eq!(s(&out), "GET / HTTP/1.1\r\nHost: island.example\r\n\r\n");
    }

    #[test]
    fn a_content_length_body_passes_through_split_across_pushes() {
        let mut f = RequestFramer::new("island.example");
        let head = b"POST /x HTTP/1.1\r\nHost: 127.0.0.1:1\r\nContent-Length: 10\r\n\r\n0123";
        let mut out = f.push(head).unwrap();
        assert_eq!(s(&out), "POST /x HTTP/1.1\r\nHost: island.example\r\nContent-Length: 10\r\n\r\n0123");
        // The rest of the body and the next request's head in one push: the
        // body bytes must not be mistaken for a head, and the head after them
        // must be rewritten.
        out = f.push(b"456789GET /y HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n").unwrap();
        assert_eq!(s(&out), "456789GET /y HTTP/1.1\r\nHost: island.example\r\n\r\n");
        assert_eq!(f.state, State::Head);
    }

    #[test]
    fn a_chunked_body_with_extension_and_trailer_passes_through() {
        let mut f = RequestFramer::new("island.example");
        let input = b"POST /c HTTP/1.1\r\nHost: 127.0.0.1:1\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Sum: 1\r\n\r\nGET /after HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n";
        let mut out = Vec::new();
        // Fed in odd pieces so every state boundary is crossed mid-push.
        for piece in input.chunks(7) {
            out.extend(f.push(piece).unwrap());
        }
        assert_eq!(
            s(&out),
            "POST /c HTTP/1.1\r\nHost: island.example\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Sum: 1\r\n\r\nGET /after HTTP/1.1\r\nHost: island.example\r\n\r\n"
        );
        assert_eq!(f.state, State::Head);
    }

    #[test]
    fn after_a_websocket_upgrade_the_stream_is_copied_raw() {
        let mut f = RequestFramer::new("island.example");
        let input = b"GET /ws/1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\n\r\n\x81\x05hello";
        let out = f.push(input).unwrap();
        let mut want = b"GET /ws/1 HTTP/1.1\r\nHost: island.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\n\r\n".to_vec();
        want.extend_from_slice(b"\x81\x05hello");
        assert_eq!(out, want);
        // Frames that would parse as a request head are NOT touched now.
        let frames = b"\x81\x20GET / HTTP/1.1\r\nHost: evil\r\n\r\n";
        assert_eq!(f.push(frames).unwrap(), frames.to_vec());
        assert_eq!(f.state, State::Raw);
    }

    #[test]
    fn a_missing_host_is_added_and_a_second_one_is_dropped() {
        let mut f = RequestFramer::new("island.example");
        let out = f.push(b"GET / HTTP/1.1\r\nAccept: */*\r\n\r\n").unwrap();
        assert_eq!(s(&out), "GET / HTTP/1.1\r\nHost: island.example\r\nAccept: */*\r\n\r\n");
        let out = f.push(b"GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n").unwrap();
        assert_eq!(s(&out), "GET / HTTP/1.1\r\nHost: island.example\r\n\r\n");
    }

    #[test]
    fn a_runaway_head_is_an_error_not_a_buffer() {
        let mut f = RequestFramer::new("island.example");
        let junk = vec![b'a'; MAX_HEAD + 1];
        assert_eq!(f.push(&junk), Err(FrameError::HeadTooLong));
    }

    #[test]
    fn the_authority_drops_a_default_port() {
        assert_eq!(authority("island.example", 443), "island.example");
        assert_eq!(authority("island.example", 8443), "island.example:8443");
        assert_eq!(authority("[::1]", 8443), "[::1]:8443");
        assert_eq!(bare("[::1]"), "::1");
    }

    // ── against a live island (§11) ──
    //
    // Ignored by default: they need the fingerprint island running and, for
    // the second, the flagship. `RCQ_TEST_ISLAND=127.0.0.1:8443
    // RCQ_TEST_ISLAND_FP=<64 hex> cargo test -- --ignored`. The store goes to
    // a scratch directory; the real one is never touched.

    fn live_island() -> Option<(String, u16)> {
        std::env::var("RCQ_TEST_ISLAND").ok().and_then(|a| split_authority(&a))
    }

    fn scratch_store() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rcq-island-trust-test-{}", std::process::id()));
        init_store_at(dir.clone());
        dir
    }

    #[test]
    #[ignore]
    fn the_forwarder_pins_a_live_island_on_first_use_and_carries_a_request() {
        let Some((host, port)) = live_island() else { return };
        let dir = scratch_store();
        let k = key(&host, port);
        // A scratch store that already knows this island (a previous run)
        // would make this a match, not a first use.
        store().lock().unwrap().pins.remove(&k);

        let reply = tauri::async_runtime::block_on(async {
            let loopback = open_at(&host, port).await.expect("forwarder");
            let mut c = TcpStream::connect(("127.0.0.1", loopback)).await.expect("loopback");
            // The Host line names loopback, as the webview would write it.
            let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{loopback}\r\nConnection: close\r\n\r\n");
            c.write_all(req.as_bytes()).await.unwrap();
            let mut out = Vec::new();
            tokio::time::timeout(Duration::from_secs(20), c.read_to_end(&mut out)).await.expect("a reply").unwrap();
            String::from_utf8_lossy(&out).into_owned()
        });
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.contains("\"ok\":true"), "{reply}");

        let rec = store().lock().unwrap().pins.get(&k).cloned().expect("a first use pins");
        assert_eq!(rec.mode, "pinned");
        assert_eq!(rec.source.as_deref(), Some("tofu"));
        assert_eq!(rec.noticed, Some(false), "the notice is still owed");
        if let Ok(want) = std::env::var("RCQ_TEST_ISLAND_FP") {
            assert_eq!(rec.fp, parse_fingerprint(&want), "the pin is the SHA-256 openssl prints for the leaf");
        }
        let saved: PinFile = serde_json::from_str(&std::fs::read_to_string(dir.join(FILE)).unwrap()).unwrap();
        assert_eq!(saved.pins.get(&k), Some(&rec), "and it is on disk");

        // The next handshake is a match, quietly.
        let again = tauri::async_runtime::block_on(probe_at(&host, port, false, None));
        assert_eq!(again.state, "pinned");
        assert_eq!(again.fingerprint, rec.fp);
        assert_eq!(again.noticed, Some(false));
        assert!(changed().lock().unwrap().get(&k).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What the bypass probes really ask. A handshake that completes says
    /// nothing about the road: this is the half that catches a middlebox
    /// which finishes the TLS and resets the stream.
    #[test]
    #[ignore]
    fn the_probe_asks_the_island_a_question_over_the_connection_the_rule_took() {
        let Some((host, port)) = live_island() else { return };
        scratch_store();
        let answered = tauri::async_runtime::block_on(async {
            let (result, verdict) = handshake(&host, port, false, None).await;
            assert!(matches!(verdict, Some(Verdict::Accept) | Some(Verdict::AcceptFirstUse(_))), "{verdict:?}");
            let mut tls = result.expect("a live island");
            health(&mut tls, &host, port).await
        });
        assert!(answered, "the island answers /health on the connection the rule accepted");
    }

    #[test]
    #[ignore]
    fn the_flagship_validates_through_the_roots_and_is_never_pinned() {
        if live_island().is_none() {
            return;
        }
        scratch_store();
        let p = tauri::async_runtime::block_on(probe_at("api.rcq.app", 443, true, None));
        assert_eq!(p.state, "ca", "chain and name both, for the name that was dialled");
        assert!(store().lock().unwrap().pins.get("api.rcq.app:443").is_none());
    }
}
