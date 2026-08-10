// Relays pulled from the BROKER, the per-request channel that hands out
// endpoints the signed config does not publish.
//
// The signed list is public by construction: it downloads in one unauthenticated
// request, so a blocklist covering the entire shared pool costs a censor one
// fetch. The broker is the other half — it answers per request, and with a paid
// tenant key it returns that account's OWN endpoints, which appear in no public
// list at all. Mirrors `BrokerRelayStore` on Android and iOS.
//
// The key is DEVICE-level, like everything else here. It buys network access,
// not an identity, and somebody with two accounts on one machine bought it once.

use crate::relay::Relay;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const BROKER_URL: &str = "https://api.rcq.app/broker/bridges?n=5";
const STATE_FILE: &str = "broker.json";

#[derive(Default, Serialize, Deserialize)]
pub struct Persisted {
    /// The paid tenant key as the customer pasted it, or None.
    #[serde(default)]
    pub key: Option<String>,
    /// What the broker made of that key on the last successful round trip:
    /// "ok", "unknown", "expired", or None if we have never asked. Kept so the
    /// settings screen can say WHY nothing arrived — a key that is simply wrong
    /// and a network that is down look identical otherwise.
    #[serde(default)]
    pub verdict: Option<String>,
    /// Last successful response, cached so a launch on a blocked network still
    /// has the paid endpoints. They are the ones most likely to still work.
    #[serde(default)]
    pub relays: Vec<Cached>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Cached {
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
    #[serde(default)]
    pub private: bool,
}

impl From<&Cached> for Relay {
    fn from(c: &Cached) -> Self {
        Relay {
            tag: c.tag.clone(),
            proto: c.proto.clone(),
            server: c.server.clone(),
            port: c.port,
            sni: c.sni.clone(),
            uuid: c.uuid.clone(),
            public_key: c.public_key.clone(),
            short_id: c.short_id.clone(),
            flow: c.flow.clone(),
            password: c.password.clone(),
            obfs_password: c.obfs_password.clone(),
            private: c.private,
        }
    }
}

/// What the settings screen shows after a key is submitted.
#[derive(Serialize)]
pub struct KeyResult {
    /// "ok" | "unknown" | "expired" | "offline"
    pub verdict: String,
    /// How many endpoints of the account's own came back.
    pub private_count: usize,
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(STATE_FILE))
}

pub fn load(app: &AppHandle) -> Persisted {
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
    std::fs::write(&path, serde_json::to_string(state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// The cached paid endpoints, for the relay pool.
pub fn relays(app: &AppHandle) -> Vec<Relay> {
    load(app).relays.iter().map(Relay::from).collect()
}

pub fn key(app: &AppHandle) -> Option<String> {
    load(app).key.filter(|k| !k.trim().is_empty())
}

pub fn verdict(app: &AppHandle) -> Option<String> {
    load(app).verdict
}

/// Store a key (or clear it with None) and ask the broker what it is worth
/// right away. A key that only takes effect at the next launch looks broken to
/// the person who just pasted it.
pub fn set_key(app: &AppHandle, new_key: Option<String>, proxy: Option<&str>) -> KeyResult {
    let new_key = new_key.map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
    let Some(k) = new_key.clone() else {
        // Clearing drops the cached endpoints with it. Leaving them behind would
        // keep routing a customer through nodes they no longer hold a key for,
        // which is exactly the state "remove the key" is meant to end.
        let _ = save(app, &Persisted::default());
        return KeyResult { verdict: "ok".into(), private_count: 0 };
    };

    match fetch(&k, proxy) {
        Some((verdict, relays)) => {
            let private_count = relays.iter().filter(|r| r.private).count();
            // A key the broker does not recognise is NOT stored. A dead key kept
            // on disk sits there failing quietly at every launch, and the person
            // who mistyped it has no way to tell that from a broken network.
            let keep = verdict == "ok";
            let _ = save(
                app,
                &Persisted {
                    key: keep.then_some(k),
                    verdict: Some(verdict.clone()),
                    relays: keep.then_some(relays).unwrap_or_default(),
                },
            );
            KeyResult { verdict, private_count }
        }
        // The round trip failed. Say so rather than blaming the key: telling
        // somebody their key is wrong when the network never carried the
        // question is the kind of answer that costs an evening.
        None => KeyResult { verdict: "offline".into(), private_count: 0 },
    }
}

/// Re-ask the broker with the stored key. Best effort, for startup.
pub fn refresh(app: &AppHandle, proxy: Option<&str>) {
    let Some(k) = key(app) else { return };
    let Some((verdict, relays)) = fetch(&k, proxy) else { return };
    let mut state = load(app);
    state.verdict = Some(verdict.clone());
    // Only a good answer replaces the cache. "unknown" after a subscription
    // lapse or a rotation should stop us using the endpoints, but a transient
    // one must not wipe the cache of somebody who is merely offline — hence the
    // fetch-failed path above returns early instead of landing here.
    if verdict == "ok" {
        state.relays = relays;
    } else {
        state.relays.clear();
    }
    let _ = save(app, &state);
}

fn fetch(key: &str, proxy: Option<&str>) -> Option<(String, Vec<Cached>)> {
    let mut client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("rcq-desktop");
    if let Some(p) = proxy {
        client = client.proxy(reqwest::Proxy::all(p).ok()?);
    }
    let body = client
        .build()
        .ok()?
        .get(BROKER_URL)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .ok()?
        .text()
        .ok()?;
    parse(&body)
}

/// ⚠ The broker spells Reality's parameters `pbk`/`sid` while the signed config
/// spells them `public_key`/`short_id`. Same values, two names, and reading only
/// one set yields an outbound that dials and then fails the handshake — a relay
/// that looks alive and carries nothing.
pub fn parse(body: &str) -> Option<(String, Vec<Cached>)> {
    let root: Value = serde_json::from_str(body).ok()?;
    let verdict = root
        .get("key")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let mut out = Vec::new();
    for e in root.get("relays").and_then(Value::as_array).unwrap_or(&vec![]) {
        let s = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned);
        let (Some(server), Some(sni)) = (s("server"), s("sni")) else { continue };
        let Some(port) = e.get("port").and_then(Value::as_u64) else { continue };
        let proto = s("proto").unwrap_or_else(|| "vless".into());
        // Tag by address: the broker does not always name an endpoint, and two
        // relays sharing a tag would collide in sing-box.
        let tag = s("tag").unwrap_or_else(|| format!("broker-{server}-{port}"));
        out.push(Cached {
            tag,
            proto,
            server,
            port: port as u16,
            sni,
            uuid: s("uuid"),
            public_key: s("public_key").or_else(|| s("pbk")),
            short_id: s("short_id").or_else(|| s("sid")),
            flow: s("flow"),
            password: s("password"),
            obfs_password: s("obfs_password").or_else(|| s("obfs")),
            private: e.get("private").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    Some((verdict, out))
}

#[allow(dead_code)]
pub fn cache_file() -> &'static Path {
    Path::new(STATE_FILE)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAID: &str = r#"{"relays":[
      {"flow":"xtls-rprx-vision","pbk":"YejEsdRG3WRhZrMhIsN77kRJOdoxvAIpTvvfaFWxsSw","port":443,
       "proto":"vless","server":"164.92.217.91","sid":"46b99812bac779ec",
       "sni":"ams3.digitaloceanspaces.com","uuid":"ddcadc57-5564-40c8-b3d7-63dcb63fa1eb",
       "tier":"community","private":true}],
      "ts":1786342854,"key":"ok","private_count":1}"#;

    #[test]
    fn reality_parameters_are_read_under_the_broker_spelling() {
        let (verdict, relays) = parse(PAID).unwrap();
        assert_eq!(verdict, "ok");
        assert_eq!(relays.len(), 1);
        let r = &relays[0];
        // The whole point: pbk/sid, not public_key/short_id. Miss these and the
        // outbound connects and then fails the Reality handshake.
        assert_eq!(r.public_key.as_deref(), Some("YejEsdRG3WRhZrMhIsN77kRJOdoxvAIpTvvfaFWxsSw"));
        assert_eq!(r.short_id.as_deref(), Some("46b99812bac779ec"));
        assert!(r.private);
    }

    #[test]
    fn a_key_the_broker_rejects_brings_back_nothing() {
        let (verdict, relays) = parse(r#"{"relays":[],"key":"unknown","private_count":0}"#).unwrap();
        assert_eq!(verdict, "unknown");
        assert!(relays.is_empty());
    }
}
