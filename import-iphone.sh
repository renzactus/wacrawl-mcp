#!/bin/bash
# Imports the years of WhatsApp the iPhone has and WhatsApp Desktop didn't receive when it
# was linked (Desktop gets ~1 year; the iPhone has everything).
#
#   ./import-iphone.sh <backup-folder> [--with-videos]
#
# Before (see the README, "Import years of history from your iPhone"):
#   1. Back up the iPhone in Finder, NOT encrypted.
#   2. Move its folder out of ~/Library/Application Support/MobileSync/Backup by
#      dragging it in Finder (macOS won't let a script read it there).
#
# It goes to ~/.wacrawl/historico, SEPARATE from the main archive: when WhatsApp renumbers,
# the sync rebuilds the main archive from scratch with what Desktop has, and would wipe out
# anything imported into it. The server queries both. (The folder and file names are the
# original Spanish ones, kept so existing installs keep working.)
#
# Without --with-videos it leaves out videos and stickers (on a typical iPhone they're half
# the space, and Claude can't look at them).

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
HIST="${WACRAWL_HISTORY_DIR:-$HOME/.wacrawl/historico}"   # the variable is for testing only
SOURCE="$HIST/fuente"
ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }
step() { echo; echo "▸ $*"; }

NODE="$REPO/runtime/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node is missing: run ./install.sh first."
WACRAWL=""
for c in "$HOME/.local/bin/wacrawl" /opt/homebrew/bin/wacrawl /usr/local/bin/wacrawl; do
  [ -x "$c" ] && { WACRAWL="$c"; break; }
done
[ -n "$WACRAWL" ] || fail "wacrawl is missing: run ./install.sh first."

B="${1:-}"; B="${B%/}"
WITH_VIDEOS=0; [ "${2:-}" = "--with-videos" ] && WITH_VIDEOS=1

step "Backup"
[ -n "$B" ] || fail "Give me the backup folder: ./import-iphone.sh ~/iphone-backup/<folder>"
if [[ "$B" == *"/MobileSync/Backup/"* ]]; then
  fail "macOS won't let a script read the backup there. In Finder, drag the folder somewhere else (e.g. your home folder) and give me that path."
fi
[ -f "$B/Manifest.db" ] || fail "There's no iPhone backup in $B (Manifest.db is missing)."
[ "$(plutil -extract IsEncrypted raw "$B/Manifest.plist" 2>/dev/null)" = false ] ||
  fail "The backup is encrypted. In Finder, untick \"Encrypt local backup\", make another backup and run this again."
[ ! -e "$HIST/wacrawl.db" ] || fail "There's already an imported history in $HIST. To redo it, delete that folder first."
BACKUP_DATE_ISO="$(plutil -extract Date raw "$B/Manifest.plist")"
BACKUP_DATE="${BACKUP_DATE_ISO:0:10}"
ok "$(plutil -extract Lockdown.DeviceName raw "$B/Manifest.plist" 2>/dev/null || echo iPhone), from $BACKUP_DATE, not encrypted"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp -c "$B/Manifest.db" "$TMP/Manifest.db" 2>/dev/null || cp "$B/Manifest.db" "$TMP/Manifest.db"
sqlite3 -separator $'\t' "$TMP/Manifest.db" \
  "SELECT fileID, relativePath FROM Files WHERE domain = 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared' AND flags = 1" > "$TMP/all.tsv"
grep -q $'\tChatStorage.sqlite$' "$TMP/all.tsv" || fail "The backup doesn't have WhatsApp in it."
if [ "$WITH_VIDEOS" = 1 ]; then
  cp "$TMP/all.tsv" "$TMP/list.tsv"
else
  awk -F'\t' 'tolower($2) !~ /\.(mp4|mov|m4v|3gp|webp)$/' "$TMP/all.tsv" > "$TMP/list.tsv"
fi

# Space: on the same disk, files are LINKED (they take nothing extra while the backup exists).
# What does take space: the temporary copy wacrawl makes of the chat database to import it,
# plus the resulting archive.
CHAT_ID="$(awk -F'\t' '$2 == "ChatStorage.sqlite" {print $1}' "$TMP/all.tsv")"
CHAT_MB=$(( $(stat -f %z "$B/${CHAT_ID:0:2}/$CHAT_ID") / 1048576 ))
NEEDED_MB=$(( CHAT_MB * 3 + 1024 ))
mkdir -p "$HIST"
if [ "$(stat -f %d "$B")" != "$(stat -f %d "$HIST")" ]; then
  # Another disk: links aren't possible, the attachments have to be copied.
  ATT_MB=$(awk -F'\t' -v b="$B" '{print b"/"substr($1,1,2)"/"$1}' "$TMP/list.tsv" | tr '\n' '\0' |
    xargs -0 stat -f %z | awk '{t+=$1} END {printf "%d", t/1048576}')
  NEEDED_MB=$(( NEEDED_MB + ATT_MB ))
fi
FREE_MB=$(df -m "$HIST" | tail -1 | awk '{print $4}')
[ "$FREE_MB" -gt "$NEEDED_MB" ] ||
  fail "It needs ~$(( NEEDED_MB / 1024 + 1 )) GB free and there are $(( FREE_MB / 1024 )) GB. Free up space and run this again."
ok "space: needs ~$(( NEEDED_MB / 1024 + 1 )) GB, $(( FREE_MB / 1024 )) GB free"

step "Taking WhatsApp out of the backup ($(wc -l < "$TMP/list.tsv" | tr -d ' ') files$([ "$WITH_VIDEOS" = 1 ] || echo ', without videos or stickers'))"
rm -rf "$SOURCE"
"$NODE" -e '
const fs = require("fs"), path = require("path");
const [backup, list, dest] = process.argv.slice(1);
let n = 0;
for (const line of fs.readFileSync(list, "utf8").split("\n")) {
  if (!line) continue;
  const [id, rel] = line.split("\t");
  const src = path.join(backup, id.slice(0, 2), id), dst = path.join(dest, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.linkSync(src, dst); } catch (e) { if (e.code !== "EXDEV") throw e; fs.copyFileSync(src, dst); }
  n++;
}
console.log(`  ✓ ${n} files`);
' "$B" "$TMP/list.tsv" "$SOURCE"

# The chat database is split off from the backup (an APFS clone, free): we're going to touch it.
CS="$SOURCE/ChatStorage.sqlite"
{ cp -c "$CS" "$CS.tmp" 2>/dev/null || cp "$CS" "$CS.tmp"; } && mv "$CS.tmp" "$CS"

# wacrawl refuses to import if the received messages point to more than one own account
# (good: it doesn't mix two people). But a real iPhone can have a few mislabeled rows — in
# the case that uncovered this, ONE, with a group as the recipient. If the main account is
# >99% of what was received, those rows are cleaned up in the copy.
step "WhatsApp account"
ACCOUNTS="$(sqlite3 -separator $'\t' "$CS" "SELECT lower(trim(ZTOJID)), count(*) FROM ZWAMESSAGE
  WHERE coalesce(ZISFROMME, 0) = 0 AND trim(coalesce(ZTOJID, '')) <> '' GROUP BY 1 ORDER BY 2 DESC")"
ACCOUNT="$(echo "$ACCOUNTS" | head -1 | cut -f1)"
TOTAL=$(echo "$ACCOUNTS" | awk -F'\t' '{t+=$2} END {print t+0}')
MAIN=$(echo "$ACCOUNTS" | head -1 | cut -f2)
OTHERS=$(( TOTAL - MAIN ))
if [ "$OTHERS" -gt 0 ]; then
  [ $(( OTHERS * 100 )) -lt "$TOTAL" ] ||
    fail "The backup seems to have more than one WhatsApp account ($(echo "$ACCOUNTS" | wc -l | tr -d ' ')). Not mixing them."
  cp -c "$CS" "$SOURCE/ChatStorage.original.sqlite" 2>/dev/null || cp "$CS" "$SOURCE/ChatStorage.original.sqlite"
  sqlite3 "$CS" "UPDATE ZWAMESSAGE SET ZTOJID = NULL WHERE coalesce(ZISFROMME, 0) = 0
    AND trim(coalesce(ZTOJID, '')) <> '' AND lower(trim(ZTOJID)) <> '$ACCOUNT'; PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  ok "${ACCOUNT%@*} (cleaned up $OTHERS mislabeled row(s); the original is in ChatStorage.original.sqlite)"
else
  ok "${ACCOUNT%@*}"
fi

step "Importing (takes a few minutes)"
T="$(getconf DARWIN_USER_TEMP_DIR)"; touch "$TMP/start"
"$WACRAWL" --source "$SOURCE" --db "$HIST/wacrawl.db" import > "$HIST/import.log" 2>&1 &
PID=$!
while kill -0 "$PID" 2>/dev/null; do
  if [ "$(df -m "$HIST" | tail -1 | awk '{print $4}')" -lt 700 ]; then
    kill "$PID"; wait "$PID" 2>/dev/null || true
    # wacrawl leaves its temporary copy behind if it's killed
    find "$T" -maxdepth 1 -name 'wacrawl-desktop-*' -newer "$TMP/start" -exec rm -rf {} +
    rm -f "$HIST"/wacrawl.db*
    fail "Stopped: the disk was running out of space. Free up space and run this again."
  fi
  sleep 3
done
wait "$PID" || { rm -f "$HIST"/wacrawl.db*; fail "wacrawl failed: $(tail -3 "$HIST/import.log")"; }
ok "$(grep -E "^messages=" "$HIST/import.log" | cut -d= -f2) messages imported"

# The two archives overlap in the last year. The cutoff is the first month from which the main
# archive is already complete (≥95% of what the iPhone has, month by month, not counting the
# backup's month, which is half-done in both): before it the history archive answers, from it
# on the main one does. That way nothing shows up twice. Where both are complete the main one
# wins: it has more sender names in groups (measured: 1.4% with no name vs. 16% on the iPhone).
# corte.json keeps the original Spanish keys (corte = cutoff, desde = since, …): server.js reads them.
step "Joining it with the current archive"
PER_MONTH="SELECT strftime('%Y-%m', ts, 'unixepoch') AS mes, count(DISTINCT msg_id) AS n
  FROM messages WHERE deleted_at IS NULL AND ts > 1230768000 GROUP BY mes"
"$WACRAWL" --sync never --json sql "$PER_MONTH" > "$TMP/main.json"
"$WACRAWL" --db "$HIST/wacrawl.db" --sync never --json sql "$PER_MONTH" > "$TMP/history.json"
"$NODE" -e '
const fs = require("fs");
const [mainFile, historyFile, out, backup, withVideos] = process.argv.slice(1);
const read = (f) => Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8") || "[]").map((r) => [r.mes, r.n]));
const p = read(mainFile), h = read(historyFile);
const months = Object.keys(h).sort();
let cutoffMonth = null;
for (let i = months.length - 1; i >= 0; i--) {
  const month = months[i];
  if (month >= backup.slice(0, 7)) continue;
  if ((p[month] || 0) < 0.95 * h[month]) break;
  cutoffMonth = month;
}
// If not even the backup month is complete in the main archive, the history answers everything up to the backup.
const corte = cutoffMonth ? Date.UTC(+cutoffMonth.slice(0, 4), +cutoffMonth.slice(5) - 1, 1) / 1000
                          : Math.floor(Date.parse(backup) / 1000);
const mensajes = months.filter((m) => m < (cutoffMonth || "9999")).reduce((s, m) => s + h[m], 0);
const info = {
  corte, corteFecha: new Date(corte * 1000).toISOString().slice(0, 10),
  // the first month with real use: there are usually a handful of stray messages dated years earlier
  desde: months.find((m) => h[m] >= 100) || months[0], backup: backup.slice(0, 10),
  mensajes, sinVideos: withVideos !== "1", importado: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(out, JSON.stringify(info, null, 2) + "\n");
console.log(`  ✓ the history adds ${mensajes.toLocaleString("en")} messages, from ${info.desde} to ${info.corteFecha}`);
' "$TMP/main.json" "$TMP/history.json" "$HIST/corte.json" "$BACKUP_DATE_ISO" "$WITH_VIDEOS"

# Since when the iPhone still has the files: after switching phones or restoring from iCloud,
# WhatsApp usually brings back the text of everything but attachments only from the last few
# years (before that it leaves a 99x99 thumbnail). The tools use this to explain why an old
# attachment is missing.
"$WACRAWL" --db "$HIST/wacrawl.db" --sync never --json sql "SELECT strftime('%Y-%m', ts, 'unixepoch') AS mes, media_path AS p
  FROM messages WHERE message_type IN ('image', 'audio') AND coalesce(media_path, '') <> ''" > "$TMP/attachments.json"
"$NODE" -e '
const fs = require("fs");
const [attachments, out] = process.argv.slice(1);
const perMonth = {};
for (const { mes, p } of JSON.parse(fs.readFileSync(attachments, "utf8") || "[]")) {
  const c = (perMonth[mes] ||= [0, 0]); c[1]++; if (fs.existsSync(p)) c[0]++;
}
const months = Object.keys(perMonth).sort();
let since = null;
for (let i = months.length - 1; i >= 0 && perMonth[months[i]][0] * 2 >= perMonth[months[i]][1]; i--) since = months[i];
const info = JSON.parse(fs.readFileSync(out, "utf8"));
info.adjuntosDesde = since;
fs.writeFileSync(out, JSON.stringify(info, null, 2) + "\n");
if (since && since !== months[0]) console.log(`  ✓ attachments since ${since} (before that, the iPhone only kept the text)`);
' "$TMP/attachments.json" "$HIST/corte.json"

echo
echo "════════════════════════════════════════════════════════════"
echo " Done. Open a new conversation in Claude and ask it about something old."
echo
echo " You can delete the backup now (the WhatsApp part is in $SOURCE):"
echo "   $B"
echo " In Finder: select it and press ⌥⌘⌫."
echo "════════════════════════════════════════════════════════════"
