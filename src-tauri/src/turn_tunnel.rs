// Carries call media over the same tunnel that carries the messages.
//
// The problem this exists for, found on Android first and worse here: the
// bypass proxies the WEBVIEW, and WebRTC does not live in the webview's
// network stack. It opens its own sockets. So on a network that blocks RCQ,
// someone turns the bypass on, their chats start working, and their calls
// stay dead - the voice goes out beside the tunnel, into the same block the
// tunnel exists to get around. On this platform the proxy is attached to the
// webview loader when the window is built (lib.rs), UDP is proxied by
// nothing, and media had no route into the tunnel at all.
//
// WebRTC takes no proxy, but it does take any address we like and speaks TURN
// over TCP. So the tunnel is put where it will be used: a listener on
// loopback that WebRTC dials as if it were the relay next door, forwarding
// every byte through sing-box's SOCKS inbound to the real one. WebRTC sees a
// TURN server; the network sees the same tunnel it already lets through.
//
// Plain `turn:` over TCP on 3478, deliberately, not `turns:` on 443. The
// tunnel already encrypts and obfuscates what it carries, and the media
// inside is SRTP either way; a second TLS layer would buy nothing and would
// break the transparent byte-for-byte forwarding this depends on.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TURN_TCP_PORT: u16 = 3478;
/// Enough for both ends of a call plus a retry, with room to spare; each is
/// one short-lived task copying both directions.
const MAX_CONNECTIONS: usize = 8;
/// Matches the budget the Android leg probe settled on: through SOCKS to a
/// VLESS relay to coturn over TCP, a throttled link regularly needs more than
/// a few seconds, and a too-short probe condemns a working leg.
const LEG_PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);

struct State {
    /// The loopback port WebRTC dials, 0 while no listener is armed.
    port: u16,
    /// The relay the listener bridges to.
    host: String,
    /// Bumped whenever the listener is replaced or dropped. An accept loop
    /// that wakes to a newer generation exits and its socket goes with it.
    generation: u64,
    /// The host whose tunnel leg was last measured, and the verdict. One
    /// measurement per road and host, so a dead leg is not re-probed (its
    /// timeout re-waited) on every call attempt; forgotten when the core
    /// stops or rebuilds, because the verdict belongs to that road.
    probed_host: Option<String>,
    probed_ok: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    port: 0,
    host: String::new(),
    generation: 0,
    probed_host: None,
    probed_ok: false,
});

/// Bridges alive right now, for the connection cap.
static LIVE: AtomicUsize = AtomicUsize::new(0);

/// Serializes ensure() end to end. Two calls racing would probe the same leg
/// twice and arm two listeners; one waiting out the other costs nothing.
static ENSURE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn loopback_url(port: u16) -> String {
    format!("turn:127.0.0.1:{port}?transport=tcp")
}

/// Make sure a listener bridging to `turn_host` is up, and hand back its URL.
/// None whenever the substitution must not happen: core down, listener
/// failed, or the leg through the tunnel carries no TURN. The caller then
/// leaves the island's own URLs alone, exactly as with no tunnel at all.
///
/// Cheap to call repeatedly: armed and matching is a lock and a compare.
/// Only a CHANGE costs a leg probe, blocking up to [`LEG_PROBE_TIMEOUT`].
pub async fn ensure(turn_host: &str) -> Option<String> {
    if turn_host.is_empty() || turn_host.len() > 255 {
        return None; // the SOCKS request carries the name in one length byte
    }
    // Asked at call time, not cached at startup: the answer has to follow the
    // core around, or a tunnel switched off would keep swallowing calls.
    let socks = crate::bypass::socks_port()?;
    let _serial = ENSURE.lock().await;
    {
        let s = STATE.lock().unwrap();
        if s.port != 0 && s.host == turn_host {
            return Some(loopback_url(s.port));
        }
        if s.probed_host.as_deref() == Some(turn_host) && !s.probed_ok {
            return None; // measured dead on this road; stay inactive
        }
    }
    stop_listener();
    // Prove the leg BEFORE arming. The listener coming up says nothing about
    // the road behind it: a relay that filters the TURN host accepts the
    // SOCKS request and returns no bytes, and arming on that leg hands WebRTC
    // a loopback relay that cannot carry a call - worse than no tunnel,
    // because the island's own URLs were traded away for it. Armed only on a
    // STUN Binding Success through the tunnel.
    let verdict_known =
        { STATE.lock().unwrap().probed_host.as_deref() == Some(turn_host) };
    if !verdict_known {
        let ok = leg_carries_turn(socks, turn_host).await;
        let mut s = STATE.lock().unwrap();
        s.probed_host = Some(turn_host.to_string());
        s.probed_ok = ok;
    }
    if !STATE.lock().unwrap().probed_ok {
        log::warn!("tunnel leg to {turn_host}:{TURN_TCP_PORT} carries no TURN; not arming");
        return None;
    }
    // Loopback only. Nothing outside this machine may use us as an open relay
    // into the tunnel. The OS picks the port: unlike a phone, a desktop runs
    // whatever else its owner installed, and nothing needs the port fixed -
    // the page learns it from this call's return value.
    let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("turn tunnel listener failed: {e}");
            return None;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            log::error!("turn tunnel listener has no address: {e}");
            return None;
        }
    };
    let generation = {
        let mut s = STATE.lock().unwrap();
        s.generation += 1;
        s.port = port;
        s.host = turn_host.to_string();
        s.generation
    };
    log::info!("tunnelling calls: {port} -> {turn_host}:{TURN_TCP_PORT}");
    tauri::async_runtime::spawn(accept_loop(listener, generation, turn_host.to_string()));
    Some(loopback_url(port))
}

/// Drop the listener and forget the leg verdict. bypass::stop and
/// bypass::rebuild call this: both remove or replace the road the verdict and
/// the bridges belong to. The next call re-proves the leg on whatever road is
/// there then.
pub fn reset() {
    let port = {
        let mut s = STATE.lock().unwrap();
        s.generation += 1;
        s.probed_host = None;
        s.probed_ok = false;
        std::mem::take(&mut s.port)
    };
    wake(port);
}

/// Retire the current listener but keep the verdict: the road is unchanged,
/// only the upstream host is about to move.
fn stop_listener() {
    let port = {
        let mut s = STATE.lock().unwrap();
        s.generation += 1;
        std::mem::take(&mut s.port)
    };
    wake(port);
}

/// Unblock a parked accept so a retired loop notices its generation is stale
/// and drops the socket. Without this the old listener would squat on its
/// port until the next stray connection.
fn wake(port: u16) {
    if port == 0 {
        return;
    }
    let addr = std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port));
    let _ = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(200));
}

async fn accept_loop(listener: TcpListener, generation: u64, host: String) {
    loop {
        let client = match listener.accept().await {
            Ok((c, _)) => c,
            Err(_) => return,
        };
        if STATE.lock().unwrap().generation != generation {
            return; // replaced or stopped; the port closes with the listener
        }
        if LIVE.load(Ordering::Relaxed) >= MAX_CONNECTIONS {
            continue; // a runaway dialer must not fan out into the tunnel
        }
        LIVE.fetch_add(1, Ordering::Relaxed);
        let host = host.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = bridge(client, &host).await {
                log::warn!("turn tunnel leg failed: {e}");
            }
            LIVE.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

async fn bridge(mut client: TcpStream, host: &str) -> std::io::Result<()> {
    // Through sing-box, not around it - the whole point. Fetched per bridge,
    // not kept from arming time: the core can stop or rebuild underneath us.
    let socks = crate::bypass::socks_port()
        .ok_or_else(|| std::io::Error::other("bypass core is gone"))?;
    let mut upstream = tokio::time::timeout(CONNECT_TIMEOUT, socks_connect(socks, host, TURN_TCP_PORT))
        .await
        .map_err(|_| std::io::Error::other("socks connect timed out"))??;
    let _ = client.set_nodelay(true); // TURN carries latency-sensitive media
    // Either end closing, cleanly or not, is the normal way a call ends.
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    Ok(())
}

/// CONNECT through the local SOCKS inbound, handing the relay the NAME.
///
/// The name, deliberately, never an address resolved here. Every relay's
/// routing table ends in `reject` and lets through a domain_suffix of rcq.app
/// plus a short list of ip_cidr - the islands, the fleet, four resolvers. A
/// locally resolved destination arrives at the relay as a bare address it has
/// no rule for and is dropped, silently and with no bytes back; the hostname
/// in the SOCKS request matches the rule that was always there. Measured on
/// Android, not reasoned: a STUN Binding Request through a relay gets a
/// Binding Success by name and a closed connection by address, over one and
/// the same tunnel.
///
/// Shared with the island forwarder (island_trust.rs), which dials whatever
/// host and port an island lives on. A host that IS an address (an island
/// reachable only by IP, the fingerprint case) travels as one: the rule above
/// is about not resolving names here, and there is nothing to resolve.
pub(crate) async fn socks_connect(socks_port: u16, host: &str, port: u16) -> std::io::Result<TcpStream> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() || host.len() > 255 {
        return Err(std::io::Error::other("host does not fit a socks request"));
    }
    let mut s = TcpStream::connect(("127.0.0.1", socks_port)).await?;
    s.set_nodelay(true)?;
    s.write_all(&[0x05, 0x01, 0x00]).await?; // SOCKS5, one method: no auth
    let mut method = [0u8; 2];
    s.read_exact(&mut method).await?;
    if method != [0x05, 0x00] {
        return Err(std::io::Error::other("socks method refused"));
    }
    let mut req = Vec::with_capacity(7 + host.len());
    req.extend_from_slice(&[0x05, 0x01, 0x00]);
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            req.push(0x01);
            req.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            req.push(0x04);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            let name = host.as_bytes();
            req.push(0x03);
            req.push(name.len() as u8);
            req.extend_from_slice(name);
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    if head[0] != 0x05 || head[1] != 0x00 {
        return Err(std::io::Error::other(format!("socks connect refused: {}", head[1])));
    }
    // Drain the bound address so the stream starts at the payload.
    let addr_len = match head[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            len[0] as usize
        }
        other => {
            return Err(std::io::Error::other(format!("socks bound address type {other}")));
        }
    };
    let mut skip = vec![0u8; addr_len + 2];
    s.read_exact(&mut skip).await?;
    Ok(s)
}

/// One STUN Binding round trip to the relay THROUGH the tunnel: the same
/// road, asked the same way [`bridge`] will ask it. A relay that filters the
/// TURN host still opens the SOCKS connection, so only bytes coming back
/// count as a leg.
async fn leg_carries_turn(socks_port: u16, host: &str) -> bool {
    let attempt = async {
        let mut s = socks_connect(socks_port, host, TURN_TCP_PORT).await?;
        let txid: [u8; 12] = rand::random();
        let mut req = Vec::with_capacity(20);
        req.extend_from_slice(&0x0001u16.to_be_bytes()); // Binding Request
        req.extend_from_slice(&0u16.to_be_bytes()); // no attributes
        req.extend_from_slice(&0x2112_A442u32.to_be_bytes()); // magic cookie
        req.extend_from_slice(&txid);
        s.write_all(&req).await?;
        let mut head = [0u8; 2];
        s.read_exact(&mut head).await?;
        Ok::<bool, std::io::Error>(u16::from_be_bytes(head) == 0x0101) // Binding Success
    };
    matches!(tokio::time::timeout(LEG_PROBE_TIMEOUT, attempt).await, Ok(Ok(true)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake SOCKS inbound plus a fake coturn behind it, in one task: accept,
    /// walk the handshake, capture the destination, answer the first STUN
    /// Binding Request. What matters is asserted where it is load-bearing:
    /// the destination travels as a NAME, and the probe only trusts bytes
    /// that came back.
    #[test]
    fn the_socks_request_carries_the_name_and_the_probe_wants_bytes_back() {
        tauri::async_runtime::block_on(async {
            let fake = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = fake.local_addr().unwrap().port();
            let served = tauri::async_runtime::spawn(async move {
                let (mut s, _) = fake.accept().await.unwrap();
                let mut greeting = [0u8; 3];
                s.read_exact(&mut greeting).await.unwrap();
                assert_eq!(greeting, [0x05, 0x01, 0x00]);
                s.write_all(&[0x05, 0x00]).await.unwrap();
                let mut head = [0u8; 5];
                s.read_exact(&mut head).await.unwrap();
                assert_eq!(&head[..4], &[0x05, 0x01, 0x00, 0x03], "must CONNECT by name");
                let mut name = vec![0u8; head[4] as usize];
                s.read_exact(&mut name).await.unwrap();
                assert_eq!(name, b"turn.example.test");
                let mut dst_port = [0u8; 2];
                s.read_exact(&mut dst_port).await.unwrap();
                assert_eq!(u16::from_be_bytes(dst_port), TURN_TCP_PORT);
                s.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await.unwrap();
                let mut stun = [0u8; 20];
                s.read_exact(&mut stun).await.unwrap();
                assert_eq!(&stun[..2], &0x0001u16.to_be_bytes());
                let mut reply = Vec::new();
                reply.extend_from_slice(&0x0101u16.to_be_bytes()); // Binding Success
                reply.extend_from_slice(&0u16.to_be_bytes());
                reply.extend_from_slice(&stun[4..]); // cookie + txid echoed
                s.write_all(&reply).await.unwrap();
            });
            assert!(leg_carries_turn(port, "turn.example.test").await);
            served.await.unwrap();
        });
    }
}
