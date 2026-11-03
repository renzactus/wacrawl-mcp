#!/bin/bash
# Transcribe los audios del histórico del iPhone (ver importar-iphone.sh), del más
# nuevo al más viejo, con Whisper en esta Mac. No sale nada de la computadora.
#
#   ./transcribir-historico.sh [procesos] [antes-de AAAA-MM-DD]   arranca en segundo plano
#   ./transcribir-historico.sh estado                             cuánto va y a qué ritmo
#   ./transcribir-historico.sh parar
#
# Es largo: una Mac M4 transcribe ~10 veces más rápido que lo que dura el audio, así
# que cientos de horas de audio son noches enteras. Más procesos no lo aceleran en una
# M4 (la placa de video ya va al 100% con uno y cada uno ocupa ~6 GB): dejalo en 1. Se puede parar y volver a largar
# cuando quieras: lo ya transcripto no se repite. Necesita la Mac enchufada (si está
# a batería, espera a que la enchufes) y con la tapa abierta: si no, se duerme.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HIST="${WACRAWL_HISTORICO_DIR:-$HOME/.wacrawl/historico}"
TRANSC="$HOME/.wacrawl/transcripciones.sqlite"
PATRON="transcribir.py --pendientes --archivo $HIST/wacrawl.db"

[ -f "$HIST/corte.json" ] || { echo "No hay histórico del iPhone importado (ver importar-iphone.sh)."; exit 1; }
CORTE=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['corte'])" "$HIST/corte.json")

estado() {
  python3 -I - "$HIST/wacrawl.db" "$TRANSC" "$CORTE" <<'EOF'
import os, sqlite3, sys, time, datetime
archivo, transc, corte = sys.argv[1], sys.argv[2], int(sys.argv[3])
a = sqlite3.connect(f"file:{archivo}?mode=ro", uri=True)
audios = a.execute("""SELECT msg_id, chat_jid, ts, media_path FROM messages WHERE message_type = 'audio'
                      AND media_path <> '' AND deleted_at IS NULL AND ts < ?""", (corte,)).fetchall()
t = sqlite3.connect(transc, timeout=30)
hechos = {(m, c) for m, c in t.execute("SELECT msg_id, chat_jid FROM transcripciones WHERE ts < ?", (corte,))}
por_anio = {}
for m, c, ts, p in audios:
    if not os.path.isfile(p):
        continue
    y = datetime.datetime.fromtimestamp(ts).year
    h, n = por_anio.get(y, (0, 0))
    por_anio[y] = (h + ((m, c) in hechos), n + 1)
for y in sorted(por_anio, reverse=True):
    h, n = por_anio[y]
    print(f"  {y}: {h:>6} de {n:>6} audios ({100 * h // n}%)")
ahora = int(time.time())
seg, n = t.execute("SELECT coalesce(sum(duracion), 0), count(*) FROM transcripciones WHERE ts < ? AND creado > ?",
                   (corte, ahora - 900)).fetchone()
if n:
    print(f"  últimos 15 min: {n} audios, {seg / 60:.0f} min de audio ({seg / 900:.1f}× tiempo real)")
EOF
  local n; n=$(ps -axo command= | grep -F -- "$PATRON" | { grep -v -e "uv run" -e grep || true; } | wc -l | tr -d ' ')
  echo "  procesos corriendo: $n"
}

parar() {
  pkill -f "$PATRON" 2>/dev/null || true
  pkill -f "transcribir-historico.sh --fondo" 2>/dev/null || true
}

case "${1:-}" in
  estado) estado; exit 0 ;;
  parar) parar; echo "Parado. Lo transcripto queda guardado."; exit 0 ;;
  --fondo) shift; FONDO=1 ;;
esac

PROCESOS="${1:-1}"
ANTES="$CORTE"
if [ -n "${2:-}" ]; then
  ANTES=$(date -j -f "%Y-%m-%d %H:%M:%S" "$2 00:00:00" +%s)
  [ "$ANTES" -gt "$CORTE" ] && ANTES="$CORTE"
fi

source "$REPO/whisper.env"
UV=""
for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
  [ -x "$c" ] && { UV="$c"; break; }
done
[ -n "$UV" ] && [ -d "$HOME/.cache/huggingface/hub/models--${WHISPER_MODELO//\//--}" ] \
  || { echo "La transcripción no está instalada: corré ./setup-whisper.sh"; exit 1; }

if [ -z "${FONDO:-}" ]; then
  parar   # una sola tanda a la vez: relanzar con otra cantidad de procesos reparte de nuevo
  # Se separa de la terminal: sigue aunque la cierres.
  nohup "$REPO/$(basename "$0")" --fondo "$PROCESOS" ${2:+"$2"} >> "$HIST/transcribir.log" 2>&1 &
  echo "Arrancado en segundo plano ($PROCESOS procesos). Ver: $0 estado · log: $HIST/transcribir.log"
  pmset -g batt | grep -q "AC Power" || echo "La Mac está a batería: empieza cuando la enchufes."
  exit 0
fi

# A batería no: Whisper usa la placa de video a fondo y la Mac se dormiría igual.
until pmset -g batt | grep -q "AC Power"; do sleep 60; done
echo "[$(date '+%F %T')] arranca: $PROCESOS procesos, audios anteriores a $(date -r "$ANTES" +%F)"
PIDS=""
for k in $(seq 1 "$PROCESOS"); do
  UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 WHISPER_MODELO="$WHISPER_MODELO" \
    "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PAQUETE" \
    python "$REPO/transcribir.py" --pendientes --archivo "$HIST/wacrawl.db" --antes "$ANTES" --parte "$k/$PROCESOS" \
    > /dev/null 2>> "$HIST/transcribir-$k.log" &
  PIDS="$PIDS $!"
done
caffeinate -i -s -w $$ &   # que la Mac no se duerma mientras corre
wait $PIDS || true
echo "[$(date '+%F %T')] terminó"
estado
