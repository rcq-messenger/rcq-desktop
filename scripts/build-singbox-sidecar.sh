#!/usr/bin/env bash
# Build the sing-box the desktop app bundles as a Tauri sidecar.
#
# Not committed to the repo: three platforms is ~80 MB of binary, and it would
# have to be re-committed on every bump. CI runs this before tauri-action; run
# it once locally before your first `npm run desktop:build`.
#
#   scripts/build-singbox-sidecar.sh                 # host platform only
#   scripts/build-singbox-sidecar.sh --all           # all three, Go cross-compiles
#
# The build tags are the two the relay pool actually needs: with_utls for
# VLESS+Reality, with_quic for Hysteria2. Upstream's default tag set drags in
# gvisor, wireguard, tailscale and more that we never configure.
set -euo pipefail

# Pinned upstream revision. Bump deliberately: this binary carries our users'
# traffic, so it should move when we have a reason, not when upstream tags.
REV="${SING_BOX_REV:-82e84f950cab3b215f4cfb4021a3f6ad0ec78fd1}"
TAGS="with_utls,with_quic"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/src-tauri/binaries"
src_dir="${SING_BOX_SRC:-$HOME/sing-box-src}"

if [ ! -d "$src_dir/cmd/sing-box" ]; then
  echo "cloning sing-box into $src_dir"
  git clone --filter=blob:none https://github.com/SagerNet/sing-box.git "$src_dir"
fi
git -C "$src_dir" fetch --quiet origin "$REV" 2>/dev/null || true
git -C "$src_dir" checkout --quiet "$REV"

mkdir -p "$out_dir"
version="1.13.0-rcq-${REV:0:7}"

build() { # goos goarch target-triple [.exe]
  local name="sing-box-$3${4:-}"
  echo "  $1/$2 -> $name"
  ( cd "$src_dir" && CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build \
      -tags "$TAGS" -trimpath \
      -ldflags "-s -w -X github.com/sagernet/sing-box/constant.Version=$version" \
      -o "$out_dir/$name" ./cmd/sing-box )
}

echo "building sing-box $version (tags: $TAGS)"
if [ "${1:-}" = "--all" ]; then
  build darwin arm64 aarch64-apple-darwin
  build linux amd64 x86_64-unknown-linux-gnu
  build windows amd64 x86_64-pc-windows-msvc .exe
else
  case "$(uname -s)" in
    Darwin) build darwin arm64 aarch64-apple-darwin ;;
    Linux)  build linux amd64 x86_64-unknown-linux-gnu ;;
    *)      build windows amd64 x86_64-pc-windows-msvc .exe ;;
  esac
fi

ls -la "$out_dir"
