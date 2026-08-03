#!/usr/bin/env python3
"""Package, sign, publish and verify the desktop updater artifacts.

The update signing key deliberately stays off CI (the repo is public and this
key is remote code execution on every install, with no way to rotate it for
already-shipped binaries). So CI produces plain installers and this script does
the updater half locally, in one pass, from the assets of a GitHub release.

    gh release download v0.1.4 --repo rcq-messenger/rcq-desktop --dir dl
    scripts/publish-desktop-update.py --version 0.1.4 --assets dl

See DESKTOP.md for what the manifest keys mean and why each format needs one.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
KEY = Path.home() / ".rcq/desktop-updater/rcq-desktop.key"
PUBKEY = Path.home() / ".rcq/desktop-updater/rcq-desktop.key.pub"
HOST = "root@165.232.69.229"
REMOTE = "/var/www/rcq/desktop"
BASE_URL = "https://rcq.app/desktop"

# hosted name -> glob that finds it among the CI release assets. macOS is not
# here: we build and Developer-ID-sign it locally, so it comes from the local
# bundle. The AppImage archive is built below, so it has no pattern either.
ASSETS = {
    "RCQ-windows-setup.exe": "*_x64-setup.exe",
    "RCQ-windows.msi": "*_x64*.msi",
    "RCQ-linux.deb": "*_amd64.deb",
    "RCQ-linux.rpm": "*.x86_64.rpm",
    "RCQ-linux.AppImage": "*_amd64.AppImage",
}

MACOS_ARCHIVE = REPO / "src-tauri/target/release/bundle/macos/RCQ.app.tar.gz"

# The plugin looks up "{os}-{arch}-{installer}" first and falls back to
# "{os}-{arch}". The Linux fallback must be the AppImage: a binary whose bundle
# type went undetected takes the AppImage install path and no other.
PLATFORMS = {
    "darwin-aarch64": "RCQ.app.tar.gz",
    "windows-x86_64-nsis": "RCQ-windows-setup.exe",
    "windows-x86_64-msi": "RCQ-windows.msi",
    "windows-x86_64": "RCQ-windows-setup.exe",
    "linux-x86_64-appimage": "RCQ-linux.AppImage.tar.gz",
    "linux-x86_64-deb": "RCQ-linux.deb",
    "linux-x86_64-rpm": "RCQ-linux.rpm",
    "linux-x86_64": "RCQ-linux.AppImage.tar.gz",
}


def die(msg):
    sys.exit(f"error: {msg}")


def collect(assets_dir, macos_archive, work):
    """Copy the CI assets and the local macOS archive to their hosted names."""
    for name, pattern in ASSETS.items():
        found = sorted(assets_dir.glob(pattern))
        if len(found) != 1:
            die(f"{pattern!r} matched {len(found)} files in {assets_dir}, expected 1")
        shutil.copy2(found[0], work / name)
        print(f"  {found[0].name} -> {name}")

    if not macos_archive.exists():
        die(f"no macOS archive at {macos_archive} — run npm run desktop:build first")
    shutil.copy2(macos_archive, work / "RCQ.app.tar.gz")
    print(f"  {macos_archive.name} -> RCQ.app.tar.gz (local signed build)")


def pack_appimage(work):
    """Wrap the AppImage in the .tar.gz the updater expects.

    Written with tarfile rather than the `tar` binary on purpose: macOS bsdtar
    prepends a pax header entry named PaxHeader/<name>.AppImage, and the
    updater picks its payload by the .AppImage extension.
    """
    src = work / "RCQ-linux.AppImage"
    out = work / "RCQ-linux.AppImage.tar.gz"
    with tarfile.open(out, "w:gz", format=tarfile.GNU_FORMAT) as tar:
        tar.add(src, arcname=src.name)

    with tarfile.open(out) as tar:
        names = tar.getnames()
    if names != [src.name]:
        die(f"archive should hold exactly {src.name}, holds {names}")
    print(f"  packed {out.name} ({out.stat().st_size / 1e6:.1f} MB), one entry")


def sign(work, names):
    env = {
        **os.environ,
        "TAURI_SIGNING_PRIVATE_KEY_PATH": str(KEY),
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD": "",
    }
    for name in names:
        subprocess.run(
            ["npx", "tauri", "signer", "sign", str(work / name)],
            cwd=REPO, env=env, check=True, capture_output=True,
        )
        print(f"  signed {name}")


def verify(data: bytes, signature: str) -> bool:
    """Verify a tauri signature exactly as tauri-plugin-updater does."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    pub = base64.b64decode(PUBKEY.read_bytes()).decode().splitlines()[1]
    pub = base64.b64decode(pub)
    key = Ed25519PublicKey.from_public_bytes(pub[10:])

    lines = base64.b64decode(signature).decode().splitlines()
    body = base64.b64decode(lines[1])
    alg, key_id, sig = body[:2], body[2:10], body[10:]
    trusted = lines[2].split("trusted comment: ", 1)[1]
    global_sig = base64.b64decode(lines[3])

    if key_id != pub[2:10]:
        return False
    message = hashlib.blake2b(data, digest_size=64).digest() if alg == b"ED" else data
    try:
        key.verify(sig, message)
        key.verify(global_sig, sig + trusted.encode())
    except InvalidSignature:
        return False
    return True


def manifest(work, version, notes, pub_date):
    platforms = {}
    for target, name in PLATFORMS.items():
        signature = (work / f"{name}.sig").read_text().strip()
        if not verify((work / name).read_bytes(), signature):
            die(f"{name}: signature does not verify against {PUBKEY.name}")
        platforms[target] = {"signature": signature, "url": f"{BASE_URL}/{name}"}
        print(f"  ok {target:24s} {name}")
    return {
        "version": version,
        "notes": notes,
        "pub_date": pub_date,
        "platforms": platforms,
    }


def upload(work, version, names):
    previous = subprocess.run(
        ["ssh", HOST, f"python3 -c \"import json;print(json.load(open('{REMOTE}/latest.json'))['version'])\""],
        capture_output=True, text=True,
    ).stdout.strip() or "prev"
    suffix = f".bak-v{previous.replace('.', '')}"

    subprocess.run(
        ["ssh", HOST,
         f"cd {REMOTE} && for f in {' '.join(names)} latest.json; do "
         f"[ -f \"$f\" ] && cp -a \"$f\" \"$f{suffix}\"; done; true"],
        check=True,
    )
    print(f"  backed up as *{suffix}")

    subprocess.run(
        ["rsync", "-az", *[str(work / n) for n in names], work / "latest.json",
         f"{HOST}:{REMOTE}/"],
        check=True,
    )
    subprocess.run(
        ["ssh", HOST, f"cd {REMOTE} && chown www-data:www-data * && chmod 644 *"],
        check=True,
    )
    print(f"  uploaded {len(names)} files + latest.json")


def verify_live():
    """Re-check every entry over the public URLs, the way a client would."""
    live = json.loads(urllib.request.urlopen(f"{BASE_URL}/latest.json").read())
    cache, bad = {}, 0
    for target, entry in live["platforms"].items():
        url = entry["url"]
        if url not in cache:
            with urllib.request.urlopen(url) as resp:
                expected = int(resp.headers["content-length"])
                cache[url] = resp.read()
            if len(cache[url]) != expected:
                die(f"{url}: got {len(cache[url])} of {expected} bytes")
        ok = verify(cache[url], entry["signature"])
        bad += not ok
        print(f"  {'ok' if ok else 'FAIL':4s} {target:24s} {len(cache[url]) / 1e6:6.1f} MB")
    if bad:
        die(f"{bad} live entries do not verify")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--version", required=True, help="release version, e.g. 0.1.4")
    ap.add_argument("--assets", required=True, type=Path, help="dir of GitHub release assets")
    ap.add_argument("--notes-file", type=Path, help="release notes shown in the manifest")
    ap.add_argument("--macos-archive", type=Path, default=MACOS_ARCHIVE,
                    help="locally built + signed RCQ.app.tar.gz")
    ap.add_argument("--pub-date", help="RFC3339; defaults to now")
    ap.add_argument("--no-upload", action="store_true", help="stop after writing latest.json")
    args = ap.parse_args()

    for path in (KEY, PUBKEY):
        if not path.exists():
            die(f"missing {path}")

    work = Path(tempfile.mkdtemp(prefix="rcq-update-"))
    names = list(ASSETS) + ["RCQ-linux.AppImage.tar.gz", "RCQ.app.tar.gz"]
    notes = args.notes_file.read_text().strip() if args.notes_file else ""
    pub_date = args.pub_date or (
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    )

    print("collecting assets")
    collect(args.assets, args.macos_archive, work)
    print("packing the AppImage")
    pack_appimage(work)
    print("signing")
    sign(work, names)
    print("building latest.json")
    (work / "latest.json").write_text(
        json.dumps(manifest(work, args.version, notes, pub_date),
                   ensure_ascii=False, indent=2) + "\n"
    )

    if args.no_upload:
        print(f"\nready in {work} (not uploaded)")
        return
    print("uploading")
    upload(work, args.version, names)
    print("verifying the live manifest")
    verify_live()
    print(f"\n{args.version} published, {len(PLATFORMS)} platforms verified")


if __name__ == "__main__":
    main()
