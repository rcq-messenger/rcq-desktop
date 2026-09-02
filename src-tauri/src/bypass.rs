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
/// What the relay selector races each relay against, until a signed payload
/// names something else. Compiled in so a client with no fetched list still
/// has a way to tell a working relay from a dead one.
const DEFAULT_PROBE: &str = "https://api.rcq.app/health";
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
    /// The onion ENTRY this install is pinned to, by relay tag.
    ///
    /// Pinned rather than re-raced each launch, for the reason Tor pins guards:
    /// a client that picks a fresh first hop every time eventually picks a
    /// hostile one, and the more often it re-picks the sooner that happens.
    #[serde(default)]
    onion_entry: Option<String>,
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
    /// Bare hostname of the CF front, when the signed list names one. Handed to
    /// the page because the front is the ONE circumvention layer this platform
    /// can apply to a window already open (the proxy cannot be: wry fixes it
    /// when the webview is built), so the page owns it, not Rust.
    pub relay_front: Option<String>,
    /// The tunnel came up because the island was unreachable directly, not
    /// because the user asked. Lets the UI explain itself rather than looking
    /// like it flipped its own switch.
    pub auto: bool,
    /// The island stopped answering while the app was running and the tunnel was
    /// raised for it — but a webview's proxy is fixed at creation, so nothing
    /// changes until relaunch. The UI has to say so; silently running a tunnel
    /// the page does not use would look exactly like the app being broken.
    pub needs_relaunch: bool,
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
    if probe_once(app, &host, Duration::from_secs(3)) {
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
/// Set once the runtime watcher has raised the tunnel mid-session.
static NEEDS_RELAUNCH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn needs_relaunch() -> bool {
    NEEDS_RELAUNCH.load(std::sync::atomic::Ordering::Relaxed)
}

/// Watch the island while the app runs, and raise the tunnel if it goes away.
///
/// The phones re-walk their whole route ladder on the fly. The desktop cannot:
/// wry fixes a webview's proxy when the webview is created and offers no way to
/// change it afterwards, so the page keeps talking directly no matter what we
/// start underneath it. Until this, the startup probe was the only one there
/// was — a network that began blocking while the window was open went unnoticed
/// until the user restarted, which is the moment they were least likely to
/// suspect a setting.
///
/// So this does the half that is possible: notice, bring the core up so it is
/// ready, and flag that a relaunch will finish the job. Raising the tunnel
/// without saying that would be worse than doing nothing — a tunnel the page
/// does not use looks identical to an app that is simply broken.
///
/// Deliberately unhurried. Three consecutive failures a minute apart before
/// acting, so a suspended laptop or one dropped request cannot flip it, and the
/// watch ends once there is nothing left to decide.
pub fn watch(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut consecutive_failures = 0u8;
        loop {
            std::thread::sleep(Duration::from_secs(60));

            let state = load(&handle);
            // Already tunnelled, or told not to: nothing to decide.
            if is_running() || state.auto_disabled || state.enabled {
                continue;
            }
            let Some(host) = state.host.clone() else { continue };

            if probe_once(&handle, &host, Duration::from_secs(5)) {
                consecutive_failures = 0;
                continue;
            }
            consecutive_failures += 1;
            if consecutive_failures < 3 {
                continue;
            }

            log::warn!("island {host} stopped answering — raising the tunnel for the next launch");
            if start(&handle).is_some() {
                let mut next = load(&handle);
                next.auto = true;
                let _ = save(&handle, &next);
                NEEDS_RELAUNCH.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            // Either it came up and a relaunch is what remains, or it could not
            // and probing again this session changes nothing.
            return;
        }
    });
}

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
    // The account's own paid endpoints lead, then the signed pool, then whatever
    // was pasted by hand. Merged at the call site rather than inside
    // write_config, which is under a test that pins one outbound per relay.
    let paid = crate::broker::relays(app);
    let mut curated = paid.clone();
    curated.extend(config.relays.iter().cloned());
    let pool = crate::user_relay::merge(&curated, &crate::user_relay::list(app));

    // Onion is a property of the signed payload, not a local toggle, so this
    // client obeys the same cohort flip the phones do. A pasted relay is never
    // an entry: an entry learns the client's address, and only the curated pool
    // (ours, or the customer's own) has been vetted for that.
    let entry = config.onion.then(|| pick_entry(app, &curated)).flatten();
    if config.onion && entry.is_none() {
        log::info!("onion asked for but no entry answered — single hop this session");
    }
    write_config(
        &config_path,
        &pool,
        port,
        &cache_dir.join(LOG_FILE),
        config.probe.as_deref(),
        entry.as_ref(),
    )
    .ok()?;

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
    // The TURN tunnel bridges into this core; a listener that outlived it
    // would hand WebRTC a road to nowhere.
    crate::turn_tunnel::reset();
    if let Some(child) = CORE.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Route an outbound fetch through our own tunnel when it is up. A blocked user
/// cannot reach the broker directly — which is precisely the user most likely to
/// be pasting a paid key — so without this the key would only ever verify for
/// people who did not need it.
pub fn proxy_for_fetch() -> Option<String> {
    proxy_url()
}

fn proxy_url() -> Option<String> {
    socks_port().map(|port| format!("socks5h://127.0.0.1:{port}"))
}

/// The SOCKS inbound the core listens on this session, for anything else that
/// has to travel the same road. The TURN tunnel reads it per call rather than
/// caching it, so the answer follows stop() and start() around.
pub fn socks_port() -> Option<u16> {
    match PORT.load(Ordering::Relaxed) {
        0 => None,
        port => Some(port),
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
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let proxy = proxy_port.map(|p| format!("socks5h://127.0.0.1:{p}"));
        crate::broker::refresh(&app_handle, proxy.as_deref());
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
        direct_ok: probe(app, host, None),
        route_ok: probe(app, host, proxy_url().as_deref()),
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
fn probe_once(app: &AppHandle, host: &str, budget: Duration) -> bool {
    // An island that is not the flagship is asked under the trust rule, not by
    // a plain HTTP client that knows nothing of pins: a fingerprint island
    // fails every CA check and would have raised the tunnel at every launch,
    // and a REFUSED certificate is an island that answered - no tunnel helps
    // that, and raising one would make the banner and the shield fight (§5.5
    // of the fingerprint design). It is the same /health question this asks
    // below, over a connection the rule accepted, so the answer is still
    // "the island answered a request" and not "the handshake finished".
    if let Some(answer) = crate::island_trust::reachability(app, host, None, budget) {
        return answer != crate::island_trust::Reachability::Unreachable;
    }
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

fn probe(app: &AppHandle, host: &str, proxy: Option<&str>) -> bool {
    // Same as probe_once: the trust rule answers for any island but the
    // flagship - with a request of its own, over the tunnel when the route
    // being checked is the tunnel, so `route_ok` means the route carried
    // something and not merely that a handshake completed on it.
    let socks = proxy.and(socks_port());
    if let Some(answer) = crate::island_trust::reachability(app, host, socks, Duration::from_secs(15)) {
        return answer != crate::island_trust::Reachability::Unreachable;
    }
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
/// Choose the onion ENTRY: the account's own node if it has one, else the
/// pinned guard, else the highest-priority curated relay. Returns None when
/// nothing answers, which drops this session to a single hop rather than
/// building a chain onto a dead first hop.
///
/// The paid node leads because the entry is the ONLY relay address the client's
/// network operator ever sees, and every public entry is listed in a config that
/// downloads in one unauthenticated request. A private endpoint is in no such
/// list, so it outlives a blocklist built from that config. That is what the
/// money buys, and it buys nothing at any other position in the chain.
fn pick_entry(app: &AppHandle, curated: &[Relay]) -> Option<Relay> {
    let vless: Vec<&Relay> = curated.iter().filter(|r| r.proto == "vless").collect();
    if vless.len() < 2 {
        return None; // no second hop to detour through
    }
    let mine: Vec<&Relay> = vless.iter().copied().filter(|r| r.private).collect();
    let field: Vec<&Relay> = if mine.is_empty() { vless } else { mine };

    let pinned = load(app).onion_entry;
    let mut order: Vec<&Relay> = Vec::new();
    if let Some(tag) = pinned.as_deref() {
        // A pin made before the account had nodes of its own must not survive
        // the purchase: `field` is the paid set once there is one, so a stale
        // public pin simply is not in it and the paid node is taken instead.
        if let Some(hit) = field.iter().copied().find(|r| r.tag == tag) {
            order.push(hit);
        }
    }
    order.extend(field.iter().copied().filter(|r| Some(r.tag.as_str()) != pinned.as_deref()));

    for candidate in order {
        if reachable(&candidate.server, candidate.port) {
            let mut state = load(app);
            if state.onion_entry.as_deref() != Some(candidate.tag.as_str()) {
                state.onion_entry = Some(candidate.tag.clone());
                let _ = save(app, &state);
            }
            return Some(candidate.clone());
        }
    }
    None
}

/// A plain TCP connect, not a health check: the question here is only whether
/// this address answers at all before we hang a whole chain off it. Short, and
/// on the startup path, where every second is a black window.
fn reachable(server: &str, port: u16) -> bool {
    use std::net::ToSocketAddrs;
    (server, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next())
        .map(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(1200)).is_ok())
        .unwrap_or(false)
}

/// Rebuild the config and restart the core ON THE SAME PORT.
///
/// The webview's proxy is fixed when the window is built and wry has no runtime
/// API for it, so anything that changes the relay pool mid-session — pasting a
/// paid key, most of all — would otherwise mean "restart the whole app". Keeping
/// the port lets the page carry on talking to the same loopback address while
/// the tunnel underneath it is replaced.
pub fn rebuild(app: &AppHandle) -> bool {
    let port = PORT.load(Ordering::Relaxed);
    if port == 0 {
        return false; // nothing running to rebuild
    }
    let Ok(cache_dir) = app.path().app_config_dir() else { return false };
    let Some(config) = relay::load(&cache_dir) else { return false };

    let paid = crate::broker::relays(app);
    let mut curated = paid.clone();
    curated.extend(config.relays.iter().cloned());
    let pool = crate::user_relay::merge(&curated, &crate::user_relay::list(app));
    let entry = config.onion.then(|| pick_entry(app, &curated)).flatten();

    let config_path = cache_dir.join(CONFIG_FILE);
    if write_config(
        &config_path,
        &pool,
        port,
        &cache_dir.join(LOG_FILE),
        config.probe.as_deref(),
        entry.as_ref(),
    )
    .is_err()
    {
        return false;
    }

    if let Some(child) = CORE.lock().unwrap().take() {
        let _ = child.kill();
    }
    let Ok(command) = app.shell().sidecar("sing-box") else { return false };
    let Ok((_rx, child)) = command
        .args(["run", "-c", &config_path.to_string_lossy()])
        .spawn()
    else {
        return false;
    };
    *CORE.lock().unwrap() = Some(child);
    if !wait_for_port(port) {
        log::error!("sing-box did not come back up on {port} after a rebuild");
        stop();
        return false;
    }
    // The relay pool changed under the same port, so the TURN tunnel's leg
    // verdict (and any listener bridging the old road) is stale. Forget it;
    // the next call re-proves the leg through the new pool.
    crate::turn_tunnel::reset();
    log::info!("bypass rebuilt on 127.0.0.1:{port}");
    true
}

fn write_config(
    path: &Path,
    relays: &[Relay],
    port: u16,
    log_path: &Path,
    probe: Option<&str>,
    entry: Option<&Relay>,
) -> std::io::Result<()> {
    let probe_url = probe.unwrap_or(DEFAULT_PROBE);
    let mut outbounds: Vec<Value> = Vec::new();

    if let Some(entry) = entry {
        // TWO HOPS. The entry learns this machine's address and nothing else;
        // the exit learns the island and nothing about who asked. Neither holds
        // both halves, which is the only thing this shape buys and the reason it
        // is worth the extra latency.
        //
        // The EXITS are deliberately public even for an account with its own
        // nodes. Nothing on this side of the wire ever sees an exit address, so
        // owning one buys no reachability; what it costs is the mixing, because
        // a private exit would carry one tenant's traffic and nobody else's.
        let others: Vec<&Relay> = relays
            .iter()
            .filter(|r| r.proto == "vless" && r.tag != entry.tag)
            .collect();
        let public: Vec<&Relay> = others.iter().copied().filter(|r| !r.private).collect();
        let exits = if public.is_empty() { others } else { public };

        outbounds.push(json!({
            "type": "urltest",
            "tag": "out",
            "outbounds": exits.iter().map(|r| format!("onion-{}", r.tag)).collect::<Vec<_>>(),
            "url": probe_url,
            "interval": "5m",
            "tolerance": 50,
        }));
        let mut e = vless_outbound(entry);
        e["tag"] = json!("onion-entry");
        outbounds.push(e);
        for r in exits {
            let mut o = vless_outbound(r);
            o["tag"] = json!(format!("onion-{}", r.tag));
            o["detour"] = json!("onion-entry");
            outbounds.push(o);
        }
    } else {
        // ONE HOP, with the paid endpoints leading it.
        //
        // Throwing a customer's two nodes into a single speed race against the
        // fourteen everybody has means they win about half of it, and the thing
        // that was bought carries a minority of the traffic. What is sold is a
        // route nobody else is on, so it IS the route — and the shared pool
        // stays underneath rather than being dropped, because a paid node that
        // dies must not leave a paying customer worse off than a free one.
        let mine: Vec<&Relay> = relays.iter().filter(|r| r.private).collect();
        let shared: Vec<&Relay> = relays.iter().filter(|r| !r.private).collect();
        if !mine.is_empty() && !shared.is_empty() {
            outbounds.push(json!({
                "type": "urltest",
                "tag": "shared",
                "outbounds": shared.iter().map(|r| r.tag.clone()).collect::<Vec<_>>(),
                "url": probe_url,
                "interval": "5m",
                "tolerance": 50,
            }));
            outbounds.push(json!({
                "type": "urltest",
                "tag": "out",
                "outbounds": mine
                    .iter()
                    .map(|r| r.tag.clone())
                    .chain(std::iter::once("shared".to_owned()))
                    .collect::<Vec<_>>(),
                "url": probe_url,
                "interval": "5m",
                // Wide on purpose, so a shared node a few tens of milliseconds
                // quicker cannot pull a paying customer off their own node.
                // Only a real failure should.
                "tolerance": 3000,
            }));
        } else {
            outbounds.push(json!({
                "type": "urltest",
                "tag": "out",
                "outbounds": relays.iter().map(|r| r.tag.clone()).collect::<Vec<_>>(),
                "url": probe_url,
                "interval": "5m",
                "tolerance": 50,
            }));
        }
        outbounds.extend(relays.iter().map(|r| {
            if r.proto == "hysteria2" {
                hysteria2_outbound(r)
            } else {
                vless_outbound(r)
            }
        }));
    }

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
        write_config(&path, &relays, 1080, &dir.join("sing-box.log"), None, None).unwrap();

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

    fn paid(tag: &str) -> Relay {
        Relay {
            tag: tag.into(),
            proto: "vless".into(),
            server: "10.0.0.1".into(),
            port: 443,
            sni: "example.invalid".into(),
            uuid: Some("u".into()),
            public_key: Some("k".into()),
            short_id: Some("s".into()),
            flow: None,
            password: None,
            obfs_password: None,
            private: true,
        }
    }

    #[test]
    fn the_paid_node_is_the_entry_and_the_exits_stay_public() {
        let dir = std::env::temp_dir().join("rcq-bypass-onion-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sing-box.json");
        let entry = paid("mine-1");
        let mut pool = vec![entry.clone(), paid("mine-2")];
        pool.extend(relays());
        write_config(&path, &pool, 1080, &dir.join("sing-box.log"), None, Some(&entry)).unwrap();

        let config: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let outbounds = config["outbounds"].as_array().unwrap();
        let tags: Vec<&str> = outbounds.iter().filter_map(|o| o["tag"].as_str()).collect();

        assert!(tags.contains(&"onion-entry"), "the chain needs an entry");
        let entry_out = outbounds.iter().find(|o| o["tag"] == "onion-entry").unwrap();
        assert_eq!(entry_out["server"], "10.0.0.1", "the paid node must BE the entry");

        // The second paid node must not become an exit: an exit carrying one
        // tenant's traffic and nobody else's is the opposite of what hop two is for.
        for o in outbounds.iter().filter(|o| o["detour"] == "onion-entry") {
            assert_ne!(o["server"], "10.0.0.1", "exits stay public");
        }
        // Every exit detours, or the hop it skipped would see address and island at once.
        let raced = outbounds[0]["outbounds"].as_array().unwrap();
        assert!(!raced.is_empty());
        for name in raced {
            let exit = outbounds.iter().find(|o| o["tag"] == *name).unwrap();
            assert_eq!(exit["detour"], "onion-entry");
        }
        assert!(!outbounds.iter().any(|o| o["type"] == "direct"));
    }

    #[test]
    fn one_hop_races_the_paid_nodes_and_keeps_the_pool_beneath_them() {
        let dir = std::env::temp_dir().join("rcq-bypass-paid-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sing-box.json");
        let mut pool = vec![paid("mine-1")];
        pool.extend(relays());
        write_config(&path, &pool, 1080, &dir.join("sing-box.log"), None, None).unwrap();

        let config: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let outbounds = config["outbounds"].as_array().unwrap();
        let out = outbounds.iter().find(|o| o["tag"] == "out").unwrap();
        let raced: Vec<&str> = out["outbounds"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();

        assert_eq!(raced.first(), Some(&"mine-1"), "the paid node leads");
        assert!(raced.contains(&"shared"), "the shared pool stays as a fallback");
        // Wide tolerance, or a shared node a few ms quicker pulls a paying
        // customer off the node they bought.
        assert_eq!(out["tolerance"], 3000);
        let shared = outbounds.iter().find(|o| o["tag"] == "shared").unwrap();
        assert!(!shared["outbounds"].as_array().unwrap().is_empty());
    }


    #[test]
    fn a_free_port_is_actually_free() {
        let port = free_port().unwrap();
        assert!(port > 0);
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
    }
}
