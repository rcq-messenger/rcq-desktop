//! Relays the user added by hand, from an `rcq-relay://` token.
//!
//! The desktop could only ever use relays from the signed list or the copy
//! compiled into the binary. Both arrive over names a censor can enumerate
//! (github-raw and relay.rcq.app), so a user whose network blocks all of them
//! had no way left to point the app at a working bridge — while the phones
//! accepted a pasted token and a relay shared by a contact. This closes that:
//! a token handed over any channel at all, even read aloud, gets the desktop
//! moving again.
//!
//! Token format is the one the phones and `relay-bootstrap.sh` already emit
//! (see docs/bridge-sharing-design.md):
//!
//! ```text
//! rcq-relay://vless?s=1.2.3.4&p=443&sni=www.apple.com&id=<uuid>&pbk=<key>&sid=<short>&fl=xtls-rprx-vision
//! rcq-relay://hy2?s=1.2.3.4&p=443&sni=www.apple.com&pw=<password>&obfs=<obfs>
//! ```
//!
//! These are NOT signed, and cannot be: the whole point is that they travel
//! out of band. So they are kept apart from the signed pool, and the UI never
//! presents them as vetted.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::relay::Relay;

const FILE: &str = "user-relays.json";
/// A hand-managed list is small by nature; the cap only stops a pathological
/// paste loop from growing the config without bound.
const MAX: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserRelay {
    pub tag: String,
    pub proto: String,
    pub server: String,
    pub port: u16,
    pub sni: String,
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub short_id: Option<String>,
    #[serde(default)]
    pub flow: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub obfs_password: Option<String>,
}

impl From<&UserRelay> for Relay {
    fn from(u: &UserRelay) -> Self {
        Relay {
            tag: u.tag.clone(),
            proto: u.proto.clone(),
            server: u.server.clone(),
            port: u.port,
            sni: u.sni.clone(),
            uuid: u.uuid.clone(),
            public_key: u.public_key.clone(),
            short_id: u.short_id.clone(),
            flow: u.flow.clone(),
            password: u.password.clone(),
            obfs_password: u.obfs_password.clone(),
        }
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

pub fn list(app: &AppHandle) -> Vec<UserRelay> {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Vec<UserRelay>>(&t).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, relays: &[UserRelay]) -> Result<(), String> {
    let p = path(app).ok_or("no config directory")?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string(relays).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| e.to_string())
}

/// Parse a token. Returns None for anything that would produce an outbound
/// sing-box cannot dial — a missing key is worse than a rejected paste,
/// because the failure would surface later as a tunnel that silently does not
/// carry traffic.
pub fn parse_token(token: &str) -> Option<UserRelay> {
    let token = token.trim();
    let rest = token.strip_prefix("rcq-relay://")?;
    let (authority, query) = rest.split_once('?')?;
    let proto = match authority.to_ascii_lowercase().as_str() {
        "hy2" | "hysteria2" => "hysteria2",
        "vless" | "" => "vless",
        _ => return None,
    };

    let mut server = None;
    let mut port = None;
    let mut sni = None;
    let (mut uuid, mut pbk, mut sid, mut fl, mut pw, mut obfs) = (None, None, None, None, None, None);
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else { continue };
        let v = percent_decode(v);
        if v.is_empty() {
            continue;
        }
        match k {
            "s" => server = Some(v),
            "p" => port = v.parse::<u16>().ok(),
            "sni" => sni = Some(v),
            "id" => uuid = Some(v),
            "pbk" => pbk = Some(v),
            "sid" => sid = Some(v),
            "fl" => fl = Some(v),
            "pw" => pw = Some(v),
            "obfs" => obfs = Some(v),
            _ => {}
        }
    }

    let server = server?;
    let port = port?;
    let sni = sni?;
    if port == 0 {
        return None;
    }
    match proto {
        "vless" if uuid.is_none() => return None,
        "hysteria2" if pw.is_none() => return None,
        _ => {}
    }

    Some(UserRelay {
        // Same shape the phones use, so the same physical relay dedupes across
        // clients and cannot collide with a signed-config tag.
        tag: format!("shared-{server}-{port}"),
        proto: proto.to_string(),
        server,
        port,
        sni,
        uuid,
        public_key: pbk,
        short_id: sid,
        flow: fl,
        password: pw,
        obfs_password: obfs,
    })
}

/// Minimal percent-decoding: tokens carry base64 keys, where `+` and `/` are
/// routinely escaped by whatever chat app the token travelled through.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Add a relay from a token. Replaces an existing entry for the same
/// proto/server/port rather than stacking duplicates, so re-pasting a refreshed
/// token updates its keys.
pub fn add(app: &AppHandle, token: &str) -> Result<UserRelay, String> {
    let relay = parse_token(token).ok_or("not a usable rcq-relay:// token")?;
    let mut all = list(app);
    all.retain(|r| !(r.proto == relay.proto && r.server == relay.server && r.port == relay.port));
    all.push(relay.clone());
    if all.len() > MAX {
        let cut = all.len() - MAX;
        all.drain(0..cut);
    }
    save(app, &all)?;
    Ok(relay)
}

pub fn remove(app: &AppHandle, tag: &str) -> Result<(), String> {
    let mut all = list(app);
    all.retain(|r| r.tag != tag);
    save(app, &all)
}

/// The signed pool with the user's own relays appended, deduped by
/// proto/server/port. The user's go LAST: the signed ones are health-checked
/// by the canary, so they lead the urltest race, and a hand-added bridge is
/// there for when those are gone.
pub fn merge(signed: &[Relay], user: &[UserRelay]) -> Vec<Relay> {
    let mut out = signed.to_vec();
    for u in user {
        let dup = out
            .iter()
            .any(|r| r.proto == u.proto && r.server == u.server && r.port == u.port);
        if !dup {
            out.push(Relay::from(u));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_relay(server: &str) -> Relay {
        Relay {
            tag: format!("signed-{server}"),
            proto: "vless".into(),
            server: server.into(),
            port: 443,
            sni: "www.apple.com".into(),
            uuid: Some("u".into()),
            public_key: Some("k".into()),
            short_id: None,
            flow: None,
            password: None,
            obfs_password: None,
        }
    }

    #[test]
    fn parses_the_token_the_bootstrap_script_prints() {
        let r = parse_token(
            "rcq-relay://vless?s=1.2.3.4&p=443&sni=www.apple.com&id=abc&pbk=key&sid=ff&fl=xtls-rprx-vision",
        )
        .expect("should parse");
        assert_eq!(r.proto, "vless");
        assert_eq!(r.server, "1.2.3.4");
        assert_eq!(r.port, 443);
        assert_eq!(r.uuid.as_deref(), Some("abc"));
        assert_eq!(r.tag, "shared-1.2.3.4-443");
    }

    #[test]
    fn accepts_hy2_as_an_alias_and_needs_a_password() {
        let r = parse_token("rcq-relay://hy2?s=5.6.7.8&p=443&sni=www.apple.com&pw=secret&obfs=o")
            .expect("should parse");
        assert_eq!(r.proto, "hysteria2");
        assert_eq!(r.password.as_deref(), Some("secret"));
        assert!(parse_token("rcq-relay://hy2?s=5.6.7.8&p=443&sni=www.apple.com").is_none());
    }

    #[test]
    fn refuses_tokens_that_would_build_a_dead_outbound() {
        // A vless relay with no uuid dials nothing; better to reject the paste
        // than to surface it later as a tunnel that carries no traffic.
        assert!(parse_token("rcq-relay://vless?s=1.2.3.4&p=443&sni=a").is_none());
        assert!(parse_token("rcq-relay://vless?s=1.2.3.4&p=0&sni=a&id=x").is_none());
        assert!(parse_token("rcq-relay://vless?p=443&sni=a&id=x").is_none());
        assert!(parse_token("https://example.com").is_none());
        assert!(parse_token("rcq-relay://wireguard?s=1.2.3.4&p=443&sni=a").is_none());
    }

    #[test]
    fn decodes_escaped_base64_keys() {
        let r = parse_token("rcq-relay://vless?s=1.2.3.4&p=443&sni=a&id=x&pbk=a%2Bb%2Fc%3D")
            .expect("should parse");
        assert_eq!(r.public_key.as_deref(), Some("a+b/c="));
    }

    #[test]
    fn merge_appends_and_dedupes() {
        let signed = vec![signed_relay("1.1.1.1")];
        let user = vec![
            parse_token("rcq-relay://vless?s=1.1.1.1&p=443&sni=a&id=x").unwrap(),
            parse_token("rcq-relay://vless?s=2.2.2.2&p=443&sni=a&id=x").unwrap(),
        ];
        let merged = merge(&signed, &user);
        assert_eq!(merged.len(), 2, "the duplicate of a signed relay is dropped");
        assert_eq!(merged[0].server, "1.1.1.1");
        assert_eq!(merged[1].server, "2.2.2.2");
    }
}
