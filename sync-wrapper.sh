#!/bin/bash
# sync-wrapper.sh — wacrawl sync with self-recovery and alerts.
#
# The launchd agent calls THIS script, not wacrawl directly.
#
# Why it exists: when WhatsApp Desktop is re-linked or updated, it sometimes compacts its
# local database and renumbers its source_pk values. wacrawl then refuses to merge
# ("belongs to a different event") so it doesn't corrupt the archive — good — but without
# this the sync silently aborts every 6 h and nobody notices until an answer looks stale.
# It happened: it was broken for 4 days without a word.
#
# The error isn't the problem. The silence is.

set -uo pipefail

# launchd runs with a minimal PATH: look for wacrawl where it's usually installed.
WACRAWL="${WACRAWL_BIN:-}"
if [ -z "$WACRAWL" ]; then
  for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
    [ -x "$c" ] && { WACRAWL="$c"; break; }
  done
fi
DIR="$HOME/.wacrawl"
DB="$DIR/wacrawl.db"
LOG="$DIR/wrapper.log"
MAX_BACKUPS=2          # each backup is as big as the archive (hundreds of MB): don't pile them up
FRESH_LIMIT_H=12       # alert if the archive falls further behind than this

mkdir -p "$DIR"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# A single value from a SELECT, without depending on python3 (which, on a Mac without the
# developer tools, opens an installer instead of running).
sql_value() { "$WACRAWL" --sync never sql "$1" 2>/dev/null | tail -1; }

if [ -z "$WACRAWL" ] || [ ! -x "$WACRAWL" ]; then
  log "can't find wacrawl"
  osascript -e 'display notification "wacrawl not found: the sync is not running." with title "wacrawl"' >/dev/null 2>&1 || true
  exit 1
fi

notify() {
  # osascript fails silently without notification permission, so we always leave a trace
  # in the log as well.
  log "NOTIFY: $1"
  osascript -e "display notification \"$1\" with title \"wacrawl\"" >/dev/null 2>&1 || true
}

# The REAL age of the data (newest message), not the file's mtime: a failed sync still
# touches the database, and the mtime lies.
data_age_hours() {
  local last
  last=$(sql_value "SELECT max(ts) FROM messages WHERE deleted_at IS NULL")
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  echo $(( ( $(date +%s) - last ) / 3600 ))
}

log "--- start ---"

# --copy-media: copies attachments to ~/.wacrawl/media, OUTSIDE WhatsApp's protected
# container. That way the MCP server reads them without depending on macOS permissions,
# and they keep working even if node's permission is lost after an update.
OUT=$("$WACRAWL" import --copy-media 2>&1); RC=$?

if [ $RC -ne 0 ]; then
  log "sync FAILED (rc=$RC): $OUT"

  if echo "$OUT" | grep -qE "different event|disk image is malformed"; then
    BAK="$DB.bak-$(date +%Y%m%d-%H%M%S)"
    log "known error, trying to recover. backup -> $BAK"

    # Without a backup nothing gets touched: the archive may have history that WhatsApp
    # Desktop no longer keeps.
    if ! cp "$DB" "$BAK"; then
      log "BACKUP FAILED — aborting without touching the archive"
      notify "Backup failed. Sync stopped, archive untouched."
      exit 1
    fi

    BEFORE=$(sql_value "SELECT count(*) FROM messages"); BEFORE=${BEFORE:-0}

    if OUT2=$("$WACRAWL" import --restore --copy-media 2>&1); then
      AFTER=$(sql_value "SELECT count(*) FROM messages"); AFTER=${AFTER:-0}
      log "restore OK: $BEFORE -> $AFTER messages"

      # The real risk of a restore is that WhatsApp has LESS history than the archive. If
      # that happens, go back to the backup: a lag can be fixed, lost history can't.
      if [ "$AFTER" -lt $(( BEFORE * 95 / 100 )) ]; then
        log "ALERT: the restore lost history ($BEFORE -> $AFTER). Reverting."
        cp "$BAK" "$DB"
        notify "The restore was losing history. Archive reverted to the backup."
        exit 1
      fi
      notify "WhatsApp archive rebuilt after a sync error ($AFTER messages)."
    else
      log "restore FAILED: $OUT2"
      notify "wacrawl is down: the restore failed. See ~/.wacrawl/wrapper.log"
      exit 1
    fi

    ls -1t "$DB".bak-* 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | while read -r old; do
      log "deleting old backup: $old"; rm -f "$old"
    done
  else
    log "unknown error, not attempting recovery"
    notify "wacrawl: the sync failed. See ~/.wacrawl/wrapper.log"
    exit 1
  fi
else
  log "sync OK"
fi

# Transcribe the new voice notes, if transcription is installed (setup-whisper.sh).
# Local and offline; capped at 20 min per run so the sync doesn't drag on forever.
# transcribe.py has its own lock: if another pass is running, it exits.
REPO="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$REPO/whisper.env" ] && [ -f "$REPO/transcribe.py" ]; then
  source "$REPO/whisper.env"
  if [ -f "$DIR/whisper.env" ]; then source "$DIR/whisper.env"; fi
  UV=""
  for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
    [ -x "$c" ] && { UV="$c"; break; }
  done
  if [ -n "$UV" ] && [ -d "$HOME/.cache/huggingface/hub/models--${WHISPER_MODEL//\//--}" ]; then
    RES=$(UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 \
      WHISPER_MODEL="$WHISPER_MODEL" WHISPER_LANGUAGE="${WHISPER_LANGUAGE:-}" \
      "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PACKAGE" \
      python "$REPO/transcribe.py" --pending --minutes 20 2>&1 >/dev/null | grep -v Warning | tail -1)
    log "voice notes: ${RES:-nothing new}"
  fi
fi

if AGE_H=$(data_age_hours); then
  log "data age: ${AGE_H}h"
  if [ "$AGE_H" -gt "$FRESH_LIMIT_H" ]; then
    notify "The WhatsApp archive is ${AGE_H}h behind."
  fi
else
  log "couldn't measure the data age"
  notify "wacrawl: couldn't read the archive to check whether it is up to date."
fi

log "--- end ---"
