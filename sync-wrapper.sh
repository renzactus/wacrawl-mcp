#!/bin/bash
# sync-wrapper.sh — sync de wacrawl con auto-recuperación y alerta.
#
# El agente de launchd llama a ESTE script, no a wacrawl directo.
#
# Por qué existe: cuando WhatsApp Desktop se re-vincula o se actualiza, a veces
# recompacta su base local y renumera los source_pk. wacrawl entonces se niega a
# mergear ("belongs to a different event") para no corromper el archivo — bien —
# pero sin esto el sync aborta en silencio cada 6h y nadie se entera hasta que
# una respuesta parece vieja. Pasó: estuvo 4 días roto sin aviso.
#
# El error no es el problema. El silencio sí.

set -uo pipefail

# launchd corre con un PATH mínimo: buscamos wacrawl donde suele instalarse.
WACRAWL="${WACRAWL_BIN:-}"
if [ -z "$WACRAWL" ]; then
  for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
    [ -x "$c" ] && { WACRAWL="$c"; break; }
  done
fi
DIR="$HOME/.wacrawl"
DB="$DIR/wacrawl.db"
LOG="$DIR/wrapper.log"
MAX_BACKUPS=2          # cada backup pesa lo que el archivo (cientos de MB): no acumular
FRESH_LIMIT_H=12       # avisar si el archivo se atrasa más que esto

mkdir -p "$DIR"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# Un único valor de un SELECT, sin depender de python3 (que en una Mac sin
# herramientas de desarrollador abre un instalador en vez de correr).
sql_valor() { "$WACRAWL" --sync never sql "$1" 2>/dev/null | tail -1; }

if [ -z "$WACRAWL" ] || [ ! -x "$WACRAWL" ]; then
  log "no encuentro wacrawl"
  osascript -e 'display notification "No encuentro wacrawl: el sync no corre." with title "wacrawl"' >/dev/null 2>&1 || true
  exit 1
fi

notify() {
  # osascript falla mudo si no hay permiso de notificaciones, así que además
  # dejamos siempre el rastro en el log.
  log "NOTIFICO: $1"
  osascript -e "display notification \"$1\" with title \"wacrawl\"" >/dev/null 2>&1 || true
}

# Antigüedad REAL de los datos (mensaje más nuevo), no el mtime del archivo:
# un sync fallido igual toca la base y el mtime miente.
data_age_hours() {
  local last
  last=$(sql_valor "SELECT max(ts) FROM messages WHERE deleted_at IS NULL")
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  echo $(( ( $(date +%s) - last ) / 3600 ))
}

log "--- inicio ---"

# --copy-media: copia los adjuntos a ~/.wacrawl/media, FUERA del container
# protegido de WhatsApp. Así el MCP los lee sin depender de permisos de macOS,
# y siguen andando aunque el permiso de node se pierda por un update.
OUT=$("$WACRAWL" import --copy-media 2>&1); RC=$?

if [ $RC -ne 0 ]; then
  log "sync FALLO (rc=$RC): $OUT"

  if echo "$OUT" | grep -qE "different event|disk image is malformed"; then
    BAK="$DB.bak-$(date +%Y%m%d-%H%M%S)"
    log "error conocido, intento recuperar. backup -> $BAK"

    # Sin backup no se toca nada: el archivo puede tener historial que WhatsApp
    # Desktop ya no conserva.
    if ! cp "$DB" "$BAK"; then
      log "BACKUP FALLO — aborto sin tocar el archivo"
      notify "Backup falló. Sync detenido, archivo intacto."
      exit 1
    fi

    ANTES=$(sql_valor "SELECT count(*) FROM messages"); ANTES=${ANTES:-0}

    if OUT2=$("$WACRAWL" import --restore --copy-media 2>&1); then
      DESPUES=$(sql_valor "SELECT count(*) FROM messages"); DESPUES=${DESPUES:-0}
      log "restore OK: $ANTES -> $DESPUES mensajes"

      # El riesgo real del restore es que WhatsApp tenga MENOS historial que el
      # archivo. Si pasa, volvemos al backup: el atraso se arregla, el historial
      # perdido no.
      if [ "$DESPUES" -lt $(( ANTES * 95 / 100 )) ]; then
        log "ALERTA: el restore perdió historial ($ANTES -> $DESPUES). Revierto."
        cp "$BAK" "$DB"
        notify "El restore perdía historial. Archivo revertido al backup."
        exit 1
      fi
      notify "Archivo de WhatsApp reconstruido tras un error de sync ($DESPUES mensajes)."
    else
      log "restore FALLO: $OUT2"
      notify "wacrawl caído: el restore falló. Mirá ~/.wacrawl/wrapper.log"
      exit 1
    fi

    ls -1t "$DB".bak-* 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | while read -r old; do
      log "borro backup viejo: $old"; rm -f "$old"
    done
  else
    log "error desconocido, no intento recuperar"
    notify "wacrawl: el sync falló. Mirá ~/.wacrawl/wrapper.log"
    exit 1
  fi
else
  log "sync OK"
fi

# Transcripción de los audios nuevos, si está instalada (setup-whisper.sh).
# Local y sin conexión; tope de 20 min por corrida para no eternizar el sync.
# transcribir.py tiene su propio candado: si hay otra pasada corriendo, sale.
REPO="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$REPO/whisper.env" ] && [ -f "$REPO/transcribir.py" ]; then
  source "$REPO/whisper.env"
  UV=""
  for c in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$HOME/.cargo/bin/uv"; do
    [ -x "$c" ] && { UV="$c"; break; }
  done
  if [ -n "$UV" ] && [ -d "$HOME/.cache/huggingface/hub/models--${WHISPER_MODELO//\//--}" ]; then
    RES=$(UV_OFFLINE=1 HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 WHISPER_MODELO="$WHISPER_MODELO" \
      "$UV" run --quiet --python "$WHISPER_PYTHON" --with "$WHISPER_PAQUETE" \
      python "$REPO/transcribir.py" --pendientes --minutos 20 2>&1 >/dev/null | grep -v Warning | tail -1)
    log "audios: ${RES:-sin novedades}"
  fi
fi

if AGE_H=$(data_age_hours); then
  log "antigüedad del dato: ${AGE_H}h"
  if [ "$AGE_H" -gt "$FRESH_LIMIT_H" ]; then
    notify "Archivo de WhatsApp con ${AGE_H}h de atraso."
  fi
else
  log "no pude medir la antigüedad del dato"
  notify "wacrawl: no pude leer el archivo para chequear si está al día."
fi

log "--- fin ---"
