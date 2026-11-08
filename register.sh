#!/bin/bash
# Registers the MCP server with Claude Desktop, without touching any other servers you
# already have configured.
#
# IMPORTANT: run it with Claude Desktop QUIT (⌘Q, not just closing the window).
# The app reads claude_desktop_config.json when it starts and REWRITES it from memory
# when it quits: if you edit it while the app is open, the entry is lost when it quits.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Tests only: point to a test config and skip the check for the app.
if [ -n "${WACRAWL_TEST_CONFIG:-}" ]; then
  CFG="$WACRAWL_TEST_CONFIG"
else
  # pgrep doesn't work: macOS truncates the process name to 16 characters
  # ("/Applications/Cl"). Match the full command line instead.
  if ps -ax -o args= | grep -F "Claude.app/Contents/MacOS/Claude" | grep -vF grep >/dev/null; then
    echo "✗ Claude Desktop is open. Quit it with ⌘Q and run this again."
    echo "  (if it stays open, quitting it later erases whatever is added now)"
    exit 1
  fi
fi

SERVER="$REPO/server.js"
[ -f "$SERVER" ] || { echo "✗ Can't find $SERVER"; exit 1; }

# The dedicated runtime if there is one: the macOS permission stays limited to this server.
if [ -x "$REPO/runtime/bin/node" ]; then
  NODE="$REPO/runtime/bin/node"
else
  NODE="$(command -v node || true)"
  echo "  (no dedicated runtime; using $NODE — run ./setup-runtime.sh)"
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ Can't find node."; exit 1; }

WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done
[ -n "$WACRAWL" ] || { echo "✗ Can't find wacrawl. Run ./install.sh first."; exit 1; }

mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] || echo '{}' > "$CFG"
cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"

# Claude Desktop doesn't inherit the shell's PATH: every path goes in absolute.
"$NODE" -e '
const fs = require("fs");
const [cfgPath, node, server, wacrawl] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8") || "{}");
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.wacrawl = { command: node, args: [server], env: { WACRAWL_BIN: wacrawl } };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log("✓ Registered with Claude Desktop. Configured servers:", Object.keys(cfg.mcpServers).join(", "));
' "$CFG" "$NODE" "$SERVER" "$WACRAWL"

echo "→ Open Claude Desktop: 'wacrawl' should show up among your connectors."
