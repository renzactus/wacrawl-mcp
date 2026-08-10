#!/bin/bash
# Instala el agente de launchd que mantiene el archivo de wacrawl al día.
#
# El sync tarda ~5,4 min sobre un archivo de ~935k mensajes (no hay incremental),
# así que corre en background cada 6h y NO al vuelo desde el MCP server.

set -euo pipefail

LABEL="com.openclaw.wacrawl.sync"
SRC="$(cd "$(dirname "$0")" && pwd)/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -f "$SRC" ] || { echo "✗ No encuentro $SRC"; exit 1; }

command -v "$HOME/.local/bin/wacrawl" >/dev/null 2>&1 || {
  echo "✗ Falta ~/.local/bin/wacrawl — instalalo antes (ver README)."
  exit 1
}

mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC" "$DEST"
plutil -lint "$DEST" >/dev/null

# bootout es idempotente: si no estaba cargado, no importa que falle.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "✓ Agente instalado. Estado:"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state = |run interval|last exit code" || true
echo
echo "→ Para forzar un sync ahora:  launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "→ Log:                        ~/.wacrawl/sync.log"
