#!/bin/bash
# Installs local transcription of voice notes (optional).
#
#   ./setup-whisper.sh
#
# Uses Whisper (large-v3-turbo) on MLX, optimized for Apple chips. Downloads the model
# once (~1.6 GB); after that it transcribes offline: voice notes never leave the Mac.
# Nothing is compiled: uv fetches Python and the libraries prebuilt.

set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
source "$REPO/whisper.env"
USER_ENV="$HOME/.wacrawl/whisper.env"
if [ -f "$USER_ENV" ]; then source "$USER_ENV"; fi
ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }

echo "▸ Requirements"
[ "$(uname -m)" = arm64 ] || fail "It needs a Mac with an Apple chip (M1 or later): MLX doesn't run on Intel."
IFS=. read -r MA MI _ <<< "$(sw_vers -productVersion).0"
{ [ "$MA" -gt 13 ] || { [ "$MA" -eq 13 ] && [ "$MI" -ge 5 ]; }; } || fail "It needs macOS 13.5 or newer."
ok "Apple chip, macOS $(sw_vers -productVersion)"
[ -f "$HOME/.wacrawl/wacrawl.db" ] || fail "Run ./install.sh first (there's no WhatsApp archive yet)."
WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done

echo; echo "▸ uv (installs Python and the libraries without compiling)"
UV=""
for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
  [ -x "$c" ] && { UV="$c"; break; }
done
if [ -z "$UV" ]; then
  echo "  uv isn't installed. It's installed with Astral's official installer:"
  echo "    curl -LsSf https://astral.sh/uv/install.sh | sh"
  read -r -p "  Install it? [y/N] " r
  [[ "$r" =~ ^[yY] ]] || fail "Can't continue without uv."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
  [ -x "$UV" ] || fail "uv didn't get installed."
fi
ok "$UV ($("$UV" --version))"

# uv's own Python: that way it doesn't depend on PATH. Claude Desktop and launchd run with
# a minimal PATH, and a Homebrew Python isn't found there.
"$UV" python install "$WHISPER_PYTHON" >/dev/null 2>&1
ok "Python $WHISPER_PYTHON managed by uv"

echo; echo "▸ Model ($WHISPER_MODEL, ~1.6 GB, only once)"
HF_HUB_DISABLE_TELEMETRY=1 "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PACKAGE" python -c "
from huggingface_hub import snapshot_download
snapshot_download('$WHISPER_MODEL')" 2>&1 | grep -v Warning || true
[ -d "$HOME/.cache/huggingface/hub/models--${WHISPER_MODEL//\//--}" ] || fail "Couldn't download the model."
ok "model ready"

echo; echo "▸ Language of your voice notes"
if [ -f "$USER_ENV" ] && grep -q '^WHISPER_LANGUAGE=' "$USER_ENV"; then
  ok "already set: ${WHISPER_LANGUAGE:-detected per voice note} (in $USER_ENV)"
else
  echo "  Whisper can detect it per voice note, but setting it is more accurate if you mostly"
  echo "  speak one language (short voice notes get detected wrong more often)."
  read -r -p "  Language code (e.g. en, es, pt, de; Enter = detect it): " L || L=""
  L="$(printf '%s' "$L" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  [[ -z "$L" || "$L" =~ ^[a-z]{2,3}$ ]] || fail "\"$L\" doesn't look like a language code (e.g. en, es)."
  mkdir -p "$HOME/.wacrawl"
  echo "WHISPER_LANGUAGE=$L" >> "$USER_ENV"
  WHISPER_LANGUAGE="$L"
  ok "${L:-detected per voice note} (you can change it in $USER_ENV)"
fi

echo; echo "▸ Vocabulary (helps get proper names right)"
VOC="$HOME/.wacrawl/vocabulary.txt"
OLD_VOC="$HOME/.wacrawl/vocabulario.txt"   # the name earlier versions used
if [ -f "$VOC" ] || [ -f "$OLD_VOC" ]; then
  F="$VOC"; [ -f "$F" ] || F="$OLD_VOC"
  ok "you already have one ($(grep -cvE '^[[:space:]]*(#|$)' "$F") terms) — leaving it alone"
else
  env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 \
    "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PACKAGE" python "$REPO/transcribe.py" --suggest-vocabulary \
    2>/dev/null > "$VOC" || true
  ok "built a suggested one from what you write: $VOC"
  echo "    Review it: put your company, team and clients at the top (the first lines weigh more)."
  echo "    Measured: with a vocabulary, a company name went from 0 to 11 right out of 20."
fi

echo; echo "▸ Test: the 3 most recent voice notes, offline"
# Into a temporary database: it doesn't depend on what's pending (that could be exactly a
# damaged voice note) and doesn't write to the real one. Passes if at least one comes out fine.
TEST="$(mktemp -d)"
RES=$(env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
  WHISPER_MODEL="$WHISPER_MODEL" WHISPER_LANGUAGE="${WHISPER_LANGUAGE:-}" WACRAWL_TRANSCRIPTIONS_DB="$TEST/t.sqlite" \
  "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PACKAGE" python "$REPO/transcribe.py" --pending --limit 3 2>&1 | grep -v Warning || true)
rm -rf "$TEST"
[[ "$RES" == *'"text"'* ]] || fail "The test failed: $(echo "$RES" | tail -2)"
ok "$(echo "$RES" | grep -o '"text": "[^"]*' | head -1 | cut -c10-90)…"

echo; echo "▸ First pass"
PEND=$("${WACRAWL:-wacrawl}" --sync never sql "SELECT count(*) FROM messages WHERE message_type='audio' AND media_path<>''" 2>/dev/null | tail -1 || echo "?")
echo "  There are ~$PEND voice notes on disk. Transcription runs in the background (≈2 s each);"
echo "  after that, the automatic sync transcribes the new ones every 6 hours."
nohup env -i HOME="$HOME" PATH=/usr/bin:/bin UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
  WHISPER_MODEL="$WHISPER_MODEL" WHISPER_LANGUAGE="${WHISPER_LANGUAGE:-}" \
  "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PACKAGE" python "$REPO/transcribe.py" --pending \
  >/dev/null 2>>"$HOME/.wacrawl/transcribe.log" &
ok "started (log: ~/.wacrawl/transcribe.log)"
echo
echo "Done. Quit and reopen Claude Desktop (⌘Q) so it picks up the voice note tool."
echo "If you edit the vocabulary later, re-transcribe the old ones with:"
echo "  $REPO/redo-transcriptions.sh"
