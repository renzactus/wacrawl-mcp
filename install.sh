#!/bin/bash
# Instala el agente de launchd que mantiene el archivo de wacrawl al día.
#
# El sync tarda varios minutos (wacrawl no tiene import incremental: re-mergea
# todo), así que corre en background cada 6h y NO al vuelo desde el MCP server.
# Llama a sync-wrapper.sh, que además se auto-recupera y avisa si algo falla.

set -euo pipefail

LABEL="com.openclaw.wacrawl.sync"
REPO="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$REPO/$LABEL.plist.template"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -f "$TEMPLATE" ] || { echo "✗ No encuentro $TEMPLATE"; exit 1; }
[ -x "$REPO/sync-wrapper.sh" ] || chmod +x "$REPO/sync-wrapper.sh"

WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done
[ -n "$WACRAWL" ] || { echo "✗ No encuentro wacrawl. Corré ./instalar.sh primero."; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.wacrawl"
sed -e "s|__WRAPPER__|$REPO/sync-wrapper.sh|" -e "s|__HOME__|$HOME|g" "$TEMPLATE" > "$DEST"
plutil -lint "$DEST" >/dev/null

# bootout es idempotente: si no estaba cargado, no importa que falle.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"

echo "✓ Sync automático instalado (cada 6 horas)."
echo "  Forzar uno ahora:  launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  Registro:          ~/.wacrawl/wrapper.log"
