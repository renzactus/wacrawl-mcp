#!/bin/bash
# Installs the launchd agent that keeps the wacrawl archive up to date.
#
# A sync takes several minutes (wacrawl has no incremental import: it re-merges
# everything), so it runs in the background every 6 h and NOT on the fly from the
# MCP server. It calls sync-wrapper.sh, which also recovers on its own and alerts
# you if something fails.

set -euo pipefail

LABEL="io.github.renzactus.wacrawl-mcp.sync"
OLD_LABEL="com.openclaw.wacrawl.sync"   # the label earlier versions used
REPO="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$REPO/sync-agent.plist.template"
AGENTS="$HOME/Library/LaunchAgents"
DEST="$AGENTS/$LABEL.plist"

[ -f "$TEMPLATE" ] || { echo "✗ Can't find $TEMPLATE"; exit 1; }
[ -x "$REPO/sync-wrapper.sh" ] || chmod +x "$REPO/sync-wrapper.sh"

WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done
[ -n "$WACRAWL" ] || { echo "✗ Can't find wacrawl. Run ./install.sh first."; exit 1; }

mkdir -p "$AGENTS" "$HOME/.wacrawl"

# Earlier versions installed the agent under another label: remove it so the sync doesn't run twice.
if [ -f "$AGENTS/$OLD_LABEL.plist" ]; then
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
  rm -f "$AGENTS/$OLD_LABEL.plist"
fi

sed -e "s|__LABEL__|$LABEL|" -e "s|__WRAPPER__|$REPO/sync-wrapper.sh|" -e "s|__HOME__|$HOME|g" "$TEMPLATE" > "$DEST"
plutil -lint "$DEST" >/dev/null

# bootout is idempotent: if it wasn't loaded, the failure doesn't matter.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "✓ Automatic sync installed (every 6 hours)."
echo "  Run one now:  launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  Log:          ~/.wacrawl/wrapper.log"
