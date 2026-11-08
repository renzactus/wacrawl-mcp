#!/bin/bash
# End-to-end installer. Safe to run more than once: every step is skipped if it's
# already done, so it also repairs an install.
#
#   ./install.sh
#
# Sets everything up except two things macOS won't let a script do: granting Full
# Disk Access to the runtime and (if Claude is open) registering the server.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="$HOME/Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }
step() { echo; echo "▸ $*"; }

step "Requirements"

[ "$(uname -s)" = "Darwin" ] || fail "This only runs on macOS. On Windows/Linux, see wacli (README)."
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MACOS_MAJOR" -ge 13 ] || fail "It needs macOS 13 or newer (you have $(sw_vers -productVersion))."
ok "macOS $(sw_vers -productVersion)"

[ -d /Applications/WhatsApp.app ] || fail "WhatsApp Desktop isn't installed. Install the Mac app (App Store or whatsapp.com/download), not WhatsApp Web."
[ -f "$CONTAINER/ChatStorage.sqlite" ] || fail "WhatsApp Desktop is installed but has no data: open it and link it to your phone (QR code)."
ok "WhatsApp Desktop linked"

[ -d /Applications/Claude.app ] || fail "Claude Desktop isn't installed (claude.ai/download)."
ok "Claude Desktop"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js 18 or newer is missing: get it from nodejs.org (or 'brew install node')."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node $("$NODE" -v) is too old: it needs 18 or newer."
ok "Node $("$NODE" -v)"

step "wacrawl (builds the local archive)"

WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done

if [ -n "$WACRAWL" ]; then
  ok "already installed: $WACRAWL ($("$WACRAWL" --version))"
else
  # Download the binary from the official release and verify its checksum. It's what the
  # Homebrew formula does, without depending on the Command Line Tools, which are outdated
  # on many Macs and make `brew install` fail.
  case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=amd64 ;; *) fail "Unsupported architecture: $(uname -m)" ;; esac
  # Pinned version, tested end to end with this server. To bump it: test it (import from
  # scratch + check.sh) and only then change this number.
  VER="${WACRAWL_VERSION:-0.4.2}"
  TAG="v$VER"
  ASSET="wacrawl_${VER}_darwin_${ARCH}.tar.gz"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "  downloading $ASSET…"
  curl -fsSL -o "$TMP/$ASSET" "https://github.com/openclaw/wacrawl/releases/download/$TAG/$ASSET"
  curl -fsSL -o "$TMP/checksums.txt" "https://github.com/openclaw/wacrawl/releases/download/$TAG/checksums.txt"
  ( cd "$TMP" && grep " $ASSET\$" checksums.txt | shasum -a 256 -c - >/dev/null ) || fail "Checksum mismatch: not installing a binary that couldn't be verified."
  tar -xzf "$TMP/$ASSET" -C "$TMP"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$TMP/wacrawl" "$HOME/.local/bin/wacrawl"
  WACRAWL="$HOME/.local/bin/wacrawl"
  ok "installed $WACRAWL ($("$WACRAWL" --version)), checksum verified"
fi

DOC="$("$WACRAWL" doctor 2>&1 || true)"
[[ "$DOC" == *'"available": true'* ]] || fail "wacrawl can't read WhatsApp. If macOS asked about access to other apps' data, allow it and run this again."
ok "wacrawl can read WhatsApp Desktop"

step "Local archive"

if [ -f "$HOME/.wacrawl/wacrawl.db" ]; then
  ok "already there ($("$WACRAWL" --sync never sql 'SELECT count(*) FROM messages' | tail -1) messages) — the automatic sync keeps it up to date"
else
  echo "  first import: it takes several minutes, depending on how many chats you have…"
  "$WACRAWL" import --copy-media | tail -3 | sed 's/^/    /'
  ok "archive created ($("$WACRAWL" --sync never sql 'SELECT count(*) FROM messages' | tail -1) messages)"
fi

step "Dedicated node runtime"

NEW_RUNTIME=0
if [ -x "$REPO/runtime/bin/node" ]; then
  # Not rebuilt: if node was updated, a new copy would have another signature and macOS
  # would ask for Full Disk Access again.
  ok "already there — left alone so the macOS permission stays valid"
else
  "$REPO/setup-runtime.sh" | sed -n '1s/^/  /p'
  NEW_RUNTIME=1
fi

step "Automatic sync"
"$REPO/install-sync-agent.sh" | sed -n '1s/^/  /p'

step "Registering with Claude Desktop"
if ps -ax -o args= | grep -F "Claude.app/Contents/MacOS/Claude" | grep -vF grep >/dev/null; then
  echo "  ⚠ Claude Desktop is open, so it isn't registered yet (the entry would be erased when it quits)."
  PENDING_REGISTER=1
else
  "$REPO/register.sh" | sed -n '1s/^/  /p'
  PENDING_REGISTER=0
fi

echo
echo "════════════════════════════════════════════════════════════"
echo " Almost there. What macOS won't let a script do:"
echo "════════════════════════════════════════════════════════════"
echo
echo " 1. Full Disk Access (for live messages and the draft queue):"
echo "    System Settings → Privacy & Security → Full Disk Access"
echo "    → + button → ⌘⇧G → paste this path → Open → turn it on:"
echo
echo "      $REPO/runtime/bin/node"
echo
if [ "$NEW_RUNTIME" = 1 ]; then
  printf '%s' "$REPO/runtime/bin/node" | pbcopy
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
  echo "    (it's already on your clipboard, and that screen is open)"
  echo
fi
if [ "$PENDING_REGISTER" = 1 ]; then
  echo " 2. Quit Claude Desktop with ⌘Q (not just the window) and run:"
  echo
  echo "      $REPO/register.sh"
  echo
  echo " 3. Open Claude Desktop."
else
  echo " 2. Open Claude Desktop."
fi
echo
echo " To try it, ask: \"what are my last 3 WhatsApp chats?\""
echo " If something's off: $REPO/check.sh"
echo
echo " Optional — transcribe voice notes on your Mac (they never leave it):"
echo "   $REPO/setup-whisper.sh"
echo " Optional — let Claude SEND messages, not just draft them (off by default):"
echo "   $REPO/enable-sending.sh"
