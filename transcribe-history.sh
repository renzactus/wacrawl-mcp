#!/bin/bash
# Transcribes the voice notes in the iPhone history (see import-iphone.sh), newest first,
# with Whisper on this Mac. Nothing leaves the computer.
#
#   ./transcribe-history.sh [processes] [before YYYY-MM-DD]   starts in the background
#   ./transcribe-history.sh status                            progress and speed
#   ./transcribe-history.sh stop
#
# It's long: an M4 Mac transcribes ~10x faster than the audio lasts, so hundreds of hours
# of audio take whole nights. More processes don't speed it up on an M4 (the GPU is already
# at 100% with one, and each one takes ~6 GB): leave it at 1. You can stop it and start it
# again whenever you want: what's already transcribed isn't repeated. It needs the Mac
# plugged in (on battery it waits until you plug it in) and with the lid open: otherwise it
# goes to sleep.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HIST="${WACRAWL_HISTORY_DIR:-$HOME/.wacrawl/historico}"
TRANSC="$HOME/.wacrawl/transcripciones.sqlite"
PATTERN="transcribe.py --pending --archive $HIST/wacrawl.db"

[ -f "$HIST/corte.json" ] || { echo "No iPhone history has been imported (see import-iphone.sh)."; exit 1; }
CUTOFF=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['corte'])" "$HIST/corte.json")

status() {
  python3 -I - "$HIST/wacrawl.db" "$TRANSC" "$CUTOFF" <<'EOF'
import os, sqlite3, sys, time, datetime
archive, transc, cutoff = sys.argv[1], sys.argv[2], int(sys.argv[3])
a = sqlite3.connect(f"file:{archive}?mode=ro", uri=True)
notes = a.execute("""SELECT msg_id, chat_jid, ts, media_path FROM messages WHERE message_type = 'audio'
                     AND media_path <> '' AND deleted_at IS NULL AND ts < ?""", (cutoff,)).fetchall()
t = sqlite3.connect(transc, timeout=30)
done = {(m, c) for m, c in t.execute("SELECT msg_id, chat_jid FROM transcripciones WHERE ts < ?", (cutoff,))}
by_year = {}
for m, c, ts, p in notes:
    if not os.path.isfile(p):
        continue
    y = datetime.datetime.fromtimestamp(ts).year
    d, n = by_year.get(y, (0, 0))
    by_year[y] = (d + ((m, c) in done), n + 1)
for y in sorted(by_year, reverse=True):
    d, n = by_year[y]
    print(f"  {y}: {d:>6} of {n:>6} voice notes ({100 * d // n}%)")
now = int(time.time())
secs, n = t.execute("SELECT coalesce(sum(duracion), 0), count(*) FROM transcripciones WHERE ts < ? AND creado > ?",
                    (cutoff, now - 900)).fetchone()
if n:
    print(f"  last 15 min: {n} voice notes, {secs / 60:.0f} min of audio ({secs / 900:.1f}x real time)")
EOF
  local n; n=$(ps -axo command= | grep -F -- "$PATTERN" | { grep -v -e "uv run" -e grep || true; } | wc -l | tr -d ' ')
  echo "  processes running: $n"
}

stop() {
  pkill -f "$PATTERN" 2>/dev/null || true
  pkill -f "transcribe-history.sh --background" 2>/dev/null || true
}

case "${1:-}" in
  status) status; exit 0 ;;
  stop) stop; echo "Stopped. Whatever was transcribed stays saved."; exit 0 ;;
  --background) shift; BACKGROUND=1 ;;
esac

PROCESSES="${1:-1}"
BEFORE="$CUTOFF"
if [ -n "${2:-}" ]; then
  BEFORE=$(date -j -f "%Y-%m-%d %H:%M:%S" "$2 00:00:00" +%s)
  [ "$BEFORE" -gt "$CUTOFF" ] && BEFORE="$CUTOFF"
fi

source "$REPO/whisper.env"
if [ -f "$HOME/.wacrawl/whisper.env" ]; then source "$HOME/.wacrawl/whisper.env"; fi
UV=""
for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
  [ -x "$c" ] && { UV="$c"; break; }
done
[ -n "$UV" ] && [ -d "$HOME/.cache/huggingface/hub/models--${WHISPER_MODEL//\//--}" ] \
  || { echo "Transcription isn't installed: run ./setup-whisper.sh"; exit 1; }

if [ -z "${BACKGROUND:-}" ]; then
  stop   # one batch at a time: relaunching with another number of processes splits the work again
  # Detached from the terminal: it keeps going even if you close it.
  nohup "$REPO/$(basename "$0")" --background "$PROCESSES" ${2:+"$2"} >> "$HIST/transcribe.log" 2>&1 &
  echo "Started in the background ($PROCESSES process(es)). Progress: $0 status · log: $HIST/transcribe.log"
  pmset -g batt | grep -q "AC Power" || echo "The Mac is on battery: it starts when you plug it in."
  exit 0
fi

# Not on battery: Whisper runs the GPU flat out, and the Mac would go to sleep anyway.
until pmset -g batt | grep -q "AC Power"; do sleep 60; done
echo "[$(date '+%F %T')] starting: $PROCESSES process(es), voice notes before $(date -r "$BEFORE" +%F)"
PIDS=""
for k in $(seq 1 "$PROCESSES"); do
  UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
    WHISPER_MODEL="$WHISPER_MODEL" WHISPER_LANGUAGE="${WHISPER_LANGUAGE:-}" \
    "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PACKAGE" \
    python "$REPO/transcribe.py" --pending --archive "$HIST/wacrawl.db" --before "$BEFORE" --part "$k/$PROCESSES" \
    > /dev/null 2>> "$HIST/transcribe-$k.log" &
  PIDS="$PIDS $!"
done
caffeinate -i -s -w $$ &   # keep the Mac awake while it runs
wait $PIDS || true
echo "[$(date '+%F %T')] finished"
status
