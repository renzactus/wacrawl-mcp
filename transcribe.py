"""
Transcribes WhatsApp voice notes with Whisper, 100% locally (MLX on Apple Silicon).

Run it with uv, which fetches Python and the libraries without compiling anything:

    uv run --python 3.12 --with mlx-whisper==0.4.3 python transcribe.py --pending
    ... | uv run ... python transcribe.py --stdin      (JSON list of voice notes on stdin)

Results go to ~/.wacrawl/transcripciones.sqlite (a separate database: the wacrawl archive
is never written from here). Anything already transcribed isn't repeated. The file, table
and column names come from the original Spanish version and are kept for existing installs.

No network: the model is downloaded once by setup-whisper.sh and then used with
HF_HUB_OFFLINE=1.

Settings (environment): WHISPER_MODEL; WHISPER_LANGUAGE (e.g. "en", "es"; empty = detect it
per voice note); WACRAWL_DIR; WACRAWL_TRANSCRIPTIONS_DB.
"""

import argparse
import collections
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import wave
import zlib

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "").strip().lower() or None   # None = detect per voice note
DIR = os.path.expanduser(os.environ.get("WACRAWL_DIR", "~/.wacrawl"))
ARCHIVE = os.path.join(DIR, "wacrawl.db")
TRANSCRIPTIONS = os.environ.get("WACRAWL_TRANSCRIPTIONS_DB", os.path.join(DIR, "transcripciones.sqlite"))
# vocabulario.txt is the name used by the original Spanish version: still read if that's the one there.
VOCABULARY = next((p for p in (os.path.join(DIR, "vocabulary.txt"), os.path.join(DIR, "vocabulario.txt"))
                   if os.path.exists(p)), os.path.join(DIR, "vocabulary.txt"))

# Faced with silence or music, Whisper sometimes "completes" it with subtitle lines from the
# YouTube videos it was trained on. If a segment is only that, it's made up.
HALLUCINATIONS = (
    "subtítulos realizados por la comunidad de amara.org",
    "subtitulado por la comunidad de amara.org",
    "gracias por ver el video",
    "gracias por ver",
    "suscríbete al canal",
    "no olvides suscribirte",
    "¡suscríbete!",
    "subtitles by the amara.org community",
    "thank you for watching",
    "thanks for watching",
    "please subscribe",
    "like and subscribe",
)


def label():
    """Model + vocabulary fingerprint. Lets --redo redo only what was transcribed with an older vocabulary."""
    voc = "\n".join(vocabulary())
    return f"{MODEL}|voc:{hashlib.sha1(voc.encode()).hexdigest()[:8]}" if voc else MODEL


def open_transcriptions():
    os.makedirs(DIR, exist_ok=True)
    db = sqlite3.connect(TRANSCRIPTIONS, timeout=30)
    # WAL: the server can read transcriptions while this writes.
    db.execute("PRAGMA journal_mode=WAL")
    # Spanish names, kept for existing installs: duracion = duration in seconds, texto = text,
    # modelo = model label (see label()), creado = created at (epoch).
    db.execute(
        """CREATE TABLE IF NOT EXISTS transcripciones (
             msg_id TEXT NOT NULL, chat_jid TEXT NOT NULL,
             chat_name TEXT, sender_name TEXT, from_me INTEGER, ts INTEGER,
             duracion REAL, texto TEXT, modelo TEXT, creado INTEGER,
             PRIMARY KEY (msg_id, chat_jid))"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS transcripciones_chat_ts ON transcripciones (chat_jid, ts)")
    return db


def pending(db, limit, redo=False, before=0, part=""):
    """Voice notes with a file on disk and no transcription (or, with redo, transcribed with another
    vocabulary), newest first. before: only the ones older than that epoch. part "K/N": only one in
    N voice notes (by msg_id), so N processes can split the work."""
    if not os.path.exists(ARCHIVE):
        sys.exit(f"The wacrawl archive doesn't exist: {ARCHIVE}")
    if redo:
        done = {(m, c) for m, c in db.execute(
            "SELECT msg_id, chat_jid FROM transcripciones WHERE modelo = ?", (label(),))}
    else:
        done = {(m, c) for m, c in db.execute("SELECT msg_id, chat_jid FROM transcripciones")}
    # The wacrawl archive is opened STRICTLY read-only.
    arch = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True)
    rows = arch.execute(
        """SELECT msg_id, chat_jid, max(chat_name), max(sender_name), max(from_me), max(ts), max(media_path)
           FROM messages
           WHERE message_type = 'audio' AND media_path <> '' AND deleted_at IS NULL AND (? = 0 OR ts < ?)
           GROUP BY msg_id, chat_jid ORDER BY max(ts) DESC""", (before, before)
    ).fetchall()
    arch.close()
    k, n = (int(x) for x in part.split("/")) if part else (1, 1)
    out = []
    for msg_id, chat_jid, chat_name, sender_name, from_me, ts, media_path in rows:
        if n > 1 and zlib.crc32(msg_id.encode()) % n != k - 1:
            continue
        if (msg_id, chat_jid) in done or not os.path.isfile(media_path):
            continue
        out.append(dict(msg_id=msg_id, chat_jid=chat_jid, chat_name=chat_name, sender_name=sender_name,
                        from_me=from_me, ts=ts, media_path=media_path))
        if limit and len(out) >= limit:
            break
    return out


def to_wav(path, tmp):
    """Converts the audio to 16 kHz mono WAV with afconvert (native to macOS, reads WhatsApp's Opus).
    It gets an explicit extension because wacrawl 0.4.x stores media without one."""
    # The extension has to match the content: afconvert won't open an MP4 named .opus. wacrawl
    # 0.4.x stores files without an extension, so we look at the file itself.
    with open(path, "rb") as f:
        head = f.read(12)
    if head[:4] == b"OggS":
        ext = ".opus"
    elif head[4:8] == b"ftyp":
        ext = ".m4a"
    elif head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        ext = ".wav"
    elif head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        ext = ".mp3"
    else:
        ext = os.path.splitext(path)[1] or ".opus"
    src = os.path.join(tmp, "in" + ext)
    dst = os.path.join(tmp, "out.wav")
    for old in os.listdir(tmp):
        os.remove(os.path.join(tmp, old))
    os.symlink(path, src)
    subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, dst],
                   check=True, capture_output=True)
    import numpy as np
    with wave.open(dst) as w:
        data = w.readframes(w.getnframes())
        dur = w.getnframes() / w.getframerate()
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0, dur


def clean(result):
    parts = []
    for seg in result.get("segments", []):
        text = seg.get("text", "").strip()
        if not text:
            continue
        # Silence with "invented" text: Whisper itself says there's probably no speech.
        if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0:
            continue
        if text.lower().strip(" .!¡") in {h.strip(" .!¡") for h in HALLUCINATIONS}:
            continue
        parts.append(text)
    return " ".join(parts).strip()


# Whisper uses at most ~223 tokens of prompt and, if it's longer, drops the BEGINNING — which
# is exactly where the most important part goes. So the prompt is built by priority and cut
# from the end, with some margin.
MAX_PROMPT_TOKENS = 180

# The prompt in the language of the voice notes. Spanish keeps the exact wording that was
# measured (see TECHNICAL-NOTES.md); any other language uses the English one.
PROMPTS = {
    "es": {"chat": "Audio de WhatsApp en el chat «{}».", "plain": "Audio de WhatsApp.",
           "people": " Participan {}.", "vocab": " Vocabulario: {}."},
}
DEFAULT_PROMPT = {"chat": "WhatsApp voice note in the chat «{}».", "plain": "WhatsApp voice note.",
                  "people": " Participants: {}.", "vocab": " Vocabulary: {}."}

_vocabulary = None
_participants = {}
_tokenizer = None


def vocabulary():
    """The user's terms, in priority order (one per line, or separated by commas)."""
    global _vocabulary
    if _vocabulary is None:
        try:
            lines = [l.strip() for l in open(VOCABULARY, encoding="utf-8")]
        except FileNotFoundError:
            lines = []
        _vocabulary = [p.strip() for l in lines if l and not l.startswith("#") for p in l.split(",") if p.strip()]
    return _vocabulary


def participants(chat_jid):
    """In a group, who talks the most: that way Whisper gets THAT group's names right."""
    if not chat_jid or not chat_jid.endswith("@g.us") or not os.path.exists(ARCHIVE):
        return []
    if chat_jid not in _participants:
        try:
            arch = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True)
            rows = arch.execute(
                """SELECT sender_name, count(*) AS n FROM messages
                   WHERE chat_jid = ? AND from_me = 0 AND sender_name IS NOT NULL
                     AND sender_name NOT GLOB '*=' AND sender_name NOT GLOB '*[0-9][0-9][0-9]*'
                     AND ts >= strftime('%s','now','-120 days')
                   GROUP BY sender_name ORDER BY n DESC LIMIT 6""", (chat_jid,)).fetchall()
            arch.close()
            names = [re.sub(r"[^\w\s.\-]", "", n).strip() for n, _ in rows]   # no emojis
            _participants[chat_jid] = [n for n in names if n]
        except sqlite3.Error:
            _participants[chat_jid] = []
    return _participants[chat_jid]


def tokens(text):
    global _tokenizer
    if _tokenizer is None:
        from mlx_whisper.tokenizer import get_tokenizer
        _tokenizer = get_tokenizer(multilingual=True, language=LANGUAGE or "en", task="transcribe")
    return len(_tokenizer.encode(" " + text))


def prompt(chat_name, chat_jid=None):
    """Context so Whisper gets names right: the chat, who takes part in it, and the vocabulary."""
    p = PROMPTS.get(LANGUAGE or "", DEFAULT_PROMPT)
    base = p["chat"].format(chat_name) if chat_name else p["plain"]
    people = participants(chat_jid)
    if people:
        base += p["people"].format(", ".join(people))
    chosen = []
    for term in vocabulary():
        attempt = base + p["vocab"].format(", ".join(chosen + [term]))
        if tokens(attempt) > MAX_PROMPT_TOKENS:
            break
        chosen.append(term)
    return base + (p["vocab"].format(", ".join(chosen)) if chosen else "")


def suggest_vocabulary():
    """A suggested vocabulary from what the person WRITES: the proper names they use most in their
    messages and the nicknames of their most active chats. It skips bot transcriptions (assistants
    like Zapia post them in italics as messages from you, with the same mistakes)."""
    arch = sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True)
    texts = [t for (t,) in arch.execute(
        """SELECT max(text) FROM messages WHERE message_type='text' AND from_me=1 AND text IS NOT NULL
           AND ts >= strftime('%s','now','-150 days') GROUP BY msg_id""")
        if t and not t.lstrip().startswith("_") and "Zapia" not in t]
    chats = [n for (n,) in arch.execute(
        """SELECT c.name FROM chats c JOIN messages m ON m.chat_jid = c.jid
           WHERE c.kind = 'dm' AND c.name IS NOT NULL AND m.ts >= strftime('%s','now','-150 days')
           GROUP BY c.jid ORDER BY count(*) DESC LIMIT 25""")]
    arch.close()
    # Capitalized mid-sentence, but not names: months and weekdays (Spanish and English).
    skip = {"ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "set", "oct", "nov", "dic",
            "jan", "apr", "aug", "dec", "january", "february", "march", "april", "june", "july", "august",
            "september", "october", "november", "december",
            "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
    caps, total = collections.Counter(), collections.Counter()
    for t in texts:
        for sentence in re.split(r"[.!?\n:;]+", t):
            words = re.findall(r"[A-Za-zÁÉÍÓÚÑáéíóúñü][\wÁÉÍÓÚÑáéíóúñü]+", sentence)
            for i, w in enumerate(words):
                total[w.lower()] += 1
                if i > 0 and w[0].isupper() and not w.isupper():
                    caps[w] += 1
    proper = [w for w, c in caps.most_common()
              if c >= 6 and len(w) >= 3 and c / total[w.lower()] >= 0.6 and w.lower() not in skip]
    nicknames = []
    for n in chats:
        first = re.sub(r"[^\wÁÉÍÓÚÑáéíóúñü]", "", n.split()[0]) if n.split() else ""
        if len(first) >= 3 and not first.isdigit():
            nicknames.append(first)
    seen, out = set(), []
    for w in nicknames + proper:
        if w.lower() not in seen:
            seen.add(w.lower())
            out.append(w)
    return ("# Suggested vocabulary, built from what you write on WhatsApp. REVIEW IT:\n"
            "# it's in priority order (the first lines weigh more); delete what doesn't belong and add\n"
            "# your company, team, clients and work terms. One per line.\n" + "\n".join(out[:60]))


def check_language():
    """Fails early, with a clear message, if WHISPER_LANGUAGE isn't a language Whisper knows."""
    if not LANGUAGE:
        return
    from mlx_whisper.tokenizer import LANGUAGES, TO_LANGUAGE_CODE
    if LANGUAGE not in LANGUAGES and LANGUAGE not in TO_LANGUAGE_CODE:
        sys.exit(f"WHISPER_LANGUAGE={LANGUAGE!r} isn't a language Whisper knows: use a code like en, es, pt, de "
                 "(in ~/.wacrawl/whisper.env), or leave it empty to detect it.")


def main():
    global ARCHIVE
    ap = argparse.ArgumentParser(description="Transcribe WhatsApp voice notes locally with Whisper (MLX).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--pending", action="store_true", help="transcribe whatever is missing from the archive")
    g.add_argument("--stdin", action="store_true", help="JSON list of voice notes on stdin")
    g.add_argument("--redo", action="store_true", help="re-transcribe what was done with a different vocabulary")
    g.add_argument("--suggest-vocabulary", action="store_true", help="print a suggested vocabulary")
    ap.add_argument("--limit", type=int, default=0, help="maximum voice notes (0 = no limit)")
    ap.add_argument("--minutes", type=float, default=0, help="stop after N minutes (0 = no limit)")
    ap.add_argument("--archive", help="another wacrawl archive (e.g. the iPhone history) instead of the main one")
    ap.add_argument("--before", type=int, default=0, help="only voice notes older than this epoch")
    ap.add_argument("--part", default="", help="K/N: part K of N, to run N processes in parallel")
    args = ap.parse_args()
    m = re.fullmatch(r"([1-9]\d*)/([1-9]\d*)", args.part) if args.part else None
    if args.part and not (m and int(m[1]) <= int(m[2])):
        sys.exit("--part goes as K/N, e.g. 2/3")
    if args.archive:
        ARCHIVE = os.path.expanduser(args.archive)

    if args.suggest_vocabulary:
        print(suggest_vocabulary())
        return

    # Never two background passes at once (the first one and the 6-hourly sync's): they would
    # duplicate all the work. A one-off request from Claude (--stdin) does NOT wait for this lock:
    # if the first pass holds it for an hour, Claude would hang. It can run alongside; the
    # database is in WAL mode.
    os.makedirs(DIR, exist_ok=True)
    if args.pending or args.redo:
        # Each archive and each part gets its own lock: a long pass over the iPhone history doesn't
        # block the one for new voice notes that runs after every sync.
        suffix = ("-" + os.path.basename(os.path.dirname(ARCHIVE)) if args.archive else "") + \
                 ("-" + args.part.replace("/", "of") if args.part else "")
        lock = open(os.path.join(DIR, f"transcribe{suffix}.lock"), "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("another transcription pass is already running", file=sys.stderr)
            return

    db = open_transcriptions()
    if args.stdin:
        items = json.load(sys.stdin)
        done = {(m, c) for m, c in db.execute("SELECT msg_id, chat_jid FROM transcripciones")}
        items = [a for a in items if (a["msg_id"], a["chat_jid"]) not in done]
    else:
        items = pending(db, args.limit, redo=args.redo, before=args.before, part=args.part)

    if not items:
        print("nothing to transcribe", file=sys.stderr)
        return

    try:
        import mlx_whisper
    except ImportError:
        sys.exit("mlx-whisper is missing: run ./setup-whisper.sh")
    check_language()

    start = time.time()
    done = errors = in_a_row = 0
    audio_s = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        for a in items:
            if args.minutes and time.time() - start > args.minutes * 60:
                print(f"stopped: time limit ({args.minutes:g} min)", file=sys.stderr)
                break
            try:
                audio, dur = to_wav(a["media_path"], tmp)
                r = mlx_whisper.transcribe(audio, path_or_hf_repo=MODEL, language=LANGUAGE,
                                           condition_on_previous_text=False,
                                           initial_prompt=prompt(a.get("chat_name"), a.get("chat_jid")))
                text = clean(r)
            except Exception as e:  # one broken voice note doesn't stop the rest
                errors += 1
                in_a_row += 1
                print(f"error in {a['msg_id']}: {str(e)[:120]}", file=sys.stderr)
                if in_a_row >= 10:
                    # Ten in a row aren't broken files but the Mac: out of memory, afconvert stopped
                    # opening anything and one pass burned 45,000 voice notes as errors in minutes.
                    # Wait; whatever failed isn't saved, so it's retried on the next pass.
                    print("10 errors in a row: waiting 2 min", file=sys.stderr)
                    time.sleep(120)
                    in_a_row = 0
                continue
            in_a_row = 0
            db.execute(
                "INSERT OR REPLACE INTO transcripciones VALUES (?,?,?,?,?,?,?,?,?,?)",
                (a["msg_id"], a["chat_jid"], a.get("chat_name"), a.get("sender_name"), a.get("from_me"),
                 a.get("ts"), round(dur, 1), text, label(), int(time.time())),
            )
            db.commit()
            done += 1
            audio_s += dur
            print(json.dumps({"msg_id": a["msg_id"], "chat_jid": a["chat_jid"], "duration": round(dur, 1),
                              "text": text}, ensure_ascii=False), flush=True)

    total = time.time() - start
    print(f"transcribed {done} ({audio_s/60:.1f} min of audio) in {total:.0f}s, errors {errors}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
