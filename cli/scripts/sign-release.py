#!/usr/bin/env python3
"""Sign a built rcq.tar.gz for release.

The console client is one file people unpack and run, downloaded over a
network this project assumes is hostile. Until 0.2.16 nothing tied that
archive to us: whoever could answer the download could hand over a different
client, and it would install itself with `rcq update`.

    python3 cli/scripts-sign-release.py /path/to/rcq.tar.gz

Writes <archive>.sig, base64 of an Ed25519 signature over the archive's exact
bytes. Upload both to the GitHub release; `rcq update` refuses an archive
whose signature is missing or wrong.

⚠ The key lives on the maintainer's machine (~/.rcq/cli_signing/private.pem)
and never in CI. A key CI holds proves that CI built something, which is not
the question anybody is asking.
"""

import base64
import pathlib
import sys

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

KEY = pathlib.Path.home() / ".rcq/cli_signing/private.pem"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    archive = pathlib.Path(sys.argv[1])
    if not archive.is_file():
        print(f"no such archive: {archive}", file=sys.stderr)
        return 1
    if not KEY.is_file():
        print(f"no signing key at {KEY}", file=sys.stderr)
        return 1
    key = serialization.load_pem_private_key(KEY.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        print(f"key at {KEY} is not Ed25519", file=sys.stderr)
        return 1
    sig = key.sign(archive.read_bytes())
    out = archive.with_suffix(archive.suffix + ".sig")
    out.write_text(base64.b64encode(sig).decode("ascii") + "\n")
    pub = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    print(f"signed {archive.name} -> {out.name}")
    print(f"public key (must match RELEASE_PUBKEY_B64 in update-check.ts): {base64.b64encode(pub).decode()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
