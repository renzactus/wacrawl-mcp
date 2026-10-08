#!/bin/bash
# Registra el MCP server en Claude Desktop, sin tocar los otros servers que ya
# tengas configurados.
#
# IMPORTANTE: correr con Claude Desktop CERRADO (⌘Q, no sólo cerrar la ventana).
# La app lee claude_desktop_config.json al arrancar y lo REESCRIBE desde memoria
# al salir: si se edita con la app abierta, al cerrarla la entrada se pierde.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Sólo para test: apunta a un config de prueba y saltea el chequeo de la app.
if [ -n "${WACRAWL_TEST_CONFIG:-}" ]; then
  CFG="$WACRAWL_TEST_CONFIG"
else
  # pgrep no sirve: macOS trunca el nombre del proceso a 16 caracteres
  # ("/Applications/Cl"). Vamos por la línea de comando completa.
  if ps -ax -o args= | grep -F "Claude.app/Contents/MacOS/Claude" | grep -vF grep >/dev/null; then
    echo "✗ Claude Desktop está abierto. Cerralo con ⌘Q y volvé a correr esto."
    echo "  (si queda abierto, al cerrarlo borra lo que se agregue ahora)"
    exit 1
  fi
fi

SERVER="$REPO/server.js"
[ -f "$SERVER" ] || { echo "✗ No encuentro $SERVER"; exit 1; }

# Runtime dedicado si existe: el permiso de macOS queda acotado a este server.
if [ -x "$REPO/runtime/bin/node" ]; then
  NODE="$REPO/runtime/bin/node"
else
  NODE="$(command -v node || true)"
  echo "  (sin runtime dedicado; usando $NODE — corré ./setup-runtime.sh)"
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "✗ No encuentro node."; exit 1; }

WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done
[ -n "$WACRAWL" ] || { echo "✗ No encuentro wacrawl. Corré ./instalar.sh primero."; exit 1; }

mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] || echo '{}' > "$CFG"
cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"

# Claude Desktop no hereda el PATH del shell: todas las rutas van absolutas.
"$NODE" -e '
const fs = require("fs");
const [cfgPath, node, server, wacrawl] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8") || "{}");
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.wacrawl = { command: node, args: [server], env: { WACRAWL_BIN: wacrawl } };
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log("✓ Registrado en Claude Desktop. Servers configurados:", Object.keys(cfg.mcpServers).join(", "));
' "$CFG" "$NODE" "$SERVER" "$WACRAWL"

echo "→ Abrí Claude Desktop: tiene que aparecer 'wacrawl' entre los conectores."
