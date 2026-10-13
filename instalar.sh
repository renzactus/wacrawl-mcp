#!/bin/bash
# Instalador de punta a punta. Se puede correr más de una vez: cada paso se
# saltea si ya está hecho, así que también sirve para reparar una instalación.
#
#   ./instalar.sh
#
# Deja todo listo salvo dos cosas que macOS no deja automatizar: darle el
# permiso de disco al runtime y (si Claude está abierto) registrar el server.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="$HOME/Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
ok()    { echo "  ✓ $*"; }
falla() { echo "  ✗ $*"; exit 1; }
paso()  { echo; echo "▸ $*"; }

paso "Requisitos"

[ "$(uname -s)" = "Darwin" ] || falla "Esto es sólo para Mac. En Windows/Linux mirá wacli (ver README)."
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MACOS_MAJOR" -ge 13 ] || falla "Hace falta macOS 13 o más nuevo (tenés $(sw_vers -productVersion))."
ok "macOS $(sw_vers -productVersion)"

[ -d /Applications/WhatsApp.app ] || falla "No está WhatsApp Desktop. Instalá la app de Mac (App Store o whatsapp.com/download), no WhatsApp Web."
[ -f "$CONTAINER/ChatStorage.sqlite" ] || falla "WhatsApp Desktop está instalado pero sin datos: abrilo y vinculalo con el teléfono (QR)."
ok "WhatsApp Desktop vinculado"

[ -d /Applications/Claude.app ] || falla "No está Claude Desktop (claude.ai/download)."
ok "Claude Desktop"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || falla "Falta Node.js 18 o más nuevo: bajalo de nodejs.org (o 'brew install node')."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || falla "Node $("$NODE" -v) es viejo: hace falta 18 o más nuevo."
ok "Node $("$NODE" -v)"

paso "wacrawl (el que arma el archivo local)"

WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done

if [ -n "$WACRAWL" ]; then
  ok "ya instalado: $WACRAWL ($("$WACRAWL" --version))"
else
  # Bajamos el binario del release oficial y verificamos su checksum. Es lo mismo
  # que hace la fórmula de Homebrew, pero sin depender de las Command Line Tools,
  # que en muchas Macs están desactualizadas y hacen fallar `brew install`.
  case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=amd64 ;; *) falla "Arquitectura no soportada: $(uname -m)" ;; esac
  # Versión fija, probada de punta a punta con este server. Para subirla:
  # probarla (import de cero + check.sh) y recién ahí cambiar este número.
  VER="${WACRAWL_VERSION:-0.4.2}"
  TAG="v$VER"
  ASSET="wacrawl_${VER}_darwin_${ARCH}.tar.gz"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  echo "  bajando $ASSET…"
  curl -fsSL -o "$TMP/$ASSET" "https://github.com/openclaw/wacrawl/releases/download/$TAG/$ASSET"
  curl -fsSL -o "$TMP/checksums.txt" "https://github.com/openclaw/wacrawl/releases/download/$TAG/checksums.txt"
  ( cd "$TMP" && grep " $ASSET\$" checksums.txt | shasum -a 256 -c - >/dev/null ) || falla "El checksum no coincide: no instalo un binario que no se pudo verificar."
  tar -xzf "$TMP/$ASSET" -C "$TMP"
  mkdir -p "$HOME/.local/bin"
  install -m 755 "$TMP/wacrawl" "$HOME/.local/bin/wacrawl"
  WACRAWL="$HOME/.local/bin/wacrawl"
  ok "instalado $WACRAWL ($("$WACRAWL" --version)), checksum verificado"
fi

DOC="$("$WACRAWL" doctor 2>&1 || true)"
[[ "$DOC" == *'"available": true'* ]] || falla "wacrawl no puede leer WhatsApp. Si macOS preguntó por acceso a datos de otras apps, aceptá y volvé a correr esto."
ok "wacrawl lee WhatsApp Desktop"

paso "Archivo local"

if [ -f "$HOME/.wacrawl/wacrawl.db" ]; then
  ok "ya existe ($("$WACRAWL" --sync never sql 'SELECT count(*) FROM messages' | tail -1) mensajes) — lo actualiza el sync automático"
else
  echo "  primera importación: tarda varios minutos según cuántos chats tengas…"
  "$WACRAWL" import --copy-media | tail -3 | sed 's/^/    /'
  ok "archivo creado ($("$WACRAWL" --sync never sql 'SELECT count(*) FROM messages' | tail -1) mensajes)"
fi

paso "Runtime dedicado de node"

RUNTIME_NUEVO=0
if [ -x "$REPO/runtime/bin/node" ]; then
  # No lo rehacemos: si node se actualizó, la copia nueva tendría otra firma y
  # macOS pediría el permiso de disco de nuevo.
  ok "ya existe — no lo toco para no invalidar el permiso de macOS"
else
  "$REPO/setup-runtime.sh" | sed -n '1s/^/  /p'
  RUNTIME_NUEVO=1
fi

paso "Sync automático"
"$REPO/install.sh" | sed -n '1s/^/  /p'

paso "Registro en Claude Desktop"
if ps -ax -o args= | grep -F "Claude.app/Contents/MacOS/Claude" | grep -vF grep >/dev/null; then
  echo "  ⚠ Claude Desktop está abierto, así que no lo registro todavía (se borraría al cerrarlo)."
  PENDIENTE_REGISTRO=1
else
  "$REPO/register.sh" | sed -n '1s/^/  /p'
  PENDIENTE_REGISTRO=0
fi

echo
echo "════════════════════════════════════════════════════════════"
echo " Falta poco. Lo que macOS no deja automatizar:"
echo "════════════════════════════════════════════════════════════"
echo
echo " 1. Permiso de disco (para mensajes en vivo y la cola de borradores):"
echo "    Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco"
echo "    → botón + → ⌘⇧G → pegá esta ruta → Abrir → activalo:"
echo
echo "      $REPO/runtime/bin/node"
echo
if [ "$RUNTIME_NUEVO" = 1 ]; then
  printf '%s' "$REPO/runtime/bin/node" | pbcopy
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
  echo "    (ya la copié al portapapeles y te abrí esa pantalla)"
  echo
fi
if [ "$PENDIENTE_REGISTRO" = 1 ]; then
  echo " 2. Cerrá Claude Desktop con ⌘Q (no sólo la ventana) y corré:"
  echo
  echo "      $REPO/register.sh"
  echo
  echo " 3. Abrí Claude Desktop."
else
  echo " 2. Abrí Claude Desktop."
fi
echo
echo " Para probar, preguntale: \"¿cuáles son mis últimos 3 chats de WhatsApp?\""
echo " Si algo no anda: $REPO/check.sh"
echo
echo " Opcional — transcribir notas de voz en tu Mac (sin mandarlas a nadie):"
echo "   $REPO/setup-whisper.sh"
