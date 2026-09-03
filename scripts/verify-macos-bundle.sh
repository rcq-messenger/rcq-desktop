#!/usr/bin/env bash
#
# The gate that 0.3.55 needed and did not have.
#
# ⚠⚠ WHY THIS EXISTS. On 2026-09-03 the macOS universal build shipped with an
# arm64 half that contained NO frontend: no /index.html, no /assets/*, only the
# files copied from public/. Every Apple Silicon user who took the update got a
# window saying "asset not found: index.html"; Intel and Rosetta ran the SAME
# FILE fine. `vite build` empties dist/, copies public/ first and writes
# index.html + assets/ LAST, so a build that compiled a slice inside that window
# embeds a half-empty asset table - and cargo then reuses that object for every
# later build until the target dir is cleared.
#
# ⚠ It was invisible to every check that was actually run: signature, universal
# architectures, sha256 against the served copy, and grepping the FAT binary for
# asset keys. The fat binary masks the asymmetry - the good slice's keys hide
# the bad slice's missing ones. The only checks that catch it look at EACH SLICE
# SEPARATELY, and open the app and look at it.
#
# Usage: scripts/verify-macos-bundle.sh path/to/RCQ.app
set -euo pipefail

APP=${1:?usage: verify-macos-bundle.sh path/to/RCQ.app}
BIN="$APP/Contents/MacOS/app"
[[ -f "$BIN" ]] || { echo "no binary at $BIN" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail=0
say() { printf '  %-6s %s\n' "$1" "$2"; }

echo "==> architectures"
ARCHS=$(lipo -archs "$BIN")
say "info" "$ARCHS"
for want in x86_64 arm64; do
    if [[ " $ARCHS " == *" $want "* ]]; then say "ok" "$want present"
    else say "FAIL" "$want missing"; fail=1; fi
done

echo "==> frontend assets, PER SLICE (this is the check that was missing)"
for arch in $ARCHS; do
    lipo -thin "$arch" "$BIN" -output "$TMP/$arch" 2>/dev/null || { say "FAIL" "$arch: cannot thin"; fail=1; continue; }
    # Tauri stores asset keys with a leading slash in __TEXT.__const.
    assets=$(strings -a "$TMP/$arch" | grep -cE '^/assets/' || true)
    index=$(strings -a "$TMP/$arch" | grep -cE '^/index\.html$' || true)
    if [[ "$assets" -gt 0 && "$index" -gt 0 ]]; then
        say "ok" "$arch: /index.html + $assets /assets/* keys"
    else
        say "FAIL" "$arch: /index.html=$index /assets/*=$assets  <- THE 0.3.55 BUG"
        fail=1
    fi
done

echo "==> embedded blob size, slice against slice"
# ⚠ The strongest signal, and screen-independent: the asset table lives in
# __TEXT.__const, so a slice that embedded no frontend is visibly SHORTER. On
# the broken 0.3.55 arm64 was 660 KB smaller than x86_64; on a good build the
# two are within a few tens of KB of each other.
prev_name=""; prev_size=0
for arch in $ARCHS; do
    size=$(otool -l "$TMP/$arch" | grep -A4 "sectname __const" | grep -m1 "size" | awk '{print $2}')
    size=$((size))
    say "info" "$arch: __TEXT.__const = $size"
    if [[ -n "$prev_name" ]]; then
        diff=$(( size > prev_size ? size - prev_size : prev_size - size ))
        if [[ $diff -gt 262144 ]]; then
            say "FAIL" "$prev_name and $arch differ by $diff bytes - one slice is missing content"
            fail=1
        else
            say "ok" "slices agree (differ by $diff bytes)"
        fi
    fi
    prev_name=$arch; prev_size=$size
done

echo "==> signature"
if codesign -v --deep --strict "$APP" 2>/dev/null; then say "ok" "signature verifies"
else say "FAIL" "signature does not verify"; fail=1; fi
# ⚠ Read it into a variable first. Under `set -o pipefail` this was
# `codesign ... | grep -q`, and `grep -q` exits the moment it matches, which
# SIGPIPEs codesign, which fails the pipeline, which sends a correctly signed
# app down the else branch: 0.3.58 is Developer ID signed and this said it was
# not. A gate that cries wolf about the signature is a gate you stop reading.
sig=$(codesign -dv --verbose=2 "$APP" 2>&1 || true)
if grep -q "Developer ID Application" <<<"$sig"; then
    say "ok" "Developer ID"
else say "warn" "not Developer-ID signed"; fi

echo
if [[ $fail -eq 0 ]]; then
    echo "PASS - and still open it and LOOK at the window before publishing."
    echo "       open -n \"$APP\"   # a good build shows the app, not a line of text"
else
    echo "FAIL - do not publish this bundle."
fi
exit $fail
