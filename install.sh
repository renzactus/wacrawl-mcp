#!/bin/bash
# End-to-end installer. Safe to run more than once: every step is skipped if it's
# already done, so it also repairs an install, and running it again is how you update.
#
#   curl -fsSL https://raw.githubusercontent.com/renzactus/wacrawl-mcp/master/install.sh | bash
#   ./install.sh                     (from a clone: the same installer)
#
# Run on its own, as in the first line, it first gets the project (with git if the
# developer tools are there, as a tarball otherwise) into the folder of an existing
# install, or ~/wacrawl-mcp (WACRAWL_MCP_DIR=<folder> picks another), and then runs the
# installer it got.
#
# It sets everything up except what macOS won't let a script do: granting Full Disk
# Access to the runtime and quitting Claude Desktop so the server can be registered. If
# Claude is open, the installer waits for you to quit it, registers and opens it again.

set -euo pipefail

ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }
step() { echo; echo "▸ $*"; }

# Run on its own (curl … | bash): get the project, then hand over to the installer it
# brings. A function, so that a download cut off halfway runs nothing at all.
bootstrap() {
  [ "$(uname -s)" = "Darwin" ] || fail "This only runs on macOS. On Windows/Linux, see wacli (README)."
  local src="https://github.com/renzactus/wacrawl-mcp" dir="${WACRAWL_MCP_DIR:-}"
  local agent="$HOME/Library/LaunchAgents/io.github.renzactus.wacrawl-mcp.sync.plist"
  if [ -z "$dir" ] && [ -f "$agent" ]; then
    # An existing install is updated where it is: its sync agent knows the folder.
    dir="$(sed -n 's|.*<string>\(.*\)/sync-wrapper\.sh</string>.*|\1|p' "$agent" | head -1 || true)"
    [ -f "$dir/install.sh" ] || dir=""
  fi
  dir="${dir:-$HOME/wacrawl-mcp}"

  step "Getting wacrawl-mcp into $dir"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull -q --ff-only </dev/null && ok "up to date" \
      || echo "  ⚠ couldn't update it (local changes?): installing the version that's there"
  elif [ -e "$dir" ] && [ ! -f "$dir/server.js" ] && [ -n "$(ls -A "$dir")" ]; then
    fail "$dir already exists and isn't wacrawl-mcp. Move it, or pick another folder with WACRAWL_MCP_DIR (see the README)."
  elif [ ! -f "$dir/server.js" ] && xcode-select -p >/dev/null 2>&1 && command -v git >/dev/null \
       && git clone -q "$src.git" "$dir" </dev/null 2>/dev/null; then
    ok "cloned"
  else
    # Without git: on a Mac without the developer tools, git only offers to install them
    # (a big download). The tarball is the same code and needs just curl and tar.
    mkdir -p "$dir"
    curl -fsSL "$src/archive/refs/heads/master.tar.gz" | tar -xzf - -C "$dir" --strip-components 1 \
      || fail "Couldn't download it. Check your connection and try again."
    ok "downloaded"
  fi
  exec /bin/bash "$dir/install.sh" </dev/null
}
SELF="${BASH_SOURCE[0]:-}"
[ -n "$SELF" ] && [ -f "$(dirname "$SELF")/server.js" ] || bootstrap

REPO="$(cd "$(dirname "$SELF")" && pwd)"
CONTAINER="$HOME/Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# pgrep doesn't work: macOS truncates the process name. Match the full command line.
claude_open() { ps -ax -o args= | grep -F "Claude.app/Contents/MacOS/Claude" | grep -vF grep >/dev/null; }

# Running inside Claude Desktop (its terminal, or Claude Code)? Then quitting Claude
# would stop the installer too, so it can't wait for that.
inside_claude() {
  local pid=$$
  while [ "${pid:-0}" -gt 1 ]; do
    case "$(ps -o args= -p "$pid" 2>/dev/null)" in *"Claude.app/Contents/MacOS/Claude"*) return 0 ;; esac
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  done
  return 1
}

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

# The server runs on its own copy of node (see "Dedicated node runtime"): yours, copied,
# or the official build if you don't have one.
NODE="$(command -v node || true)"
if [ -x "$REPO/runtime/bin/node" ]; then
  ok "Node $("$REPO/runtime/bin/node" -v) (this server's own copy)"
elif [ -n "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then
  ok "Node $("$NODE" -v)"
else
  ok "Node.js isn't installed (or is older than 18): this server will get a copy of its own"
fi

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

# Already registered from this folder (an update, say)? Then there's nothing to redo.
already_registered() {
  "$REPO/runtime/bin/node" -e '
    const fs = require("fs"), [cfg, ...want] = process.argv.slice(1);
    const s = JSON.parse(fs.readFileSync(cfg, "utf8")).mcpServers.wacrawl;
    const has = [s.command, s.args[0], s.env.WACRAWL_BIN];
    process.exit(want.every((p, i) => fs.realpathSync(p) === fs.realpathSync(has[i])) ? 0 : 1);
  ' "$CFG" "$REPO/runtime/bin/node" "$REPO/server.js" "$WACRAWL" 2>/dev/null
}

if already_registered; then
  ok "already registered"
  REGISTER=done
elif ! claude_open; then
  "$REPO/register.sh" | sed -n '1s/^/  /p'
  REGISTER=done
elif [ -t 1 ] && ! inside_claude; then
  echo "  Claude Desktop is open: the installer registers the server when you quit it (see below)."
  REGISTER=wait
else
  echo "  ⚠ Claude Desktop is open, so it isn't registered yet (the entry would be erased when it quits)."
  REGISTER=manual
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
case "$REGISTER" in
  wait)
    echo " 2. Then quit Claude Desktop with ⌘Q (closing the window isn't enough)."
    echo "    The installer is waiting for that: it registers the server and opens Claude again."
    ;;
  manual)
    echo " 2. Quit Claude Desktop with ⌘Q (not just the window) and run, in Terminal:"
    echo
    echo "      $REPO/register.sh"
    echo
    echo " 3. Open Claude Desktop."
    ;;
  *)
    if claude_open; then
      echo " 2. Quit Claude Desktop (⌘Q) and open it again, so it loads this version."
    else
      echo " 2. Open Claude Desktop."
    fi
    ;;
esac
echo
echo " To try it, ask: \"what are my last 3 WhatsApp chats?\""
echo " If something's off: $REPO/check.sh"
echo
echo " Optional — transcribe voice notes on your Mac (they never leave it):"
echo "   $REPO/setup-whisper.sh"
echo " Optional — let Claude SEND messages, not just draft them (off by default):"
echo "   $REPO/enable-sending.sh"

if [ "$REGISTER" = wait ]; then
  echo
  echo "⏳ Waiting for Claude Desktop to quit (⌘Q)…"
  echo "   (Ctrl-C stops waiting; then, with Claude quit, run $REPO/register.sh)"
  while claude_open; do sleep 1; done
  sleep 2   # it rewrites its config as it quits: let it finish first
  if "$REPO/register.sh" | sed -n '1s/^/  /p'; then
    open -a Claude 2>/dev/null && ok "Opening Claude Desktop. You're all set." || true
  else
    echo "  With Claude quit, run: $REPO/register.sh"
  fi
fi
