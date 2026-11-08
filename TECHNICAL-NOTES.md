# Technical notes

For whoever is going to touch the code. The user guide is in the [README](README.md).

An MCP server (stdio) in a single file, `server.js`, with no npm dependencies and no network. It builds
on [wacrawl](https://github.com/openclaw/wacrawl), which turns WhatsApp Desktop for Mac's database into a
SQLite archive.

## The two sources

The central decision: there are **two** databases, and each tool knows which one it reads.

| | Archive (wacrawl) | Live (WhatsApp) |
|---|---|---|
| What it is | `~/.wacrawl/wacrawl.db` | WhatsApp Desktop's `ChatStorage.sqlite` |
| Freshness | up to 6 h behind | seconds |
| Search | full-text (FTS5) + substring | only the last N messages |
| Speed | 1-3 s | ~40 ms per query |
| macOS permission | none | Full Disk Access for the runtime |

There's no single "smart" tool that picks for you: it's worth knowing which one answered. If Meta
changes WhatsApp's CoreData schema, only what reads live breaks, and the archive stays intact.

### A third, optional one: the iPhone history

WhatsApp Desktop receives ~1 year when it's linked. `import-iphone.sh` imports the rest from a Finder
backup into `~/.wacrawl/historico/wacrawl.db`, with `historico/corte.json` next to it. For the tools it's
transparent: `countDistinct`, `selectMessages` and `queryChats` run the query on both archives
(`inBoth`) and merge the results.

- **It's kept separate, not merged into the main archive.** When WhatsApp renumbers, the sync runs
  `import --restore`, which leaves the main archive *exactly* like what Desktop has: it would wipe out
  the imported part.
- **Each archive answers for its own range.** They overlap in the last year. The cutoff (`corte`) is the
  first month from which the main archive has ≥95% of the iPhone's messages, month by month: before it
  the history answers, from it on the main archive does. That way counts add up without duplicates
  (deduplicating by `msg_id` across two databases can't be done in a single `wacrawl sql`).
- **Chats are joined by JID**: counts are added up, the main archive's name wins (it's the current one),
  and the history's unread counts are ignored (they're from the iPhone snapshot).
- **Without a history, everything runs exactly as before** (one query, no range).

## Tools

| Tool | Source | What for |
|---|---|---|
| `search_messages` | archive | full-text, fast; the default |
| `deep_search` | archive | substring (`LIKE`), finds matches inside words |
| `list_chats` | archive | by recent activity or by volume, with unread counts |
| `read_chat` | archive | a thread in chronological order |
| `recent_messages` | live | what arrived seconds ago |
| `view_attachments` | archive + live | returns images and PDFs as MCP images, Word documents as text |
| `export_attachments` | archive + live | copies an attachment to a normal folder |
| `draft_message` | opens WhatsApp | one unsent draft |
| `draft_queue` | opens WhatsApp + live | several drafts, one at a time, as they get sent |
| `send_message` | opens WhatsApp + live | sends for real and verifies it (opt-in) |
| `transcribe_audio` | archive + local Whisper | transcribes, on the spot, voice notes that have no text yet |

The archive tools compare against WhatsApp live (`wacrawl doctor`, ~1 s) and warn if the archive fell behind.

## Pieces

| File | What it does |
|---|---|
| `server.js` | the MCP server |
| `install.sh` | end-to-end install, idempotent |
| `setup-runtime.sh` | a dedicated copy of node in `runtime/` (not versioned) |
| `install-sync-agent.sh` | renders the plist template and loads the launchd agent (`io.github.renzactus.wacrawl-mcp.sync`; it replaces the `com.openclaw.wacrawl.sync` agent earlier versions installed) |
| `sync-wrapper.sh` | what launchd runs every 6 h: sync + self-recovery + alerts |
| `register.sh` | adds the server to Claude Desktop's config |
| `check.sh` | fidelity diagnostic |
| `transcribe.py` | transcription with Whisper/MLX (`--pending`, or a list via `--stdin`) |
| `setup-whisper.sh` | installs uv, a managed Python and the model; sets the language, tests, and starts the first pass |
| `redo-transcriptions.sh` | re-transcribes in the background whatever was done with another vocabulary |
| `enable-sending.sh` | turns `allowSending` on or off and opens the Accessibility settings |
| `import-iphone.sh` | imports, once, the older years from an iPhone backup into `~/.wacrawl/historico` |
| `transcribe-history.sh` | transcribes the history's voice notes in N processes (`--archive/--before/--part` of `transcribe.py`) |
| `whisper.env` | Python, library and model versions: the single source of truth (`~/.wacrawl/whisper.env` overrides it per user) |

## Storage layout

Everything lives in `~/.wacrawl/`. The project started out in Spanish, and the names of the files that
hold data were kept so existing installs keep working:

| Path | What it is |
|---|---|
| `wacrawl.db`, `media/` | wacrawl's archive and its copied attachments |
| `historico/` | the iPhone history: `wacrawl.db`, `corte.json` (the cutoff; keys `corte`, `desde`, `sinVideos`, `adjuntosDesde`…), `chats.json` (a cache) and `fuente/` (the files taken out of the backup — the history's media paths point there) |
| `transcripciones.sqlite` | transcriptions: table `transcripciones` with `texto` (text), `duracion` (duration), `modelo` (model + vocabulary fingerprint), `creado` (created at) |
| `borradores.jsonl` | the draft and send log, which the safeguards count |
| `limits.json` | user-adjustable limits (the older `limites.json`, with Spanish keys, is still read) |
| `vocabulary.txt` | the transcription vocabulary (`vocabulario.txt` is still read) |
| `whisper.env` | per-user transcription settings, e.g. `WHISPER_LANGUAGE` |
| `STOP` | if it exists, no drafts or sends |
| `wrapper.log`, `transcribe.log` | logs |

## macOS permissions

Claude Desktop launches MCP servers through `Contents/Helpers/disclaimer --pgroup`, which **cuts off
permission inheritance**: the process responsible to macOS becomes node, not Claude. That's why
*"node would like to access data from other apps"* shows up when touching WhatsApp's container, and why
giving the permission to Claude doesn't help. Having `wacrawl` read it (it has permission when launchd
starts it) doesn't help either: macOS looks at the responsible process, not at the binary that opens
the file. That hypothesis was tested, and it failed.

Two defenses:

1. **`--copy-media` on the sync** leaves attachments in `~/.wacrawl/media`, outside the protected area.
   `view_attachments` and `export_attachments` don't need the permission for those. It costs duplicating
   the media.
2. **A dedicated runtime** (`setup-runtime.sh`): a copy of node used only by this server, which is the one
   that gets Full Disk Access. That way not everything that runs with node inherits it (for example an
   `npx -y package` that's downloaded from npm on every start). The path and the binary also stay stable:
   Homebrew's node is ad-hoc signed, so every update changes its identity and macOS invalidates the
   permission. Homebrew's node isn't self-contained — it loads `libnode.*.dylib` through `@rpath` from
   `../lib`, which is copied too. `install.sh` doesn't rebuild the runtime if it already exists, so as not
   to invalidate the permission.

Sending also needs **Accessibility** for that same runtime (to press Enter), and **Automation → System Events**.

## Expensive to rediscover

**wacrawl**

- **Never use the `chats` / `messages` / `search` subcommands.** They run a "backfill" that writes and
  takes minutes (measured: `chats --limit 2000` hung for 2m40s). Claude Desktop cuts off at 4 min.
  Everything goes through `wacrawl sql`, which is read-only (it rejects anything that isn't a single
  SELECT) and takes 1-3 s.
- **`wacrawl search` is incomplete; the index isn't.** Through FTS via SQL, "error" in one group gives 69
  results; the subcommand gave 1.
- **There's no incremental import.** Every sync re-merges everything: ~5 min on ~1M messages, even if 200
  came in. That's why it runs in launchd and not on the fly.
- **The agent uses `StartCalendarInterval` (00:15, 06:15, 12:15, 18:15), not `StartInterval`.**
  `StartInterval`'s timer pauses while the Mac sleeps: after one night asleep the archive was 16 h behind.
  A missed calendar time runs as soon as the Mac wakes up.
- **When WhatsApp Desktop is re-linked or updated it can renumber its `source_pk`s**, and wacrawl aborts
  with *"belongs to a different event"*. `import --restore` fixes it; `sync-wrapper.sh` does that on its
  own, with a backup first, and reverts if the archive shrinks by more than 5%.
- **`--db <path>` + `sql` can query any SQLite database**, including WhatsApp's live one.

**iPhone backup (`import-iphone.sh`)**

- **The iPhone's schema is the same as WhatsApp Desktop's** (the Mac app is the iOS one built with
  Catalyst): `wacrawl --source <folder>` imports it as is if the folder has the container's shape
  (`ChatStorage.sqlite`, `Message/Media/...`). The domain in the backup is
  `AppDomainGroup-group.net.whatsapp.WhatsApp.shared`; the files are stored by hash in `Manifest.db`.
- **macOS doesn't let you read `~/Library/Application Support/MobileSync/Backup`** without Full Disk
  Access (neither from Terminal nor from Claude). Moving it to another folder with Finder is instant and
  solves it.
- **Link, don't copy.** Hard links from the backup: zero extra space, and when the backup is deleted the
  WhatsApp files stay. Node's `COPYFILE_FICLONE_FORCE` gives `ENOSYS` on macOS; `cp -c` does clone.
- **wacrawl copies the chat database to `$TMPDIR/wacrawl-desktop-*` to import it** (1.9 GB for an iPhone
  with 2.3M messages), and if it's killed it leaves that copy behind: it has to be cleaned up. With a
  tight disk, that alone fills it.
- **"source contains multiple WhatsApp account identities"**: wacrawl collects the `ZTOJID`s of the
  received messages and requires a single one. A real iPhone had ONE row (out of 2.3M) with a group as
  the recipient. The script cleans up those rows in its copy if the main account is >99%.
- **`Manifest.db` and `ChatStorage.sqlite` don't open in place with `sqlite3 ?mode=ro`** (they're in WAL
  mode and it can't create the `-shm`): clone them or use `?immutable=1`. `--db` doesn't accept URIs
  (`file:...?mode=ro`). Verified on wacrawl 0.3.7 and 0.4.2 that importing doesn't modify the source
  (same md5, same files).
- **0.4.x stores copied media by hash and without an extension** (`media/46/4637a2f5…`); 0.3.x kept the
  name (`…/uuid.jpg`). Neither records the type. `detectExtension()` infers it from the first bytes (and
  from the tail for zips, where the index that tells `.docx` from `.xlsx` lives).
- `install.sh` installs a **pinned version** (0.4.2 today, tested with an import from scratch + every
  tool). Before bumping it, repeat that test.
- Two calls in parallel give `SQLITE_BUSY` (the automatic sync writes): every call goes through a queue,
  with retries and backoff in case the launchd agent is running.

**Archive data**

- **`messages` stores each conversation more than once** (same `msg_id`, different `source_pk`). Group
  by `msg_id, chat_jid, ts, text` **before** the LIMIT, or counts come out ~3x inflated and the limit
  returns too few.
- **`chats.last_message_at` has corrupt rows** (year 9026). Sort by the real `max(ts)`.
- `ts` is Unix epoch; in the live database (CoreData) it counts from 2001: add `978307200`.
- **For audio, stickers and images, `text` holds the file's hash**, not text; for reactions, a hex
  string. Showing it as is made a voice note and a sticker look identical.
- **Statuses (stories) come mixed with the messages**, marked with `sender_jid = status@broadcast` and
  `chats.kind = 'status'`.
- **Senders in groups**: for people who aren't in your contacts, WhatsApp stores an empty name (a base64
  blob like `IAA=`) and an opaque `@lid`. It can't be recovered through `contacts.lid` or
  `group_participants` (the row exists, without a name). In one-to-one chats the sender is the chat's
  other party.
- Times are in the Mac's local time. In UTC, night-time messages fell on the next day.

**WhatsApp's live database**

- `ZWAMESSAGE`, `ZWACHATSESSION`, `ZWAGROUPMEMBER`, `ZWAMEDIAITEM`. For **documents**, `ZWAMESSAGE.ZTEXT`
  is the **original file name** and `ZWAMEDIAITEM.ZTITLE` the text that came with it (in wacrawl's
  archive: `text` and `media_title`). `ZMEDIALOCALPATH` is relative to `<container>/Message/`.
- `ZMESSAGETYPE`: 1 image, 2 video, 3 audio, 8 document, 11 gif, 15 sticker, 7 link thumbnail.
- **A new chat is created with `ZCONTACTJID = <x>@lid` and the phone number in `ZCONTACTIDENTIFIER`.**
  Looking only at `ZCONTACTJID` meant the queue never detected sends to new numbers.
- `LID.sqlite` (`ZWAPHONENUMBERLIDPAIR`) was empty: for the `@lid`s of people who aren't in your
  contacts there's no way to get the phone number.
- Local media only exists since WhatsApp Desktop was linked (the download policy already comes as
  `image/audio/video/document = 1`). The `.thumb` thumbnails are 72×72 JPEGs: useless.

**Claude Desktop**

- **It rewrites `claude_desktop_config.json` from memory when it quits.** Editing it with the app open =
  the entry is lost when it quits. `register.sh` refuses to run if the app is open. `pgrep -x` can't
  detect it (macOS truncates the name to 16 characters).
- **Tool failures go back as a result with `isError: true`, not as a JSON-RPC error.** Claude Desktop
  shows protocol errors as a bare "failed" and the model never sees the reason.
- It doesn't inherit the shell's PATH: the config uses absolute paths.
- **Never `process.exit()` with stdout pending**: it truncates the response (a base64 image isn't
  flushed in one go).

**Drafts**

- `whatsapp://send?phone=…&text=…` opens the chat with the text in the box, without sending. It needs a
  phone number: it doesn't work for groups or for `@lid`s of people who aren't in your contacts.
- **WhatsApp doesn't keep a draft if another chat is opened.** That's why the queue opens the next one
  only when it detects a message of yours in that chat (polling the live database every 2.5 s, ~40 ms
  per query), and not on a timer.
- The safeguards live in code and their counters on disk (`~/.wacrawl/borradores.jsonl`): a runaway
  model ignores instructions but not an `if`, and restarting doesn't reset them. A damaged line in that
  log is skipped, so it can't wipe out the counters.

**Voice note transcription**

- Whisper `large-v3-turbo` on MLX (`mlx-whisper`), run with `uv run --with` so nothing gets compiled.
  Measured on an M4: 13-17x real time; ~5 s to load the model per process.
- Transcriptions go to a **separate** database (`~/.wacrawl/transcripciones.sqlite`, keyed by
  `msg_id + chat_jid`): wacrawl's archive is never written. The server reads them with
  `wacrawl --db … sql`, so it works with any Node version (no `node:sqlite`).
- **No network while transcribing**: `HF_HUB_OFFLINE=1`, `UV_OFFLINE=1`, telemetry off. The network is
  only used by `setup-whisper.sh`, to download the model.
- **Python managed by uv** (`uv python install`), not the system's: Claude Desktop and launchd run with a
  minimal PATH, and with Homebrew's Python `uv` couldn't find an interpreter.
- The audio is converted to WAV with `afconvert` (native, it reads WhatsApp's Opus: no ffmpeg needed)
  and loaded with `wave`. It gets an extension through a symlink because wacrawl 0.4.x stores files
  without one.
- The database is in **WAL** mode so the server can read while it's being written. Background passes
  (`--pending`) hold a lock (`flock`) against each other; a request from Claude (`--stdin`) does **not**
  wait for it — if the first pass holds it for an hour, Claude would hang until the timeout. They can run
  in parallel; at worst the same voice note is transcribed twice (`INSERT OR REPLACE`).
- Anti-hallucination: segments with `no_speech_prob > 0.6` and `avg_logprob < -1` are dropped, and so are
  the YouTube subtitle lines Whisper makes up over silence ("Subtítulos realizados por la comunidad de
  Amara.org", "Thanks for watching"). `condition_on_previous_text=False` keeps one mistake from dragging on.
- **Speed on a 16 GB M4** (turbo, fp16): ~10× real time with the Mac idle, ~7.5× with little memory left.
  **Parallelizing doesn't help**: with 2 processes the GPU is already at 100% and the total went down
  (6.7×), because each process takes 5–6 GB and the Mac starts swapping. **Decoding in batches** (`decode`
  with several mels at once) doesn't either: ×0.93, and it changes some words compared with `transcribe`.
- **Out of memory, afconvert stops opening anything** (`ExtAudioFileRead failed (-1)`, also on healthy
  files): one pass over the history burned 45,000 voice notes as errors in minutes. After 10 errors in a
  row it waits 2 min; whatever fails isn't saved and is retried on the next pass.
- **Language**: `WHISPER_LANGUAGE` (in `~/.wacrawl/whisper.env`) fixes it; empty, Whisper detects it per
  voice note (short ones get detected wrong more often). An unknown code fails right away, with a clear
  message. The prompt goes in the language of the voice notes: Spanish keeps the exact wording it was
  measured with; any other language uses an English one.
- **Vocabulary** (`initial_prompt`): the chat's name + in groups, the 6 people who talk most (from the
  archive, without emojis) + `~/.wacrawl/vocabulary.txt` by priority. **Whisper uses at most ~223 prompt
  tokens and, if it's longer, drops the BEGINNING**: that's why the prompt is built term by term, counting
  tokens with Whisper's tokenizer, and cut at 180, from the end.
- Measured (A/B on the same voice notes, in Spanish): company name right 0 → 11 out of 20; nickname
  1 → 7 out of 8; 12 random voice notes without invented names; same speed (15.3x). The known risk of the
  prompt is that it induces words over silence: it didn't show up, and the `no_speech_prob` filter helps.
- Each transcription stores `modelo = <model>|voc:<sha1 of the vocabulary>`. `--redo` only redoes the
  ones with another fingerprint: it can be stopped and resumed, and editing the vocabulary doesn't force
  redoing what was already up to date.
- `--suggest-vocabulary` suggests one from the person's **own text messages** (names capitalized
  mid-sentence + nicknames of the most active chats). It skips anything that starts with `_`: **Zapia
  posts its transcriptions as your own messages, in italics**, with the same mistakes ("Viatic"), and
  without that filter the mistake made it into the vocabulary.

**Recently arrived attachments**

- `view_attachments` and `export_attachments` search the archive **and** WhatsApp live
  (`findAttachments`), joined by message id. Before, they only looked at the archive: a document received
  a while ago existed on the Mac but not there, and "the docx with the press release" returned the latest
  PDF that was there — another, older file, without a warning. If both copies exist, the archive's is
  used (it needs no permission).
- A new chat may not be in the archive yet: if `resolveChatJID` doesn't find it, it's looked up by name,
  live (`ZPARTNERNAME`).
- `export_attachments` saves documents with their original name, and asks the model to check the date,
  chat and name.
- **Word/RTF/OpenDocument are read as text with `textutil`** (native). It decides the format by the
  extension, so the file is copied with the right one (wacrawl 0.4.x stores files without one). Capped at
  20,000 characters; Excel isn't supported (it gets exported).
- **Attachments that were never downloaded.** WhatsApp Desktop doesn't download large files on its own
  (seen: a 1.2 GB zip): the message exists but `ZMEDIALOCALPATH` is empty. They used to be filtered out
  silently, the tool said "not found", and the model made up a cause ("the archive is 6 h behind, I'll
  check in 30 min") — false, and waiting didn't fix it. Now they come back marked (`downloaded: false`)
  with their size and the real instruction (click it in WhatsApp Desktop). If the newest match isn't
  downloaded and another one gets exported, the warning goes FIRST, so the old one isn't used as if it
  were the one asked for.
- A document's title sometimes comes **without an extension** (a title like "Quarterly report - final"):
  it's used as the name anyway, with the detected extension added.
- `recent_messages` marks attachments: a document carries its name in `ZTEXT`, and unmarked it looked
  like a text message.

**Sending (`send_message`)**

- The same path as a draft (`whatsapp://send`) + Enter via AppleScript (`key code 36` to System Events)
  + verification against the live database with `detectSent`. Official app: no unofficial-client risk.
  It's opt-in with `allowSending` in `limits.json`, which the person turns on; it's a separate tool from
  `draft_message` so that Claude Desktop's per-call permission is a human confirmation.
- Before the Enter it checks that WhatsApp is the frontmost app: if focus moved, the Enter would land in
  another window. A second Enter, if the send wasn't detected, is safe: if the first one sent it, the box
  is empty.
- If it isn't confirmed, it **doesn't retry**, and the model is told not to retry: it may have gone out anyway.
- Permissions: Accessibility for the runtime (the keystroke, error 1002) and Automation → System Events
  (error -1743). Each error is translated into the exact instruction.
- Unconfirmed attempts count toward `sendsPerHour`: prudent with a model that insists.

**Name resolution:** status chats (`*.status`) carry the person's name and are left out if there's
another candidate — before, looking up a contact by name came back as "matches 2 chats" in every tool.

**PDFs are rendered to an image with `sips`**, their text isn't extracted: macOS ships nothing native to
extract it (Spotlight doesn't index WhatsApp's container, PyObjC isn't there), and rendering also works
for scanned ones. Only the first page comes out.

## Keeping private data out of the repo

The repository is public, and it's developed against a real WhatsApp. `.githooks/pre-commit` blocks a
commit whose added lines contain phone numbers, WhatsApp IDs, email addresses, the full names of your own
chats (read from your local archive) or anything listed in `~/.wacrawl/private-words.txt`. Turn it on
once per clone with `git config core.hooksPath .githooks`; `.githooks/pre-commit --all` scans every
tracked file. False positives go in `~/.wacrawl/allowed-words.txt`, which is local, so it doesn't publish
them either. `CLAUDE.md` tells AI assistants the same rules.

## Tests

There's no test suite; `check.sh` covers rendering fidelity. To try things without side effects:

- `WACRAWL_OPEN_BIN=<script>` replaces the `open` that launches WhatsApp.
- `WACRAWL_ENTER_BIN=<script>` replaces the AppleScript that presses Enter.
- `WACRAWL_DRAFTS_DIR=<dir>` isolates the draft log, `STOP`, `limits.json`, `whisper.env` and the
  transcriptions database.
- `WACRAWL_FAKE_SENT_FILE=<file>` fakes sends for the queue and `send_message` (one phone number per
  line). Careful: it skips the real query to the database — that's how the `ZCONTACTIDENTIFIER` bug
  slipped through; test the real detection separately.
- `WACRAWL_QUEUE_POLL_MS` speeds up the queue's polling.
- `WACRAWL_HISTORY_DIR=<dir>` points to another iPhone history.
- `WACRAWL_TEST_CONFIG=<file>` makes `register.sh` write there and skip the check for Claude being open.
