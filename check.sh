#!/bin/bash
# Diagnóstico de fidelidad: muestra CÓMO RENDERIZA el server cada tipo de
# mensaje, al lado del dato crudo.
#
# Existe porque los dos peores bugs hasta ahora no fueron caídas — fueron datos
# que se mostraban mal y parecían plausibles: horarios en UTC (todo corrido) y
# audios/stickers renderizados como el mismo blob base64 (indistinguibles).
# Un test de "¿responde?" no los agarra. Esto obliga a mirarlos.
#
# Uso:  ./check.sh          (todo)
#       ./check.sh tipos    (sólo un tipo de chequeo)

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WACRAWL="${WACRAWL_BIN:-}"
if [ -z "$WACRAWL" ]; then
  for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
    [ -x "$c" ] && { WACRAWL="$c"; break; }
  done
fi
[ -x "$WACRAWL" ] || { echo "✗ No encuentro wacrawl. Corré ./instalar.sh"; exit 1; }
export WACRAWL_BIN="$WACRAWL"
NODE="$DIR/runtime/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
SOLO="${1:-todo}"

sql() { "$WACRAWL" --sync never --json sql "$1"; }

# Llama a una tool del MCP y devuelve su texto.
tool() {
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | "$NODE" "$DIR/server.js" \
  | python3 -c "
import sys, json
for line in sys.stdin:
    d = json.loads(line)
    if d.get('id') != 2: continue
    if 'error' in d: print('ERROR:', d['error']['message'][:200])
    else: print(d['result']['content'][0]['text'])
"
}

# ---------------------------------------------------------------- tipos
# Cada tipo de mensaje, renderizado. Buscás: blobs base64, "(undefined)",
# dos tipos distintos que se vean igual.
if [ "$SOLO" = todo ] || [ "$SOLO" = tipos ]; then
  echo "══ Cómo se ve CADA tipo de mensaje ══"
  # Traemos UNA fila real de cada tipo y la pasamos por el mismo renderizador
  # que usa el server. Así se compara manzana con manzana.
  sql "SELECT message_type, count(*) AS n,
              max(text) AS text, max(media_title) AS media_title,
              max(sender_name) AS sender_name, max(chat_name) AS chat_name,
              max(chat_jid) AS chat_jid, max(sender_jid) AS sender_jid, 0 AS from_me
       FROM messages WHERE deleted_at IS NULL AND message_type IS NOT NULL
       GROUP BY message_type ORDER BY n DESC" \
  | "$NODE" -e '
const { messageBody } = require(process.argv[1] + "/server.js");
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  for (const r of JSON.parse(raw)) {
    const crudo = (r.text || "").slice(0, 28).replace(/\n/g, " ");
    console.log(
      `  ${r.message_type.padEnd(14)} ${String(r.n).padStart(7)}  ` +
      `crudo: ${crudo.padEnd(30)} → ${messageBody(r).slice(0, 42)}`
    );
  }
});
' "$DIR"
  echo "  (buscás: blobs base64 pasando de largo, o dos tipos que se vean igual)"
  echo
fi

# ---------------------------------------------------------------- horarios
# El horario que muestra la tool vs el reloj de la Mac. Si no coinciden,
# está saliendo en UTC.
if [ "$SOLO" = todo ] || [ "$SOLO" = horarios ]; then
  echo "══ Horarios (tienen que coincidir con el reloj local) ══"
  echo "reloj de esta Mac:  $(date '+%Y-%m-%d %H:%M')  ($(date '+%Z, UTC%z'))"
  echo -n "último en vivo:     "; tool mensajes_recientes '{"limit":1}' | tail -1 | cut -c1-70
  echo -n "último del archivo: "; tool listar_chats '{"limit":1}' | tail -1 | cut -c1-90
  echo
fi

# ------------------------------------------------------------- cobertura
# Archivo vs WhatsApp en vivo: cuánto falta.
if [ "$SOLO" = todo ] || [ "$SOLO" = cobertura ]; then
  echo "══ Archivo vs WhatsApp en vivo ══"
  "$WACRAWL" --sync never doctor | python3 -c "
import sys, json, subprocess, os, datetime
src = json.load(sys.stdin)['desktop']
out = subprocess.run([os.environ.get('WACRAWL_BIN', os.path.expanduser('~/.local/bin/wacrawl')),
                      '--sync','never','--json','sql',
                      'SELECT max(ts) AS t, count(*) AS n FROM messages WHERE deleted_at IS NULL'],
                     capture_output=True, text=True).stdout
arch = json.loads(out)[0]
viv = datetime.datetime.fromisoformat(src['newest_message'].replace('Z','+00:00')).timestamp()
print(f\"  mensajes:  archivo {arch['n']:>7}   whatsapp {src['message_rows']:>7}\")
print(f\"  atraso:    {int((viv - arch['t']) / 60)} min\")
"
  echo
fi

# ------------------------------------------------------------------ sync
# El sync estuvo roto 4 días sin que nadie se enterara. Esto lo hace visible.
if [ "$SOLO" = todo ] || [ "$SOLO" = sync ]; then
  echo "══ Salud del sync ══"
  LABEL=com.openclaw.wacrawl.sync
  EXIT=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -m1 "last exit code" | tr -d ' \t')
  echo "  agente:        ${EXIT:-NO INSTALADO}"
  if [ -f "$HOME/.wacrawl/wrapper.log" ]; then
    echo "  última corrida:"
    tail -4 "$HOME/.wacrawl/wrapper.log" | sed 's/^/    /'
  else
    echo "  ⚠️  sin wrapper.log — el agente no está usando sync-wrapper.sh"
  fi
  if [ -s "$HOME/.wacrawl/sync.err.log" ]; then
    echo "  ⚠️  hay errores en sync.err.log:"
    tail -2 "$HOME/.wacrawl/sync.err.log" | sed 's/^/    /'
  fi
  echo
fi

# ------------------------------------------------------------- atribución
if [ "$SOLO" = todo ] || [ "$SOLO" = atribucion ]; then
  echo "══ Atribución de remitente ══"
  sql "SELECT c.kind,
              count(*) AS mensajes,
              sum(CASE WHEN m.sender_name GLOB '*=' THEN 1 ELSE 0 END) AS sin_nombre
       FROM messages m JOIN chats c ON c.jid = m.chat_jid
       WHERE m.deleted_at IS NULL AND m.from_me = 0 AND m.message_type = 'text'
       GROUP BY c.kind ORDER BY mensajes DESC" \
  | python3 -c "
import sys, json
for r in json.load(sys.stdin):
    tot, sn = r['mensajes'], r['sin_nombre']
    print(f\"  {r['kind']:<12} {tot:>7} mensajes, {sn:>6} sin nombre ({100*sn/tot if tot else 0:.0f}%)\")
"
fi
