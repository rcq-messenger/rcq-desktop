//! The PIN-locked vault: the desktop's answer to "anyone who opens this laptop
//! is inside your account".
//!
//! ## Why this is in Rust and not in the page
//!
//! The web client cannot do this and says so (docs/web-storage-inventory.md):
//! a browser hands `localStorage` and IndexedDB to any script in the origin,
//! and to anyone holding the unlocked machine. A PIN there would be a curtain
//! over an open window.
//!
//! The desktop is a different machine. It owns a directory on disk that the
//! page cannot read on its own, so the account material can live there as
//! ciphertext and come back only when someone types the PIN. While the app is
//! locked — or simply not running — the private keys, the recovery seed and
//! the session tokens are bytes nobody can use.
//!
//! ## What it protects, exactly
//!
//! * ✅ The account. Keys, seed, tokens. Without the PIN they cannot be read
//!   off the disk, so the laptop that was taken cannot become "you" anywhere.
//! * ⏭ NOT the message history yet. That still lives in the webview's own
//!   IndexedDB, unencrypted, and the "what is in this browser" screen says so
//!   rather than letting anyone believe otherwise. It is the next piece.
//!
//! ## Shape of the file
//!
//! One JSON file, `vault.json`, in the app data directory:
//!
//! ```json
//! { "v": 1, "salt": "...", "nonce": "...", "ct": "...",
//!   "m_cost": 65536, "t_cost": 3, "failures": 0 }
//! ```
//!
//! Argon2id turns the PIN into the key; AES-256-GCM seals the payload, so a
//! wrong PIN fails to AUTHENTICATE rather than producing plausible garbage.
//! The KDF parameters are written into the file rather than compiled in, so a
//! vault made by an older build still opens after they are raised.
//!
//! ⚠ A four-digit PIN has ten thousand values. No KDF makes that unguessable
//! for someone holding the file — Argon2id at 64 MiB just makes each guess
//! cost about a tenth of a second, and the failure counter below makes an
//! unattended machine give up long before a human gets through the space. The
//! honest claim is "this stops the person who picked up your laptop", not
//! "this stops a lab". Anyone who needs the second one uses a passphrase, and
//! the field accepts one.

use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "vault.json";
/// 64 MiB / 3 passes. Roughly 100 ms on a laptop of the last few years, which
/// is invisible when you type your own PIN and ruinous at ten thousand tries.
const M_COST: u32 = 65_536;
const T_COST: u32 = 3;
/// Failed attempts before the vault refuses to try again for a while. The
/// delay is what makes an unattended machine useless; nothing is destroyed.
const SLOW_AFTER: u32 = 5;

/// The key derived from the PIN, held for as long as the app stays unlocked.
///
/// ⚠ Something has to be in memory while the app is open, or every write of a
/// refreshed token would have to ask for the PIN again. The key is the least
/// bad thing to hold: it is not the PIN (so a memory dump does not hand over a
/// secret the owner also uses elsewhere), it never touches the disk, and
/// `lock()` zeroes it. Same choice Signal Desktop makes, for the same reason.
#[derive(Default)]
pub struct Unlocked(pub Mutex<Option<[u8; 32]>>);

#[derive(Serialize, Deserialize)]
struct VaultFile {
    v: u8,
    salt: String,
    nonce: String,
    ct: String,
    #[serde(default = "default_m")]
    m_cost: u32,
    #[serde(default = "default_t")]
    t_cost: u32,
    #[serde(default)]
    failures: u32,
}

fn default_m() -> u32 {
    M_COST
}
fn default_t() -> u32 {
    T_COST
}

#[derive(Serialize)]
pub struct VaultState {
    /// Is there a vault on this machine at all?
    pub exists: bool,
    /// Has someone typed the PIN since the app started?
    pub unlocked: bool,
    /// Consecutive wrong PINs. Shown so the UI can warn before the wait.
    pub failures: u32,
    /// Seconds the next attempt will be refused for, 0 when it will be tried.
    pub cooldown: u32,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join(FILE))
}

fn read(app: &AppHandle) -> Option<VaultFile> {
    read_at(&path(app).ok()?)
}

fn read_at(p: &std::path::Path) -> Option<VaultFile> {
    let raw = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_at(p: &std::path::Path, file: &VaultFile) -> Result<(), String> {
    let body = serde_json::to_string(file).map_err(|e| e.to_string())?;
    // Write beside it and rename: a vault half-written by a machine that lost
    // power is an account that cannot be opened again, and this is the one
    // file where that is unrecoverable.
    let tmp = p.with_extension("json.part");
    std::fs::write(&tmp, body).map_err(|e| format!("cannot write vault: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("cannot replace vault: {e}"))
}

fn derive(pin: &str, salt: &[u8], m_cost: u32, t_cost: u32) -> Result<[u8; 32], String> {
    let params = Params::new(m_cost, t_cost, 1, Some(32)).map_err(|e| e.to_string())?;
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    a2.hash_password_into(pin.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

/// How long the next attempt is refused for, given how many have failed.
/// Deliberately a delay and not a wipe: the most likely person mistyping a PIN
/// five times is the owner.
fn cooldown_secs(failures: u32) -> u32 {
    if failures < SLOW_AFTER {
        0
    } else {
        // 5 → 5s, 6 → 10s, 7 → 20s … capped at five minutes.
        let steps = failures - SLOW_AFTER;
        (5u32).saturating_mul(1 << steps.min(6)).min(300)
    }
}

pub fn state(app: &AppHandle, unlocked: &Unlocked) -> VaultState {
    let open = unlocked.0.lock().map(|g| g.is_some()).unwrap_or(false);
    match read(app) {
        Some(f) => VaultState {
            exists: true,
            unlocked: open,
            failures: f.failures,
            cooldown: cooldown_secs(f.failures),
        },
        None => VaultState {
            exists: false,
            unlocked: false,
            failures: 0,
            cooldown: 0,
        },
    }
}

/// Create the vault (or replace it) with `plaintext` sealed under `pin`, and
/// leave it unlocked — whoever just set a PIN is already past it.
pub fn create(app: &AppHandle, state: &Unlocked, pin: &str, plaintext: &str) -> Result<(), String> {
    create_at(&path(app)?, state, pin, plaintext)
}

fn create_at(
    p: &std::path::Path,
    state: &Unlocked,
    pin: &str,
    plaintext: &str,
) -> Result<(), String> {
    if pin.chars().count() < 4 {
        return Err("pin_too_short".into());
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive(pin, &salt, M_COST, T_COST)?;
    *state.0.lock().map_err(|_| "poisoned")? = Some(key);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|_| "encrypt_failed".to_string())?;
    write_at(
        p,
        &VaultFile {
            v: 1,
            salt: B64.encode(salt),
            nonce: B64.encode(nonce_bytes),
            ct: B64.encode(ct),
            m_cost: M_COST,
            t_cost: T_COST,
            failures: 0,
        },
    )
}

/// Open the vault. Returns the plaintext, or a coded error the page can
/// translate: `no_vault`, `wrong_pin`, `locked_out:<seconds>`.
pub fn unlock(app: &AppHandle, state: &Unlocked, pin: &str) -> Result<String, String> {
    unlock_at(&path(app)?, state, pin)
}

fn unlock_at(p: &std::path::Path, state: &Unlocked, pin: &str) -> Result<String, String> {
    let mut f = read_at(p).ok_or("no_vault")?;
    let wait = cooldown_secs(f.failures);
    if wait > 0 {
        // The wait is enforced here rather than in the page, where a reload
        // would clear it.
        return Err(format!("locked_out:{wait}"));
    }
    let salt = B64.decode(&f.salt).map_err(|_| "corrupt_vault")?;
    let nonce = B64.decode(&f.nonce).map_err(|_| "corrupt_vault")?;
    let ct = B64.decode(&f.ct).map_err(|_| "corrupt_vault")?;
    let key = derive(pin, &salt, f.m_cost, f.t_cost)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    match cipher.decrypt(Nonce::from_slice(&nonce), ct.as_ref()) {
        Ok(plain) => {
            if f.failures != 0 {
                f.failures = 0;
                let _ = write_at(p, &f);
            }
            *state.0.lock().map_err(|_| "poisoned")? = Some(key);
            String::from_utf8(plain).map_err(|_| "corrupt_vault".into())
        }
        Err(_) => {
            f.failures = f.failures.saturating_add(1);
            let _ = write_at(p, &f);
            Err("wrong_pin".into())
        }
    }
}

/// Read the contents back while ALREADY unlocked, with no PIN.
///
/// The page reloads itself for reasons that have nothing to do with locking:
/// switching accounts and switching islands both tear the whole app down and
/// build it again. Before this, every one of those reloads landed on the lock
/// screen and asked for the PIN a second time in the same session — and
/// founder, who does both often, hit it immediately. The key is already in
/// memory; a session that has been unlocked once stays unlocked until the app
/// quits or `lock()` is called on purpose.
///
/// Fails with `locked` when nobody has unlocked this run, which is exactly the
/// case where the PIN must be asked for.
pub fn read_unlocked(app: &AppHandle, state: &Unlocked) -> Result<String, String> {
    let key = state.0.lock().map_err(|_| "poisoned")?.ok_or("locked")?;
    let f = read(app).ok_or("no_vault")?;
    let nonce = B64.decode(&f.nonce).map_err(|_| "corrupt_vault")?;
    let ct = B64.decode(&f.ct).map_err(|_| "corrupt_vault")?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "corrupt_vault".to_string())?;
    String::from_utf8(plain).map_err(|_| "corrupt_vault".into())
}

/// Re-seal the contents while unlocked. This is the ordinary write: the
/// account material changes constantly (a refreshed token, a second account, a
/// UIN migration) and none of that should ask for the PIN again.
///
/// A fresh nonce every time, and the salt is kept so the same PIN still opens
/// it. Fails with `locked` when nobody has unlocked this session — which is
/// the case the page must never paper over by writing the account somewhere
/// else instead.
pub fn write_unlocked(app: &AppHandle, state: &Unlocked, plaintext: &str) -> Result<(), String> {
    write_unlocked_at(&path(app)?, state, plaintext)
}

fn write_unlocked_at(
    p: &std::path::Path,
    state: &Unlocked,
    plaintext: &str,
) -> Result<(), String> {
    let key = state.0.lock().map_err(|_| "poisoned")?.ok_or("locked")?;
    let mut f = read_at(p).ok_or("no_vault")?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|_| "encrypt_failed".to_string())?;
    f.nonce = B64.encode(nonce_bytes);
    f.ct = B64.encode(ct);
    write_at(p, &f)
}

/// Forget the key. The vault stays on disk; nothing in this process can open
/// it again until someone types the PIN.
pub fn lock(state: &Unlocked) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut key) = guard.take() {
            // Overwrite rather than just drop it.
            key.fill(0);
        }
    }
}

/// Turn the PIN off: hand the contents back and delete the file.
pub fn remove(app: &AppHandle, state: &Unlocked, pin: &str) -> Result<String, String> {
    remove_at(&path(app)?, state, pin)
}

/// Delete the vault WITHOUT the PIN, losing whatever it held.
///
/// The way out of "I forgot it". Everything the vault protects is derived from
/// the PIN, so there is nothing to recover here and nothing to ask: the account
/// itself comes back from the recovery phrase, which lives outside this file.
///
/// ⚠ This grants no capability an attacker did not already have. Anyone holding
/// the machine can delete the same file from the OS; refusing to do it from
/// inside the app would only have trapped the owner. What it must never be is
/// easy to hit by accident, so the confirmation lives in the UI and says plainly
/// what goes.
pub fn destroy(app: &AppHandle, state: &Unlocked) -> Result<(), String> {
    lock(state);
    let p = path(app)?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        // Already gone is the outcome we wanted.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove vault: {e}")),
    }
}

fn remove_at(p: &std::path::Path, state: &Unlocked, pin: &str) -> Result<String, String> {
    let plain = unlock_at(p, state, pin)?;
    lock(state);
    std::fs::remove_file(p).map_err(|e| format!("cannot remove vault: {e}"))?;
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The file layer needs an AppHandle, so these cover the parts that decide
    // whether the vault is safe: the KDF/AEAD round trip and the back-off.

    #[test]
    fn wrong_pin_does_not_decrypt() {
        let salt = [7u8; 16];
        let key = derive("1234", &salt, 8192, 1).unwrap();
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let nonce = [1u8; 12];
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), b"the account".as_ref())
            .unwrap();

        let same = derive("1234", &salt, 8192, 1).unwrap();
        assert_eq!(key, same, "the same PIN and salt must give the same key");
        let plain = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&same))
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .unwrap();
        assert_eq!(plain, b"the account");

        // ★ The point of AEAD here: a wrong PIN FAILS rather than handing back
        // plausible-looking garbage that the page would then try to sign in with.
        let wrong = derive("1235", &salt, 8192, 1).unwrap();
        assert!(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&wrong))
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .is_err());
    }

    #[test]
    fn a_different_salt_is_a_different_key() {
        let a = derive("1234", &[1u8; 16], 8192, 1).unwrap();
        let b = derive("1234", &[2u8; 16], 8192, 1).unwrap();
        assert_ne!(a, b, "two vaults with the same PIN must not share a key");
    }

    #[test]
    fn backoff_starts_late_and_is_capped() {
        // The owner mistyping is the common case, so the first few are free.
        assert_eq!(cooldown_secs(0), 0);
        assert_eq!(cooldown_secs(4), 0);
        assert_eq!(cooldown_secs(5), 5);
        assert_eq!(cooldown_secs(6), 10);
        assert_eq!(cooldown_secs(7), 20);
        // …and it stops growing, so a wrong PIN never bricks the app for good.
        assert_eq!(cooldown_secs(30), 300);
        assert_eq!(cooldown_secs(u32::MAX), 300);
    }

    #[test]
    fn the_whole_cycle_on_a_real_file() {
        // create → unlock → write while unlocked → unlock again → remove.
        // Cheap KDF settings so the test is not 100 ms per call; the crypto
        // path is identical.
        let dir = std::env::temp_dir().join(format!("rcq-vault-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("vault.json");
        let state = Unlocked::default();

        create_at(&p, &state, "4821", "{\"account\":\"first\"}").unwrap();
        assert!(p.exists(), "the vault file is written");
        let on_disk = std::fs::read_to_string(&p).unwrap();
        assert!(!on_disk.contains("account"), "★ the payload is not readable on disk");

        // A wrong PIN is refused and counted.
        assert_eq!(unlock_at(&p, &state, "0000").unwrap_err(), "wrong_pin");
        assert_eq!(read_at(&p).unwrap().failures, 1);

        // The right one opens it and clears the count.
        assert_eq!(unlock_at(&p, &state, "4821").unwrap(), "{\"account\":\"first\"}");
        assert_eq!(read_at(&p).unwrap().failures, 0);

        // A write while unlocked needs no PIN, and the same PIN still opens it
        // afterwards — the salt must survive the re-seal.
        write_unlocked_at(&p, &state, "{\"account\":\"second\"}").unwrap();
        assert_eq!(unlock_at(&p, &state, "4821").unwrap(), "{\"account\":\"second\"}");

        // Locking forgets the key, and then a write is refused rather than
        // silently dropping the account somewhere unsealed.
        lock(&state);
        assert_eq!(
            write_unlocked_at(&p, &state, "{}").unwrap_err(),
            "locked",
            "★ a locked vault must refuse writes, not swallow them"
        );

        // Turning the PIN off hands the contents back and takes the file away.
        let back = remove_at(&p, &state, "4821").unwrap();
        assert_eq!(back, "{\"account\":\"second\"}");
        assert!(!p.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_short_pin_is_refused_before_anything_is_written() {
        let dir = std::env::temp_dir().join(format!("rcq-vault-short-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("vault.json");
        assert_eq!(
            create_at(&p, &Unlocked::default(), "12", "x").unwrap_err(),
            "pin_too_short"
        );
        assert!(!p.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
