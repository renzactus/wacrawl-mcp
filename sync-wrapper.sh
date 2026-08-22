#!/bin/bash
# sync-wrapper.sh — sync de wacrawl con auto-recuperación y alerta.
#
# El agente de launchd llama a ESTE script, no a wacrawl directo.
#
# Por qué existe: el 2026-08-09 WhatsApp Desktop recompactó su base local y
# renumeró los source_pk. wacrawl se negó a mergear ("belongs to a different
# event") para no corromper el archivo — correcto — pero abortó en silencio
# durante 4 días. Renzo se enteró de casualidad, en medio de una búsqueda,
# porque una respuesta le pareció vieja.
#
# El error no fue el problema. El silencio sí.

set -uo pipefail

WACRAWL="${WACRAWL_BIN:-$HOME/.local/bin/wacrawl}"
DIR="$HOME/.wacrawl"
DB="$DIR/wacrawl.db"
LOG="$DIR/wrapper.log"
MAX_BACKUPS=2          # cada backup son ~635 MB, no acumular
FRESH_LIMIT_H=12       # avisar si el archivo se atrasa más que esto

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

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
  last=$("$WACRAWL" --sync never --json sql \
    "SELECT max(ts) AS t FROM messages WHERE deleted_at IS NULL" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['t'])" 2>/dev/null) || return 1
  [ -n "$last" ] || return 1
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

    # Sin backup no se toca nada: el archivo tiene 10 años de historial que
    # WhatsApp Desktop ya no necesariamente conserva.
    if ! cp "$DB" "$BAK"; then
      log "BACKUP FALLO — aborto sin tocar el archivo"
      notify "Backup falló. Sync detenido, archivo intacto."
      exit 1
    fi

    ANTES=$("$WACRAWL" --sync never --json sql \
      "SELECT count(*) AS n FROM messages" 2>/dev/null \
      | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['n'])" 2>/dev/null || echo 0)

    if OUT2=$("$WACRAWL" import --restore --copy-media 2>&1); then
      DESPUES=$("$WACRAWL" --sync never --json sql \
        "SELECT count(*) AS n FROM messages" 2>/dev/null \
        | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['n'])" 2>/dev/null || echo 0)
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
