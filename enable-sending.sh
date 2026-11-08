#!/bin/bash
# Turns direct sending on (or off): lets Claude press Enter in WhatsApp Desktop,
# instead of only leaving the message typed for you.
#
#   ./enable-sending.sh         turn it on
#   ./enable-sending.sh --off   turn it off
#
# Off by default on purpose: sending messages in your name is your decision.

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
NODE="$REPO/runtime/bin/node"
[ -x "$NODE" ] || { echo "✗ The runtime is missing: run ./install.sh first."; exit 1; }
VALUE=true; [ "${1:-}" = "--off" ] && VALUE=false

"$NODE" -e '
const fs = require("fs"), f = require("os").homedir() + "/.wacrawl/limits.json";
let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
c.allowSending = process.argv[1] === "true";
fs.mkdirSync(require("path").dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "$VALUE"

if [ "$VALUE" = false ]; then
  echo "✓ Direct sending is OFF. Claude can only leave messages typed for you."
  echo "  (No restart needed for this to take effect.)"
  exit 0
fi

echo "✓ Direct sending is on."
echo
echo "It still needs permission to press Enter (macOS won't let a script grant it):"
echo "  System Settings → Privacy & Security → Accessibility → + → ⌘⇧G → paste this path → turn it on:"
echo
echo "    $NODE"
echo
printf '%s' "$NODE" | pbcopy
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
echo "  (it's already on your clipboard, and that screen is open)"
echo
echo "Then quit (⌘Q) and reopen Claude Desktop. Try it with: \"send me a WhatsApp message that says test\"."
echo "If macOS asks whether it can control \"System Events\", allow it."
