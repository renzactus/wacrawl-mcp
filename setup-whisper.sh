#!/bin/bash
# Instala la transcripción local de notas de voz (opcional).
#
#   ./setup-whisper.sh
#
# Usa Whisper (large-v3-turbo) sobre MLX, optimizado para chips de Apple. Baja el
# modelo una sola vez (~1,6 GB); después transcribe sin conexión: los audios no
# salen de la Mac. No compila nada: uv se baja Python y las librerías listas.

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
source "$REPO/whisper.env"
ok()    { echo "  ✓ $*"; }
falla() { echo "  ✗ $*"; exit 1; }

echo "▸ Requisitos"
[ "$(uname -m)" = arm64 ] || falla "Necesita una Mac con chip Apple (M1 o posterior): MLX no corre en Intel."
IFS=. read -r MA MI _ <<< "$(sw_vers -productVersion).0"
{ [ "$MA" -gt 13 ] || { [ "$MA" -eq 13 ] && [ "$MI" -ge 5 ]; }; } || falla "Necesita macOS 13.5 o más nuevo."
ok "chip Apple, macOS $(sw_vers -productVersion)"
[ -f "$HOME/.wacrawl/wacrawl.db" ] || falla "Primero corré ./instalar.sh (no hay archivo de WhatsApp todavía)."

echo; echo "▸ uv (instala Python y las librerías sin compilar)"
UV=""
for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
  [ -x "$c" ] && { UV="$c"; break; }
done
if [ -z "$UV" ]; then
  echo "  No está uv. Se instala con el instalador oficial de Astral:"
  echo "    curl -LsSf https://astral.sh/uv/install.sh | sh"
  read -r -p "  ¿Lo instalo? [s/N] " r
  [[ "$r" =~ ^[sS] ]] || falla "Sin uv no se puede seguir."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
  [ -x "$UV" ] || falla "No quedó instalado uv."
fi
ok "$UV ($("$UV" --version))"

# Python propio de uv: así no depende del PATH. Claude Desktop y launchd corren
# con un PATH mínimo, y ahí un Python de Homebrew no se encuentra.
"$UV" python install "$WHISPER_PYTHON" >/dev/null 2>&1
ok "Python $WHISPER_PYTHON gestionado por uv"

echo; echo "▸ Modelo ($WHISPER_MODELO, ~1,6 GB, una sola vez)"
HF_HUB_DISABLE_TELEMETRY=1 "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PAQUETE" python -c "
from huggingface_hub import snapshot_download
snapshot_download('$WHISPER_MODELO')" 2>&1 | grep -v Warning || true
[ -d "$HOME/.cache/huggingface/hub/models--${WHISPER_MODELO//\//--}" ] || falla "No se pudo bajar el modelo."
ok "modelo listo"

echo; echo "▸ Vocabulario (ayuda a acertar nombres propios)"
VOC="$HOME/.wacrawl/vocabulario.txt"
if [ -f "$VOC" ]; then
  ok "ya tenés uno ($(grep -cvE '^[[:space:]]*(#|$)' "$VOC") términos) — no lo toco"
else
  env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 \
    "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PAQUETE" python "$REPO/transcribir.py" --vocabulario-base \
    2>/dev/null > "$VOC" || true
  ok "armé uno sugerido desde lo que escribís: $VOC"
  echo "    Revisalo: agregá arriba tu empresa, equipo y clientes (lo primero pesa más)."
  echo "    Medido: con vocabulario, el nombre de una empresa pasó de salir bien 0 a 11 veces de 20."
fi

echo; echo "▸ Prueba: los 3 audios más recientes, sin conexión"
# En una base temporal: no depende de qué haya pendiente (podría ser justo un
# audio dañado) ni escribe en la base real. Pasa si al menos uno sale bien.
PRUEBA="$(mktemp -d)"
RES=$(env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
  WHISPER_MODELO="$WHISPER_MODELO" WACRAWL_TRANSCRIPCIONES="$PRUEBA/t.sqlite" \
  "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PAQUETE" python "$REPO/transcribir.py" --pendientes --limite 3 2>&1 | grep -v Warning || true)
rm -rf "$PRUEBA"
[[ "$RES" == *'"texto"'* ]] || falla "La prueba falló: $(echo "$RES" | tail -2)"
ok "$(echo "$RES" | grep -o '"texto": "[^"]*' | head -1 | cut -c11-90)…"

echo; echo "▸ Pasada inicial"
PEND=$("$HOME/.local/bin/wacrawl" --sync never sql "SELECT count(*) FROM messages WHERE message_type='audio' AND media_path<>''" 2>/dev/null | tail -1 || echo "?")
echo "  Hay ~$PEND audios en disco. La transcripción corre en segundo plano (≈2 s por audio);"
echo "  después, el sync automático transcribe los nuevos cada 6 horas."
nohup env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 WHISPER_MODELO="$WHISPER_MODELO" \
  "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PAQUETE" python "$REPO/transcribir.py" --pendientes \
  >/dev/null 2>>"$HOME/.wacrawl/transcribir.log" &
ok "arrancó (registro: ~/.wacrawl/transcribir.log)"
echo
echo "Listo. Cerrá y abrí Claude Desktop (⌘Q) para que tome la tool de audios."
echo "Si después editás el vocabulario, re-transcribí lo viejo con:"
echo "  $REPO/rehacer-transcripciones.sh"
