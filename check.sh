#!/bin/bash
# Fidelity check: shows HOW the server RENDERS each message type, next to the raw data.
#
# It exists because the two worst bugs so far weren't crashes — they were data shown
# wrong that looked plausible: times in UTC (everything shifted) and voice notes and
# stickers rendered as the same base64 blob (indistinguishable). A "does it answer?" test
# doesn't catch those. This forces you to look at them.
#
# Usage:  ./check.sh          (everything)
#         ./check.sh types    (one section: types, times, coverage, sync, audio, senders)

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WACRAWL="${WACRAWL_BIN:-}"
if [ -z "$WACRAWL" ]; then
  for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
    [ -x "$c" ] && { WACRAWL="$c"; break; }
  done
fi
[ -x "$WACRAWL" ] || { echo "✗ Can't find wacrawl. Run ./install.sh"; exit 1; }
export WACRAWL_BIN="$WACRAWL"
NODE="$DIR/runtime/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
ONLY="${1:-all}"

sql() { "$WACRAWL" --sync never --json sql "$1"; }

# Calls one of the MCP server's tools and prints its text.
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

# ---------------------------------------------------------------- types
# Each message type, rendered. What you're looking for: base64 blobs, "(undefined)", two
# different types that look the same.
if [ "$ONLY" = all ] || [ "$ONLY" = types ]; then
  echo "══ How EACH message type looks ══"
  # Take ONE real row of each type and run it through the same renderer the server uses.
  # That way it's apples to apples.
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
    const rawText = (r.text || "").slice(0, 28).replace(/\n/g, " ");
    console.log(
      `  ${r.message_type.padEnd(14)} ${String(r.n).padStart(7)}  ` +
      `raw: ${rawText.padEnd(30)} → ${messageBody(r).slice(0, 42)}`
    );
  }
});
' "$DIR"
  echo "  (what you're looking for: base64 blobs slipping through, or two types that look the same)"
  echo
fi

# ---------------------------------------------------------------- times
# The time the tool shows vs. the Mac's clock. If they don't match, it's coming out in UTC.
if [ "$ONLY" = all ] || [ "$ONLY" = times ]; then
  echo "══ Times (they must match the local clock) ══"
  echo "this Mac's clock:   $(date '+%Y-%m-%d %H:%M')  ($(date '+%Z, UTC%z'))"
  echo -n "latest live:        "; tool recent_messages '{"limit":1}' | tail -1 | cut -c1-70
  echo -n "latest in archive:  "; tool list_chats '{"limit":1}' | tail -1 | cut -c1-90
  echo
fi

# ------------------------------------------------------------- coverage
# Archive vs. WhatsApp live: how much is missing.
if [ "$ONLY" = all ] || [ "$ONLY" = coverage ]; then
  echo "══ Archive vs. WhatsApp live ══"
  "$WACRAWL" --sync never doctor | python3 -c "
import sys, json, subprocess, os, datetime
src = json.load(sys.stdin)['desktop']
out = subprocess.run([os.environ.get('WACRAWL_BIN', os.path.expanduser('~/.local/bin/wacrawl')),
                      '--sync','never','--json','sql',
                      'SELECT max(ts) AS t, count(*) AS n FROM messages WHERE deleted_at IS NULL'],
                     capture_output=True, text=True).stdout
arch = json.loads(out)[0]
live = datetime.datetime.fromisoformat(src['newest_message'].replace('Z','+00:00')).timestamp()
print(f\"  messages:  archive {arch['n']:>7}   whatsapp {src['message_rows']:>7}\")
print(f\"  lag:       {int((live - arch['t']) / 60)} min\")
"
  echo
fi

# ------------------------------------------------------------------ sync
# The sync was once broken for 4 days without anyone noticing. This makes it visible.
if [ "$ONLY" = all ] || [ "$ONLY" = sync ]; then
  echo "══ Sync health ══"
  LABEL=io.github.renzactus.wacrawl-mcp.sync
  EXIT=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -m1 "last exit code" | tr -d ' \t')
  if [ -z "$EXIT" ] && launchctl print "gui/$(id -u)/com.openclaw.wacrawl.sync" >/dev/null 2>&1; then
    EXIT="installed under the old label — run ./install-sync-agent.sh"
  fi
  echo "  agent:         ${EXIT:-NOT INSTALLED (./install-sync-agent.sh)}"
  if [ -f "$HOME/.wacrawl/wrapper.log" ]; then
    echo "  last run:"
    tail -4 "$HOME/.wacrawl/wrapper.log" | sed 's/^/    /'
  else
    echo "  ⚠️  no wrapper.log — the agent isn't using sync-wrapper.sh"
  fi
  if [ -s "$HOME/.wacrawl/sync.err.log" ]; then
    echo "  ⚠️  there are errors in sync.err.log:"
    tail -2 "$HOME/.wacrawl/sync.err.log" | sed 's/^/    /'
  fi
  echo
fi

# ---------------------------------------------------------------- audio
if [ "$ONLY" = all ] || [ "$ONLY" = audio ]; then
  echo "══ Voice note transcription ══"
  T="$HOME/.wacrawl/transcripciones.sqlite"
  if [ ! -f "$T" ]; then
    echo "  not installed (optional: ./setup-whisper.sh)"
  else
    DONE=$("$WACRAWL" --db "$T" --sync never sql "SELECT count(*) FROM transcripciones" | tail -1)
    EMPTY=$("$WACRAWL" --db "$T" --sync never sql "SELECT count(*) FROM transcripciones WHERE texto=''" | tail -1)
    ON_DISK=$("$WACRAWL" --sync never sql "SELECT count(DISTINCT msg_id) FROM messages WHERE message_type='audio' AND media_path<>''" | tail -1)
    WITH_VOC=$("$WACRAWL" --db "$T" --sync never sql "SELECT count(*) FROM transcripciones WHERE modelo LIKE '%|voc:%'" | tail -1)
    VOC="$HOME/.wacrawl/vocabulary.txt"; [ -f "$VOC" ] || VOC="$HOME/.wacrawl/vocabulario.txt"
    LANGUAGE_SET=$(sed -n 's/^WHISPER_LANGUAGE=//p' "$HOME/.wacrawl/whisper.env" 2>/dev/null | tail -1)
    echo "  transcribed:     $DONE of ~$ON_DISK voice notes on disk ($EMPTY with no speech detected)"
    echo "  with vocabulary: $WITH_VOC $( [ -f "$VOC" ] || echo '(there is no ~/.wacrawl/vocabulary.txt)')"
    echo "  language:        ${LANGUAGE_SET:-detected per voice note}"
    LAST=$(grep -v Warning "$HOME/.wacrawl/transcribe.log" 2>/dev/null | grep -E "^transcribed|^nothing|^stopped|^another" | tail -1)
    [ -n "$LAST" ] && echo "  last finished pass: $LAST"
    pgrep -f "transcribe.py --(pending|redo)" >/dev/null && echo "  (a pass is running right now)"
  fi
  echo
fi

# ------------------------------------------------------------- senders
if [ "$ONLY" = all ] || [ "$ONLY" = senders ]; then
  echo "══ Sender attribution ══"
  sql "SELECT c.kind,
              count(*) AS messages,
              sum(CASE WHEN m.sender_name GLOB '*=' THEN 1 ELSE 0 END) AS no_name
       FROM messages m JOIN chats c ON c.jid = m.chat_jid
       WHERE m.deleted_at IS NULL AND m.from_me = 0 AND m.message_type = 'text'
       GROUP BY c.kind ORDER BY messages DESC" \
  | python3 -c "
import sys, json
for r in json.load(sys.stdin):
    tot, nn = r['messages'], r['no_name']
    print(f\"  {r['kind']:<12} {tot:>7} messages, {nn:>6} with no sender name ({100*nn/tot if tot else 0:.0f}%)\")
"
fi
