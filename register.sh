#!/bin/bash
# Registra el MCP server wacrawl en Claude Desktop.
#
# IMPORTANTE: correr con Claude Desktop CERRADO. La app carga el config al
# arrancar y lo reescribe desde memoria al salir, así que si se edita mientras
# está abierta, la entrada se pierde al cerrarla.

set -euo pipefail

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# Ojo: pgrep no sirve — macOS trunca el nombre del proceso a 16 caracteres
# ("/Applications/Cl"), así que `pgrep -x Claude` nunca matchea. Vamos por la
# línea de comando completa.
if ps -ax -o args= | grep -F "Claude.app/Contents/MacOS/Claude" | grep -qvF grep; then
  echo "✗ Claude Desktop está abierto. Cerralo con ⌘Q y volvé a correr esto."
  echo "  (si lo dejás abierto, la entrada se pierde al salir)"
  exit 1
fi

[ -f "$CFG" ] || { echo "✗ No existe $CFG"; exit 1; }

cp "$CFG" "$CFG.bak.$(date +%Y%m%d%H%M%S)"

# La ruta sale de dónde está este script, no hardcodeada: así mover el repo no
# vuelve a desincronizar la config de Claude Desktop.
SERVER="$(cd "$(dirname "$0")" && pwd)/server.js"
[ -f "$SERVER" ] || { echo "✗ No encuentro $SERVER"; exit 1; }

# Preferimos el runtime dedicado: el permiso de macOS queda acotado a este
# server en vez de dárselo a todo lo que corra con node. Ver setup-runtime.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$DIR/runtime/bin/node" ]; then
  NODE="$DIR/runtime/bin/node"
else
  NODE="$(command -v node || true)"
  [ -x "$NODE" ] || NODE=/opt/homebrew/bin/node
  echo "  (sin runtime dedicado: usando $NODE — corré ./setup-runtime.sh)"
fi
[ -x "$NODE" ] || { echo "✗ No encuentro node"; exit 1; }

python3 - "$CFG" "$SERVER" "$NODE" <<'PY'
import json, sys

path, server, node = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    cfg = json.load(f)

cfg.setdefault("mcpServers", {})["wacrawl"] = {
    "command": node,
    "args": [server],
    "env": {"WACRAWL_BIN": "/Users/renzactus/.local/bin/wacrawl"},
}

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")

print("✓ Registrado. mcpServers ahora:", ", ".join(cfg["mcpServers"]))
PY

echo "→ Ahora abrí Claude Desktop. Debería aparecer 'wacrawl' con 4 tools."
