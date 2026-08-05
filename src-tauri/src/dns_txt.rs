//! Reading a signed payload out of a DNS TXT record over DoH. Mirrors Android
//! `DnsTxt.kt` and iOS `DnsTxt.swift`.
//!
//! The relay list reaches clients over exactly two names. Block both and no push
//! of ours arrives again — including the one that would hand out a working
//! mirror. A TXT record read over DoH does not depend on either name: it rides a
//! resolver that is reachable because half the internet needs it to be.
//!
//! A resolver cannot forge what it serves. The payload is signed, so a hostile
//! or compelled resolver can only withhold it or replay an old one, and replay
//! is what the version floor refuses. That is what makes it reasonable to ask a
//! DOMESTIC resolver, which is often the only one answering on the networks this
//! exists for. What it does leak is that this machine asked for our name, so the
//! query rides the tunnel when one is up, exactly like the HTTPS mirrors.
//!
//! Wire format is RFC 8484 rather than any resolver's JSON API, because the JSON
//! one is Cloudflare's and Google's alone — and those two are the most likely to
//! be unreachable precisely where this matters.

/// Records we published carry this, so a name that also holds SPF or a
/// verification string yields ours without guessing.
const PREFIX: &str = "rcq1:";

const TYPE_TXT: u16 = 16;
const CLASS_IN: u16 = 1;

/// A DNS answer is small; anything larger is not one.
const MAX_RESPONSE: usize = 64 * 1024;

/// DoH endpoints, tried in order, addressed by IP.
///
/// By IP on purpose. Asking a resolver by NAME means resolving that name through
/// ordinary DNS first — the very thing being tampered with on the networks this
/// channel exists for. Their certificates carry the addresses in the SAN, so
/// verification is unaffected.
///
/// ⚠ This list first read `common.dns.yandex.net`, which does not exist: the one
/// resolver included because it answers inside RU would never have returned
/// anything. All four below were checked live against a published record.
///
/// A resolver cannot forge a signed payload, so one that answers beats one that
/// does not — hence the domestic entry, and four jurisdictions.
pub const RESOLVERS: [&str; 4] = [
    "https://1.1.1.1/dns-query",   // Cloudflare
    "https://77.88.8.8/dns-query", // Yandex — answers inside RU
    "https://8.8.8.8/dns-query",   // Google
    "https://9.9.9.9/dns-query",   // Quad9
];

/// Fetch and reassemble the payload published at `name`.
///
/// A single record's character-strings arrive in order, which is why the whole
/// payload goes in ONE record: order ACROSS records is not guaranteed by DNS, so
/// a payload split over several could reassemble into garbage.
pub fn fetch(name: &str, client: &reqwest::blocking::Client) -> Option<String> {
    let query = build_query(name)?;
    for resolver in RESOLVERS {
        let Ok(resp) = client
            .post(resolver)
            .header("Content-Type", "application/dns-message")
            .header("Accept", "application/dns-message")
            .body(query.clone())
            .send()
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(bytes) = resp.bytes() else { continue };
        if bytes.len() > MAX_RESPONSE {
            continue;
        }
        if let Some(value) = parse_txt(&bytes) {
            return Some(value);
        }
    }
    None
}

/// A minimal query: one question, recursion desired, ID zero as RFC 8484 asks
/// (a cached DoH response must not be keyed on a random id).
pub fn build_query(name: &str) -> Option<Vec<u8>> {
    let labels: Vec<&str> = name.trim_matches('.').split('.').collect();
    if labels.is_empty() || labels.iter().any(|l| l.is_empty() || l.len() > 63) {
        return None;
    }
    let mut out = Vec::with_capacity(32 + name.len());
    for v in [0u16, 0x0100, 1, 0, 0, 0] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    for label in labels {
        if !label.is_ascii() {
            return None;
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&TYPE_TXT.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    Some(out)
}

/// Pull our payload out of a DNS response, or None when it is not there.
///
/// Every failure is a None rather than an error: this parses bytes from a
/// resolver we do not control, on a path whose whole purpose is to be tried when
/// other things are already broken, and the caller's next move is the next
/// source.
pub fn parse_txt(msg: &[u8]) -> Option<String> {
    if msg.len() < 12 {
        return None;
    }
    let u16_at = |at: usize| -> Option<usize> {
        if at + 1 >= msg.len() {
            None
        } else {
            Some(((msg[at] as usize) << 8) | msg[at + 1] as usize)
        }
    };
    let answers = u16_at(6)?;
    if answers == 0 {
        return None;
    }

    let mut pos = 12usize;
    let questions = u16_at(4)?;
    for _ in 0..questions {
        pos = skip_name(msg, pos)? + 4;
    }

    for _ in 0..answers {
        pos = skip_name(msg, pos)?;
        if pos + 10 > msg.len() {
            return None;
        }
        let rtype = u16_at(pos)?;
        let rd_length = u16_at(pos + 8)?;
        pos += 10;
        if pos + rd_length > msg.len() {
            return None;
        }
        if rtype == TYPE_TXT as usize {
            // Character-strings, each length-prefixed, concatenated in the order
            // the record carries them.
            let mut text = String::new();
            let mut p = pos;
            let end = pos + rd_length;
            while p < end {
                let len = msg[p] as usize;
                if p + 1 + len > end {
                    return None;
                }
                text.push_str(std::str::from_utf8(&msg[p + 1..p + 1 + len]).ok()?);
                p += 1 + len;
            }
            if let Some(stripped) = text.strip_prefix(PREFIX) {
                return Some(stripped.to_owned());
            }
        }
        pos += rd_length;
    }
    None
}

/// Advance past a NAME, which may end in a compression pointer. Returns None on
/// a malformed one rather than following it, since a pointer chain from an
/// untrusted response is a loop waiting to happen.
fn skip_name(msg: &[u8], start: usize) -> Option<usize> {
    let mut pos = start;
    loop {
        let len = *msg.get(pos)? as usize;
        if len == 0 {
            return Some(pos + 1);
        }
        if len & 0xC0 == 0xC0 {
            return if pos + 2 <= msg.len() { Some(pos + 2) } else { None };
        }
        if len > 63 {
            return None;
        }
        pos += 1 + len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    /// A real Cloudflare answer for rcq.app: one TXT record, none of it ours.
    const RCQ_APP: &str = include_str!("../test-fixtures/doh-rcq-app.b64");
    /// A real Cloudflare answer for google.com: fifteen TXT records, none ours.
    /// This is the case that catches a parser returning the first record it
    /// finds rather than the one it was asked for.
    const GOOGLE: &str = include_str!("../test-fixtures/doh-google.b64");
    /// A response carrying our seed across five character-strings.
    const SEED: &str = include_str!("../test-fixtures/doh-seed.b64");
    /// The exact query bytes a live resolver answered.
    const LIVE_QUERY: &str = include_str!("../test-fixtures/doh-query.b64");

    fn bytes(b64: &str) -> Vec<u8> {
        B64.decode(b64.trim()).unwrap()
    }

    #[test]
    fn builds_the_query_a_resolver_actually_answered() {
        assert_eq!(build_query("rcq.app").unwrap(), bytes(LIVE_QUERY));
    }

    #[test]
    fn rejects_names_that_cannot_be_encoded() {
        assert!(build_query("a..b").is_none());
        assert!(build_query(&format!("{}.example.com", "x".repeat(64))).is_none());
    }

    #[test]
    fn reassembles_a_seed_split_across_character_strings() {
        let value = parse_txt(&bytes(SEED)).expect("seed record must be found");
        let json = String::from_utf8(B64.decode(value).unwrap()).unwrap();
        // The whole point: what comes off DNS goes through the SAME verifier as
        // anything fetched over HTTPS, with no special case for its origin.
        let config = crate::relay::verify_and_parse(&json, None).expect("seed must verify");
        assert_eq!(config.relays.len(), 3);
        assert_eq!(config.version, Some(131));
    }

    #[test]
    fn ignores_txt_records_that_are_not_ours() {
        assert!(parse_txt(&bytes(RCQ_APP)).is_none());
        assert!(parse_txt(&bytes(GOOGLE)).is_none());
    }

    #[test]
    fn survives_garbage_from_a_resolver_it_does_not_control() {
        assert!(parse_txt(&[]).is_none());
        assert!(parse_txt(&[0u8; 11]).is_none());
        assert!(parse_txt(&bytes(SEED)[..30]).is_none());
    }
}
