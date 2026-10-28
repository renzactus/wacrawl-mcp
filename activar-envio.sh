#!/bin/bash
# Activa (o apaga) el envío directo de mensajes: que Claude pueda apretar Enter
# en WhatsApp Desktop, en vez de sólo dejar el mensaje escrito.
#
#   ./activar-envio.sh          activar
#   ./activar-envio.sh --apagar desactivar
#
# Viene apagado a propósito: mandar mensajes en tu nombre lo decidís vos.

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
NODE="$REPO/runtime/bin/node"
[ -x "$NODE" ] || { echo "✗ Falta el runtime: corré ./instalar.sh primero."; exit 1; }
VALOR=true; [ "${1:-}" = "--apagar" ] && VALOR=false

"$NODE" -e '
const fs = require("fs"), f = require("os").homedir() + "/.wacrawl/limites.json";
let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
c.permitirEnvio = process.argv[1] === "true";
fs.mkdirSync(require("path").dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "$VALOR"

if [ "$VALOR" = false ]; then
  echo "✓ Envío directo APAGADO. Claude sólo puede dejar mensajes escritos."
  echo "  (Para que tome el cambio no hace falta reiniciar.)"
  exit 0
fi

echo "✓ Envío directo activado."
echo
echo "Falta darle permiso para apretar Enter (macOS no deja hacerlo por script):"
echo "  Ajustes del Sistema → Privacidad y seguridad → Accesibilidad → + → ⌘⇧G → pegá esta ruta → activalo:"
echo
echo "    $NODE"
echo
printf '%s' "$NODE" | pbcopy
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
echo "  (ya la copié al portapapeles y te abrí esa pantalla)"
echo
echo "Después: ⌘Q y reabrí Claude Desktop. Probá con: \"mandame un mensaje a mí que diga prueba\"."
echo "Si macOS pregunta si puede controlar \"System Events\", aceptá."
