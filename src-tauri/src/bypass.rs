// Circumvention on the desktop: a bundled sing-box runs as a sidecar and
// exposes a local SOCKS proxy, and the webview is created pointing at it.
//
// The webview proxy can only be set when the webview is built — wry has no
// runtime API for it — so the on/off flag lives here in Rust rather than in
// the page's localStorage, which does not exist yet at the moment we have to
// decide. Flipping the toggle therefore restarts the app.

use crate::relay::{self, Relay, RelayConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const STATE_FILE: &str = "bypass.json";
/// Where the startup probe knocks on a first-ever launch, before the front has
/// ever told us which island this install talks to.
const DEFAULT_ISLAND: &str = "api.rcq.app";
const CONFIG_FILE: &str = "sing-box.json";
const LOG_FILE: &str = "sing-box.log";

// How long to wait for the core to accept connections before giving up and
// starting without it. Long enough for a cold start, short enough that a
// broken core doesn't look like a hung app.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(12);

static CORE: Mutex<Option<CommandChild>> = Mutex::new(None);

// What the flag said when the window was built. Lets the settings screen tell
// "you flipped this and haven't restarted yet" apart from "we tried to start
// the core and it didn't come up", which read identically otherwise.
static TRIED_AT_STARTUP: AtomicBool = AtomicBool::new(false);

// The port the core listens on this session, 0 when it isn't up. Needed after
// startup so the diagnostics can probe through the same route the webview uses.
static PORT: AtomicU16 = AtomicU16::new(0);

#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    /// What the user asked for. Survives restarts and always wins.
    enabled: bool,
    /// This session's tunnel was turned on by the startup probe, not by the
    /// user. Kept so the UI can say so, and so it can be dropped again the
    /// moment the network recovers instead of quietly staying on forever.
    #[serde(default)]
    auto: bool,
    /// The user switched an AUTO-engaged tunnel off. Their opt-out has to
    /// outlive the session, or the next launch would helpfully turn it back on
    /// and we would be arguing with them once a day. The explicit toggle is
    /// unaffected.
    #[serde(default)]
    auto_disabled: bool,
    /// Last island the front talked to. Rust never learns it otherwise: the
    /// only place the host crosses the boundary is `network_diagnostics`, and
    /// the startup probe happens long before the window exists. Falls back to
    /// the flagship for a first-ever launch.
    #[serde(default)]
    host: Option<String>,
}

/// What the settings screen needs to draw the toggle.
#[derive(Serialize)]
pub struct Status {
    /// Whether this build can actually route the webview through a proxy.
    /// False on a macOS build without the `mac-bypass` feature, where
    /// `proxy_url` compiles but wry silently ignores it.
    pub supported: bool,
    /// What the user asked for, which survives a restart.
    pub enabled: bool,
    /// Whether the core is up in THIS session. Differs from `enabled` right
    /// after the toggle is flipped, and when the core failed to start.
    pub running: bool,
    /// Whether this session tried to bring the core up. With `running` false
    /// this means it failed; without it, the user has simply not restarted yet.
    pub tried_at_startup: bool,
    /// Version of the signed relay list in use, null when we are on the
    /// bundled copy and have never verified a fetched one.
    pub relay_config_version: Option<i64>,
    pub relay_count: usize,
    /// The tunnel came up because the island was unreachable directly, not
    /// because the user asked. Lets the UI explain itself rather than looking
    /// like it flipped its own switch.
    pub auto: bool,
}

pub const fn supported() -> bool {
    cfg!(any(not(target_os = "macos"), feature = "mac-bypass"))
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(STATE_FILE))
}

fn load(app: &AppHandle) -> Persisted {
    state_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Persisted>(&t).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, state: &Persisted) -> Result<(), String> {
    let path = state_path(app).ok_or("no config directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string(state).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

pub fn is_enabled(app: &AppHandle) -> bool {
    supported() && load(app).enabled
}

/// True when the tunnel currently up was raised by the startup probe.
pub fn is_auto(app: &AppHandle) -> bool {
    load(app).auto
}

/// Read-modify-write, unlike the original which rebuilt the whole record from
/// one field and would have silently erased everything added beside it.
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let mut state = load(app);
    // Switching OFF a tunnel this app turned on itself is an opt-out, and it
    // has to stick: otherwise the next launch probes, finds the island still
    // unreachable, and turns it straight back on.
    if !enabled && state.auto {
        state.auto_disabled = true;
    }
    if enabled {
        state.auto_disabled = false;
    }
    state.enabled = enabled;
    state.auto = false;
    save(app, &state)
}

/// Remember which island the front is talking to, so the next launch can probe
/// the right host before any window exists.
pub fn remember_host(app: &AppHandle, host: &str) {
    let mut state = load(app);
    if state.host.as_deref() == Some(host) {
        return;
    }
    state.host = Some(host.to_string());
    let _ = save(app, &state);
}

/// The desktop equivalent of the phones' auto-engage: when the user has not
/// asked for the tunnel, probe the island once and raise it if the network is
/// blocking us. Returns the SOCKS port when it did.
///
/// Until now the desktop had none of this. sing-box only ever started from the
/// manual toggle, and only on the NEXT launch, so a blocked user had to know
/// the feature existed, find it in settings, and restart the app — through a
/// connection that was already broken.
///
/// ⚠ This runs BEFORE the window is built, because wry can only attach a proxy
/// while the webview is being created. Every second spent here is a second of
/// blank screen, so the probe gets one short attempt, not the three long ones
/// the diagnostics screen can afford.
pub fn auto_engage_if_blocked(app: &AppHandle) -> Option<u16> {
    if !supported() {
        return None;
    }
    let state = load(app);
    if state.enabled || state.auto_disabled {
        return None;
    }
    let host = state.host.clone().unwrap_or_else(|| DEFAULT_ISLAND.to_string());
    if probe_once(&host, Duration::from_secs(3)) {
        // Reachable directly: make sure a previously auto-raised tunnel does
        // not linger into a session that does not need it.
        if state.auto {
            let mut next = state;
            next.auto = false;
            let _ = save(app, &next);
        }
        return None;
    }
    log::warn!("island {host} unreachable directly — engaging the tunnel automatically");
    let port = start(app)?;
    let mut next = load(app);
    next.auto = true;
    let _ = save(app, &next);
    Some(port)
}

/// Start the core and return the local SOCKS port it listens on.
///
/// Returns None if anything goes wrong — a missing sidecar, an unusable relay
/// list, a core that never comes up. The caller then builds the window with no
/// proxy: a direct connection is worse for a censored user than a tunnelled
/// one, but far better than a window that never appears.
pub fn start(app: &AppHandle) -> Option<u16> {
    TRIED_AT_STARTUP.store(true, Ordering::Relaxed);
    let cache_dir = app.path().app_config_dir().ok()?;
    let config = relay::load(&cache_dir)?;
    let port = free_port()?;

    let config_path = cache_dir.join(CONFIG_FILE);
    std::fs::create_dir_all(&cache_dir).ok()?;
    // Signed pool first, then whatever the user pasted by hand. Merged at the
    // call site rather than inside write_config, which is under a test that
    // pins one outbound per relay.
    let pool = crate::user_relay::merge(&config.relays, &crate::user_relay::list(app));
    write_config(&config_path, &pool, port, &cache_dir.join(LOG_FILE)).ok()?;

    let command = app
        .shell()
        .sidecar("sing-box")
        .map_err(|e| log::error!("sing-box sidecar missing: {e}"))
        .ok()?
        .args(["run", "-c", &config_path.to_string_lossy()]);

    let (_rx, child) = command
        .spawn()
        .map_err(|e| log::error!("sing-box failed to spawn: {e}"))
        .ok()?;
    *CORE.lock().unwrap() = Some(child);

    if !wait_for_port(port) {
        log::error!("sing-box did not accept connections within {STARTUP_TIMEOUT:?}");
        stop();
        return None;
    }
    PORT.store(port, Ordering::Relaxed);
    log::info!("bypass up on 127.0.0.1:{port}, {} relays", config.relays.len());
    Some(port)
}

pub fn stop() {
    PORT.store(0, Ordering::Relaxed);
    if let Some(child) = CORE.lock().unwrap().take() {
        let _ = child.kill();
    }
}

fn proxy_url() -> Option<String> {
    match PORT.load(Ordering::Relaxed) {
        0 => None,
        port => Some(format!("socks5h://127.0.0.1:{port}")),
    }
}

pub fn is_running() -> bool {
    CORE.lock().unwrap().is_some()
}

pub fn tried_at_startup() -> bool {
    TRIED_AT_STARTUP.load(Ordering::Relaxed)
}

/// Refresh the signed relay list for the NEXT launch, through the tunnel when
/// it is up. Deliberately not applied to the running core: rebuilding the
/// tunnel underneath a live session would drop the socket for no gain, and the
/// list only decides which relays we race at startup.
pub fn refresh_relays_in_background(app: &AppHandle, proxy_port: Option<u16>) {
    let Ok(cache_dir) = app.path().app_config_dir() else { return };
    std::thread::spawn(move || {
        let proxy = proxy_port.map(|p| format!("socks5h://127.0.0.1:{p}"));
        match relay::refresh(&cache_dir, proxy.as_deref()) {
            Some(config) => log::info!(
                "relay list refreshed to v{:?}, {} relays",
                config.version,
                config.relays.len()
            ),
            None => log::info!("relay list refresh found nothing new to trust"),
        }
    });
}

/// The relay list as it stands, for the status the settings screen shows.
pub fn current_config(app: &AppHandle) -> Option<RelayConfig> {
    let cache_dir = app.path().app_config_dir().ok()?;
    relay::load(&cache_dir)
}

/// What the diagnostics screen reports, mirroring the phones' connection
/// diagnostics: is the island reachable at all, and is it reachable the way we
/// are currently routing? Those two answers together say whether the network
/// is blocking us and whether the relay is doing its job.
#[derive(Default, Serialize)]
pub struct Diagnostics {
    /// Whether traffic is going through a relay right now.
    pub tunnel: bool,
    /// The island answered a request that deliberately ignored the tunnel.
    pub direct_ok: bool,
    /// The island answered over the route the app is actually using.
    pub route_ok: bool,
    pub relay_count: usize,
    pub relay_config_version: Option<i64>,
}

/// Probe both paths. Blocking on purpose: the caller runs it off the UI thread,
/// and each probe has to actually wait out a censored network to be worth
/// anything.
pub fn diagnostics(app: &AppHandle, host: &str) -> Diagnostics {
    let config = current_config(app);
    Diagnostics {
        tunnel: is_running(),
        direct_ok: probe(host, None),
        route_ok: probe(host, proxy_url().as_deref()),
        relay_count: config.as_ref().map(|c| c.relays.len()).unwrap_or(0),
        relay_config_version: config.and_then(|c| c.version),
    }
}

// Three attempts before calling a network blocked. A cold first connection can
// blow the budget on DNS plus a TLS handshake without anything censoring it,
// and on the phones a single-shot probe misreading that was exactly the
// "bypass turns itself on when it shouldn't" report. Real DPI keeps timing out.
/// One attempt, short budget — for the startup path, where the cost of waiting
/// is a blank window rather than a slower diagnostics screen.
fn probe_once(host: &str, budget: Duration) -> bool {
    let Ok(client) = reqwest::blocking::Client::builder()
        .timeout(budget)
        .no_proxy()
        .build()
    else {
        return false;
    };
    client
        .get(format!("https://{host}/health"))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn probe(host: &str, proxy: Option<&str>) -> bool {
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .danger_accept_invalid_certs(false);
    if let Some(url) = proxy {
        match reqwest::Proxy::all(url) {
            Ok(p) => builder = builder.proxy(p),
            Err(e) => log::error!("bad proxy url for probe: {e}"),
        }
    } else {
        builder = builder.no_proxy();
    }
    let Ok(client) = builder.build() else { return false };
    let url = format!("https://{host}/health");
    (0..3).any(|_| {
        client
            .get(&url)
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    })
}

// Ask the OS for a free port by binding and immediately dropping. Something
// else could take it in the gap, which is why a failed start is handled rather
// than assumed away. A fixed port would collide far more often: unlike a
// phone, a desktop runs whatever else the user has installed.
fn free_port() -> Option<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

fn wait_for_port(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// A local mixed inbound plus one outbound per relay behind a `urltest` that
/// races them against /health and keeps the fastest. Same shape the phone
/// clients build, minus the onion and local-proxy modes.
///
/// There is deliberately no `direct` outbound: with the tunnel on, a relay
/// pool that is entirely unreachable must fail loudly rather than quietly
/// carry the user's traffic in the clear.
fn write_config(path: &Path, relays: &[Relay], port: u16, log_path: &Path) -> std::io::Result<()> {
    let mut outbounds: Vec<Value> = vec![json!({
        "type": "urltest",
        "tag": "out",
        "outbounds": relays.iter().map(|r| r.tag.clone()).collect::<Vec<_>>(),
        "url": "https://api.rcq.app/health",
        "interval": "5m",
        "tolerance": 50,
    })];
    outbounds.extend(relays.iter().map(|r| {
        if r.proto == "hysteria2" {
            hysteria2_outbound(r)
        } else {
            vless_outbound(r)
        }
    }));

    // `warn` on purpose: it records why a relay failed, which is what anyone
    // debugging a blocked user needs, without writing a line per connection —
    // a list of every host they talked to is not something a messenger should
    // leave on disk.
    let config = json!({
        "log": { "level": "warn", "output": log_path.to_string_lossy(), "timestamp": true },
        "inbounds": [{
            "type": "mixed",
            "tag": "in",
            "listen": "127.0.0.1",
            "listen_port": port,
        }],
        "outbounds": outbounds,
    });

    let mut file = std::fs::File::create(path)?;
    file.write_all(config.to_string().as_bytes())
}

fn vless_outbound(r: &Relay) -> Value {
    json!({
        "type": "vless",
        "tag": r.tag,
        "server": r.server,
        "server_port": r.port,
        "uuid": r.uuid.clone().unwrap_or_default(),
        "flow": r.flow.clone().unwrap_or_else(|| "xtls-rprx-vision".into()),
        "tls": {
            "enabled": true,
            "server_name": r.sni,
            "utls": { "enabled": true, "fingerprint": "chrome" },
            "reality": {
                "enabled": true,
                "public_key": r.public_key.clone().unwrap_or_default(),
                "short_id": r.short_id.clone().unwrap_or_default(),
            },
        },
    })
}

// UDP + Salamander obfs, so DPI cannot fingerprint the QUIC handshake.
// insecure=true because the relay holds a self-signed cert: authentication is
// the password pair, not PKI.
fn hysteria2_outbound(r: &Relay) -> Value {
    let mut out = json!({
        "type": "hysteria2",
        "tag": r.tag,
        "server": r.server,
        "server_port": r.port,
        "password": r.password.clone().unwrap_or_default(),
        "tls": { "enabled": true, "server_name": r.sni, "insecure": true },
    });
    if let Some(obfs) = r.obfs_password.as_deref().filter(|p| !p.is_empty()) {
        out["obfs"] = json!({ "type": "salamander", "password": obfs });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relays() -> Vec<Relay> {
        relay::verify_and_parse(include_str!("../relay-config.json"), None)
            .unwrap()
            .relays
    }

    #[test]
    fn config_races_every_relay_and_offers_no_way_around_them() {
        let dir = std::env::temp_dir().join("rcq-bypass-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sing-box.json");
        let relays = relays();
        write_config(&path, &relays, 1080, &dir.join("sing-box.log")).unwrap();

        let config: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let outbounds = config["outbounds"].as_array().unwrap();

        assert_eq!(outbounds[0]["type"], "urltest");
        assert_eq!(outbounds[0]["tag"], "out");
        assert_eq!(
            outbounds[0]["outbounds"].as_array().unwrap().len(),
            relays.len(),
            "urltest must race every relay"
        );
        assert_eq!(outbounds.len(), relays.len() + 1);
        assert!(
            !outbounds.iter().any(|o| o["type"] == "direct"),
            "a direct outbound would leak around the tunnel"
        );
        assert_eq!(config["inbounds"][0]["listen"], "127.0.0.1");
        assert_eq!(config["inbounds"][0]["listen_port"], 1080);
    }

    #[test]
    fn each_protocol_gets_the_outbound_it_needs() {
        let relays = relays();
        for r in &relays {
            let out = if r.proto == "hysteria2" {
                hysteria2_outbound(r)
            } else {
                vless_outbound(r)
            };
            assert_eq!(out["tag"], r.tag.as_str());
            assert_eq!(out["server"], r.server.as_str());
            assert_eq!(out["tls"]["server_name"], r.sni.as_str());
            if r.proto == "hysteria2" {
                assert_eq!(out["type"], "hysteria2");
                assert_eq!(out["tls"]["insecure"], true);
                if r.obfs_password.is_some() {
                    assert_eq!(out["obfs"]["type"], "salamander");
                }
            } else {
                assert_eq!(out["type"], "vless");
                assert_eq!(out["tls"]["reality"]["enabled"], true);
                assert_eq!(out["tls"]["utls"]["fingerprint"], "chrome");
            }
        }
    }

    #[test]
    fn a_free_port_is_actually_free() {
        let port = free_port().unwrap();
        assert!(port > 0);
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
    }
}
