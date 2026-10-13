#!/bin/bash
# Re-transcribe los audios hechos con un vocabulario distinto del actual (por
# ejemplo, después de editar ~/.wacrawl/vocabulario.txt). Corre en segundo plano
# y se puede cortar: retoma donde quedó, porque cada transcripción guarda con qué
# versión del vocabulario se hizo.

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
source "$REPO/whisper.env"
UV=""
for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
  [ -x "$c" ] && { UV="$c"; break; }
done
[ -n "$UV" ] || { echo "✗ No está instalada la transcripción: corré ./setup-whisper.sh"; exit 1; }
nohup env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 WHISPER_MODELO="$WHISPER_MODELO" \
  "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PAQUETE" python "$REPO/transcribir.py" --rehacer \
  >/dev/null 2>>"$HOME/.wacrawl/transcribir.log" &
echo "✓ Re-transcribiendo en segundo plano (≈2 s por audio). Progreso: $REPO/check.sh audios"
