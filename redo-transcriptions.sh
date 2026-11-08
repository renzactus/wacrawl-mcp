#!/bin/bash
# Re-transcribes the voice notes done with a different vocabulary than the current one
# (for example, after editing ~/.wacrawl/vocabulary.txt). Runs in the background and can
# be stopped: it resumes where it left off, because each transcription records which
# version of the vocabulary it used.

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
source "$REPO/whisper.env"
if [ -f "$HOME/.wacrawl/whisper.env" ]; then source "$HOME/.wacrawl/whisper.env"; fi
UV=""
for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
  [ -x "$c" ] && { UV="$c"; break; }
done
[ -n "$UV" ] || { echo "✗ Transcription isn't installed: run ./setup-whisper.sh"; exit 1; }
nohup env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
  WHISPER_MODEL="$WHISPER_MODEL" WHISPER_LANGUAGE="${WHISPER_LANGUAGE:-}" \
  "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PACKAGE" python "$REPO/transcribe.py" --redo \
  >/dev/null 2>>"$HOME/.wacrawl/transcribe.log" &
echo "✓ Re-transcribing in the background (≈2 s per voice note). Progress: $REPO/check.sh audio"
