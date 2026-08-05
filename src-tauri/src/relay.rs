// Signed relay list — the same payload the phone clients use, so a burned
// relay can be swapped without shipping a desktop release.
//
// Mirrors `RelayConfigStore` on Android and iOS: fetch from hard-to-block
// mirrors, verify an Ed25519 signature over the canonical JSON of everything
// except `sig`, cache the verified payload, and fall back through
// memory -> disk -> a bundled copy so a fresh install on a censored network
// still has a list to try.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::Value;
use std::path::Path;

// Which keys may sign this payload lives in `signing_keys` — a SET, so the
// signing key can change without a release. See that module for why the set is
// compiled in rather than carried by the payload it authenticates.

// The two mirrors compiled into the app. Tried in order, first signature-valid
// payload wins. GitHub raw is primary: RU DPI hits it far less than Cloudflare.
//
// ⚠ These two names are also the entire attack surface of the delivery channel:
// a censor who blocks both leaves this install with the bundled pool and a
// hand-pasted token, which is what the payload's own `sources` list is for.
const BUNDLED_SOURCES: [&str; 2] = [
    "https://raw.githubusercontent.com/rcq-messenger/rcq-ios/main/relay-config.json",
    "https://relay.rcq.app/v1/config",
];

/// Where a payload can be read from. `Https` is a mirror URL; `DnsTxt` is a name
/// whose TXT record carries a signed seed, read over DoH — a channel that
/// survives both mirror names being blocked, since it rides resolvers half the
/// internet needs to stay up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Https(String),
    DnsTxt(String),
}

pub const CACHE_FILE: &str = "relay-config.json";

// Last-resort pool for an install that has never reached a mirror. It is a
// real signed payload rather than a hand-copied list, so it verifies through
// exactly the same path as a fetched one.
const BUNDLED: &str = include_str!("../relay-config.json");

#[derive(Clone, Debug)]
pub struct Relay {
    pub tag: String,
    pub proto: String,
    pub server: String,
    pub port: u16,
    pub sni: String,
    pub uuid: Option<String>,
    pub public_key: Option<String>,
    pub short_id: Option<String>,
    pub flow: Option<String>,
    pub password: Option<String>,
    pub obfs_password: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RelayConfig {
    pub version: Option<i64>,
    pub relays: Vec<Relay>,
    /// Extra mirrors this payload names for itself, so a new delivery channel
    /// reaches installed clients without a release.
    pub sources: Vec<Source>,
}

/// The list to use right now: the freshest verified payload we have.
/// Disk cache first (it was verified before it was written), bundled last.
pub fn load(cache_dir: &Path) -> Option<RelayConfig> {
    std::fs::read_to_string(cache_dir.join(CACHE_FILE))
        .ok()
        .and_then(|t| verify_and_parse(&t, None))
        .or_else(|| verify_and_parse(BUNDLED, None))
}

/// Pull a fresh list and cache it for the next launch. Best-effort: on a
/// blocked network every mirror fails and the caller keeps using disk/bundled.
///
/// `proxy` routes the fetch through our own tunnel once it is up. A censored
/// user cannot reach either mirror directly, so without this they would stay
/// on the bundled pool forever and never see a rotation. The signed config is
/// public, so tunnelling it leaks nothing.
pub fn refresh(cache_dir: &Path, proxy: Option<&str>) -> Option<RelayConfig> {
    let mut client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(12));
    if let Some(url) = proxy {
        if let Ok(p) = reqwest::Proxy::all(url) {
            client = client.proxy(p);
        }
    }
    let client = client.build().ok()?;

    // Mirrors to walk, freshest knowledge first, then the compiled-in pair, and
    // the floor to hold them to.
    //
    // ★ The bundled pair is ALWAYS appended and never replaced. A published
    // source list is an ADDITION, not a substitution — otherwise one bad push,
    // a typo'd host or a lapsed domain, points every install at a dead mirror
    // with no route back and no later push able to reach it.
    let known = load(cache_dir);
    let floor = known.as_ref().and_then(|c| c.version);
    let mut sources: Vec<Source> = known.map(|c| c.sources).unwrap_or_default();
    for bundled in BUNDLED_SOURCES {
        let s = Source::Https(bundled.to_owned());
        if !sources.contains(&s) {
            sources.push(s);
        }
    }
    // A refresh runs before the tunnel is up, so each dead entry costs its full
    // timeout; a payload naming fifty would turn launch into a stall.
    sources.truncate(8);

    for source in sources {
        let body = match source {
            Source::Https(ref url) => {
                let Ok(resp) = client.get(url).send() else { continue };
                if !resp.status().is_success() {
                    continue;
                }
                let Ok(text) = resp.text() else { continue };
                text
            }
            Source::DnsTxt(ref name) => {
                let Some(value) = crate::dns_txt::fetch(name, &client) else { continue };
                let Ok(raw) = B64.decode(value) else { continue };
                let Ok(text) = String::from_utf8(raw) else { continue };
                text
            }
        };
        let Some(config) = verify_and_parse(&body, floor) else { continue };
        let _ = std::fs::create_dir_all(cache_dir);
        let _ = std::fs::write(cache_dir.join(CACHE_FILE), &body);
        return Some(config);
    }
    None
}

/// Verify the signature, then parse the relays in priority order. Any failure
/// returns None: an unsigned or mis-signed payload is treated as no payload.
pub fn verify_and_parse(text: &str, min_version: Option<i64>) -> Option<RelayConfig> {
    let root: Value = serde_json::from_str(text).ok()?;
    let sig_b64 = root.get("sig")?.as_str()?;

    let mut signed = root.clone();
    signed.as_object_mut()?.remove("sig");
    let mut message = String::new();
    canonical(&signed, &mut message);

    if !crate::signing_keys::verify(
        crate::signing_keys::Role::RelayConfig,
        message.as_bytes(),
        sig_b64,
    ) {
        return None;
    }

    let mut relays: Vec<(i64, Relay)> = Vec::new();
    for entry in root.get("relays")?.as_array()? {
        let s = |k: &str| entry.get(k).and_then(Value::as_str).map(str::to_owned);
        let (Some(tag), Some(server), Some(sni)) = (s("tag"), s("server"), s("sni")) else {
            continue;
        };
        let Some(port) = entry.get("port").and_then(Value::as_u64) else { continue };
        relays.push((
            entry.get("priority").and_then(Value::as_i64).unwrap_or(100),
            Relay {
                tag,
                proto: s("proto").unwrap_or_else(|| "vless".into()),
                server,
                port: port as u16,
                sni,
                uuid: s("uuid"),
                public_key: s("public_key"),
                short_id: s("short_id"),
                flow: s("flow"),
                password: s("password"),
                obfs_password: s("obfs_password"),
            },
        ));
    }
    if relays.is_empty() {
        return None;
    }
    relays.sort_by_key(|(priority, _)| *priority);

    let version = root.get("version").and_then(Value::as_i64);
    // Refuse to move BACKWARDS. A signature proves a payload came from us; it
    // says nothing about WHEN. Anyone who can answer for a mirror, or sit on the
    // path to one, can replay an OLD signed payload and walk this install back
    // onto a relay set we retired months ago — no forgery, just an old truth
    // served late. The updater was never exposed to this because it compares
    // against the installed version; this list had no such check.
    if let (Some(v), Some(floor)) = (version, min_version) {
        if v < floor {
            return None;
        }
    }

    let sources = root
        .get("sources")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| match e.get("type").and_then(Value::as_str).unwrap_or("https") {
                    "https" => e
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|u| u.starts_with("https://"))
                        .map(|u| Source::Https(u.to_owned())),
                    "dns-txt" => e
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|n| !n.is_empty())
                        .map(|n| Source::DnsTxt(n.to_owned())),
                    // A channel this build cannot speak; the rest stays usable.
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();

    Some(RelayConfig {
        version,
        relays: relays.into_iter().map(|(_, r)| r).collect(),
        sources,
    })
}

#[cfg(test)]
pub(crate) fn canonical_for_test(v: &Value, out: &mut String) {
    canonical(v, out)
}

/// Canonical JSON, byte-for-byte what the Python signer produces with
/// `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
///
/// Keys are sorted explicitly rather than relying on serde_json's map order:
/// with the `preserve_order` feature on anywhere in the tree, that order is
/// insertion order and every signature would fail.
fn canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                canonical(&map[key.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(item, out);
            }
            out.push(']');
        }
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // The payload carries only integers, which serialize identically in
        // both languages. A float would not be safe to assume that about.
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => write_string(s, out),
    }
}

// serde_json escapes the same set Python does with ensure_ascii=False: quotes,
// backslash, the \b \f \n \r \t shortcuts, other control chars as \u00xx, and
// slashes and non-ASCII left alone.
fn write_string(s: &str, out: &mut String) {
    out.push_str(&Value::String(s.to_owned()).to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_payload_verifies() {
        let config = verify_and_parse(BUNDLED, None).expect("bundled payload must verify");
        assert!(!config.relays.is_empty());
    }

    #[test]
    fn relays_come_back_in_priority_order() {
        let config = verify_and_parse(BUNDLED, None).unwrap();
        let root: Value = serde_json::from_str(BUNDLED).unwrap();
        let mut expected: Vec<(i64, String)> = root["relays"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["priority"].as_i64().unwrap_or(100),
                    r["tag"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        expected.sort_by_key(|(p, _)| *p);
        let got: Vec<String> = config.relays.iter().map(|r| r.tag.clone()).collect();
        assert_eq!(got, expected.into_iter().map(|(_, t)| t).collect::<Vec<_>>());
    }

    #[test]
    fn a_tampered_payload_is_rejected() {
        let mut root: Value = serde_json::from_str(BUNDLED).unwrap();
        root["relays"][0]["server"] = Value::String("127.0.0.1".into());
        assert!(verify_and_parse(&root.to_string(), None).is_none());
    }

    #[test]
    fn an_unsigned_payload_is_rejected() {
        let mut root: Value = serde_json::from_str(BUNDLED).unwrap();
        root.as_object_mut().unwrap().remove("sig");
        assert!(verify_and_parse(&root.to_string(), None).is_none());
    }

    #[test]
    fn canonical_json_sorts_keys_and_stays_compact() {
        let value: Value = serde_json::from_str(r#"{"b":1,"a":{"d":[1,2],"c":"x/y"}}"#).unwrap();
        let mut out = String::new();
        canonical(&value, &mut out);
        assert_eq!(out, r#"{"a":{"c":"x/y","d":[1,2]},"b":1}"#);
    }
}
