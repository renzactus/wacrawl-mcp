#!/bin/bash
# Builds a dedicated copy of node for THIS server, in runtime/: a copy of yours if you have
# Node.js 18 or newer, otherwise the official build, downloaded from nodejs.org and checked
# against its published checksum. Either way, you don't need to install Node.js.
#
# Why: macOS asks the responsible process for permission, and that's node (Claude
# Desktop launches it through Helpers/disclaimer, which cuts off permission
# inheritance). If you give access to the shared node, EVERYTHING that runs with node
# inherits it — including, say, an `npx -y some-mcp-server` that downloads from npm on
# every start.
#
# With its own copy, the permission stays limited to this server. And since the path is
# stable, it isn't lost when Homebrew updates node.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/runtime"
fail() { echo "✗ $*" >&2; exit 1; }

SRC="$(command -v node || true)"
[ -n "$SRC" ] && SRC="$(readlink -f "$SRC")"

if [ -n "$SRC" ] && [ "$("$SRC" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then
  rm -rf "$DIR"; mkdir -p "$DIR/bin" "$DIR/lib"
  cp "$SRC" "$DIR/bin/node"

  # Homebrew's node isn't self-contained: it loads libnode through @rpath from ../lib
  PREFIX="$(dirname "$(dirname "$SRC")")"
  for lib in "$PREFIX"/lib/libnode.*.dylib; do
    [ -f "$lib" ] && cp "$lib" "$DIR/lib/"
  done
else
  # No Node.js, or one too old: the latest official build of the LTS line this server is
  # tested with. It's self-contained, so the binary alone is enough.
  NODE_LINE=26
  case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) fail "Unsupported architecture: $(uname -m)" ;; esac
  BASE="https://nodejs.org/dist/latest-v$NODE_LINE.x"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt" || fail "Couldn't reach nodejs.org. Check your connection and try again."
  ASSET="$(grep -oE "node-v[0-9.]+-darwin-$ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1 || true)"
  [ -n "$ASSET" ] || fail "nodejs.org doesn't list a Node.js $NODE_LINE build for this Mac."
  echo "  downloading ${ASSET%.tar.gz} from nodejs.org, just for this server…" >&2
  curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET" || fail "Couldn't download $ASSET."
  ( cd "$TMP" && grep " $ASSET\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null ) || fail "Checksum mismatch: not installing a binary that couldn't be verified."
  tar -xzf "$TMP/$ASSET" -C "$TMP" "${ASSET%.tar.gz}/bin/node"
  rm -rf "$DIR"; mkdir -p "$DIR/bin"
  cp "$TMP/${ASSET%.tar.gz}/bin/node" "$DIR/bin/node"
fi

"$DIR/bin/node" --version >/dev/null || fail "The copy doesn't start"

echo "✓ Dedicated runtime ready: $("$DIR/bin/node" --version), $(du -sh "$DIR" | cut -f1)"
echo
echo "Give Full Disk Access ONLY to this path"
echo "(System Settings → Privacy & Security → Full Disk Access, ⌘⇧G to paste it):"
echo
echo "  $DIR/bin/node"
