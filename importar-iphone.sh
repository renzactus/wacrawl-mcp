#!/bin/bash
# Importa los años de WhatsApp que tiene el iPhone y que WhatsApp Desktop no recibió
# al vincularse (Desktop trae ~1 año; el iPhone tiene todo).
#
#   ./importar-iphone.sh <carpeta-del-backup> [--con-videos]
#
# Antes (ver README, "Importar años de historia desde el iPhone"):
#   1. Backup del iPhone en Finder, SIN cifrar.
#   2. Sacar su carpeta de ~/Library/Application Support/MobileSync/Backup
#      arrastrándola en Finder (macOS no deja que un script la lea ahí).
#
# Queda en ~/.wacrawl/historico, APARTE del archivo principal: cuando WhatsApp
# renumera, el sync reconstruye el principal entero con lo que tiene Desktop y se
# llevaría puesto lo importado. El server consulta los dos.
#
# Sin --con-videos deja afuera videos y stickers (en un iPhone típico son la mitad
# del espacio, y Claude no los puede mirar).

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HIST="${WACRAWL_HISTORICO_DIR:-$HOME/.wacrawl/historico}"   # la variable, sólo para probar
FUENTE="$HIST/fuente"
ok()    { echo "  ✓ $*"; }
falla() { echo "  ✗ $*"; exit 1; }
paso()  { echo; echo "▸ $*"; }

NODE="$REPO/runtime/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || falla "Falta Node: corré ./instalar.sh primero."
WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done
[ -n "$WACRAWL" ] || falla "Falta wacrawl: corré ./instalar.sh primero."

B="${1:-}"; B="${B%/}"
CON_VIDEOS=0; [ "${2:-}" = "--con-videos" ] && CON_VIDEOS=1

paso "Backup"
[ -n "$B" ] || falla "Pasame la carpeta del backup: ./importar-iphone.sh ~/backup-iphone/<carpeta>"
if [[ "$B" == *"/MobileSync/Backup/"* ]]; then
  falla "macOS no deja leer el backup ahí. En Finder arrastrá la carpeta a otro lado (ej. tu carpeta de usuario) y pasame esa ruta."
fi
[ -f "$B/Manifest.db" ] || falla "En $B no hay un backup de iPhone (falta Manifest.db)."
[ "$(plutil -extract IsEncrypted raw "$B/Manifest.plist" 2>/dev/null)" = false ] ||
  falla "El backup está cifrado. En Finder destildá \"Cifrar copia local\", hacé otra copia y volvé a correr esto."
[ ! -e "$HIST/wacrawl.db" ] || falla "Ya hay un histórico importado en $HIST. Para rehacerlo, borrá esa carpeta primero."
FECHA_BACKUP_ISO="$(plutil -extract Date raw "$B/Manifest.plist")"
FECHA_BACKUP="${FECHA_BACKUP_ISO:0:10}"
ok "$(plutil -extract Lockdown.DeviceName raw "$B/Manifest.plist" 2>/dev/null || echo iPhone), del $FECHA_BACKUP, sin cifrar"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp -c "$B/Manifest.db" "$TMP/Manifest.db" 2>/dev/null || cp "$B/Manifest.db" "$TMP/Manifest.db"
sqlite3 -separator $'\t' "$TMP/Manifest.db" \
  "SELECT fileID, relativePath FROM Files WHERE domain = 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared' AND flags = 1" > "$TMP/todo.tsv"
grep -q $'\tChatStorage.sqlite$' "$TMP/todo.tsv" || falla "El backup no tiene WhatsApp."
if [ "$CON_VIDEOS" = 1 ]; then
  cp "$TMP/todo.tsv" "$TMP/lista.tsv"
else
  awk -F'\t' 'tolower($2) !~ /\.(mp4|mov|m4v|3gp|webp)$/' "$TMP/todo.tsv" > "$TMP/lista.tsv"
fi

# Espacio: en el mismo disco los archivos se ENLAZAN (no ocupan nada extra mientras
# exista el backup). Lo que sí ocupa: la copia temporal que wacrawl hace de la base
# de chats para importarla, más el archivo resultante.
CHAT_ID="$(awk -F'\t' '$2 == "ChatStorage.sqlite" {print $1}' "$TMP/todo.tsv")"
CHAT_MB=$(( $(stat -f %z "$B/${CHAT_ID:0:2}/$CHAT_ID") / 1048576 ))
NECESITA_MB=$(( CHAT_MB * 3 + 1024 ))
mkdir -p "$HIST"
if [ "$(stat -f %d "$B")" != "$(stat -f %d "$HIST")" ]; then
  # Otro disco: no se puede enlazar, hay que copiar los adjuntos.
  ADJ_MB=$(awk -F'\t' -v b="$B" '{print b"/"substr($1,1,2)"/"$1}' "$TMP/lista.tsv" | tr '\n' '\0' |
    xargs -0 stat -f %z | awk '{t+=$1} END {printf "%d", t/1048576}')
  NECESITA_MB=$(( NECESITA_MB + ADJ_MB ))
fi
LIBRE_MB=$(df -m "$HIST" | tail -1 | awk '{print $4}')
[ "$LIBRE_MB" -gt "$NECESITA_MB" ] ||
  falla "Hacen falta ~$(( NECESITA_MB / 1024 + 1 )) GB libres y hay $(( LIBRE_MB / 1024 )) GB. Liberá espacio y volvé a correr esto."
ok "espacio: hacen falta ~$(( NECESITA_MB / 1024 + 1 )) GB, hay $(( LIBRE_MB / 1024 )) GB libres"

paso "Sacando WhatsApp del backup ($(wc -l < "$TMP/lista.tsv" | tr -d ' ') archivos$([ "$CON_VIDEOS" = 1 ] || echo ', sin videos ni stickers'))"
rm -rf "$FUENTE"
"$NODE" -e '
const fs = require("fs"), path = require("path");
const [backup, lista, destino] = process.argv.slice(1);
let n = 0;
for (const linea of fs.readFileSync(lista, "utf8").split("\n")) {
  if (!linea) continue;
  const [id, rel] = linea.split("\t");
  const src = path.join(backup, id.slice(0, 2), id), dst = path.join(destino, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); } catch (e) { if (e.code !== "EXDEV") throw e; fs.copyFileSync(src, dst); }
  n++;
}
console.log(`  ✓ ${n} archivos`);
' "$B" "$TMP/lista.tsv" "$FUENTE"

# La base de chats se separa del backup (clon APFS, gratis): la vamos a tocar.
CS="$FUENTE/ChatStorage.sqlite"
{ cp -c "$CS" "$CS.tmp" 2>/dev/null || cp "$CS" "$CS.tmp"; } && mv "$CS.tmp" "$CS"

# wacrawl se niega a importar si los mensajes recibidos apuntan a más de una cuenta
# propia (bien: no mezcla dos personas). Pero un iPhone real puede tener unas pocas
# filas mal marcadas — en el caso que lo destapó, UNA, con un grupo como destinatario.
# Si la cuenta principal es >99% de los recibidos, esas filas se limpian en la copia.
paso "Cuenta de WhatsApp"
CUENTAS="$(sqlite3 -separator $'\t' "$CS" "SELECT lower(trim(ZTOJID)), count(*) FROM ZWAMESSAGE
  WHERE coalesce(ZISFROMME, 0) = 0 AND trim(coalesce(ZTOJID, '')) <> '' GROUP BY 1 ORDER BY 2 DESC")"
CUENTA="$(echo "$CUENTAS" | head -1 | cut -f1)"
TOTAL=$(echo "$CUENTAS" | awk -F'\t' '{t+=$2} END {print t+0}')
PRINCIPAL=$(echo "$CUENTAS" | head -1 | cut -f2)
OTRAS=$(( TOTAL - PRINCIPAL ))
if [ "$OTRAS" -gt 0 ]; then
  [ $(( OTRAS * 100 )) -lt "$TOTAL" ] ||
    falla "El backup parece tener más de una cuenta de WhatsApp ($(echo "$CUENTAS" | wc -l | tr -d ' ')). No lo mezclo."
  cp -c "$CS" "$FUENTE/ChatStorage.original.sqlite" 2>/dev/null || cp "$CS" "$FUENTE/ChatStorage.original.sqlite"
  sqlite3 "$CS" "UPDATE ZWAMESSAGE SET ZTOJID = NULL WHERE coalesce(ZISFROMME, 0) = 0
    AND trim(coalesce(ZTOJID, '')) <> '' AND lower(trim(ZTOJID)) <> '$CUENTA'; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  ok "${CUENTA%@*} (limpié $OTRAS fila(s) mal marcadas; el original quedó en ChatStorage.original.sqlite)"
else
  ok "${CUENTA%@*}"
fi

paso "Importando (tarda unos minutos)"
T="$(getconf DARWIN_USER_TEMP_DIR)"; touch "$TMP/inicio"
"$WACRAWL" --source "$FUENTE" --db "$HIST/wacrawl.db" import > "$HIST/import.log" 2>&1 &
PID=$!
while kill -0 "$PID" 2>/dev/null; do
  if [ "$(df -m "$HIST" | tail -1 | awk '{print $4}')" -lt 700 ]; then
    kill "$PID"; wait "$PID" 2>/dev/null || true
    # wacrawl deja su copia temporal si se lo corta
    find "$T" -maxdepth 1 -name 'wacrawl-desktop-*' -newer "$TMP/inicio" -exec rm -rf {} +
    rm -f "$HIST"/wacrawl.db*
    falla "Corté: el disco se estaba quedando sin lugar. Liberá espacio y volvé a correr esto."
  fi
  sleep 3
done
wait "$PID" || { rm -f "$HIST"/wacrawl.db*; falla "wacrawl falló: $(tail -3 "$HIST/import.log")"; }
ok "$(grep -E "^messages=" "$HIST/import.log" | cut -d= -f2) mensajes importados"

# Los dos archivos se solapan en el último año. El corte es el primer mes desde el
# cual el principal ya está completo (≥95% de lo que tiene el iPhone, mes a mes, sin contar el mes
# del backup, que está a medias en los dos): antes responde el histórico, desde ahí el principal.
# Así nada sale dos veces. Donde los dos están completos gana el principal: tiene más nombres de
# remitentes en grupos (medido: 1,4% sin nombre contra 16% en el iPhone).
paso "Uniendo con el archivo actual"
POR_MES="SELECT strftime('%Y-%m', ts, 'unixepoch') AS mes, count(DISTINCT msg_id) AS n
  FROM messages WHERE deleted_at IS NULL AND ts > 1230768000 GROUP BY mes"
"$WACRAWL" --sync never --json sql "$POR_MES" > "$TMP/principal.json"
"$WACRAWL" --db "$HIST/wacrawl.db" --sync never --json sql "$POR_MES" > "$TMP/historico.json"
"$NODE" -e '
const fs = require("fs");
const [principal, historico, salida, backup, conVideos] = process.argv.slice(1);
const leer = (f) => Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8") || "[]").map((r) => [r.mes, r.n]));
const p = leer(principal), h = leer(historico);
const meses = Object.keys(h).sort();
const hasta = backup;
let corteMes = null;
for (let i = meses.length - 1; i >= 0; i--) {
  const mes = meses[i];
  if (mes >= hasta.slice(0, 7)) continue;
  if ((p[mes] || 0) < 0.95 * h[mes]) break;
  corteMes = mes;
}
// Si ni el mes del backup está completo en el principal, el histórico responde todo hasta el backup.
const corte = corteMes ? Date.UTC(+corteMes.slice(0, 4), +corteMes.slice(5) - 1, 1) / 1000
                       : Math.floor(Date.parse(backup) / 1000);
const mensajes = meses.filter((m) => m < (corteMes || "9999")).reduce((s, m) => s + h[m], 0);
const info = {
  corte, corteFecha: new Date(corte * 1000).toISOString().slice(0, 10),
  // el primer mes con uso real: suele haber un puñado de mensajes sueltos con fechas de años antes
  desde: meses.find((m) => h[m] >= 100) || meses[0], backup: backup.slice(0, 10),
  mensajes, sinVideos: conVideos !== "1", importado: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(salida, JSON.stringify(info, null, 2) + "\n");
console.log(`  ✓ el histórico aporta ${mensajes.toLocaleString("es")} mensajes, desde ${info.desde} hasta ${info.corteFecha}`);
' "$TMP/principal.json" "$TMP/historico.json" "$HIST/corte.json" "$FECHA_BACKUP_ISO" "$CON_VIDEOS"

# Desde cuándo el iPhone todavía tiene los archivos: al migrar de teléfono o restaurar desde iCloud,
# WhatsApp suele traer el texto de todo pero los adjuntos sólo de los últimos años (de antes deja una
# miniatura de 99x99). Las tools lo usan para explicar por qué falta un adjunto viejo.
"$WACRAWL" --db "$HIST/wacrawl.db" --sync never --json sql "SELECT strftime('%Y-%m', ts, 'unixepoch') AS mes, media_path AS p
  FROM messages WHERE message_type IN ('image', 'audio') AND coalesce(media_path, '') <> ''" > "$TMP/adjuntos.json"
"$NODE" -e '
const fs = require("fs");
const [adjuntos, salida] = process.argv.slice(1);
const porMes = {};
for (const { mes, p } of JSON.parse(fs.readFileSync(adjuntos, "utf8") || "[]")) {
  const c = (porMes[mes] ||= [0, 0]); c[1]++; if (fs.existsSync(p)) c[0]++;
}
const meses = Object.keys(porMes).sort();
let desde = null;
for (let i = meses.length - 1; i >= 0 && porMes[meses[i]][0] * 2 >= porMes[meses[i]][1]; i--) desde = meses[i];
const info = JSON.parse(fs.readFileSync(salida, "utf8"));
info.adjuntosDesde = desde;
fs.writeFileSync(salida, JSON.stringify(info, null, 2) + "\n");
if (desde && desde !== meses[0]) console.log(`  ✓ adjuntos desde ${desde} (de antes, el iPhone sólo guardaba el texto)`);
' "$TMP/adjuntos.json" "$HIST/corte.json"

echo
echo "════════════════════════════════════════════════════════════"
echo " Listo. Abrí una conversación nueva en Claude y preguntale algo viejo."
echo
echo " Ya podés borrar el backup (lo de WhatsApp quedó en $FUENTE):"
echo "   $B"
echo " En Finder: seleccionalo y ⌥⌘⌫."
echo "════════════════════════════════════════════════════════════"
